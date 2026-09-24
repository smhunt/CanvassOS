# Instrumenting CanvassOS with Amplitude — research and plan

Status: **research only, nothing built.** Written 2026-09-24, 32 days before election day.

## 1. The constraint that decides the design

Amplitude is a third party. Under MEA s. 23(8), putting a row of the voters list into it counts as
the list being "provided to another person", which is the same rule behind `streetview.ts` (only
two coordinates leave the server) and `advice.ts` (counts only, re-checked before sending). A
**default** Amplitude install would break that rule on day one. It would not take a bug, only the
defaults:

| Default SDK behaviour | What it would send from this app |
|---|---|
| `autocapture.pageViews` sends the full URL | `/signs?tab=place&household=H-…&address=<street address>` (`SignRequestsPanel.tsx:125`, `HouseholdActions.tsx:186`, `SignsMap.tsx:264`), `/map?household=H-…` (a key into the list), and `/invite/<raw token>`, which the API hashes precisely so that it is stored nowhere |
| `autocapture.elementInteractions` / `frustrationInteractions` record `[Amplitude] Element Text` | A tap on a `DoorRow` sends a name and an address |
| `autocapture.formInteractions` | Door form, consent form, `/subscribe` |
| Session Replay (the website project already runs it) | A video of the door list: names, addresses, support levels |
| `autocapture.networkTracking` | Failed `/api/*` URLs with household ids in the path |
| IP collection / geo lookup | Every volunteer's location, down to the door they are standing at |
| Guides & Surveys | Third-party script running on pages that show list data |

So everything below starts from **`autocapture: false`, no Session Replay, no Guides & Surveys**,
and uses an allow-list rather than a deny-list, enforced at one point. That is the same shape as
`serialize.ts` and `AdviceInput`.

### What may be sent, and what may not

**Never sent:** household id, voter id, `natural_key`, name, address or any part of one, phone,
email, lat/lon, GPS accuracy, search text, typed notes, `issues`, `support` / `supports`,
`needs_ride` (it implies mobility or health), sign-photo anything, invite tokens, resolved URLs,
error `message` strings (send the `code` only), `audit_log.detail` passed through as-is, the
volunteer's email or name, IP.

**Allowed:** enumerated values (door `result`, role, route *pattern*, breakpoint, platform), counts,
durations, booleans about a door (`wants_sign`, `wants_volunteer`, `follow_up`, `has_note`), the
opaque `app_user.id` uuid, turf uuid, ward / community (aggregates published by the municipality),
app version.

**`support` and `issues` are excluded by default.** They record a political opinion held at a door.
With turf + timestamp + volunteer, anyone holding the campaign database could re-identify the door.
The campaign already aggregates them in Postgres (the reachability report, the stats page), so
Amplitude adds nothing there that is worth the exposure.

## 2. Where the data goes: a new project

The org's only project, `default` (id 665054, org `ecoworks-525911`, **Starter** plan, 2M events/mo),
**belongs to the public campaign website.** It holds `donate_opened`, `listen_*`, `vote_plan_*`,
`signup_submitted`, and so on, with full autocapture and Session Replay turned on. CanvassOS must
not share it:

- One project means one set of project-level settings. Leaving replay/autocapture on there, or a
  teammate switching it back on, would reach this app.
- The website's visitors are the public, while CanvassOS users are campaign staff. Mixing them
  corrupts both user counts.
- A post-election purge (§8) should delete one whole project, not pick rows out of a shared one.

**Default: create `CanvassOS (prod)`.** Add a separate `CanvassOS (dev)` if the plan allows a second
project; otherwise dev and demo send nothing (no key = off). If Starter caps the org at one project,
the fallback is to keep everything off rather than share `default`.

**Data residency:** Amplitude offers US (default) or EU. There is no Canadian region. EU
(`api.eu.amplitude.com`) is the more protective choice, but the region is fixed when the org is
created, and this org already exists as US. Moving means a new org, which is a decision for the
campaign, not a code change.

**Naming:** snake_case `object_verb`, e.g. `door_result_recorded`. This matches the website
project's convention (`signup_submitted`, `reminder_subscribed`), so one person can read both.
Amplitude's own guide prefers Title Case, but it also says consistency wins.

## 3. Architecture: a first-party relay

```
browser ── @amplitude/analytics-browser (autocapture:false, serverUrl=/api/analytics/events)
             │  same-origin POST, session cookie
             ▼
        api  POST /api/analytics/events
             ├─ requireAuth
             ├─ zod: event_type ∈ catalogue, props strict per event (unknown key → drop event)
             ├─ user_id := session user (a queued event under another user is dropped)
             ├─ strip ip / location / [Amplitude] Page URL / library-added fields
             ├─ assertNoPersonalData(payload)   ← same idea as advice.ts
             └─ forward(events)  ──────────────┐
        api  audit() → AUDIT_EVENTS map ───────┤  server-side events, same forward()
                                               ▼
                               app.httpFetch → https://api2.amplitude.com/2/httpapi
                               (off unless AMPLITUDE_API_KEY is set)
```

Why the relay rather than the SDK talking to Amplitude directly:

1. **One enforcement point.** Client and server events both go through `forward()`. The codebase
   explicitly avoids "a second implementation that drifts".
2. **The volunteer's IP never reaches Amplitude.** The API is the uploader and sends no `ip`.
   Amplitude's HTTP v2 docs say it geolocates only when `ip` is given or set to `$remote`. Verify
   this with one test event before trusting it (check `city` on the user in User Lookup).
3. **The key stays server-side**, like `STREETVIEW_API_KEY`. The browser SDK needs *some* key
   string; give it a placeholder, which the relay ignores.
4. **No new third-party origin in the browser.** Ad-blockers don't break it, the Referer carries
   nothing, and `Referrer-Policy: no-referrer` stays meaningful.
5. **Tests stub `app.httpFetch`**, so no test ever makes a billed call. Same as the other two
   outbound integrations.
6. **Off by default:** no `AMPLITUDE_API_KEY` means the relay answers `204` and discards. That keeps
   the demo stack and local dev silent without extra code.

Why keep the browser SDK at all: it provides device_id, session_id, batching, retry with backoff
and a persistent queue across reloads, and a field app on LTE needs all of that. A hand-rolled
~80-line tracker (`sendBeacon` on `pagehide` plus an in-memory batch) is a workable alternative if
bundle size matters. It would lose events that were queued offline, which the server-side events
in §5 mostly make up for.

### Browser SDK configuration

```ts
// web/src/analytics/index.ts — lazy-imported from inside RequireAuth only
init('relay', undefined /* userId set explicitly below */, {
  serverUrl: '/api/analytics/events',
  autocapture: false,              // every sub-option off: pageViews, sessions, attribution,
                                   // formInteractions, fileDownloads, elementInteractions,
                                   // frustrationInteractions, networkTracking, webVitals
  trackingOptions: { ipAddress: false, language: true, platform: true },
  identityStorage: 'localStorage',   // no cookie; see §7 on the localStorage rule
  appVersion: APP_VERSION,           // from components/changelog-modal.tsx
  flushIntervalMillis: 10_000,
  minIdLength: 1,
  optOut: prefs.analyticsOff === true,
});
setUserId(me.id);   // opaque uuid, never the email
```

- **Where it runs:** only inside `RequireAuth`. It never runs on `/login`, `/invite/:token` or
  `/subscribe`, the same rule `pwa.ts` follows for the install banner.
- **Sign-out:** `SignOutButton.tsx` calls `analytics.reset()` after the logout succeeds. This is
  the same passed-phone problem as the outbox. The SDK's own unsent queue can also outlive a
  sign-out, which is why the relay **drops any event whose `user_id` ≠ the session user** instead
  of re-stamping it.
- **The public `/subscribe` page is not instrumented.** Its visitors are the public, and the
  website project already covers their funnel.

### The typed `track()` wrapper

This follows the `AdviceInput` pattern: the property types cannot hold a row.

```ts
type Props = Record<string, string | number | boolean>;   // no objects, no arrays
type Catalogue = {
  screen_viewed: { route: RoutePattern; breakpoint: Breakpoint };
  door_result_recorded: { result: ContactResult; via: 'online' | 'queued'; n_named: number;
                          wants_sign: boolean; wants_volunteer: boolean; follow_up: boolean;
                          has_note: boolean };
  // …one entry per event in §5
};
export function track<E extends keyof Catalogue>(event: E, props: Catalogue[E]): void;
```

`RoutePattern` is the union of the literal route strings in `App.tsx` (`'/canvass/:turfId'`, and so
on). Page views are tracked **manually** from a `useLocation` effect that matches the location
against those patterns and sends only the pattern. The resolved path and query are never read.

The server keeps the same catalogue as zod schemas. If the two disagree, the server wins and the
event is dropped and counted in a log line. A client bug therefore loses an event rather than
leaking one.

## 4. User properties

| Property | Values | Why |
|---|---|---|
| `role` | admin / organizer / volunteer | The main segment for every chart |
| `app_version` | `1.5.0` | Is anyone still on an old service worker? |
| `installed` | bool (`display-mode: standalone`) | PWA adoption |
| `breakpoint` | phone / compact / tablet / desktop | From `styles.css`'s four stops, never a pixel width |
| `pointer` | coarse / fine | Density rules key on this, not width |
| `voice_kind` | local / online / none | Online voices send text to a third party; worth knowing the share |
| `turfs_assigned` | number | Scale of each volunteer's load |

No group analytics: it is a paid add-on and there is only one "account".

## 5. Event catalogue

Two sources. **Server** events are derived in `audit()`, which already fires for every meaningful
action. **Client** events are UI that has no endpoint: offline, PWA, drive mode, layout.

### 5a. Server: derived from `AuditAction`

Add an exhaustive map in `api/src/lib/analytics.ts`:

```ts
export const AUDIT_EVENTS: Record<AuditAction, null | ((d: AuditDetail) => ServerEvent)> = { … };
```

Because it is a `Record` over the union, **adding a new `AuditAction` fails to compile until someone
decides its analytics mapping**, even if that decision is `null`. Each mapper picks keys out of
`detail` and never spreads it. `audit()` calls `forward()` after the insert, fire-and-forget, and
failures are logged, never thrown (the audit rule).

| Area | AuditAction → event | Properties (allow-list) |
|---|---|---|
| Auth | `login` → `session_signed_in`; `login_failed` → `sign_in_failed`; `logout` → `session_signed_out`; `accept_invite` → `invite_accepted`; `change_password` → `password_changed` | role; failure reason code |
| Users | `invite`/`reinvite` → `user_invited`; `update_user` → `user_updated` | invitee role, fields_changed (names only) |
| Canvass | `contact` → `door_result_recorded` | result, n_named, wants_sign, wants_volunteer, follow_up, has_note, `replayed` (a 200 idempotent replay), `queue_delay_s` (server time − the door's `at`). **Event `time` = the door's `at`**, so offline doors land when they were knocked, not when they synced |
| | `view_turf_doors` → `turf_opened` | turf_id, n_doors, n_done |
| | `view_household` → `household_viewed` | surface (map / door / search) |
| | `view_follow_ups` → `follow_ups_viewed` | n |
| Turfs | `preview_turf` → `turf_previewed`; `create_turf` → `turf_created`; `update_turf`/`delete_turf`; `assign_turf`/`unassign_turf`/`update_assignment` → `turf_assigned` / `turf_unassigned` / `assignment_updated` | method (streets / polygon), n_doors, status |
| Search | `search` → `search_performed` | n_results, query_length. **Never the query** |
| Signs | `place_sign` → `sign_placed`; `update_sign` → `sign_updated`; `delete_sign`; `upload_sign_photo` → `sign_photo_uploaded`; `view_sign_photo`; `view_sign_requests` | status, source (door / public / manual), has_gps, `accuracy_bucket` (<10 m, <50 m, worse), photo bytes bucket |
| Requests | `public_request` → `public_request_received` (no user: `device_id: 'server'`); `create/update/delete_manual_request`; `handle_public_request` → `sign_request_handled` | source, kind, outcome |
| Voter contact | `collect_voter_contact` → `doorstep_contact_collected`; `withdraw_voter_contact` → `consent_withdrawn`; `update_…`/`delete_…`; `view_voter_contacts`, `view_gotv_list` | purposes (enum list as a joined string), channel (sms / email). **Never the value** |
| Messaging | `create/update/approve/send/pause/resume/cancel_campaign` → `campaign_*`; `test_send` → `campaign_test_sent`; `inbound_stop` → `sms_stop_received`; `inbound_join` | channel, audience_size, n_sent, n_failed, provider (log / twilio) |
| Subscriber link | `subscriber_sync`, `suggest_match`, `auto_accept_match`, `decide_match`, `apply_match_ledger` | counts, decision |
| Reports | `view_reachability` → `report_viewed` (report: reachability) | advice_enabled |
| Street View | `view_streetview` → `streetview_viewed` | outcome (image / no_imagery / disabled) |
| Ops | `import` → `list_imported`; `export` | mode (full / diff / apply), counts |

The drip scheduler and the messaging provider callbacks send delivery outcomes
(`message_delivered`, `message_failed` with the provider's error code) from their own call sites
through the same `forward()`.

### 5b. Client: no endpoint behind them

| Area | Event | Properties | Where |
|---|---|---|---|
| Navigation | `screen_viewed` | route (pattern), breakpoint | `useLocation` effect in `App.tsx` |
| Door screen | `door_opened` | variant (sheet / pane), order (nearest / list), position_in_list | `DoorSheet.tsx` |
| | `door_form_abandoned` | fields_touched (count), seconds_open | `RecordVisit.tsx` unmount without submit |
| | `door_order_toggled` | to | `DoorScreen.tsx` |
| Offline | `write_queued` | kind (contact / sign / voter_contact) | `outbox.ts` `submitOrQueue` |
| | `queue_flushed` | n_sent, n_failed, oldest_age_s | `outbox.ts` `flush` |
| | `queue_entry_parked` | kind, attempts (20), last_status | `outbox.ts` |
| | `storage_not_durable` | — | `db.ts` when `durable === false` (the in-memory fallback). **Crucial: those doors die with the tab** |
| | `turf_cache_fallback_used` | age_s | `useDoors` |
| | `saved_data_cleared` | n_turfs, n_photos | the clear button |
| | `sign_out_blocked_by_queue` | n_pending, n_photos, proceeded | `SignOutButton.tsx` |
| Photos | `sign_photo_captured` | bytes_bucket, downscaled | `PhotoCapture.tsx` |
| | `sign_photo_queue_failed` | reason (413 / 400 / 404 / network) | `photoQueue.ts` |
| PWA | `install_prompt_shown` / `app_installed` / `install_prompt_dismissed` | platform (chromium / ios) | `pwa.ts` |
| | `app_updated` | from_version, to_version | new service worker takes control |
| Drive mode | `drive_started` / `drive_ended` | minutes, doors_announced, doors_recorded, had_heading | `DrivePage.tsx` |
| | `drive_door_announced` | side (left / right / ahead), fallback (bool: no heading) | `DrivePage.tsx`. **Only the side.** The spoken text is never sent |
| | `drive_help_played` | first_use | `driveHelp.ts` / `HelpButton.tsx` |
| Help | `help_opened` | topic (the topic key from `help/route.ts`) | `HelpButton.tsx` |
| Map | `base_layer_changed` | layer | `MapView.tsx` |
| | `map_filter_applied` | filter (result / ward / signs…) | `FiltersDrawer.tsx` |
| | `turf_drawn` | vertices, n_doors_preview | `DrawPolygon.tsx` |
| Turf sheet | `turf_sheet_printed` | n_doors | `window.onbeforeprint` in `TurfSheetPage` |
| Settings | `voice_changed` | kind (local / online) | `VoiceSettings.tsx` |
| Errors | `error_encountered` | code (ApiError code), status, route (pattern) | `api/client.ts`. **Code only, never message** |
| Performance | `door_list_loaded` | ms, n_doors, from_cache | `useDoors` |

This is about 30 client events and about 45 server events. At roughly 50 users × 300 events a day
× 32 days, that is about 0.5M events: a quarter of the Starter quota.

## 6. Questions this answers that Postgres can't

Postgres already knows *what* happened at every door, so Amplitude is not needed for that. Its
value is the part the database never sees:

- **Is the offline layer losing doors?** Rates of `storage_not_durable`, `queue_entry_parked`,
  `sign_out_blocked_by_queue` (proceeded = true), and the `queue_delay_s` distribution.
- **Where volunteers stall:** the funnel `turf_opened → door_opened → door_result_recorded`,
  `door_form_abandoned` by field count, and time per door by breakpoint.
- **Is drive mode worth it?** Doors recorded per drive-minute vs. walking, and how often it falls
  back without a heading.
- **Adoption:** installed share, stale `app_version` share after a deploy (the `/sw.js` cache
  landmine, measured), and voice kind.
- **Errors in the field**, which never reach the office Mac's logs because the request never
  arrived.

## 7. Changes the docs contract requires

Enabling this changes several statements that the repo says must stay true:

- **CLAUDE.md and `docs/README.md`** both say "the server makes exactly **two** outbound calls".
  This makes three. Update both, plus the architecture diagram, and add a landmine paragraph:
  *the analytics allow-list; never enable autocapture/replay; the relay drops cross-user events;
  new AuditActions must be mapped.*
- **`localStorage` is "for UI preferences only".** The SDK stores its device id, session and unsent
  queue there (`AMP_*` keys). Queued events hold only allow-listed props, but the rule needs a
  written exception, and **"Clear saved turf data" should also clear `AMP_*`**.
- **`API.md`:** `POST /api/analytics/events` (auth, body, 204 when off) and the env vars
  `AMPLITUDE_API_KEY` and `AMPLITUDE_SERVER_ZONE`.
- **`README.md`:** env, "off by default", and how to create the project.
- **`prompt_plan.md`**, `CHANGELOG.md`, and `changelog-modal.tsx`: add a "How It Works" line telling
  volunteers what is collected, with an opt-out toggle under Account (`optOut`).
- **Tests** (`api/test/api.test.ts`): the relay drops unknown events, unknown props, and a
  mismatched user; an outgoing-body test in the style of the advice suite that asserts **no real
  elector name, address or household id** from the loaded DB appears in anything `forward()`
  sends while the suite runs; and each `AUDIT_EVENTS` mapper is fed a realistic `detail` and
  checked against the allow-list.
- **CSP:** `helmet` has `contentSecurityPolicy: false` and Caddy sets none. The relay keeps it that
  way: no new `connect-src`.

## 8. After the election

`make purge` cannot reach Amplitude. Add a step to the purge checklist: **delete the CanvassOS
project** (Settings → Projects), or use the User Privacy API per `user_id` if the project is to be
kept. Nothing in it is list data if §1 held, but the volunteers' activity is still personal
information about *them*.

## 9. Phasing against 2026-10-26

The repo's own rule applies: *"too much risk this close to the election."*

- **Phase A (about 1 day, low risk):** the relay endpoint, `forward()`, the `AUDIT_EVENTS` map
  (server only, no browser change), and the outgoing-body test. This covers every door, sign,
  consent and message event with correct timestamps, and touches no client code the canvassers
  run.
- **Phase B (about 1 day):** the browser SDK behind `RequireAuth`, `screen_viewed`, and the offline
  and PWA events (the §6 "are we losing doors" set), sign-out `reset()`, the opt-out toggle, and the
  docs in §7.
- **Phase C (optional, after an earlier deploy has soaked):** drive mode, map, help, performance
  events, and dashboards (funnel, offline health, adoption).

Before any of it ships: create the project, send one test event through the relay, and confirm in
User Lookup that it has no IP or city and no property outside the catalogue.

## Sources

- Amplitude Browser SDK 2 (`@amplitude/analytics-browser`): autocapture sub-options,
  `trackingOptions`, `serverUrl`, `identityStorage`, `optOut`.
  <https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2>
- HTTP V2 API: `ip` / `$remote`, `time`, `insert_id` (7-day dedupe), `session_id`, EU endpoint.
  <https://amplitude.com/docs/apis/analytics/http-v2>
- Node SDK (`@amplitude/analytics-node`): not needed if `forward()` posts to HTTP v2 directly
  through `app.httpFetch`, which is what keeps it stubbable.
  <https://amplitude.com/docs/sdks/analytics/node/node-js-sdk>
- Org and project state read through the Amplitude MCP on 2026-09-24. Read-only; nothing was
  written to Amplitude.
