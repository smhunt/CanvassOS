/**
 * The field outbox: the writes a volunteer made that the network has not accepted yet.
 *
 * Rural Middlesex Centre drops signal for whole concession roads. Without this module a recorded
 * door is simply lost when the POST fails and the volunteer walks on — a door somebody knocked for
 * nothing. So every canvass write goes through here: try it now, and if the network is the reason
 * it failed, keep the exact body and replay it later.
 *
 * WHY replay is safe. `POST /api/contacts` and `POST /api/signs` are idempotent on `client_id`
 * (API.md, "Idempotency"): the stored row wins and a replay inserts nothing. That only holds if the
 * key never changes, so **`client_id` is generated once, when the write is first attempted, and is
 * stored with the body**. Regenerating it on retry would turn one door into two.
 *
 * WHY we never reconcile on the server's echo. When `voter_ids` is present the API derives a
 * per-row key of `<client_id>:<voter_id>`, so the `client_id` that comes back is NOT the one we
 * sent. Entries are keyed and reconciled by the id we generated; the response is only ever read for
 * its data.
 */
import { ApiError, api } from '../api/client';
import type { ContactResult } from '../api/types';
import { META, OUTBOX, idbDelete, idbGetAll, idbPut, isMemoryOnly } from './db';

export type OutboxEndpoint = '/contacts' | '/signs';

/** Why an entry stopped being retried. Both are shown as "needs attention"; neither is a deletion. */
export type ParkedReason = 'rejected' | 'stalled';

export interface OutboxEntry {
  /** The `client_id` we generated. Primary key here *and* the idempotency key on the wire. */
  id: string;
  endpoint: OutboxEndpoint;
  /** The exact JSON body, `client_id` included, replayed byte-for-byte. */
  body: Record<string, unknown>;
  /** One line a volunteer recognises: "41 Ilderton Rd — Not home". */
  label: string;
  state: 'pending' | 'parked';
  parked_reason: ParkedReason | null;
  attempts: number;
  queued_at: number;
  last_tried_at: number | null;
  last_error: string | null;
  last_status: number | null;
  /** Denormalised so the door list can grey out a queued door without parsing bodies. */
  household_id: string | null;
  result: ContactResult | null;
}

export interface OutboxSnapshot {
  online: boolean;
  syncing: boolean;
  entries: OutboxEntry[];
  pending: number;
  parked: number;
  lastSyncAt: number | null;
  /** False when IndexedDB refused to open — the queue is then only as durable as this tab. */
  durable: boolean;
}

/** Backoff: quick enough to catch a bar of signal in a driveway, capped so nothing spins. */
const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;
/**
 * Retries are capped so a write that will never land cannot hammer the phone's radio for a whole
 * shift. Twenty attempts across the backoff curve is over an hour of trying — past that it is a
 * failure the volunteer should see, not one the app should keep hiding.
 */
const MAX_ATTEMPTS = 20;

const LAST_SYNC_KEY = 'last_sync_at';

// ------------------------------------------------------------------ state

let entries: OutboxEntry[] = [];
let lastSyncAt: number | null = null;
let syncing = false;
let started: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
/** Called after a flush actually landed something, so the caches showing that data can refresh. */
const syncedListeners = new Set<() => void>();

let snapshot: OutboxSnapshot = {
  online: true,
  syncing: false,
  entries: [],
  pending: 0,
  parked: 0,
  lastSyncAt: null,
  durable: true,
};

const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

function rebuild(): void {
  const sorted = [...entries].sort((a, b) => a.queued_at - b.queued_at);
  snapshot = {
    online: isOnline(),
    syncing,
    entries: sorted,
    pending: sorted.filter((e) => e.state === 'pending').length,
    parked: sorted.filter((e) => e.state === 'parked').length,
    lastSyncAt,
    durable: !isMemoryOnly(),
  };
}

function notify(): void {
  rebuild();
  for (const fn of listeners) fn();
}

/** useSyncExternalStore needs a stable object between changes, so the snapshot is cached. */
export const getSnapshot = (): OutboxSnapshot => snapshot;

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  void start();
  return () => listeners.delete(fn);
}

/** Fires after a successful flush; hooks.ts uses it to invalidate the queries that just changed. */
export function onSynced(fn: () => void): () => void {
  syncedListeners.add(fn);
  return () => syncedListeners.delete(fn);
}

// ------------------------------------------------------------------ startup

export function start(): Promise<void> {
  if (started) return started;
  started = (async () => {
    entries = await idbGetAll<OutboxEntry>(OUTBOX);
    const meta = await idbGetAll<{ key: string; value: number }>(META);
    lastSyncAt = meta.find((m) => m.key === LAST_SYNC_KEY)?.value ?? null;
    if (typeof window !== 'undefined') {
      // Coming back onto a road with signal is the moment the queue exists for.
      window.addEventListener('online', () => void flush());
      window.addEventListener('offline', notify);
      // A phone in a pocket suspends timers; the app being looked at again is a fresh chance.
      window.addEventListener('focus', () => void flush());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void flush();
      });
    }
    notify();
    void flush();
  })();
  return started;
}

// ------------------------------------------------------------------ classifying a failure

type Failure = 'network' | 'auth' | 'server' | 'rejected';

/**
 * A 4xx that is not about the connection means the write will never succeed however often it is
 * replayed — a door in a turf that was reassigned, a voter that is not at that address. Those get
 * parked with the server's own message. Everything else is worth retrying.
 *
 * 401 is queued rather than parked: the session simply expired, and the write becomes valid again
 * the moment the volunteer signs back in.
 */
export function classify(err: unknown): Failure {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'auth';
    if (err.status === 408 || err.status === 425 || err.status === 429) return 'server';
    if (err.status >= 500) return 'server';
    if (err.status >= 400) return 'rejected';
    return 'server';
  }
  // fetch() rejects with a TypeError when the request never reached the server.
  return 'network';
}

const message = (err: unknown): string => {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'TypeError') return 'No connection.';
  if (err instanceof Error) return err.message;
  return 'Unknown error.';
};

const statusOf = (err: unknown): number | null => (err instanceof ApiError ? err.status : null);

// ------------------------------------------------------------------ queueing

async function persist(entry: OutboxEntry): Promise<void> {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
  await idbPut(OUTBOX, entry);
  notify();
}

async function drop(id: string): Promise<void> {
  entries = entries.filter((e) => e.id !== id);
  await idbDelete(OUTBOX, id);
  notify();
}

async function noteSync(): Promise<void> {
  lastSyncAt = Date.now();
  // Told before it is stored: the pill should say "synced" the instant the write landed, not one
  // IndexedDB round trip later.
  notify();
  await idbPut(META, { key: LAST_SYNC_KEY, value: lastSyncAt });
}

export interface QueueMeta {
  label: string;
  household_id?: string | null;
  result?: ContactResult | null;
}

async function enqueue(
  endpoint: OutboxEndpoint,
  body: Record<string, unknown>,
  meta: QueueMeta,
  err: unknown,
): Promise<OutboxEntry> {
  await start();
  const clientId = String(body.client_id ?? '');
  // Belt and braces on the one invariant that makes replay safe. An entry with no key — or with a
  // fresh one per attempt — is the double-counted door this whole module exists to prevent, and an
  // empty id would collide every queued write onto one row here as well.
  if (!clientId) throw new Error('Refusing to queue a write with no client_id.');
  const entry: OutboxEntry = {
    id: clientId,
    endpoint,
    body,
    label: meta.label,
    state: 'pending',
    parked_reason: null,
    attempts: 1,
    queued_at: Date.now(),
    last_tried_at: Date.now(),
    last_error: message(err),
    last_status: statusOf(err),
    household_id: meta.household_id ?? null,
    result: meta.result ?? null,
  };
  await persist(entry);
  schedule();
  return entry;
}

export type SubmitOutcome<T> = { queued: false; data: T } | { queued: true; entry: OutboxEntry };

/**
 * Send now if the network allows it; otherwise queue the exact body and resolve anyway, so the
 * volunteer moves to the next door instead of standing in a driveway watching a spinner.
 *
 * A definite refusal (400/403/404) is re-thrown rather than queued: the volunteer is still at the
 * door, and an error they can act on now beats one parked for later.
 */
export async function submitOrQueue<T>(
  endpoint: OutboxEndpoint,
  body: Record<string, unknown>,
  meta: QueueMeta,
): Promise<SubmitOutcome<T>> {
  if (!body.client_id) throw new Error('submitOrQueue needs a client_id — it is the idempotency key.');
  void start();
  try {
    const data = await api.post<T>(endpoint, body);
    void noteSync();
    return { queued: false, data };
  } catch (err) {
    if (classify(err) === 'rejected') throw err;
    return { queued: true, entry: await enqueue(endpoint, body, meta, err) };
  }
}

// ------------------------------------------------------------------ flushing

const dueAt = (e: OutboxEntry): number =>
  (e.last_tried_at ?? e.queued_at) + Math.min(FIRST_DELAY_MS * 2 ** Math.max(0, e.attempts - 1), MAX_DELAY_MS);

/**
 * One timer, set to the earliest thing actually due. No pending entries means no timer at all —
 * that is what stops a queue from spinning a radio for a whole shift.
 */
function schedule(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const pending = entries.filter((e) => e.state === 'pending');
  if (pending.length === 0) return;
  const next = Math.min(...pending.map(dueAt));
  const delay = Math.max(1_000, Math.min(next - Date.now(), MAX_DELAY_MS));
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

async function park(entry: OutboxEntry, reason: ParkedReason, err: unknown): Promise<void> {
  await persist({
    ...entry,
    state: 'parked',
    parked_reason: reason,
    last_tried_at: Date.now(),
    last_error: message(err),
    last_status: statusOf(err),
  });
}

/**
 * Replay the queue oldest first, one at a time.
 *
 * Sequential on purpose: a phone on one bar does not get faster by opening six sockets, and doors
 * arriving in the order they were knocked keeps `contact` history readable.
 */
export async function flush(): Promise<void> {
  // Claimed before the first await: `online` firing while a timer-driven flush is already awaiting
  // would otherwise send the same entry twice. Idempotency would forgive it; the radio would not.
  if (syncing) return;
  syncing = true;
  let landed = false;
  try {
    await start();
    if (!isOnline()) return;
    const due = entries
      .filter((e) => e.state === 'pending' && dueAt(e) <= Date.now())
      .sort((a, b) => a.queued_at - b.queued_at);
    if (due.length === 0) return;
    notify();
    for (const entry of due) {
      try {
        await api.post(entry.endpoint, entry.body);
        // The response's `client_id` may be a derived `<client_id>:<voter_id>` key, so it is not
        // consulted: the entry is identified by the id we generated and nothing else.
        await drop(entry.id);
        landed = true;
      } catch (err) {
        const kind = classify(err);
        if (kind === 'rejected') {
          await park(entry, 'rejected', err);
          continue;
        }
        const attempts = entry.attempts + 1;
        await persist({
          ...entry,
          attempts,
          last_tried_at: Date.now(),
          last_error: message(err),
          last_status: statusOf(err),
        });
        if (attempts >= MAX_ATTEMPTS) {
          await park({ ...entry, attempts }, 'stalled', err);
          continue;
        }
        // The connection is gone or the session is: stop walking the queue rather than burning
        // every entry's attempt budget on the same dead network.
        break;
      }
    }
  } finally {
    syncing = false;
    if (landed) {
      await noteSync();
      for (const fn of syncedListeners) fn();
    }
    notify();
    schedule();
  }
}

/** The "Sync now" button: ignore backoff and try everything pending immediately. */
export async function syncNow(): Promise<void> {
  await start();
  const now = Date.now();
  for (const e of entries.filter((x) => x.state === 'pending')) {
    await persist({ ...e, last_tried_at: now - MAX_DELAY_MS });
  }
  await flush();
}

/** Un-park one entry the volunteer wants tried again (a 403 after an organiser fixed the turf). */
export async function retryEntry(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  // Backdated so "Try again" means now rather than "in five seconds, once the backoff agrees".
  await persist({ ...entry, state: 'pending', parked_reason: null, attempts: 0, last_tried_at: Date.now() - MAX_DELAY_MS });
  await flush();
}

/** Deliberate deletion only — a queued door is never dropped on the app's own initiative. */
export async function discardEntry(id: string): Promise<void> {
  await drop(id);
  schedule();
}
