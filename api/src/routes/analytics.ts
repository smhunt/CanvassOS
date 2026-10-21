/**
 * POST /api/analytics/events — the only way a browser event reaches Amplitude.
 *
 * The web app's tracker (`web/src/analytics/index.ts` — hand-rolled, not the Amplitude SDK) posts
 * here and nowhere else, so:
 * - the volunteer's IP never reaches the vendor (this server uploads, and sends no `ip`);
 * - the API key stays server-side, like STREETVIEW_API_KEY and ADVICE_API_KEY;
 * - every event is re-checked against CLIENT_EVENTS: an unknown event, an unknown property, or a
 *   value of the wrong shape drops that event. Nothing the client sends is forwarded as it came —
 *   the outgoing event is rebuilt field by field.
 *
 * An event whose user_id is not the signed-in user is DROPPED, not re-stamped. The SDK keeps its
 * own unsent queue in localStorage, and on a phone passed between canvassers that queue would
 * otherwise credit one volunteer's taps to the next — the outbox problem, in analytics.
 *
 * Two constraints the web side honours by construction (they are why the SDK was not used):
 * - one batch every 10 s at most. A 1 s flush in a busy door session would trip the 60/min
 *   per-user limit below and then retry into it.
 * - identify with `$set` only. `$identify` is accepted with `{ $set }` and nothing else, so a
 *   `$setOnce`/`$unset`/`$add` would drop the whole identify as `bad_props`.
 *
 * The answer is always 200 with an Amplitude-shaped body, including when the feature is off and
 * when events were dropped: a 4xx would make a client retry a batch that will never be accepted.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth } from '../auth/guard.js';
import { type OutgoingEvent, type Props } from '../lib/analytics.js';

const int = (max: number) => z.number().int().min(0).max(max);
const secs = z.number().min(0).max(7 * 24 * 3600);
const semver = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
/** Short machine identifiers set by code (a help topic key, an error code). Never free text. */
const ident = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

/** The route PATTERNS from web/src/App.tsx. A resolved path or a query string is never accepted. */
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
const route = z.enum(ROUTE_PATTERNS);
const breakpoint = z.enum(['phone', 'compact', 'tablet', 'desktop']);
const TABS = ['place', 'requests', 'map', 'pickup', 'follow-ups', 'activity', 'unreachable', 'coverage'] as const;
const queueKind = z.enum(['contact', 'sign', 'voter_contact', 'other']);
const platform = z.enum(['chromium', 'ios', 'other']);

const none = z.object({}).strict();

/**
 * Every event the browser may send, and exactly the properties each may carry.
 * Adding one here is the deliberate step; the web side cannot send what is not listed.
 */
export const CLIENT_EVENTS = {
  screen_viewed: z.object({ route, breakpoint, tab: z.enum(TABS).optional() }).strict(),

  door_opened: z.object({ variant: z.enum(['sheet', 'pane']), order: z.enum(['nearest', 'list']), position: int(5000) }).strict(),
  door_form_abandoned: z.object({ fields_touched: int(50), seconds_open: secs }).strict(),
  door_order_toggled: z.object({ to: z.enum(['nearest', 'list']) }).strict(),

  write_queued: z.object({ kind: queueKind }).strict(),
  queue_flushed: z.object({ n_sent: int(10_000), n_failed: int(10_000), oldest_age_s: secs }).strict(),
  queue_entry_parked: z.object({ kind: queueKind, attempts: int(1000), last_status: int(599) }).strict(),
  storage_not_durable: none,
  turf_cache_fallback_used: z.object({ age_s: secs }).strict(),
  saved_data_cleared: z.object({ n_turfs: int(10_000), n_photos: int(10_000) }).strict(),
  sign_out_blocked_by_queue: z.object({ n_pending: int(10_000), n_photos: int(10_000), proceeded: z.boolean() }).strict(),

  sign_photo_captured: z.object({ size: z.enum(['<250KB', '250KB-1MB', '1-4MB', '4MB+']), downscaled: z.boolean() }).strict(),
  sign_photo_queue_failed: z.object({ reason: z.enum(['413', '400', '404', 'network', 'other']) }).strict(),

  install_prompt_shown: z.object({ platform }).strict(),
  install_prompt_dismissed: z.object({ platform }).strict(),
  app_installed: z.object({ platform }).strict(),
  app_updated: z.object({ from_version: semver, to_version: semver }).strict(),

  drive_started: none,
  drive_ended: z.object({ minutes: z.number().min(0).max(24 * 60), doors_announced: int(10_000), doors_recorded: int(10_000), had_heading: z.boolean() }).strict(),
  // Only the side of the road. The spoken text is never sent, for the reason it is never a name.
  drive_door_announced: z.object({ side: z.enum(['left', 'right', 'ahead']), fallback: z.boolean() }).strict(),
  drive_help_played: z.object({ first_use: z.boolean() }).strict(),
  help_opened: z.object({ topic: ident }).strict(),

  base_layer_changed: z.object({ layer: z.enum(['light', 'streets', 'satellite']) }).strict(),
  map_filter_applied: z.object({ filter: ident }).strict(),
  turf_drawn: z.object({ vertices: int(1000), n_doors: int(20_000) }).strict(),
  turf_sheet_printed: z.object({ n_doors: int(20_000) }).strict(),
  voice_changed: z.object({ kind: z.enum(['local', 'online', 'none']) }).strict(),

  // The ApiError code, never its message: messages can quote what the user typed.
  error_encountered: z.object({ code: ident, status: int(599), route }).strict(),
  door_list_loaded: z.object({ ms: int(600_000), n_doors: int(20_000), from_cache: z.boolean() }).strict(),
} as const;

export type ClientEventName = keyof typeof CLIENT_EVENTS;

/** User properties the browser may $set. `role` is NOT here: the server stamps it from the session. */
const userProps = z
  .object({
    app_version: semver,
    installed: z.boolean(),
    breakpoint,
    pointer: z.enum(['coarse', 'fine']),
    voice_kind: z.enum(['local', 'online', 'none']),
    turfs_assigned: int(1000),
  })
  .partial()
  .strict();
const identify = z.object({ $set: userProps }).strict();

// Device fields the tracker fills in. Bounded and character-limited so none of them can carry text.
const token = (max: number) => z.string().regex(/^[A-Za-z0-9 ._()/-]+$/).max(max);
const envelope = z.object({
  event_type: z.string().max(60),
  user_id: z.string().uuid().optional(),
  device_id: z.string().regex(/^[A-Za-z0-9._-]{5,100}$/).optional(),
  session_id: z.number().int().positive().optional(),
  time: z.number().int().positive().optional(),
  insert_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
  app_version: semver.optional(),
  platform: token(20).optional(),
  os_name: token(40).optional(),
  os_version: token(40).optional(),
  device_model: token(60).optional(),
  language: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
  event_properties: z.record(z.unknown()).optional(),
  user_properties: z.record(z.unknown()).optional(),
});

const body = z.object({ events: z.array(z.unknown()).max(500) });

/** Clock skew tolerance: an SDK-queued event may be days old (offline), never in the future. */
const MAX_FUTURE_MS = 10 * 60_000;
const MAX_AGE_MS = 7 * 24 * 3600_000;

export type DropReason = 'shape' | 'unknown_event' | 'bad_props' | 'other_user' | 'time';

/**
 * Validate one client event and rebuild it. Returns the outgoing event, or why it was dropped.
 * Exported for the unit tests; the route is a thin loop around it.
 */
export function rebuild(raw: unknown, sessionUserId: string, now = Date.now()): OutgoingEvent | DropReason {
  const env = envelope.safeParse(raw);
  if (!env.success) return 'shape';
  const e = env.data;
  if (e.user_id !== sessionUserId) return 'other_user';
  const time = e.time ?? now;
  if (time > now + MAX_FUTURE_MS || time < now - MAX_AGE_MS) return 'time';

  let event_properties: Props | undefined;
  let user_properties: Props | undefined;
  if (e.event_type === '$identify') {
    const p = identify.safeParse(e.user_properties ?? {});
    if (!p.success) return 'bad_props';
    user_properties = p.data.$set as Props;
  } else {
    const schema = (CLIENT_EVENTS as Record<string, z.ZodTypeAny>)[e.event_type];
    if (!schema) return 'unknown_event';
    const p = schema.safeParse(e.event_properties ?? {});
    if (!p.success) return 'bad_props';
    event_properties = p.data as Props;
  }

  const out: OutgoingEvent = {
    event_type: e.event_type,
    user_id: sessionUserId,
    time,
    insert_id: e.insert_id ?? `${sessionUserId}:${e.device_id ?? 'nodevice'}:${time}:${e.event_type}`,
  };
  if (e.device_id) out.device_id = e.device_id;
  if (e.session_id) out.session_id = e.session_id;
  if (e.app_version) out.app_version = e.app_version;
  if (e.platform) out.platform = e.platform;
  if (e.os_name) out.os_name = e.os_name;
  if (e.os_version) out.os_version = e.os_version;
  if (e.device_model) out.device_model = e.device_model;
  if (e.language) out.language = e.language;
  if (event_properties && Object.keys(event_properties).length > 0) out.event_properties = event_properties;
  if (user_properties && Object.keys(user_properties).length > 0) out.user_properties = user_properties;
  return out;
}

const accepted = (n: number, bytes: number) => ({
  code: 200,
  events_ingested: n,
  payload_size_bytes: bytes,
  server_upload_time: Date.now(),
});

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/analytics/events',
    {
      preHandler: requireAuth,
      config: {
        // The SDK flushes every ~10 s; this is several times that, per user (a team shares a NAT).
        rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.session?.user.id ?? req.ip },
      },
    },
    async (req) => {
      const me = currentSession(req).user;
      const bytes = Number(req.headers['content-length'] ?? 0);
      const sink = app.analytics;
      if (!sink) return accepted(0, bytes);

      const parsed = body.safeParse(req.body);
      if (!parsed.success) return accepted(0, bytes);

      const kept: OutgoingEvent[] = [];
      const dropped: Partial<Record<DropReason, number>> = {};
      for (const raw of parsed.data.events) {
        const r = rebuild(raw, me.id);
        if (typeof r === 'string') dropped[r] = (dropped[r] ?? 0) + 1;
        else kept.push(r);
      }
      // A dropped event is a client bug or a passed phone, never a reason to fail the request.
      // Counts only in the log: the event itself may be exactly what must not be written down.
      if (Object.keys(dropped).length > 0) req.log.info({ dropped }, 'analytics: events dropped at the relay');
      if (kept.length > 0) sink.enqueue(...kept);
      return accepted(kept.length, bytes);
    },
  );
};
