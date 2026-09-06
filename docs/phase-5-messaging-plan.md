# Phase 5 — SMS and email to electors who opted in

Draft plan, 2026-09-06. Election day is **26 October 2026 — 50 days out.**

SMS first, email second. Nobody is messaged who has not said yes, and a person who says stop is
never messaged again.

---

## 1. Read this before designing anything

Two findings from `docs/data-sources-research.md` §2.2 change the shape of the system. Neither is
obvious, and a design that ignores either will fail *silently* — which is the worst way for a GOTV
tool to fail, because you find out after the polls close.

### 1.1 Throughput is the ceiling, not cost

Unregistered Canadian **local long codes are throttled to roughly 100–250 messages per day per
number, and the excess fails silently.** Not queued — dropped.

The arithmetic that follows from that is the single most important fact in this document:

| Audience | One number | Ten numbers | Forty numbers |
|---|---|---|---|
| 2,000 subscribers | 8–20 days | 1–2 days | hours |
| 17,000 electors | 70–170 days | 7–17 days | 2–4 days |

**So there is no "text everyone on Sunday night" button, and building one would be a lie.** The
system has to be a *drip*: a long-running, throttled send that spreads over hours or days across a
pool of numbers, shows honest progress, and can be paused. A GOTV send has to be scheduled days
ahead of the day it is meant to land.

This also caps the realistic audience. A list of 1,500–3,000 opted-in subscribers is deliverable
inside a weekend on a handful of numbers. Seventeen thousand is not, at any price.

**Corrected 2026-09-06.** No provider publishes a per-day figure for Canadian long codes, and it is
probably not a quota at all. What Twilio does say first-party is that *"Canadian mobile carriers
enforce strict filtering on A2P messages"* — that is **reputation-based spam filtering**, which moves
with content, pacing and complaint rate, not a dial set to 250.

So treat 100–250 as a **conservative tunable cap** (`sender_number.daily_cap`), never as a cited
fact. The half of the claim that is true is the half that matters: **filtered messages fail
silently**, which is why delivery receipts are load-bearing rather than reporting polish.

One open question remains, and it is the only one that could still change the design: **ask the
provider in writing what happens to messages above the cap** — dropped, queued, or throttled.

### 1.2 Campaign Verify — REFUTED 2026-09-06, this is not a blocker

An earlier draft made this step zero. Primary-source check (`docs/sms-providers-canada.md` §2) says
otherwise: Campaign Verify's own page scopes the 17 February 2026 requirement to **"U.S. political
committees"** — by the *sender's identity*, not by the destination country — and attaches it to short
code and toll-free, not 10DLC. Canada-to-Canada traffic on a Canadian long code never enters the US
vetting apparatus at all.

So a Canadian municipal candidate is not blocked, is not required to register, and has nothing to
apply for. **The step-zero gate that opened this plan does not exist.** What is confirmed is only
that Campaign Verify itself is US-only, which is irrelevant to us.

There is also **no Canadian equivalent of 10DLC** — no registration, no queue. A long code bought on
Monday sends on Monday.

### 1.3 The rest of the legal picture

- **CASL** bites on *commercial* electronic messages. A GOTV reminder is not commercial, so the
  campaign is in better shape than it might assume — but a message that solicits a donation is a
  different animal. Keep those separate at the schema level so the distinction cannot blur.
- **DNCL**: municipal candidates *are* exempt, via CRTC Rule 3.1 (not Telecom Act s. 41.7). No DNCL
  subscription needed.
- **ADAD**: the solicitation ban is about automated *voice* dialling. It does not reach SMS, but it
  means "just add robocalls" is not a later increment — it needs counsel first.
- **Quiet hours**: 09:00–21:30 weekdays, 10:00–18:00 weekends. Strictly these are the telemarketing
  and ADAD rules rather than SMS rules, but a text at 07:00 costs goodwill regardless. Enforce them.
- **Municipal Elections Act s. 23(7)–(8)** still governs the underlying list. A phone number given at
  the door is *not* list data — it lives in `voter_contact` for exactly that reason — but the
  association between a number and a named elector is, so exports and provider payloads must carry
  the minimum.

### 1.4 One content trap that costs real money

**Corrected 2026-09-06.** An earlier draft of this document — and the research it came from — said a
single `é` or `à` forces UCS-2. That is wrong: GSM 03.38's basic alphabet *includes* `è é ù ì ò Ç Ø
Å Æ ß É Ä Ö Ñ Ü à ä ö ñ ü`, so ordinary French accents cost one character each. Verified against the
alphabet in `api/src/lib/segments.ts`.

The real trap is **smart punctuation**: the curly apostrophe `’`, curly quotes `“ ”`, the em dash `—`
and lowercase `ç` are all outside GSM-7 and force UCS-2, dropping the segment limit from **160
characters to 70** and tripling the cost of every message in the send. These are exactly what Word,
Pages and iOS silently substitute for `'`, `"` and `-` as you type — so the likeliest way to triple a
bill is to draft the message somewhere else and paste it in.

**And Canada is not 160 characters.** Twilio's Canada SMS guidelines state, for both inbound and
outbound long codes, *"GSM 3.38=136, Unicode=70"* — [verified 2026-09-06](https://www.twilio.com/en-us/guidelines/ca/sms).
The GSM default of 160/153 is wrong here, and wrong in the expensive direction: at 160 a 150-character
body reads as one segment and is billed as two. Both the API and the composer use **136** single /
**129** concatenated (the concatenated figure inferred from the 7-septet header, as 160 becomes 153).

The composer therefore shows characters, segments and encoding live, names the offending character
when it flips, and offers to replace smart punctuation. It never strips accents, because it does not
need to.

---

## 2. What already exists

More than half the consent work is done. `db/migrations/002_voter_contact.sql` gives us:

- `voter_contact` — `channel` (`phone` | `email`), normalised `value`, optional `voter_id`, required
  `household_id`.
- **Per-purpose consent**: `consent_gotv` and `consent_updates` as separate columns, because one
  "ok to contact" boolean cannot answer *"did they agree to this?"*.
- `consented_at`, `collected_by`, and `contact_id` linking back to the doorstep conversation.
- **`withdrawn_at` — a stamp, never a delete.** A deleted row is just re-collected at the next
  canvass; the row stays so the system remembers someone asked us to stop.
- `GET /api/voter-contacts/gotv` already returns the send list: consented, not withdrawn.

**The gap is everything downstream of that**: subscribing at scale, composing, sending, proving
delivery, and honouring STOP.

---

## 3. Design

### 3.1 Channel priority — SMS first

One resolver decides how a person is reached, in this order:

1. A `phone` contact with `consent_gotv` and no `withdrawn_at` → **SMS**.
2. Otherwise an `email` contact with `consent_gotv` and no `withdrawn_at` → **email**.
3. Otherwise not reachable. Not an error; most electors will be here, and that is fine.

If someone gives both, SMS wins and email is not also sent — one message per person per campaign,
never two. Where a household shares a number, it is contacted once.

### 3.2 Saying yes

"They must say yes" is the whole design constraint. Three routes in, all recording the same thing:

- **At the door** — already built. A volunteer ticks `consent_gotv` in the door screen.
- **Self-serve web** — a public page where someone enters their own number. **Confirmed by a reply**:
  we text them, they reply `YES`, and only then does `consent_gotv` go true. An unconfirmed number is
  never messaged. This is the only route where we cannot see the person, so it gets the strictest
  proof.
- **Text to join** — inbound `JOIN` to the campaign number sets consent directly, since the act of
  texting us *is* the consent and is logged with the carrier's own timestamp.

Every route writes `consented_at`, `collected_by` (or "self", for the web and inbound routes) and the
verbatim wording they agreed to. **A consent record that cannot say what was agreed to is not a
consent record.**

### 3.3 Saying stop

- Inbound `STOP`, `UNSUBSCRIBE`, `ARRÊT` and the usual variants set `withdrawn_at` **immediately**,
  before any queued message to that number is sent. The send worker re-checks withdrawal at dequeue
  time, not at queue time — a queue built on Friday must not deliver on Sunday to someone who
  withdrew on Saturday.
- Every SMS carries a short opt-out instruction. Every email carries a one-click unsubscribe.
- Withdrawal is per person, not per campaign. There is no "but this one is important" override.

### 3.4 Schema (migration 003)

```
message_campaign   id, name, purpose ('gotv' | 'updates'), body_sms, body_email_subject,
                   body_email, audience jsonb, status ('draft'|'scheduled'|'sending'|'paused'
                   |'done'|'cancelled'), scheduled_for, created_by, created_at, sent_count,
                   failed_count
message_send       id, campaign_id, voter_contact_id, channel, status ('queued'|'sent'
                   |'delivered'|'failed'|'skipped'), skip_reason, provider_message_id,
                   segments, attempts, error, queued_at, sent_at, delivered_at
sender_number      id, e164, provider, daily_cap, sent_today, last_reset, active
message_inbound    id, from_e164, body, received_at, matched_contact_id, action ('join'|'stop'|
                   'help'|'other')
```

`message_send` is one row per recipient per campaign — that is what makes "did she get it?"
answerable, and what stops a retry double-sending.

### 3.5 The sender

- A worker drains `message_send` against the `sender_number` pool, respecting each number's daily
  cap and a global quiet-hours window. It is a **drip, not a blast**.
- Provider failures retry with backoff; a hard rejection (invalid number, carrier block) marks the
  row failed with the provider's own reason and does not retry.
- Delivery receipts webhook updates `delivered`. **Without receipts we do not know whether the
  throttle is silently dropping messages**, which is the failure mode §1.1 warns about — so receipts
  are not optional polish, they are how we detect the thing that breaks us.
- Progress is visible while it runs: sent, delivered, failed, remaining, and estimated finish given
  the current cap. An organiser must be able to see that a Sunday send will not finish before Tuesday.

### 3.6 Costs

At Twilio's Canadian long-code rates, ~$326 USD per 20,000 single-segment messages. A 2,000-person
GOTV send is a few tens of dollars — trivial against a **$21,858.20** spending limit. Numbers rent
monthly, so a pool of ten is a small fixed cost. **Cost is not the constraint; throughput is.**

---

## 4. Build order

| # | Piece | Why first |
|---|---|---|
| 0 | **One written question to the provider**: what happens to messages above the throughput cap — dropped, queued or throttled? Plus written blessing for a ~10-number pool | No longer a gate — Campaign Verify does not apply and there is no Canadian registration queue. But the answer tunes `daily_cap`, and the pool blessing avoids a snowshoeing suspension |
| 1 | Migration 003 + the channel-priority resolver + `GET /api/messaging/audience` (counts only) | Answers "how many people can we actually reach?" — which decides whether this is worth building |
| 2 | Inbound webhook: STOP first, then JOIN | Ship the ability to stop **before** the ability to send. Non-negotiable. |
| 3 | Self-serve subscribe page + confirmation reply | Grows the list while the rest is built; the list is the long pole |
| 4 | Composer with live segment/encoding count, and a test send to yourself | The é trap is cheapest to catch here |
| 5 | Send worker, number pool, quiet hours, receipts | The actual sender |
| 6 | Campaign dashboard: progress, delivery rate, opt-outs | Detects silent throttling |
| 7 → **2b** | Email, built in parallel from week 2 | **Moved up.** If SMS fails 72 hours out, a second SMS provider cannot be provisioned, warmed and consent-verified in time. Email is the only channel that can absorb the whole list on election eve with no throughput ceiling and no carrier filter. Send priority is unchanged — SMS still wins — but email must be *built and tested* before it is needed |

**Two gates before the first real send:** the provider confirmation at step 0, and a lawyer's read on
the CASL position for a non-commercial political SMS from a municipal candidate. Neither is optional
and both take calendar time, which is why they are listed first with 50 days on the clock.

---

## 5. What I would not build

- **No "send to the whole list" button.** It cannot work at long-code throughput and would fail
  silently. The UI should not offer a shape the transport cannot honour.
- **No merging with the voters list.** Subscribers are `voter_contact` rows; the elector list stays
  separate, and a message send never exports list data to the provider — only the number and the body.
- **No robocalls.** The ADAD solicitation ban needs counsel before anyone touches voice.
- **No pre-checked consent, anywhere, ever.**
