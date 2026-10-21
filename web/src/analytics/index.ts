/**
 * Product analytics, browser side — Phase B of docs/analytics-plan.md.
 *
 * This is the hand-rolled tracker the plan allows for, not the Amplitude SDK, and the choice is
 * deliberate. The relay (`POST /api/analytics/events`) already rebuilds every event field by field
 * and drops anything under another user's id, so what the SDK would add is a persistent
 * localStorage queue that outlives a sign-out — the passed-phone problem the relay exists to
 * refuse — plus autocapture switches that must all be off, and ~40 KB of gzipped code in a PWA
 * that runs on rural LTE. The cost is that events tracked with no signal die with the tab; the
 * server-side events cover the actions that matter, and this module keeps an in-memory batch that
 * goes on `online` and on `pagehide`.
 *
 * What can leave here is fixed by `Catalogue` below, and the relay holds the same list as zod:
 * an event this file cannot type is one the server would drop anyway. Nothing in a property is
 * ever free text — a route PATTERN, never a path; a tab id; a count; a bucket. `screenFor()` is
 * the one place a URL is read, and it returns the pattern it matched, never the URL.
 *
 * It never sends before `setUser()` has been called with the signed-in user's id (an opaque uuid,
 * never the email), and `reset()` on sign-out empties the batch and rotates the device id. Opting
 * out is a localStorage preference (`mc-canvass.analytics-off`), the UI-preference class of
 * storage, read at track time. Everything touching `window`, `navigator` or `localStorage` is
 * guarded, so the module loads and is testable with no DOM.
 */

export type Breakpoint = 'phone' | 'compact' | 'tablet' | 'desktop';

/** The route PATTERNS from App.tsx — the relay's list, kept identical by hand. */
export const ROUTE_PATTERNS = [
  '/map',
  '/canvass',
  '/canvass/:turfId',
  '/canvass/:turfId/drive',
  '/turfs',
  '/turfs/:turfId/sheet',
  '/signs',
  '/messaging',
  '/requests',
  '/reports',
  '/stats',
  '/turnout',
  '/admin/users',
  '/admin/audit',
  '/account',
  'not_found',
] as const;
export type RoutePattern = (typeof ROUTE_PATTERNS)[number];

const TABS = ['place', 'requests', 'map', 'pickup', 'follow-ups', 'activity', 'unreachable', 'coverage'] as const;
export type Tab = (typeof TABS)[number];
const TABBED: ReadonlySet<RoutePattern> = new Set<RoutePattern>(['/signs', '/reports']);

export type QueueKind = 'contact' | 'sign' | 'voter_contact' | 'other';
export type InstallPlatform = 'chromium' | 'ios' | 'other';

/** Every event this app may send, and exactly the properties each carries. Mirrors CLIENT_EVENTS. */
export interface Catalogue {
  screen_viewed: { route: RoutePattern; breakpoint: Breakpoint; tab?: Tab };
  write_queued: { kind: QueueKind };
  queue_flushed: { n_sent: number; n_failed: number; oldest_age_s: number };
  queue_entry_parked: { kind: QueueKind; attempts: number; last_status: number };
  storage_not_durable: Record<string, never>;
  turf_cache_fallback_used: { age_s: number };
  saved_data_cleared: { n_turfs: number; n_photos: number };
  sign_out_blocked_by_queue: { n_pending: number; n_photos: number; proceeded: boolean };
  install_prompt_shown: { platform: InstallPlatform };
  install_prompt_dismissed: { platform: InstallPlatform };
  app_installed: { platform: InstallPlatform };
}
export type EventName = keyof Catalogue;

/** User properties the browser may set. `role` is not here: the server stamps it from the session. */
export interface UserProps {
  app_version?: string;
  installed?: boolean;
  breakpoint?: Breakpoint;
  pointer?: 'coarse' | 'fine';
  voice_kind?: 'local' | 'online' | 'none';
  turfs_assigned?: number;
}

type Prop = string | number | boolean;

interface Envelope {
  event_type: string;
  user_id?: string;
  device_id: string;
  session_id: number;
  time: number;
  insert_id: string;
  app_version?: string;
  platform: 'Web';
  language?: string;
  event_properties?: Record<string, Prop>;
  user_properties?: { $set: Record<string, Prop> };
}

export const ENDPOINT = '/api/analytics/events';
const OPT_OUT_KEY = 'mc-canvass.analytics-off';
const DEVICE_KEY = 'mc-canvass.analytics-device';
/** The relay rate-limits at 60/min per user; 10 s between batches keeps a busy door session well under it. */
const FLUSH_MS = 10_000;
const MAX_BUFFER = 200;
const MAX_BATCH = 100;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

let appVersion: string | undefined;
let userId: string | null = null;
let sessionId: number | null = null;
let deviceId: string | null = null;
let buffer: Envelope[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sending = false;
let listening = false;
let seq = 0;

// ------------------------------------------------------------------ environment, guarded

const g = () => globalThis as unknown as { window?: Window; navigator?: Navigator; localStorage?: Storage; fetch?: typeof fetch };

function readPref(key: string): string | null {
  try {
    return g().localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writePref(key: string, value: string | null): void {
  try {
    const ls = g().localStorage;
    if (!ls) return;
    if (value === null) ls.removeItem(key);
    else ls.setItem(key, value);
  } catch {
    /* private mode, quota, blocked storage — the preference just does not persist */
  }
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Stable per browser until `reset()`; the relay only accepts `[A-Za-z0-9._-]{5,100}`. */
function device(): string {
  if (deviceId) return deviceId;
  const stored = readPref(DEVICE_KEY);
  deviceId = stored && /^[A-Za-z0-9._-]{5,100}$/.test(stored) ? stored : randomId();
  if (deviceId !== stored) writePref(DEVICE_KEY, deviceId);
  return deviceId;
}

function language(): string | undefined {
  const l = g().navigator?.language;
  return l && LANGUAGE.test(l) ? l : undefined;
}

const online = (): boolean => g().navigator?.onLine !== false;

// ------------------------------------------------------------------ opt-out

export const optedOut = (): boolean => readPref(OPT_OUT_KEY) === '1';

export function setOptedOut(off: boolean): void {
  writePref(OPT_OUT_KEY, off ? '1' : null);
  if (off) buffer = [];
}

// ------------------------------------------------------------------ lifecycle

/** Called once, with the app version; installs the flush-on-leave listeners. Safe to call again. */
export function configure(opts: { appVersion: string }): void {
  appVersion = opts.appVersion;
  const w = g().window;
  if (listening || !w?.addEventListener) return;
  listening = true;
  w.addEventListener('online', () => void flush());
  // `pagehide` is the reliable "the tab is going away" on iOS; visibilitychange covers app switches.
  w.addEventListener('pagehide', beacon);
  w.document?.addEventListener?.('visibilitychange', () => {
    if (w.document.visibilityState === 'hidden') beacon();
  });
}

/**
 * Attribute what follows to this user. A different id than before means the phone changed hands:
 * whatever was buffered under the previous user is dropped, never re-stamped.
 */
export function setUser(id: string): void {
  if (userId === id) return;
  if (userId !== null) buffer = [];
  userId = id;
  sessionId = Date.now();
  schedule();
}

/** Sign-out: nothing buffered survives, and the device id rotates so nothing links across users. */
export function reset(): void {
  userId = null;
  sessionId = null;
  buffer = [];
  deviceId = null;
  writePref(DEVICE_KEY, null);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

// ------------------------------------------------------------------ recording

function envelope(event_type: string): Envelope {
  const time = Date.now();
  seq += 1;
  const e: Envelope = {
    event_type,
    device_id: device(),
    session_id: sessionId ?? time,
    time,
    insert_id: `${device()}.${time}.${seq}`,
    platform: 'Web',
  };
  if (appVersion) e.app_version = appVersion;
  const lang = language();
  if (lang) e.language = lang;
  return e;
}

function push(e: Envelope): void {
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push(e);
  schedule();
}

export function track<E extends EventName>(event: E, props: Catalogue[E]): void {
  try {
    if (optedOut()) return;
    const e = envelope(event);
    const clean: Record<string, Prop> = {};
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
    }
    if (Object.keys(clean).length > 0) e.event_properties = clean;
    push(e);
  } catch {
    /* analytics must never be the reason anything else fails */
  }
}

export function identify(props: UserProps): void {
  try {
    if (optedOut()) return;
    const clean: Record<string, Prop> = {};
    for (const [k, v] of Object.entries(props)) if (v !== undefined) clean[k] = v as Prop;
    if (Object.keys(clean).length === 0) return;
    const e = envelope('$identify');
    e.user_properties = { $set: clean };
    push(e);
  } catch {
    /* as above */
  }
}

// ------------------------------------------------------------------ the URL → pattern step

/**
 * The one place a location is read. Returns the PATTERN the path matched and, on the two tabbed
 * screens, the tab id when it is one of the known ids — never the path, never the query.
 */
export function screenFor(pathname: string, search = ''): { route: RoutePattern; tab?: Tab } {
  const parts = pathname.split('/').filter(Boolean);
  let route: RoutePattern = 'not_found';
  for (const p of ROUTE_PATTERNS) {
    if (p === 'not_found') continue;
    const segs = p.split('/').filter(Boolean);
    if (segs.length !== parts.length) continue;
    if (segs.every((s, i) => (s.startsWith(':') ? parts[i]!.length > 0 : s === parts[i]))) {
      route = p;
      break;
    }
  }
  if (!TABBED.has(route)) return { route };
  const m = /(?:^|[?&])tab=([a-z-]+)/.exec(search);
  const tab = m?.[1];
  return tab && (TABS as readonly string[]).includes(tab) ? { route, tab: tab as Tab } : { route };
}

// ------------------------------------------------------------------ sending

function schedule(): void {
  if (timer !== null || buffer.length === 0 || userId === null) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

function stamped(batch: Envelope[]): string {
  return JSON.stringify({ events: batch.map((e) => ({ ...e, user_id: userId ?? undefined })) });
}

/** Send what is buffered. Exported for the tests and for `online`; the timer calls it otherwise. */
export async function flush(): Promise<void> {
  if (sending || userId === null || buffer.length === 0 || !online()) return;
  const f = g().fetch;
  if (!f) return;
  sending = true;
  const batch = buffer.splice(0, MAX_BATCH);
  try {
    const res = await f(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: stamped(batch),
    });
    // A 4xx is a verdict on these events (or on the session); only a dead network earns a retry.
    if (!res.ok && res.status >= 500 && buffer.length + batch.length <= MAX_BUFFER) buffer.unshift(...batch);
  } catch {
    if (buffer.length + batch.length <= MAX_BUFFER) buffer.unshift(...batch);
  } finally {
    sending = false;
    schedule();
  }
}

/**
 * Hand the batch to the browser now, which delivers it even after the page is gone. Used on
 * `pagehide`, and by sign-out BEFORE the logout request: `reset()` empties the buffer and the
 * session cookie goes with the logout, so an event tracked in the same tap would otherwise never
 * arrive — and the one that says "they handed the phone over anyway" is exactly that event.
 */
export function flushNow(): void {
  beacon();
}

function beacon(): void {
  if (userId === null || buffer.length === 0) return;
  const nav = g().navigator as (Navigator & { sendBeacon?: (url: string, data: BodyInit) => boolean }) | undefined;
  if (!nav?.sendBeacon || typeof Blob === 'undefined') return;
  try {
    // Fastify parses JSON by content type, and a bare string beacon goes up as text/plain.
    const ok = nav.sendBeacon(ENDPOINT, new Blob([stamped(buffer)], { type: 'application/json' }));
    if (ok) buffer = [];
  } catch {
    /* the batch stays for the next flush, if there is one */
  }
}

/** Tests only: back to the state at import. */
export function _resetForTests(): void {
  reset();
  appVersion = undefined;
  listening = false;
  sending = false;
  seq = 0;
}
export const _bufferSize = (): number => buffer.length;
