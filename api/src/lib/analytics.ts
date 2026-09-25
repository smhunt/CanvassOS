/**
 * Product analytics, forwarded to Amplitude. OFF unless AMPLITUDE_API_KEY is set.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED LIKE THIS — read before adding an event or a property
 * ---------------------------------------------------------------------------------------------
 * This is the third thing in the stack that talks to a third party (after `streetview.ts` and
 * `advice.ts`), and the argument there applies here with more force: an analytics vendor is built
 * to receive rows. MEA s. 23(8) — the voters list "shall not be provided to any other person" —
 * means nothing that identifies a door, an elector, or what an elector said may leave. So:
 *
 * 1. **Allow-list, never deny-list.** Every property is picked by name and type-checked by a
 *    mapper written for that one event. `audit_log.detail` is never spread: it carries household
 *    ids, emails, coordinates and search text, and it is allowed to because it never leaves.
 *
 * 2. **Every AuditAction must be decided.** `AUDIT_EVENTS` is a `Record` over the whole union, so a
 *    new action does not compile until somebody writes its mapper or writes `null`.
 *
 * 3. **The payload is re-checked before it leaves.** `assertNoPersonalData()` (the one in
 *    advice.ts; one implementation, not two) runs on the serialised batch. A batch that fails it
 *    is dropped whole and logged at error level — a programming error, not a transient one.
 *
 * 4. **No IP, no location.** Events go out with no `ip` field. The HTTP v2 API geolocates only
 *    from `ip`/`$remote`, so Amplitude learns neither where a volunteer stood nor which LTE NAT
 *    they share. The browser never talks to Amplitude either: see routes/analytics.ts.
 *
 * 5. **Never in the request path.** Events are queued in memory and sent in batches by a timer.
 *    Any failure is logged and the batch dropped: the canvass is the product, the charts are not.
 *    Losing analytics on a crash is acceptable; slowing a door write to send them is not.
 *
 * Deliberately excluded everywhere: `support`, `issues`, `needs_ride` (a political opinion or a
 * health hint about a door), search text, notes, names, addresses, ids of households, voters,
 * signs, photos, requests or contacts, coordinates, emails and phone numbers.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import type { Queryable } from '../db.js';
import { assertNoPersonalData } from './advice.js';
import type { AuditAction, AuditEntry } from './audit.js';
import type { FetchLike } from './streetview.js';

export type Prop = string | number | boolean;
/** Flat on purpose: no objects, no arrays — a property that cannot nest cannot carry a row. */
export type Props = Record<string, Prop>;

export interface ServerEvent {
  event: string;
  props?: Props;
}

/** What goes on the wire: the HTTP v2 event shape, reduced to the fields this app ever sets. */
export interface OutgoingEvent {
  event_type: string;
  user_id?: string;
  device_id?: string;
  session_id?: number;
  time: number;
  insert_id: string;
  app_version?: string;
  platform?: string;
  os_name?: string;
  os_version?: string;
  device_model?: string;
  language?: string;
  event_properties?: Props;
  user_properties?: Props;
}

// ------------------------------------------------------------------------------ picking helpers
// Each returns undefined for anything that is not exactly the expected shape, and `pick()` drops
// undefined keys, so a detail that changes shape upstream loses a property rather than leaking one.

type Detail = Record<string, unknown> | null | undefined;

const num = (d: Detail, k: string): number | undefined => {
  const v = d?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const bool = (d: Detail, k: string): boolean | undefined => {
  const v = d?.[k];
  return typeof v === 'boolean' ? v : undefined;
};
const oneOf = <T extends string>(d: Detail, k: string, allowed: readonly T[]): T | undefined => {
  const v = d?.[k];
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
};
/** An array of enum values, as one sorted comma-joined string (Amplitude groups by it cleanly). */
const setOf = (d: Detail, k: string, allowed: readonly string[]): string | undefined => {
  const v = d?.[k];
  if (!Array.isArray(v)) return undefined;
  const kept = [...new Set(v.filter((x): x is string => typeof x === 'string' && allowed.includes(x)))].sort();
  return kept.join(',');
};
/** Names of keys that were present — for "which fields changed", never their values. */
const keysOf = (d: Detail, allowed: readonly string[], k?: string): string | undefined => {
  const src = k ? d?.[k] : d;
  const names = Array.isArray(src) ? src : src && typeof src === 'object' ? Object.keys(src) : null;
  if (!names) return undefined;
  return names.filter((x): x is string => typeof x === 'string' && allowed.includes(x)).sort().join(',');
};

function pick(props: Record<string, Prop | undefined>): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined) out[k] = v;
  return out;
}

/** Sizes as buckets: an exact byte count is a fingerprint of one photo. */
function bytesBucket(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  if (n < 250_000) return '<250KB';
  if (n < 1_000_000) return '250KB-1MB';
  if (n < 4_000_000) return '1-4MB';
  return '4MB+';
}

const ROLES = ['admin', 'organizer', 'volunteer'] as const;
const WANTS = ['sign', 'volunteer', 'reminders', 'donate', 'other'] as const;
const SIGN_STATUSES = ['requested', 'placed', 'removed', 'missing', 'damaged'] as const;
const CANCEL_REASONS = ['test', 'spam', 'withdrawn', 'duplicate', 'other'] as const;
const CHANNELS = ['phone', 'email'] as const;
const PURPOSES = ['gotv', 'updates'] as const;
const ASSIGNMENT_STATUSES = ['open', 'in_progress', 'done'] as const;
const DECISIONS = ['accept', 'reject'] as const;
const PROVIDERS = ['log', 'twilio', 'google'] as const;
const USER_FIELDS = ['name', 'role', 'active'] as const;
const TURF_FIELDS = ['name', 'archived'] as const;
const CAMPAIGN_FIELDS = ['name', 'purpose', 'body_sms', 'email_subject', 'body_email', 'audience', 'scheduled_for'] as const;
const SIGN_FIELDS = ['status', 'label', 'size', 'note'] as const;
const REQUEST_FIELDS = ['name', 'email', 'phone', 'address', 'note', 'wants', 'household_id'] as const;

type Mapper = (d: Detail, e: AuditEntry) => ServerEvent | null;

/**
 * AuditAction → event. `null` = deliberately not sent.
 *
 * `contact` is null because a contact audit is per named voter; the door-level
 * `door_result_recorded` is emitted once per door from routes/contacts.ts instead, where the
 * door-level booleans are in scope.
 */
export const AUDIT_EVENTS: Record<AuditAction, Mapper | null> = {
  // auth
  login: (d) => ({ event: 'session_signed_in', props: pick({ via: d?.via === 'invite' ? 'invite' : 'password' }) }),
  login_failed: () => ({ event: 'sign_in_failed' }), // target is the typed email: never read
  logout: () => ({ event: 'session_signed_out' }),
  accept_invite: () => ({ event: 'invite_accepted' }),
  change_password: () => ({ event: 'password_changed' }),

  // users
  invite: (d) => ({ event: 'user_invited', props: pick({ invitee_role: oneOf(d, 'role', ROLES), reinvite: false }) }),
  reinvite: () => ({ event: 'user_invited', props: { reinvite: true } }),
  update_user: (d) => ({ event: 'user_updated', props: pick({ fields: keysOf(d, USER_FIELDS) }) }),

  // reads of the list — counts only
  view_household: () => ({ event: 'household_viewed' }),
  view_streetview: (d) => ({
    event: 'streetview_viewed',
    props: pick({ available: bool(d, 'available'), provider: oneOf(d, 'provider', PROVIDERS) }),
  }),
  search: (d) => ({
    // Never the query. Its length is enough to see "people type a name" vs "people type a number".
    event: 'search_performed',
    props: pick({
      query_length: typeof d?.q === 'string' ? d.q.length : undefined,
      n_voters: num(d, 'n_voters'),
      n_households: num(d, 'n_households'),
    }),
  }),
  view_reachability: (d) => ({ event: 'report_viewed', props: pick({ report: 'reachability', advice: bool(d, 'advice') }) }),
  view_follow_ups: (d) => ({ event: 'follow_ups_viewed', props: pick({ n: num(d, 'n') }) }),
  view_turf_doors: (d) => ({ event: 'turf_opened', props: pick({ n_doors: num(d, 'n_doors') }) }),
  view_sign_requests: (d) => ({ event: 'sign_requests_viewed', props: pick({ n: num(d, 'n') }) }),
  view_sign_photo: () => ({ event: 'sign_photo_viewed' }),
  view_voter_contacts: (d) => ({ event: 'doorstep_contacts_viewed', props: pick({ n: num(d, 'n') }) }),
  view_gotv_list: (d) => ({
    event: 'gotv_list_viewed',
    props: pick({ channel: d?.channel === 'all' ? 'all' : oneOf(d, 'channel', CHANNELS), n: num(d, 'n') }),
  }),
  view_public_requests: (d) => ({ event: 'requests_viewed', props: pick({ n: num(d, 'n'), open_only: bool(d, 'open_only') }) }),
  view_audience: (d) => ({
    event: 'audience_previewed',
    props: pick({ purpose: oneOf(d, 'purpose', PURPOSES), sms: num(d, 'sms'), email: num(d, 'email') }),
  }),

  // requests (public form + hand-entered)
  public_request: (d) => ({
    event: 'public_request_received',
    props: pick({ wants: setOf(d, 'wants', WANTS), has_address: bool(d, 'has_address') }),
  }),
  handle_public_request: (d) => ({ event: 'request_handled', props: pick({ handled: bool(d, 'handled') }) }),
  create_manual_request: (d) => ({
    event: 'manual_request_created',
    props: pick({ wants: setOf(d, 'wants', WANTS), has_household: bool(d, 'has_household') }),
  }),
  update_manual_request: (d) => ({
    event: 'manual_request_updated',
    props: pick({ fields: keysOf(d, REQUEST_FIELDS, 'fields'), from_household: bool(d, 'from_household') }),
  }),
  delete_manual_request: (d) => ({
    event: 'manual_request_deleted',
    props: pick({ wants: setOf(d, 'wants', WANTS), had_household: bool(d, 'had_household') }),
  }),

  // ops
  export: () => ({ event: 'list_exported' }),
  import: () => ({ event: 'list_imported' }),

  // turfs
  preview_turf: (d) => ({
    event: 'turf_previewed',
    props: pick({ method: oneOf(d, 'by', ['polygon', 'streets'] as const), n_doors: num(d, 'n_households') }),
  }),
  create_turf: (d) => ({
    // Not the name: a turf is often named after the street it covers.
    event: 'turf_created',
    props: pick({ method: oneOf(d, 'by', ['polygon', 'streets'] as const), n_doors: num(d, 'n_households') }),
  }),
  update_turf: (d) => ({ event: 'turf_updated', props: pick({ fields: keysOf(d, TURF_FIELDS) }) }),
  delete_turf: () => ({ event: 'turf_deleted' }),
  assign_turf: () => ({ event: 'turf_assigned' }),
  unassign_turf: () => ({ event: 'turf_unassigned' }),
  update_assignment: (d) => ({ event: 'assignment_updated', props: pick({ status: oneOf(d, 'status', ASSIGNMENT_STATUSES) }) }),

  // doors
  contact: null,

  // signs
  place_sign: (d) => ({ event: 'sign_placed', props: pick({ status: oneOf(d, 'status', SIGN_STATUSES) }) }),
  update_sign: (d) => ({
    event: 'sign_updated',
    props: pick({
      from_status: oneOf(d, 'from_status', SIGN_STATUSES),
      to_status: oneOf(d, 'status', SIGN_STATUSES),
      fields: keysOf(d, SIGN_FIELDS),
    }),
  }),
  delete_sign: (d) => ({
    // The photo delete reuses this action with a photo_id in the detail.
    event: d && 'photo_id' in d ? 'sign_photo_deleted' : 'sign_deleted',
    props: pick({ status: oneOf(d, 'status', SIGN_STATUSES), photos: num(d, 'photos') }),
  }),
  upload_sign_photo: (d) => ({ event: 'sign_photo_uploaded', props: pick({ size: bytesBucket(num(d, 'bytes')) }) }),
  cancel_sign_request: (d) => ({
    event: 'sign_request_cancelled',
    props: pick({ reason: oneOf(d, 'reason', CANCEL_REASONS), signs: num(d, 'signs'), had_note: bool(d, 'had_note') }),
  }),
  restore_sign_request: (d) => ({ event: 'sign_request_restored', props: pick({ signs: num(d, 'signs') }) }),

  // doorstep phone / email — the channel and the consent booleans, never the value
  collect_voter_contact: (d) => ({
    event: 'doorstep_contact_collected',
    props: pick({
      channel: oneOf(d, 'channel', CHANNELS),
      consent_gotv: bool(d, 'consent_gotv'),
      consent_updates: bool(d, 'consent_updates'),
      re_offered: bool(d, 're_offered'),
    }),
  }),
  update_voter_contact: (d) => ({
    event: 'doorstep_contact_updated',
    props: pick({ channel: oneOf(d, 'channel', CHANNELS), consent_gotv: bool(d, 'consent_gotv'), consent_updates: bool(d, 'consent_updates') }),
  }),
  withdraw_voter_contact: (d) => ({ event: 'consent_withdrawn', props: pick({ channel: oneOf(d, 'channel', CHANNELS) }) }),
  delete_voter_contact: (d) => ({
    event: 'doorstep_contact_deleted',
    props: pick({ channel: oneOf(d, 'channel', CHANNELS), was_withdrawn: bool(d, 'was_withdrawn') }),
  }),

  // messaging — never the campaign name (free text), never a sender number
  create_campaign: (d) => ({ event: 'campaign_created', props: pick({ purpose: oneOf(d, 'purpose', PURPOSES) }) }),
  update_campaign: (d) => ({ event: 'campaign_updated', props: pick({ fields: keysOf(d, CAMPAIGN_FIELDS, 'fields') }) }),
  approve_campaign: (d) => ({
    event: 'campaign_approved',
    props: pick({ purpose: oneOf(d, 'purpose', PURPOSES), sms_segments: num(d, 'sms_segments') }),
  }),
  send_campaign: (d) => ({
    event: 'campaign_sent',
    props: pick({
      // The route spreads its count object into the detail, so these are top-level keys.
      audience_size: num(d, 'size'),
      sms: num(d, 'sms'),
      email: num(d, 'email'),
      override_max_audience: bool(d, 'override_max_audience'),
      provider: oneOf(d, 'provider', PROVIDERS),
    }),
  }),
  pause_campaign: () => ({ event: 'campaign_paused' }),
  resume_campaign: () => ({ event: 'campaign_resumed' }),
  cancel_campaign: (d) => ({ event: 'campaign_cancelled', props: pick({ unsent_skipped: num(d, 'unsent_skipped') }) }),
  test_send: (d) => ({ event: 'campaign_test_sent', props: pick({ provider: oneOf(d, 'provider', PROVIDERS), segments: num(d, 'segments') }) }),
  create_sender_number: (d) => ({ event: 'sender_number_added', props: pick({ provider: oneOf(d, 'provider', PROVIDERS) }) }),
  update_sender_number: (d) => ({ event: 'sender_number_updated', props: pick({ active: bool(d, 'active') }) }),
  inbound_stop: (d) => ({ event: 'sms_stop_received', props: pick({ from_known: bool(d, 'from_known'), matched: num(d, 'matched') }) }),
  inbound_join: (d) => ({ event: 'sms_join_received', props: pick({ matched: num(d, 'matched'), unattached: bool(d, 'unattached') }) }),
  subscribe_request: (d) => ({
    event: 'subscribe_requested',
    props: pick({ wants_gotv: bool(d, 'wants_gotv'), wants_updates: bool(d, 'wants_updates') }),
  }),

  // website subscriber link
  subscriber_sync: (d) => ({ event: 'subscriber_sync_ran', props: pick({ pulled: num(d, 'pulled'), new: num(d, 'new'), failed: num(d, 'failed') }) }),
  suggest_match: (d) => ({ event: 'match_suggested', props: pick({ n: num(d, 'n'), exact: d?.tier === 'exact' }) }),
  auto_accept_match: () => ({ event: 'match_auto_accepted' }),
  apply_match_ledger: (d) => ({ event: 'match_ledger_applied', props: pick({ rows: num(d, 'rows'), relinked: num(d, 'relinked') }) }),
  decide_match: (d) => ({ event: 'match_decided', props: pick({ decision: oneOf(d, 'decision', DECISIONS) }) }),
};

// ------------------------------------------------------------------------------------ the sink

const ENDPOINTS = {
  US: 'https://api2.amplitude.com/2/httpapi',
  EU: 'https://api.eu.amplitude.com/2/httpapi',
} as const;
/** Events with no signed-in user (the public form, inbound SMS, the matcher) share this id. */
export const SERVER_DEVICE_ID = 'canvassos-server';
const FLUSH_MS = 10_000;
const BATCH_MAX = 500;
const QUEUE_MAX = 5_000;
const ROLE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

export interface AnalyticsDeps {
  config: Config;
  db: Queryable;
  log: FastifyBaseLogger;
  httpFetch: FetchLike;
}

export class Analytics {
  private queue: OutgoingEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private roles = new Map<string, { role: string; at: number }>();
  private flushing: Promise<void> | null = null;

  constructor(private readonly deps: AnalyticsDeps) {}

  static enabled(config: Config): boolean {
    return Boolean(config.AMPLITUDE_API_KEY);
  }

  /** Queue one server-side event. Never throws, never awaits the network. */
  track(userId: string | null, ev: ServerEvent, at: number = Date.now()): void {
    this.enqueue({
      event_type: ev.event,
      ...(userId ? { user_id: userId } : { device_id: SERVER_DEVICE_ID }),
      time: at,
      insert_id: randomUUID(),
      platform: 'server',
      ...(ev.props && Object.keys(ev.props).length > 0 ? { event_properties: ev.props } : {}),
    });
  }

  /** Queue events that routes/analytics.ts has already validated and rebuilt field by field. */
  enqueue(...events: OutgoingEvent[]): void {
    for (const e of events) {
      if (this.queue.length >= QUEUE_MAX) {
        // Amplitude has been unreachable for a long time. Dropping the oldest keeps memory bounded;
        // this is analytics, and the audit log is the record that matters.
        this.queue.shift();
      }
      this.queue.push(e);
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  /** Send everything queued. Safe to call concurrently; resolves when this pass is done. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH_MAX);
        await this.send(batch);
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async send(batch: OutgoingEvent[]): Promise<void> {
    const { config, log, httpFetch } = this.deps;
    try {
      await this.stampRoles(batch);
    } catch (err) {
      log.warn({ err }, 'analytics: role lookup failed; sending without role');
    }
    const payload = JSON.stringify({
      api_key: config.AMPLITUDE_API_KEY,
      events: batch,
      options: { min_id_length: 1 },
    });
    try {
      // The key itself is not personal data, but it is in the payload; check the events only.
      assertNoPersonalData(JSON.stringify(batch));
    } catch (err) {
      log.error({ err, n: batch.length }, 'analytics: refusing to send a batch that failed the personal-data check');
      return;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await httpFetch(ENDPOINTS[config.AMPLITUDE_SERVER_ZONE], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: ac.signal,
      });
      if (!res.ok) log.warn({ status: res.status, n: batch.length }, 'analytics: upload rejected; batch dropped');
    } catch (err) {
      log.warn({ err, n: batch.length }, 'analytics: upload failed; batch dropped');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Role is the segment every chart wants, and audit entries do not carry it. One indexed query
   * per flush, cached, rather than widening AuditEntry at sixty call sites.
   */
  private async stampRoles(batch: OutgoingEvent[]): Promise<void> {
    const now = Date.now();
    const fresh = (id: string) => (this.roles.get(id)?.at ?? 0) > now - ROLE_TTL_MS;
    const missing = [...new Set(batch.map((e) => e.user_id).filter((id): id is string => !!id && !fresh(id)))];
    if (missing.length > 0) {
      const { rows } = await this.deps.db.query<{ id: string; role: string }>(
        'SELECT id, role FROM app_user WHERE id = ANY($1::uuid[])',
        [missing],
      );
      for (const r of rows) this.roles.set(r.id, { role: r.role, at: now });
    }
    for (const e of batch) {
      const role = e.user_id ? this.roles.get(e.user_id)?.role : undefined;
      if (role && (ROLES as readonly string[]).includes(role)) e.user_properties = { ...e.user_properties, role };
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

// ------------------------------------------------------------------------- module-level access
// audit() is called with (db, log, entry) from sixty places and has no app in scope, so the sink
// is installed here by buildApp. Only an app WITH a key installs one; an app without a key leaves
// whatever is installed alone, and uninstalls only its own on close.

let current: Analytics | null = null;

export function installAnalytics(a: Analytics): () => void {
  current = a;
  return () => {
    if (current === a) current = null;
  };
}

/** Called by audit() after the row is written. Never throws. */
export function emitAudit(e: AuditEntry): void {
  if (!current) return;
  try {
    const mapper = AUDIT_EVENTS[e.action];
    if (!mapper) return;
    const ev = mapper(e.detail ?? null, e);
    if (ev) current.track(e.userId, ev);
  } catch {
    // A mapper bug must not reach the request. The audit row is already written.
  }
}

/** A server-side event with no audit row behind it (the door-level result). Never throws. */
export function trackServer(userId: string | null, ev: ServerEvent): void {
  try {
    current?.track(userId, ev);
  } catch {
    /* see emitAudit */
  }
}

export function currentAnalytics(): Analytics | null {
  return current;
}
