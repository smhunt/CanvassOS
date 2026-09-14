# Phase 8 — the website subscriber link

Approved 2026-09-14. Links people who sign up on the campaign website
(sean-hunt.com, a Cloudflare Pages site with its own D1 `signups` table) to
voter records here, so the GOTV list and the canvass see one person, not two.

There is no shared key between the two systems, so this is identity
resolution: exact contact-info joins where possible, fuzzy name/address
matching everywhere else, and a human organizer confirming anything a
machine cannot prove.

## Decisions (made with the candidate)

1. **Pull, not push.** A sync worker inside this API pulls the website's
   admin export (`GET /api/signups?status=all`, bearer token) every five
   minutes and upserts into `public_request`. No new public endpoints, no
   voter data ever leaves this stack, and downtime self-heals on the next
   pull.
2. **Match policy is configurable; the default auto-accepts exact hits
   only.** `MATCH_AUTO_ACCEPT=exact` (default) lets the matcher link a
   subscriber on its own only when their email or E.164 phone exactly
   matches a door-collected `voter_contact` value resolving to exactly one
   voter. Everything fuzzier is a ranked *suggestion* for the organizer
   queue, per this repo's standing rule that matching a person to a real
   door is a human job. `off` makes even exact hits suggestions.
3. **The website form gains an optional street-address field** (this repo's
   TODO already asked for it) — address is the strongest matching key.
4. **All matching runs locally.** Trigram similarity, a nickname table, and
   deterministic joins in Postgres. No voter row is ever sent to an external
   AI ("a row in a prompt is the list provided to another person" — see
   `docs/data-sources-research.md`); the owner's looser read of the Act
   changes nothing here because local matching needs no outside help anyway.

## Pieces

- **Migration 007**: `public_request` gains `external_id` (the website D1 row
  id; unique with `source`), `website_status`
  (pending/confirmed/unsubscribed mirror of the site's double-opt-in state)
  and `matched_at`. New `match_candidate` table (per-request ranked
  suggestions; FK to `public_request` CASCADE; voter identifiers stored as
  plain columns plus `natural_key`, no FK, because re-imports regenerate
  voter ids). New `subscriber_link` ledger — the durable record of every
  accept/reject, deliberately FK-free so `TRUNCATE household CASCADE` (which
  empties `public_request` and `match_candidate` on a voters-list re-import)
  cannot erase decisions: sync rebuilds the queue, the matcher re-applies
  the ledger by `natural_key`.
- **`SubscriberSync`** (`api/src/subscriber/sync.ts`): interval worker,
  started by `server.ts` only when `WEBSITE_SYNC_URL` + `WEBSITE_SYNC_TOKEN`
  are both set (absent = feature off, like every optional integration
  here). Uses `app.httpFetch` so tests inject the website. Maps interests →
  `wants` (volunteer→volunteer, lawn-sign→sign, sms-reminders→reminders),
  message → note, consent text verbatim. A changed row NULLs `matched_at`
  so the matcher revisits it.
- **Matcher** (`api/src/subscriber/match.ts`): per unmatched request —
  ledger re-apply, then tier 0 exact contact joins, then tier 1 fuzzy
  (nickname-expanded trigram on `voter.full_name`, trigram + civic-number
  boost on `household.address` when the subscriber gave one). Top 3 stored.
  Every suggestion, auto-accept and decision is audited.
- **Queue API**: `GET /api/public/requests` now returns each request's
  candidates (voter name + address, score, method, status);
  `POST /api/public/requests/:id/decide` records accept/reject, stamps
  `public_request.household_id` on accept, writes the ledger.
- **Requests screen** (`web/src/pages/RequestsPage.tsx`, organizer-only):
  the queue with candidate cards and one-click Accept / Not them.
- **Website repo**: optional address input on the Get Involved form, stored
  in D1 and included in the admin export.

## What a match never does

Accepting a match sets `public_request.household_id` — a pointer. It never
writes to `voter`/`household`, never mints messaging consent (that stays
with the site's own double-opt-in and `/api/subscribe`), and never sends
anything to anybody.
