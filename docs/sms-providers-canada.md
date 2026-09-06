# SMS Providers for a Canadian Municipal Campaign (Middlesex Centre, ON)

**Status: COMPLETE.** Research date 2026-09-06. Supersedes the SMS findings in
`docs/data-sources-research.md` §2.2 and `docs/phase-5-messaging-plan.md` §1.1–1.2 where they differ.

> **Method note.** This session's web-*search* budget was already exhausted before this research
> began, so every finding below comes from **direct fetches of primary-source URLs** (provider docs,
> pricing pages, acceptable-use policies, regulator pages). That is the standard this memo wanted
> anyway, but it means I could not discover pages I did not already know the address of. Where a
> URL would not load, that is noted rather than retried.
>
> **I am not counsel.** Sections 2, 4 and 5 contain questions that are legal and contractual, not
> technical. They are flagged where they arise.

Election day: **2026-10-26 — 50 days out.**

---

## 0. Executive summary

**Both headline claims from the earlier pass were wrong in the same direction: the situation is
better than feared.**

1. **Campaign Verify does not bind this campaign.** VERIFIED from Campaign Verify's own page: the
   February 2026 requirement is *"a wireless carrier requirement for **U.S. political committees**"*,
   scoped by the **sender's** status, not by the destination country — and it attaches to **short
   code and toll-free**, not to the path this campaign will use. Canada-to-Canada traffic on a
   Canadian long code never enters the US carrier vetting apparatus. **The obstacle the Phase 5 plan
   called its first blocker is not an obstacle.** (§2)
2. **The "100–250 messages/day" figure is not in any first-party documentation** — I could not find
   it, and it is almost certainly not a published quota but a description of Canadian carrier spam
   filtering, which is content- and reputation-dependent and has no fixed number. **The "fails
   silently" half of the claim is the true and important half.** The design consequence is unchanged:
   drip, don't blast; instrument with delivery receipts. But stop citing 250 as a fact — make it a
   tunable per-number cap. (§1)
3. **Short codes are impossible.** 12–16 weeks provisioning lands **after** the election. Not a
   fallback. Not a stretch. Gone. (§4.2)
4. **There is no Canadian 10DLC.** No brand registration, no campaign registration, no queue. A
   Canadian local long code is bought and used the same day. (§4.1)
5. **No provider policy forbids this.** Twilio's AUP lists nine prohibited categories and political
   messaging is not among them. (§3.5)
6. **Recommendation: Twilio primary, CallHub fallback, ~10 Canadian long codes, ≈ $350 USD / $480 CAD
   all-in** for 2,000 subscribers × 6 messages — about **2% of the $21,858.20 spending limit**. (§6)

**The risk has moved from compliance to fieldwork.** Nothing here stops the campaign from sending.
What could stop it is failing to collect 2,000 consented numbers in six weeks, or discovering
carrier filtering on 25 October instead of 1 October.

## 1. Claim check: "Unregistered Canadian long codes are throttled to ~100–250 msg/day and excess fails silently"

**Verdict: NOT CONFIRMED as a documented number, but the underlying risk is real and is documented
in a different form. Treat the number as folklore; treat the risk as fact.**

### What primary sources actually say

**Twilio, Canada SMS guidelines** ([twilio.com/en-us/guidelines/ca/sms](https://www.twilio.com/en-us/guidelines/ca/sms)) — VERIFIED:

- **"Canadian mobile carriers enforce strict filtering on A2P messages."** That is Twilio's own
  wording, first-party, unqualified.
- **"Twilio recommends sending application-to-person (A2P) traffic over short codes or verified
  toll-free numbers for optimal delivery results."** Read that as what it is: Twilio telling you a
  long code is *not* the recommended A2P path in Canada.
- Domestic long codes are supported; **alphanumeric sender IDs are NOT supported in Canada.**
- Short code provisioning: **12–16 weeks.** (This alone kills short codes for 26 Oct 2026 — see §4.)
- The page **does not publish any messages-per-second or messages-per-day figure** for Canadian long
  codes.

**So: no first-party source publishes "100–250/day."** I could not find that number in any provider's
documentation. It remains reseller/community folklore, exactly as the earlier pass flagged.

### Why the number is probably not literally right, and why that does not help you

The mechanism people are describing is not a *published quota*. It is **carrier-side spam filtering**.
Long codes were designed for person-to-person traffic; Canadian carriers (Rogers, Bell, Telus and
their flankers) run unpublished heuristics that look at volume, velocity, repetition of identical
bodies, link presence, and complaint rate. There is no dial set to "250". There is a filter that
starts dropping — or blocking the number outright — when traffic stops looking human.

That distinction matters for the design in three ways:

1. **The cap is not a constant.** It is content- and reputation-dependent. Identical bodies with a
   shortlink, fired in a burst, will trip filtering far below 250. Varied bodies, drip-paced, to
   numbers that have messaged you first, may pass well above it. **You cannot plan against a number
   you cannot measure — you can only instrument and back off.**
2. **The failure really can be silent.** This half of the claim I would treat as **true and the most
   important part of it.** Carrier-level filtering commonly returns a *success* status upstream while
   the message never reaches the handset. This is precisely why `phase-5-messaging-plan.md` §3.5 is
   right that **delivery receipts are not polish.** Sent-vs-delivered divergence is your only
   instrument.
3. **The real risk is not slowness, it is the number being killed.** A long code that trips filtering
   hard can be blocked by a carrier for all traffic. Losing your sender number on 24 October is a
   materially worse outcome than a slow send.

### Practical guidance — inference, clearly marked

**INFERENCE, not verified:** the planning assumption of **~200 messages/day/number for an unregistered
Canadian long code, ramping** is a *reasonable conservative default*, not a documented limit. I would
build to it, and I would build the system so the number is a **configurable per-number cap**
(`sender_number.daily_cap` already is — good) that an operator raises or lowers based on the observed
delivered-rate, rather than a constant baked into the design.

**What I would actually do given 50 days:** the arithmetic in `phase-5-messaging-plan.md` §1.1 holds
its shape regardless of whether the true figure is 150 or 500. A 2,000-subscriber list on a pool of
5–10 numbers is comfortably deliverable over a weekend under any plausible value. **The design does
not change.** What changes is that you should stop treating 100–250 as a fact to cite and start
treating it as a dial to tune with delivery receipts.

**The one thing that would settle this:** ask the chosen provider's support, in writing, "what
throughput will you allow on a Canadian local long code on my account, and what happens to the
excess — queued, rejected with an error code, or accepted and dropped?" Providers answer this in
support tickets; they do not publish it. That is a **step 0 action item**, not a research finding.

*(Undetermined: Telnyx and Twilio help-centre articles that plausibly carry per-number figures would
not load — see §7.)*


## 2. Claim check: "Campaign Verify is US-only; from 17 Feb 2026 carriers require its Auth Token for political messaging, including traffic to Canada"

**Verdict so far: half survives, half does not — and the half that fails is the half that mattered.**

**VERIFIED (primary source, campaignverify.org):**

- Campaign Verify **is** US-only. Eligibility, verbatim: *"Any candidate, party, PAC, or other
  committee that is a **527 tax-exempt organization** and registered with the **Federal Elections
  Commission (FEC) or a State, Local, or Tribal Election Authority** is eligible to obtain
  verification through Campaign Verify."* A Middlesex Centre council candidate is none of those
  things and **cannot register**. Cost, for reference, is $95 USD per entity per two-year cycle.
  ([campaignverify.org](https://www.campaignverify.org/))
- The **17 February 2026** date is real. Verbatim: *"A wireless carrier requirement for **U.S.
  political committees** to obtain a Campaign Verify Authorization Token for these channels went
  into effect on February 17, 2026."*

**CORRECTED — the earlier pass overstated the scope on two counts:**

1. **Who it binds.** Campaign Verify's own wording is *"a wireless carrier requirement for **U.S.
   political committees**"* — the obligation attaches to the **sender's status as a US political
   committee**, not to the destination country of the traffic. A Canadian municipal candidate is
   not a US political committee and so is not the subject of the requirement. The earlier memo read
   the rule as scoped by *destination* ("including traffic to Canada"); the primary source scopes it
   by *sender identity*.
2. **Which channels.** Campaign Verify's page attaches the February 2026 requirement to **Short Code
   and Toll-Free** channels. The earlier memo added 10DLC to that list. 10DLC political use cases
   have had their own vetting story (via TCR/Campaign Verify) for longer, but the Feb-2026
   requirement as stated by Campaign Verify itself is short code + toll-free.

**What this means practically.** 10DLC, toll-free political vetting and Campaign Verify are all
artefacts of the **US** carrier ecosystem (The Campaign Registry, AT&T/T-Mobile/Verizon). A message
sent **from a Canadian long code to a Canadian mobile number** never touches a US carrier's
political-vetting apparatus. The route the earlier memo landed on — a **Canadian local long code,
staying off the toll-free path** — is the right one, and it is right for a simpler reason than the
memo gave: not because it evades a rule that binds us, but because **the rule was never addressed to
us in the first place.**

**Where the risk actually is (and it is not Campaign Verify):** a US-domiciled provider (Twilio,
Bird, Telnyx, Vonage, Plivo, Sinch, AWS) may apply its **own** political-content policy to your
account globally, regardless of what carriers require. That is a **contract** question, not a
regulatory one, and it is the thing to get in writing. See §3.

**Residual uncertainty:** if any of the campaign's traffic is ever sent **to a US mobile number**
(a supporter who moved, a US-roaming number, a US area code) it enters the US carrier ecosystem and
the US rules do apply to that message. Restrict the send list to Canadian numbers.

**Not counsel.** Whether a Canadian campaign has any exposure under a US carrier requirement it
cannot satisfy is a question for a lawyer, but the technical answer is that it does not arise on
Canada-to-Canada traffic.


## 3. Provider-by-provider

**Reading this table.** "Political traffic permitted" is almost never answered on a public page —
providers gate it through their acceptable-use policy plus manual account review. Where I could not
verify from a primary source I say so rather than guessing.

### 3.1 Twilio — VERIFIED pricing, the reference case

Sources: [Canada SMS guidelines](https://www.twilio.com/en-us/guidelines/ca/sms),
[Canada SMS pricing](https://www.twilio.com/en-us/sms/pricing/ca),
[Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy).

| Item | Verified value |
|---|---|
| Canadian local long codes | Yes. Alphanumeric sender IDs **not** supported in Canada |
| Long code / toll-free base rate | **$0.0083** outbound, **$0.0083** inbound (USD) |
| Rogers & Fido carrier fee | **$0.0084** out / $0.017 in |
| Bell & Virgin carrier fee | **$0.0087** out / $0.0323 in |
| Telus carrier fee | **$0.0073** out / $0.0146 in |
| Freedom / Videotron | $0.0067 out / $0.0089 in |
| All other carriers | $0.0064 out / $0.0079 in |
| **All-in outbound, per segment** | **≈ $0.0156 – $0.0170 USD** depending on carrier |
| Long code monthly rental | **$1.15** (Twilio-leased) / $0.50 (BYOA) |
| Toll-free monthly rental | $2.15 |
| Short code | **$1,000 per quarter** + $2,500 one-time MMS setup; **12–16 week** provisioning |
| Short code messaging | $0.0315 base + $0.0146–$0.0361 carrier fee |
| Registration for Canadian long codes | **No 10DLC-equivalent registration published.** Toll-free requires verification |
| Political content | **Not addressed in the Messaging Policy.** It defers to "prohibited by law, regulation, or carrier requirement." No political prohibition found — but also no explicit permission |

The messaging policy's consent language is worth quoting because the Phase 5 design already satisfies
it: *"you must obtain prior express consent from the message recipient"*, consent must be *"freely
given"*, and *"You are required to retain proof of all consents obtained from recipients... at least
until a recipient withdraws their consent."* The `voter_contact` schema with `consented_at`,
`collected_by`, verbatim wording and `withdrawn_at` is a direct fit.

Note the **inbound carrier fees are much higher than outbound on Bell** ($0.0323 vs $0.0087). A
design with a heavy inbound leg — text-to-join, YES confirmations, STOP handling — pays for it. Still
trivial at this volume, but budget for it.

### 3.2 Telnyx — pricing still not public for Canada

[telnyx.com/pricing/messaging](https://telnyx.com/pricing/messaging) publishes detailed **US** rate
cards (local, toll-free, short code, RCS) and **no Canadian section**. The page notes rates are
available via `GET /v2/public/pricing`. **The earlier memo's finding that Telnyx does not publish
Canadian messaging rates survives — VERIFIED, still true.** For a 50-day campaign, a provider whose
price you must query an API to learn is a poor first choice.

### 3.3 CallHub — the political specialist

[callhub.io/pricing](https://callhub.io/pricing/) — page title is **"Pricing US & CA"**, and the
published SMS rate is **"$0.019 /SMS segment"** (VERIFIED figure; **not verified** whether Canadian
carrier surcharges are included or added). CallHub explicitly sells into this vertical: the pricing
page lists **GOTV**, **Voter & issue persuasion**, **Political** and **Advocacy** as named use cases.

**Why that matters more than the price.** Every generic CPaaS carries a small but real risk that an
abuse-team reviewer looks at 2,000 near-identical political messages from a pool of ten numbers on
the Saturday before an election and pauses the account first, asks later. **A provider whose
homepage advertises GOTV will not be surprised by GOTV.** That is worth paying a premium for at this
volume, where the entire spend is a rounding error.

**Not verified:** whether CallHub provisions **Canadian** local long codes, and their Canadian
onboarding requirements. Their public pages are US-centric (they cite TCPA 8am–9pm windows,
STIR/SHAKEN, and NGP VAN / NationBuilder / PDI voter-file integrations — all US). **Ask on the sales
call; do not assume.**

### 3.4 Providers I could not verify this session

| Provider | Status |
|---|---|
| **Telnyx** | Canadian messaging rates **still not published** (VERIFIED absence) |
| **Bird** | Pricing page not reachable. Earlier memo's ≈$268/20k figure **not re-verified** |
| **Vonage** | Country-specific page defers to a knowledgebase; the Canada article returned **403** |
| **Plivo** | Canada regulatory-guidelines and Canada SMS pages both returned **404** |
| **Sinch** | Not reached |
| **AWS End User Messaging** | Canada registration doc returned only a page title |
| **ClickSend** | Canadian pricing page returned **404** |
| **EZ Texting** | Not reached. Earlier memo's ≈$1,300/20k figure **not re-verified**; if roughly right it is 4× Twilio and should be dropped from consideration |

**Canadian-domiciled providers: undetermined.** I could not identify a Canadian-domiciled A2P SMS
provider from primary sources without web search. This is a genuine gap — see §7 — but note it is a
gap in *comfort*, not in *capability*: a Canadian long code from Twilio is a Canadian number on
Canadian carriers regardless of where Twilio is incorporated. The reason to want a Canadian vendor
here would be data residency and a support line in the same time zone, not deliverability.

### 3.5 Does any provider forbid political traffic? — VERIFIED: Twilio does not

Twilio's [Acceptable Use Policy](https://www.twilio.com/en-us/legal/aup) prohibits nine categories:
violating laws/regulations/carrier requirements, interfering with the Services, reverse engineering,
**falsification of identity or origin**, bypassing service limitations, exploiting vulnerabilities,
denial-of-service, malware, and unauthorized access. **Political campaigns, elections and advocacy
are entirely absent from the list.** The only hook that could reach political traffic is the general
*"Violating laws, regulations... or telecommunications providers' requirements or guidance in any
applicable jurisdiction"* clause.

Combined with §2, this is the single most reassuring finding in the memo: **there is no
policy-level barrier at Twilio to a Canadian municipal candidate sending consented GOTV texts to
Canadian numbers on Canadian long codes.** Two clauses to respect: don't falsify identity or origin
(so identify the campaign in every message — which CRTC Rule 3.1 requires anyway), and don't
"bypass service limitations" (so don't build automation whose stated purpose is defeating the
throughput cap — drip *within* the cap).

## 4. The Canadian registration path — and why short codes are off the table

### 4.1 There is no Canadian 10DLC — CONFIRMED by absence

Twilio's Canada guidelines page describes sender types, character limits and provisioning times. It
describes **no registration regime for Canadian local long codes** — no brand registration, no
campaign registration, no use-case vetting. Compare this with Twilio's US pages, where A2P 10DLC
registration is unmissable. **A Canadian local long code is bought and used.** That is the good news
in this entire memo: the fastest path is also the only one available, and it has no queue.

The trade is that **unregistered means unvetted means filtered.** You get no registration burden and
no carrier trust. See §1.

### 4.2 Short codes: dead on arrival for 26 October 2026

- Administered by **txt.ca**, which is *"administered by the **Canadian Telecommunications
  Association**"* ([txt.ca/en](https://www.txt.ca/en/)). **Terminology correction:** the earlier memo
  and plan say "CWTA". CWTA rebranded to the Canadian Telecommunications Association; txt.ca is the
  current registry. Use the current name when you contact them.
- Twilio publishes **12–16 weeks** provisioning for Canadian short codes
  ([guidelines](https://www.twilio.com/en-us/guidelines/ca/sms)).
- Cost via Twilio: **$1,000 per quarter**, plus per-message rates roughly 3–4× a long code.

**12–16 weeks from today (2026-09-06) lands between 29 November 2026 and 27 December 2026 — five to
nine weeks *after* the election.** A short code is not a fallback, a rush option, or a stretch goal.
It does not exist for this campaign. Do not spend another hour on it.

### 4.3 Toll-free: possible, but the wrong shape

Canadian toll-free numbers exist and Twilio supports them with **verification** rather than a
months-long provisioning queue. But toll-free is precisely the channel Campaign Verify's February
2026 requirement attaches to (§2), and toll-free verification asks use-case questions that put a
political campaign in front of a reviewer. **The long code avoids that conversation entirely.**
The earlier memo's instinct to stay off the toll-free path is correct.

### 4.4 What a *candidate*, rather than a company, can obtain

**Undetermined from primary sources.** Twilio, Telnyx and Plivo all require an account with billing
details; none of the pages I could read state that a business entity is required to buy a Canadian
local long code. **INFERENCE:** an individual with a credit card can buy Canadian long codes from
Twilio today — this is routine and I would be surprised if it failed — but the campaign should
expect to name a responsible entity during any toll-free or short-code verification, which is another
reason to stay on long codes. Ontario municipal campaigns operate through a **registered campaign
bank account** under the *Municipal Elections Act*; use that for billing so the expense is clean
against the $21,858.20 spending limit.

## 5. Deliverability in Canada

### 5.1 Carrier filtering — VERIFIED that it exists, undocumented as to thresholds

Twilio, first-party: **"Canadian mobile carriers enforce strict filtering on A2P messages"**, and
therefore **"Twilio recommends sending application-to-person (A2P) traffic over short codes or
verified toll-free numbers for optimal delivery results"**
([Canada SMS guidelines](https://www.twilio.com/en-us/guidelines/ca/sms)).

That is a provider telling you plainly that the channel you are about to use is the one it does not
recommend. It is still the right choice here (§4), but go in with eyes open: **the plan's insistence
on delivery receipts and a visible delivered-rate is what converts an undocumented filter into
something you can manage.**

No primary source I could reach publishes per-carrier thresholds for Rogers, Bell or Telus, and I
would not expect one to — publishing a spam threshold defeats it.

**What is known to trip filtering (inference from general A2P practice, not a Canadian primary
source — marked as such):** identical message bodies at volume; URL shorteners (bit.ly, tinyurl) as
opposed to a link on your own campaign domain; bursts rather than a drip; a cold number with no
prior inbound traffic; high opt-out or complaint rate. **Use your own domain for links.** A campaign
that already owns a domain should send `middlesexcentre-campaign.ca/vote` rather than a shortener —
shorteners on shared domains inherit other senders' reputation.

### 5.2 Opt-out keywords, and the ARRÊT question

**Partially verified.** Twilio's Canada guidelines state that **"SMS campaigns should support
HELP/STOP messages, and similar messages, in the end-user's local language."**
That is a first-party instruction to support local-language keywords, and in Canada the local
language is French for a meaningful share of the population.

Twilio's [Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) enumerates the
English set verbatim: **STOP, STOPALL, UNSUBSCRIBE, OPTOUT, CANCEL, END, REVOKE, QUIT.** It **does
not** mention ARRÊT or any French keyword.

**Verdict on "must ARRÊT be supported alongside STOP":** I found **no primary source making ARRÊT
mandatory.** But the answer for this project is *support it anyway*, for three reasons, and the cost
of doing so is one line in a regex:

1. Twilio's own guidance says local language.
2. Middlesex Centre has francophone residents; a French-speaker who texts `ARRÊT` and keeps receiving
   messages is the exact scenario that generates a complaint, and complaints are what get a long code
   blocked.
3. The project's own consent ethic — "a person who says stop is never messaged again" — does not
   have an English-only clause in it.

**Implementation note:** match case-insensitively, strip accents *for matching only*, and accept
both `ARRET` and `ARRÊT`, plus `DESABONNER` / `DÉSABONNER` and `ANNULER`. The plan's §3.3 already
lists ARRÊT — keep it, and add the unaccented form, since a French keyboard is not guaranteed.

### 5.3 A segmentation discrepancy worth checking — POSSIBLE COST BUG

Twilio's Canada guidelines list character limits for Canadian long-code messaging as
**"GSM 3.38=136, Unicode=70"**. The repo's `api/src/lib/segments.ts` uses the ordinary GSM-7
constants: `GSM7_SINGLE = 160`, `GSM7_MULTI = 153`, `UCS2_SINGLE = 70`, `UCS2_MULTI = 67`.

**If Twilio's 136 figure reflects a real per-segment payload constraint on Canadian long codes rather
than a conservative published guideline, the composer will under-count segments on bodies between
137 and 160 characters** — the campaign would be told "1 segment" and billed for 2. This is not
proven; the page does not explain the 136. **Action: send a 150-character GSM-7 test message through
the chosen provider and read the segment count off the delivery record before trusting the composer.**
Cheap to test, and the Phase 5 build order already has a "test send to yourself" step (#4) where this
belongs.

*(The 136 figure may simply be Twilio quoting a concatenated-with-overhead worst case. I could not
determine which — see §7.)*

### 5.4 What gets a number blocked

**Inference, general A2P practice, not Canadian primary sources:** carriers and providers act on
complaint rate, opt-out rate, and unsolicited-traffic reports. Twilio's Messaging Policy explicitly
prohibits *"unsolicited or unwanted messages in bulk"* and calls out **"snowshoeing"** — spreading
traffic across many numbers to evade filtering — by name.

**This is a direct warning about the design in `phase-5-messaging-plan.md`.** A pool of 10–40 numbers
dripping identical bodies is, viewed uncharitably, snowshoeing. The distinction that makes it
legitimate is **consent**: every recipient opted in, the campaign can produce the verbatim wording
they agreed to, and STOP is honoured immediately. That defence is real and the schema already
supports it — but it means the **number pool must be disclosed to and blessed by the provider up
front**, not discovered by their abuse team mid-send on the weekend before the election. Put it in
the step-0 written confirmation.

**Keep the pool as small as the volume allows.** Ten numbers for 2,000 subscribers is defensible.
Forty numbers is the shape that gets an account suspended.

## 6. Recommendation

### 6.1 Primary: Twilio, Canadian local long codes, pool of ~10

**Why.** It is the only provider whose Canadian story I could verify end to end from primary sources:
sender types, per-carrier pricing, number rental, short-code lead time, consent policy, and an AUP
that does not touch political content. There is **no Canadian registration queue** to sit in, so a
number bought on Monday sends on Monday. And the Phase 5 design — number pool with per-number caps,
delivery receipts, inbound webhook — maps directly onto Twilio primitives the team can be productive
with immediately.

**Not because it is cheapest.** It is not the cheapest; it is the one whose behaviour is knowable in
the 50 days available. With total spend under $500, buying certainty is the correct trade.

### 6.2 Fallback: CallHub

**Why CallHub and not "another CPaaS".** The failure mode this campaign should actually fear is not
price and not throughput — it is **an account pause on the weekend before the election**, when there
is no time to migrate. CallHub's entire market is political and advocacy organising, so political
volume is expected traffic rather than an anomaly. Its published $0.019/segment is competitive.

**Caveat, stated plainly:** I could not verify that CallHub provisions Canadian long codes. If the
sales call says no, the fallback slot goes to **Bird or Plivo** — but both would need the same
step-0 written confirmation Twilio needs, and neither has the political-vertical comfort.

### 6.3 The fallback that actually matters is not an SMS provider

If SMS fails 72 hours out, a second SMS provider does not save you — provisioning numbers, warming
them, and re-verifying consent takes longer than you have. **The real redundancy is the email
channel**, which the Phase 5 build order currently puts at step 7 (last).

**I would move email earlier — to run in parallel from week 2** — not because email is better, but
because it is the only channel that can absorb the full list on election eve with no throughput
ceiling and no carrier filter, and it costs almost nothing to have standing by. Keep the send
priority as designed (SMS wins), but have email *built and tested* before you need it.

### 6.4 Cost model — 2,000 subscribers × 6 messages

All figures USD, from Twilio's published Canadian rates (§3.1). Assumes bodies kept single-segment
GSM-7 by the composer.

| Line | Volume | Unit | Cost |
|---|---|---|---|
| Outbound GOTV/update messages | 12,000 segments | $0.0165 blended (base $0.0083 + carrier $0.0064–$0.0087) | **$198** |
| Segment overrun allowance (20% of bodies go to 2 segments) | +2,400 | $0.0165 | **$40** |
| Inbound: YES confirmations + STOP + replies | ~3,200 | ~$0.028 blended (inbound carrier fees are high, esp. Bell at $0.0323) | **$90** |
| Long code rental, 10 numbers × 2 months | 20 | $1.15 | **$23** |
| **Total** | | | **≈ $350 USD ≈ $480 CAD** |

**Against the $21,858.20 spending limit that is about 2%.** The earlier memo's headline —
*cost is not the constraint; throughput is* — **survives, and is if anything understated.**

**Throughput sanity check.** The largest single send is 2,000 messages. At the conservative planning
figure of 200/day/number across 10 numbers that is **one day**; at a pessimistic 100/day it is **two
days**. Both fit. **Ten numbers is enough. Do not build the forty-number pool** — see the snowshoeing
warning in §5.4.

**What would blow the budget:** smart punctuation flipping the whole send to UCS-2 (triples it — to
about $1,000, still affordable, but it would be an avoidable and embarrassing 3×), or an audience
expansion from 2,000 to 17,000 (which the *throughput*, not the money, forbids).

### 6.5 Dated setup checklist — in the order the steps must happen

Today is **2026-09-06**. Election day is **2026-10-26**. Steps 1–3 are calendar-bound and gate
everything else.

| By | Step | Notes |
|---|---|---|
| **Mon 8 Sep** | **Open the Twilio account** and buy **two** Canadian local long codes in the 519/226 area | Two, not ten. You need one to test and one to fail with. Bill to the registered campaign bank account. |
| **Mon 8 Sep** | **Open the written provider question** (email support, keep the thread) | Ask exactly: (a) permitted throughput on a Canadian local long code on this account; (b) what happens to excess — queued, rejected with an error code, or accepted and silently dropped; (c) confirmation that consented political/GOTV traffic from a Canadian municipal candidate is permitted; (d) that a **10-number pool** for one consented campaign will not be treated as snowshoeing. **This is Phase 5 build-order step 0. Nothing waits on it, but everything is void without it.** |
| **Tue 9 Sep** | **Engage counsel** on the CASL position for non-commercial political SMS, and on ADAD if voice is ever contemplated | Calendar time. Start the clock now. |
| **Wed 10 Sep** | **Send a 150-character GSM-7 test** and read the billed segment count | Settles the 136-vs-160 discrepancy in §5.3 before the composer is trusted |
| **Fri 12 Sep** | **Inbound webhook live: STOP before send** | Phase 5 step 2. Ship the ability to stop before the ability to send. Include `ARRET`/`ARRÊT`, `DESABONNER`, `ANNULER`. |
| **Mon 15 Sep** | **Self-serve subscribe page + YES confirmation live** | The list is the long pole. Every day it is not live is subscribers not collected. |
| **Mon 15 Sep →** | **Canvass collects numbers continuously** | 2,000 opt-ins in six weeks is the actual hard part of this project |
| **Fri 19 Sep** | **Composer with live segment/encoding counter** | Phase 5 step 4 |
| **Fri 26 Sep** | **Send worker, number pool, quiet hours, delivery receipts** | Phase 5 step 5 |
| **Mon 29 Sep** | **First real send to a small segment (100–200 people)** — a genuine campaign update, not a test | This is the **warm-up send**, and it is doing double duty: it builds number reputation *and* it produces the first real delivered-rate measurement. **Do not let the first send be the GOTV send.** |
| **Wed 1 Oct** | **Read the delivered-rate off the warm-up.** If delivered/sent is materially below ~95%, you are being filtered — reduce per-number cap, vary bodies, check links | The measurement §1 says you cannot get any other way |
| **Fri 3 Oct** | **Buy the remaining 8 long codes**, warm each with low volume | Buying late means warming late; buying earlier means paying rental for idle numbers. Early October is the balance. |
| **Mon 6 Oct** | **Campaign dashboard: sent / delivered / failed / opt-outs** | Phase 5 step 6. Needed *before* the sends that matter. |
| **Wed 8 Oct** | **Email channel built and tested** | Moved up from step 7 per §6.3 |
| **Sat 10 Oct** | Send #2 — advance-vote information | Advance polls in Ontario municipal elections run in the weeks before voting day; confirm Middlesex Centre's dates with the Clerk and schedule around them |
| **Sat 17 Oct** | Send #3 | |
| **Wed 21 Oct** | Send #4 | |
| **Fri 23 Oct** | **Queue the GOTV send now** — it must be *queued* days ahead, per the drip constraint | The worker re-checks withdrawal at dequeue, so queuing early is safe |
| **Sat 24 – Sun 25 Oct** | Send #5 — GOTV, dripping across the pool | Two full days of headroom even at the pessimistic throughput figure |
| **Mon 26 Oct, 09:00** | Send #6 — election-day reminder, small and early | Quiet hours open at 09:00. Polls close 20:00. **A message that lands at 19:00 because the drip was still running is a message that did nothing.** |

**Two gates remain unchanged from the Phase 5 plan and both are on this list: the written provider
confirmation, and counsel on CASL.**

### 6.6 Would I bet on this being live and sending before 26 October 2026?

**Yes — with high confidence on the technology and low confidence on the list.**

The technical path is clear and short: no registration queue, no Campaign Verify obstacle, no policy
prohibition, numbers purchasable today, and a cost of roughly $480 CAD. There is no external
dependency with a lead time longer than a few days. That part I would bet on comfortably.

**The risk has moved.** It is no longer Campaign Verify (§2 dissolved it) and it was never money
(§6.4). It is now two things:

1. **Getting to 2,000 opted-in numbers in six weeks.** The system is worthless without the list, and
   the list is collected by humans at doors. That is a field-operations problem, not an engineering
   one, and nothing in this memo helps with it.
2. **Silent carrier filtering discovered too late.** Mitigated entirely by the 29 September warm-up
   send and delivery receipts — which is why that date is on the checklist and not later.

**The single most valuable thing on the checklist is the 8 September support email**, because it is
the only item that could still return an answer that changes the design, and it costs ten minutes.

## 7. What I could not determine

**Method limits.** Web *search* was unavailable for this entire session (budget exhausted before the
work began), so I could only fetch URLs I already knew. Several loaded as page titles only
(JavaScript-rendered) or 404'd. Per instruction I did not retry pages that failed twice.

1. **Any first-party per-day or per-second throughput figure for Canadian long codes.** No provider
   publishes one. The "100–250/day" number is neither confirmed nor refuted — it is *unsourced*.
   **Only a provider support ticket will settle it**, which is why that is checklist item #2.
2. **Whether the excess is queued, rejected, or silently dropped.** Same answer, same ticket. This
   is the operationally decisive question and it has no public answer.
3. **Per-carrier filtering thresholds at Rogers, Bell and Telus.** Not published by anyone, and I
   would not expect them to be.
4. **Whether ARRÊT is mandatory.** No primary source found either way. Twilio says support the
   end-user's local language; nothing states French keywords as a requirement. Support it regardless
   (§5.2) — the cost is a regex.
5. **The 136-vs-160 character discrepancy** between Twilio's Canada guidelines and the repo's
   `segments.ts`. Possibly a conservative published figure, possibly a real constraint. **A single
   150-character test send settles it** (§5.3).
6. **Whether CallHub provisions Canadian long codes**, and their Canadian onboarding. Their public
   material is US-centric. Sales call required.
7. **Bird, Vonage, Plivo, Sinch, AWS End User Messaging, ClickSend, EZ Texting** — pages 403'd,
   404'd or returned titles only (§3.4). The earlier memo's cost figures for Bird (≈$268/20k) and
   EZ Texting (≈$1,300/20k) are **not re-verified**; treat them as carried forward, not confirmed.
8. **Any Canadian-domiciled A2P provider.** I could not identify one from primary sources without
   search. A real gap, though a Canadian long code is Canadian regardless of vendor domicile.
9. **txt.ca short-code costs, lead times and whether an individual candidate may apply.** The site is
   JS-rendered and the detail pages did not load. **Moot** — 12–16 weeks ends the question (§4.2).
10. **Whether Twilio would treat a 10-number pool as snowshoeing.** Their policy names snowshoeing as
    prohibited without defining a threshold. Consent is the defence, but **get it blessed in writing
    before the send, not during it** (§5.4).

**Legal questions, not technical ones — these need counsel, not more research:**

- The CASL position on a non-commercial political SMS from a municipal candidate (the Phase 5 plan's
  second gate).
- Whether a Canadian campaign has any residual exposure under a US carrier requirement it is
  structurally unable to satisfy. My technical reading is that it does not arise on Canada-to-Canada
  traffic (§2), but that is an engineer's reading of a policy page, not advice.
- Whether the *Municipal Elections Act* s. 23(7)–(8) acknowledgement constrains what may be sent to a
  provider. The Phase 5 design's answer — send only the number and the body, never list data — looks
  right, but the association between a number and a named elector is the sensitive artefact and a
  lawyer should confirm the boundary.

**I am not counsel and nothing above is legal advice.**
