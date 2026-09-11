# Phase 7 — Event hooks and notifications

Draft plan, 2026-09-11. Election day is **26 October 2026 — 45 days out.**

Nothing here is built. `prompt_plan.md` §"Requested, not yet built — 2026-09-06" is the request; this
is the design that answers it.

The ask is small and the trap underneath it is not. The ask: a volunteer should learn that a turf was
given to them without having to open the app and go looking, and an organiser should learn that a
door was flagged for follow-up or a sign was asked for. The trap: the moment the stack can push a
string to somebody's phone, it has a second way for the voters list to leave the building — one that
does not go through `serialize.ts`, does not go through `scope.ts`, and ends up on a lock screen that
`make purge` cannot reach. Sections 1 and 4 exist to close that.

---

## 1. The event hooks

### 1.1 What already exists

`assign_turf` is already an event. `api/src/routes/turfs.ts` writes an `audit_log` row at the moment
a turf changes hands, and `unassign_turf` next to it; `contacts.ts` writes a `contact` row that knows
whether `follow_up` was ticked, and inserts a `sign` row with status `requested` when `wants_sign`
was. Every event this phase needs already happens. **Nothing listens.**

So the work is not "detect assignments". It is "give the detection a second subscriber besides the
audit log".

### 1.2 The emitter

A new `api/src/lib/events.ts`: a typed, in-process emitter, decorated onto the app as `app.events` in
`buildApp()` alongside `app.httpFetch`, so tests can swap it for a recorder and assert what was
emitted without a push provider anywhere in the picture.

```ts
export type CanvassEvent =
  | { type: 'turf.assigned';      turf_id: string; turf_name: string; user_id: string; actor_id: string; due_date: string | null }
  | { type: 'turf.unassigned';    turf_id: string; turf_name: string; user_id: string; actor_id: string }
  | { type: 'door.follow_up';     household_id: string; contact_id: string; turf_id: string | null; actor_id: string }
  | { type: 'sign.requested';     household_id: string; sign_id: string; actor_id: string }
  | { type: 'campaign.finished';  campaign_id: string; campaign_name: string; sent: number; failed: number; skipped: number }
  | { type: 'campaign.failed';    campaign_id: string; campaign_name: string; reason: string; sent: number; remaining: number };
```

Deliberately not an `EventEmitter` subclass with string topics: the union is the contract, and a
`switch` over `type` is exhaustively checked by `tsc`, so adding a seventh event that no listener
handles is a compile error rather than a silence in the field.

**Call sites** (one line each, immediately after the existing `audit()` call, inside the same `if`
that guards the audit — a replay that is not re-audited is not re-notified either):

| Event | File | Where |
|---|---|---|
| `turf.assigned` | `api/src/routes/turfs.ts` | after the `assign_turf` audit, inside `if (inserted)` |
| `turf.unassigned` | `api/src/routes/turfs.ts` | after the `unassign_turf` audit, inside `if (row)` |
| `door.follow_up` | `api/src/routes/contacts.ts` | once per door when `body.follow_up`, **not** once per named voter |
| `sign.requested` | `api/src/routes/contacts.ts` | in the `wants_sign` branch, only when the insert actually created a row |
| `campaign.finished` | `api/src/messaging/worker.ts` | where a campaign is moved to `'done'` and `finished_at` set |
| `campaign.failed` | `api/src/messaging/worker.ts` | where the drip gives up — a provider auth failure or the send pool exhausted |

`emit()` is fire-and-forget and every listener runs inside its own `try/catch`: **a notification that
cannot be produced never becomes a 500 at the door.** That is the same rule `audit()` already
follows, and for the same reason — a volunteer standing on a porch with one bar of signal must not
see a failed submission because a push endpoint was slow.

`emit()` is also *not* awaited inside the contact transaction. The door knock is the record that
matters; the nudge is a courtesy.

### 1.3 The rule that makes this safe: **an event payload carries ids, never list data**

Every field in the union above is a uuid, an integer, a nullable date, or a campaign-authored label
(`turf_name` — typed by an organiser; `campaign_name` — likewise). **There is no field that can hold
an elector's name, an address, a phone number, or a canvasser's free-text note**, and that is not an
accident of the current shape, it is the invariant:

> A notification is a *pointer*. It says "something happened, here is its id". The recipient follows
> the pointer back into the API and reads the thing through the same `serialize.ts` allow-list and
> the same `assertTurfAccess` as every other read. A notification must never be a shortcut that
> delivers content the recipient's role would not have been given.

Three enforcement points, in ascending order of paranoia, mirroring `advice.ts`:

1. **The type.** `CanvassEvent` has no field that could carry a row. Widening it is a visible diff.
2. **`assertPayloadIsReferences(event)`** — a runtime re-check before the payload is persisted or
   sent, exactly like `assertNoPersonalData()` in `api/src/lib/advice.ts`. It walks the serialised
   object and rejects anything that is not a uuid, a number, a boolean, a null, an ISO timestamp, or
   a value on the per-event label allow-list. "The type says it is safe" stops being true the day
   someone widens the type.
3. **A test.** `api/test/api.test.ts` asserts the emitted payloads against real elector names and
   addresses drawn from the loaded database, the same way the advice test asserts the outgoing
   Anthropic body. Keep that test; it is what makes the invariant load-bearing rather than aspirational.

The consequence worth stating plainly: **`door.follow_up` does not say who was rude.** It says
"household `…`, contact `…`, in turf `…`". The organiser taps it and the door screen loads the note
under the rules that already govern the door screen. A volunteer who is notified about a turf they
were then unassigned from gets a `403 not_your_turf` when they tap — which is correct, and is why the
pointer design is better than the payload design even ignoring the legal argument.

---

## 2. Delivery

### 2.1 Web Push, and why it is the right channel

Campaign workers, not electors. They have accounts, they signed in, and a notification about their
own turf is not a commercial electronic message — **CASL does not reach it**, which is the entire
reason this is a different problem from Phase 5. There is no provider to register with, no long-code
throttle, no per-message cost, and no consent ledger.

The prerequisite already shipped. Phase 3 put a real service worker in the build and an
add-to-home-screen path in `web/src/pwa.ts`, which matters because **iOS delivers web push only to an
installed PWA** (Safari 16.4+, home-screen app, `display: standalone`). `pwa.ts` already detects iOS
and already shows written install instructions there, because `beforeinstallprompt` never fires on
Safari. So the iOS story is: install first, then offer notifications — and the code that knows
whether the app is installed (`navigator.standalone`) already exists in that file.

### 2.2 VAPID

Three new optional env vars in `api/src/config.ts`, using the existing `optionalSecret()` helper so a
blank value in `.env` is treated as absent (see the header comment in that file — a blank optional
secret once took the whole API down):

```
VAPID_PUBLIC_KEY   # base64url P-256 public key — the only one that reaches the browser
VAPID_PRIVATE_KEY  # never leaves the server
VAPID_SUBJECT      # mailto: address the push service contacts about abuse
```

**No key configured = the whole feature is off**, answered before the database is touched, exactly as
`STREETVIEW_API_KEY` and `ADVICE_API_KEY` behave. The in-app bell (§5, phase 7a) still works; only
the phone buzz is lost. A campaign is entitled to decide it would rather not.

Generated once with `npx web-push generate-vapid-keys` and stored in `.env` (git-ignored). They are
not rotated casually: rotating invalidates every stored subscription, and every volunteer has to
re-enable notifications.

The public key is served by `GET /api/meta` rather than baked into the bundle, so rotating it does
not require a rebuild of the SPA and a redeploy of the `web` build-only container.

**Dependency.** Encrypting a Web Push payload is ECDH P-256 + HKDF + AES128GCM plus a signed JWT —
all of it available in `node:crypto`, all of it about 150 lines of exacting code where a mistake is
silent. This is one of the few places where the no-dependency habit is the wrong call: take
`web-push` (single package, no transitive sprawl, long-standing). Wrap it in
`api/src/lib/push.ts` so exactly one file imports it, the way `streetview.ts` is the only file that
knows about Google.

### 2.3 The service worker

`web/vite.config.ts` generates `sw.js` at build time from an inline plugin (`appShellServiceWorker`,
~40 lines, no workbox). Two handlers get appended to that generated `source` string:

```js
self.addEventListener('push', (event) => {
  // No payload = nothing to show. Never invent a body: a push with an unreadable payload is a bug,
  // and "You have a new notification" trains people to ignore the ones that matter.
  if (!event.data) return;
  let n; try { n = event.data.json(); } catch { return; }
  event.waitUntil(self.registration.showNotification(n.title, {
    body: n.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Collapses repeats: a second "turf assigned" for the same turf replaces the first rather
    // than stacking. The tag is the notification id's scope key, never anything identifying.
    tag: n.tag,
    data: { url: n.url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    // Focus the already-open app rather than opening a second copy, which on a phone means the
    // volunteer loses their place in the door list.
    for (const c of cs) if (c.url.includes(self.location.origin)) return c.focus().then(() => c.navigate(url));
    return self.clients.openWindow(url);
  }));
});
```

Two gotchas that will cost an afternoon if they are not written down:

- **The plugin is `apply: 'build'`.** There is no service worker in `npm run dev`, so push cannot be
  tested at `https://dev.ecoworks.ca:3030`. Test against `npm run build && npm run preview` (4173),
  which is already how `web/tools/e2e.py` runs.
- **The precache list must not gain `sw.js`.** It is already filtered out; adding the handlers does
  not change that, but the cache-name hash is derived from the asset list, so a handler-only change
  does *not* bump the cache name. That is fine (the shell did not change) but it means an old SW
  stays active until `skipWaiting` runs on the next asset change. Bump a constant in the source
  string if a push fix needs to land on its own.

### 2.4 Permission prompting

**Never on load.** A permission prompt fired at page load is denied, and a denial is sticky — iOS
gives no second chance without the user digging through Settings. So: a "Turn on notifications"
button in Settings, next to "Clear saved turf data", and `Notification.requestPermission()` called
directly inside its click handler (iOS requires a user gesture; Chrome merely prefers one).

The button's four states, all of which a volunteer will hit:

| State | What the button says |
|---|---|
| iOS, not installed | "Add this to your home screen first" + the instructions `pwa.ts` already renders |
| `Notification.permission === 'default'` | "Turn on notifications" |
| `'granted'`, subscription stored | "Notifications are on — turn off" (unsubscribes *and* deletes the row) |
| `'denied'` | "Blocked by your phone" + where to change it. Do not re-prompt; you cannot. |

On grant: `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, then
`POST /api/push/subscriptions` with the endpoint and keys. `userVisibleOnly` is mandatory in Chrome
and is also the right promise to make — this stack has no business running code on someone's phone
without showing them why.

### 2.5 Email fallback — an option, not phase 7

`app_user` has an email address, and the campaign already has an email sender in
`api/src/messaging/provider.ts`. So the fallback is cheap to add: if a user has no working push
subscription and the event is one of a small "important enough to email" set (turf assigned, campaign
failed), send one plain email instead.

Two rules if it is ever built:

1. **It must not touch the Phase 5 tables.** `message_campaign` / `message_send` are the *elector
   consent ledger*; a worker notification written there corrupts audience counts, delivery stats and
   the CASL story in one move. Separate code path, separate rows.
2. **The email body follows the same pointer rule as the push body.** "A door on your turf needs
   follow-up — open the app" and a link. Not the note. Email is stored on a third party's server
   indefinitely and forwarded by people who mean well.

Quiet hours (`api/src/lib/quiet-hours.ts`) do not legally apply to campaign workers, but a 06:00 buzz
about a lawn sign costs goodwill. Reuse the module for the two organiser-nudge kinds; assignment and
campaign-failure notifications go through immediately.

---

## 3. Storage

Shown here as it would appear in `db/migrations/006_notifications.sql`. **Do not create that file
from this document** — migration numbers are in flight and 003–005 are already taken by Phase 5;
check `make migrate-status` and take the next free number when this is actually built.

```sql
-- 006: in-app notifications and Web Push subscriptions.
--
-- A notification is a POINTER, not a copy. Its payload holds ids and campaign-authored labels only;
-- the recipient follows the id back into the API and reads the underlying row through serialize.ts
-- and assertTurfAccess like any other read. That is what keeps this table from becoming a second,
-- un-scoped, un-audited copy of the voters list (MEA s. 23(7)-(8)) — see docs/phase-7-notifications-plan.md §1.3.

CREATE TYPE notification_kind AS ENUM (
  'turf_assigned', 'turf_unassigned', 'door_follow_up',
  'sign_requested', 'campaign_finished', 'campaign_failed'
);

CREATE TABLE notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE: a deactivated user's pointers are worth nothing to anyone else.
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind        notification_kind NOT NULL,
  -- ids + labels ONLY. Enforced in the API by assertPayloadIsReferences(); the CHECK below is the
  -- cheap half of that, catching the obvious shapes at the database boundary.
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Who caused it. NULL for system events (a campaign finishing had no author at that moment).
  actor_id    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  -- Delivery is tracked so a phone that was off does not get an hour-old buzz on reconnect and so
  -- "it never arrived" is answerable. NULL = never pushed (feature off, or no subscription).
  pushed_at   timestamptz,
  -- Derived, never echoed — the same trick as contact.client_id. '<kind>:<subject id>:<user id>'
  -- collapses a double-assign into one row instead of two buzzes.
  dedupe_key  text UNIQUE,
  CONSTRAINT notification_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX notification_user_idx   ON notification(user_id, created_at DESC);
CREATE INDEX notification_unread_idx ON notification(user_id) WHERE read_at IS NULL;
-- Retention sweep (§4): a plain range delete wants this.
CREATE INDEX notification_age_idx    ON notification(created_at);

CREATE TABLE push_subscription (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- The push service's URL for this browser instance. UNIQUE because the same endpoint arriving
  -- again is the same phone re-registering, not a second device: upsert onto the current user.
  endpoint    text NOT NULL UNIQUE,
  -- Client-generated keys the payload is encrypted to. The server cannot read its own sent pushes
  -- back out of the push service with these; they only encrypt.
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  -- Enough to let a volunteer recognise "which phone is this?" in Settings. Truncated at insert;
  -- it is a device label, not telemetry.
  device_label text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  fail_count  int NOT NULL DEFAULT 0
);

CREATE INDEX push_subscription_user_idx ON push_subscription(user_id);
```

**Subscription hygiene.** A push service answers `404`/`410 Gone` when a subscription is dead (app
deleted, browser data cleared). That is a definite verdict, exactly like the photo queue's 404: delete
the row immediately. Any other failure increments `fail_count`; at 10 the row is deleted too, because
a permanently failing endpoint is just a slow way to log errors.

**No `notification_delivery` table.** One row per notification with a `pushed_at` stamp is enough;
a per-subscription delivery ledger is a reporting feature nobody asked for and one more thing to purge.

**Serialisation.** `serializeNotification` joins the existing allow-lists in
`api/src/lib/serialize.ts` — `{ id, kind, payload, created_at, read_at }` and nothing else, picked not
deleted. `actor_id` becomes an `actor_name` only for organiser-and-above, matching how
`serializeUserListRow` already treats identity.

**Routes**, all of them scoped to the caller and none of them able to read another user's list:

- `GET /api/notifications?unread=1` — mine only. `user_id = session.user.id` is not a filter the
  client can influence; there is no `user_id` query parameter to get wrong.
- `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`.
- `POST /api/push/subscriptions`, `DELETE /api/push/subscriptions` (by endpoint).
- `GET /api/meta` gains `vapid_public_key` (null when the feature is off).

New `AuditAction` members: `view_notifications`, `enable_push`, `disable_push`. Extending the union
in `api/src/lib/audit.ts` is the only way to add them — never a loose string.

---

## 4. The retention trap

`prompt_plan.md` flags it and it is the part of this phase that can actually do damage:

> A message between organisers **will** contain voters-list data. "The man at 297 George St was
> rude." That is a canvasser's note about a named elector sitting in a chat table.

Phase 7 as scoped here does not build messaging — but it builds the delivery path messaging would
use, and the rules have to be set now, while the tables are empty and free to shape.

**1. Notifications hold nothing original.** Every field is a pointer to a row that already exists
under the existing rules. So `notification` can be deleted wholesale at any time and the campaign
loses nothing but convenience. That property is the whole defence, and §1.3's three enforcement
points are what preserve it. The day someone adds a `note_excerpt` column "just for the preview", it
is gone.

**2. A retention window, swept automatically.** Notifications older than **60 days** are deleted by
the same interval loop that drives the messaging worker — not a cron the operator has to remember.
60 days outlives the campaign's useful memory of "did I tell Dana about that turf" and dies well
before the post-election purge. `make purge` already destroys the `pgdata` volume, so both new tables
go with everything else without a Makefile change; **verify that, do not assume it**, and add
`notification` / `push_subscription` to the purge checklist in `README.md` so a future
non-volume-based deployment does not quietly keep them.

**3. Reads are audited like any other read.** `GET /api/notifications` writes `view_notifications`.
It is a read of pointers rather than of rows, but the point of `audit_log` is that every look at the
system is on the record, and the same argument that audits `view_reachability` (aggregate counts
only) applies here with less effort.

**4. It is not an export side channel.** Three specific things:
   - No endpoint returns another user's notifications, at any role. An admin who wants to know what a
     volunteer was told reads `audit_log`, which is the artefact built for that question.
   - `serializeNotification` is an allow-list, so a widened SQL projection or a `RETURNING *` cannot
     leak a joined column. Same rule as everywhere else.
   - Notifications are **not** included in the Phase 4 CSV export, and the `export` audit action is
     not extended to cover them. If someone needs them out of the database they can take a backup,
     which is encrypted and already accounted for.

**5. The push body is the part `make purge` cannot reach, so it carries nothing.** A delivered
notification sits in iOS Notification Centre and in Android's shade; on macOS and Windows it is
*mirrored to the desktop* and may be read by anyone who walks past a locked phone. The campaign has
no ability to delete it after the fact. Therefore:
   - The push body is rendered from `api/src/lib/notification-templates.ts` using only the event's
     ids and labels. A door notification says *"A door on Glendon Drive North needs a follow-up"* —
     the turf's name, which the campaign wrote — and never the elector's name, house number or note.
   - Where even a turf name feels like too much on a lock screen, the template is a plain string in a
     file and an organiser can edit it down to "You have a new follow-up". That is exactly why the
     templates are plain strings rather than compiled into the code.
   - Settings' **"Clear saved turf data"** button gains a sibling that unsubscribes from push and
     calls `registration.getNotifications()` to dismiss anything still showing. That button exists
     because `make purge` cannot reach a phone; push adds a second thing on the phone it cannot
     reach, so it goes in the same place.

**6. When messaging does land (phase 8, not this one):** the message body is stored in its own table,
that table is in the purge checklist with a *shorter* retention window than notifications, a message
generates a `notification` whose payload is `{ thread_id, message_id, from_user_id }` and nothing
else, and the push body is **"New message from Dana"** — never the text. Same pointer rule, applied to
the case that actually contains list data.

---

## 5. Phasing

**7a — the bell. No push at all.** `events.ts`, the `notification` table, the six emit call sites,
`GET /api/notifications`, and an unread count in the app header that refetches on window focus
(TanStack Query already does this; no polling loop to write). This is the smallest thing that is
genuinely useful: a volunteer who opens the app sees "Ward 3 — Glendon was assigned to you" instead
of finding out at the Tuesday meeting. It is also the whole privacy surface, built and tested with no
third party involved. Ship it and leave it running for a week.

**7b — push, one event.** VAPID config, `push.ts`, `push_subscription`, the two SW handlers, the
Settings button, and `turf.assigned` **only**. One event proves the plumbing end-to-end on a real
iPhone and a real Android, including the install prerequisite, without a second kind's edge cases
muddying the diagnosis. Expect to spend the time on iOS, not on the server.

**7c — the organiser nudges.** `door.follow_up` and `sign.requested`, fanned out to organisers and
above. These need rate limiting in a way 7b does not: a canvasser working a street can flag six doors
in twenty minutes, and six buzzes is how an organiser turns notifications off for good. Coalesce on a
window (one notification per turf per 30 minutes, with a count) and route them through quiet hours.

**7d — campaign finished / failed.** Smallest audience — the campaign's `created_by` and
`approved_by` — and the highest value per message, because a Phase 5 send is a multi-hour drip that
fails *silently* by design. This is the one notification somebody genuinely needs at 11pm.

### What I would not build

- **Messages between users.** A real feature with a real design (threads, read state, the retention
  rules in §4.6). It shares the delivery path, which is the whole reason to build the path first, but
  it is phase 8 and it is not small.
- **A per-user, per-kind preference matrix.** One switch per user, plus the ability to mute the two
  organiser-nudge kinds, covers every complaint a nine-person campaign will actually make. A
  preferences table is a week that buys nothing before October.
- **Digests, scheduling, snooze, "remind me tomorrow".** All reasonable; none of them are why anyone
  asked for this.
- **A job queue.** The messaging worker's interval loop is already the pattern; a second scheduler is
  a second thing to operate.
- **A cross-process event bus.** `app.events` is in-process and the API runs as one container. If the
  API is ever scaled to two, `notification` rows *are* the queue — a dispatcher claiming rows with
  `pushed_at IS NULL ... FOR UPDATE SKIP LOCKED` is the migration path, and it is a day's work when
  it is actually needed. Do not pre-build it.
- **Notifying on inbound elector replies.** That is Phase 5's `message_inbound` and it is a different
  audience with a different consent story. Adding it here would mix the worker channel with the
  elector channel, which §2.5 exists to prevent.
- **Email fallback**, until push has been in the field long enough to show it is not enough.
