# Supplementary data sources and integrations — research and legal assessment

**Scope.** What additional data sources and integrations could supplement the municipal voters list
in this project, sold as a separate paid add-on rather than bundled into the core tool. Ontario
municipal context: Municipality of Middlesex Centre, Middlesex County, Ontario; head-of-council
race; voting day 26 October 2026.

**Status.** Research memo, September 2026. Everything below is either **verified** against a primary
source (URL given inline) or explicitly marked as **inference** / **unverified**.

> **This is not legal advice and I am not counsel.** Several conclusions below turn on the reading of
> a statute and of a declaration the candidate signs personally, with a corrupt-practice exposure
> attached. Nothing here should be relied on without a lawyer. The sections marked
> "needs counsel" are the ones where the risk of being wrong is a disqualification from office,
> not a refund.

---

## 1. Executive summary

Five findings change the decision.

### 1.1 The citation in the repo is wrong, and the real provision is stricter in the one way that matters

`README.md` and `CLAUDE.md` cite *Municipal Elections Act, 1996* **ss. 23 and 88** and state the rule
as "No other use, no sharing outside the campaign, **no merging into other contact lists**." Both
halves of that need correcting.

**The operative provision is s. 23(7) and s. 23(8)**, added by 2020, c. 23, Sched. 4, s. 7 and in
force since **1 January 2023**. Verbatim
([e-Laws consolidation](https://www.ontario.ca/laws/statute/96m32)):

> **Restrictions**
> **23 (7)** The clerk may not provide a copy of the voters' list under subsection (3) or a part of
> the voters' list under subsection (4) to a person unless the person provides a written
> acknowledgment that they,
> (a) **shall only use it for electoral purposes and shall not use it for commercial purposes**;
> (b) are bound by the restrictions in this subsection and subsection (8); and
> (c) may only disclose its content to others after obtaining their written acknowledgement that
> they are bound by the restrictions in this subsection and subsection (8).

> **23 (8)** ... 1. In the case of a person who has been provided with ... part of the voters' list
> from a certified candidate under subsection (4), i. **they shall not provide it to any other
> person, and shall not make further copies, either in printed form or electronically** ...
> iii. if they received an electronic copy, they shall **destroy** it, and shall provide the person
> who provided it with a **written acknowledgment of the destruction** ...
> 4. A certified candidate ... shall, on or before the day when the candidate's election campaign
> period ends under subsection 88.24 (1), i. destroy the part of the voters' list ...
> 5. The written acknowledgements received under this section shall be **retained for the term of
> office of the council** ... and until their successors are elected.

**s. 88 is not the voters-list-use provision.** s. 88 is election *records*: 120-day retention
(88(1)–(2)), public inspection of filed documents (88(5)), no extracts or copies of the voters' list
from that public-inspection route without a court order (88(7.1)), no use of public-record
information except for election purposes (88(10)), and no posting the voters' list publicly (88(11)).
88(10) governs a *different pathway* — information a member of the public obtains by inspecting
records at the clerk's office — not the candidate's own s. 23(4) copy. **Fix the citation in the repo
docs.**

**Now the two substantive corrections, and they point in opposite directions.**

**Correction 1 — there is no "no merging" rule anywhere in Ontario law.** An exhaustive search of the
current MEA consolidation, O. Reg. 101/97, and a dozen municipal clerks' forms and procedures found
**no** provision restricting merging, combining, linking, or enriching the voters' list with other
data. The only words are "electoral purposes" and "not commercial", plus mandatory destruction at the
end of the campaign period. The repo's "no merging into other contact lists" is a **self-imposed
policy, stricter than the law** — a defensible choice, but it should be labelled as a choice rather
than presented as a statutory requirement, because a reader who discovers the difference will trust
the rest of the document less.

**Correction 2 — and this is the one that kills the product.** s. 23(8) para. 1(i) binds every
downstream recipient: they *"shall not make further copies, either in printed form or
electronically."*

A SaaS enrichment vendor cannot honour that sentence. Copying is what the architecture *is*:
database replicas, backups, caches, log lines, a queue, a warm standby, a staging restore. Then
s. 23(8) para. 1(iii) requires the vendor to destroy its copy and hand the candidate a **written
acknowledgement of destruction**, and s. 23(8) para. 5 requires the candidate to file that
acknowledgement and keep it for the council's term (the province's guide puts the date at
**15 November 2030** —
[2026 Candidates' Guide](https://www.ontario.ca/document/2026-candidates-guide-ontario-municipal-council-and-school-board-elections/voters-list)).

So a third-party enrichment vendor must, per campaign: sign an acknowledgement, avoid making copies
it structurally must make, destroy everything at campaign end, and certify that destruction in
writing. **It can never accumulate a reusable data asset across campaigns or cycles.** A data
business whose data must be shredded after every customer, and which is forbidden from copying the
data in the first place, is not a data business.

Enforcement is not theoretical. There is no bespoke offence for list misuse; it falls under the
general offence provision, **s. 94**, with penalties under **s. 94.1**: up to **$25,000** for an
individual and **$50,000** for a corporation, with a limitation period running to November 15 of the
fourth year after the election. Where a judge finds the act was done knowingly, the corrupt-practice
consequences attach — which for a sitting mayor means forfeiting the office.

### 1.2 The legal burden also flips onto the seller

There is an asymmetry that is easy to miss:

| Party | PIPEDA | MFIPPA | Practical constraint |
|---|---|---|---|
| The **campaign** | Does **not** apply — a campaign's activities are not "commercial activity" ([OPC, 2021](https://www.priv.gc.ca/en/opc-news/news-and-announcements/2021/an_210513/)) | Binds the **clerk / municipality**, not the candidate | MEA s. 23(7)–(8) + the signed declaration |
| The **add-on vendor** | **Applies fully** — selling a service is commercial activity | n/a | Consent, purposes, safeguards, openness, access |

A municipal campaign in Ontario sits in a genuine privacy-law gap: it is bound by an election
statute and a one-paragraph declaration, and by almost nothing else. **The moment you sell someone
a data product, you leave that gap.** The vendor is an organization collecting, using and disclosing
personal information in the course of commercial activity, and PIPEDA's consent requirement attaches
to it. Electors have not consented to being profiled by a data broker.

That is why the Canadian market looks the way it does — see 1.3 and §5. **Individual-level elector
enrichment is not a constrained opportunity here. As a paid product it is effectively a
non-starter**, and the reason is PIPEDA on the seller's side at least as much as the MEA on the
buyer's side.

**But notice the escape hatch, because it is the business model.** Both problems — s. 23(8) para.
1(i)'s no-further-copies rule and PIPEDA's consent requirement — attach to a vendor *that receives
the list*. A **self-hosted, candidate-operated deployment never makes the vendor a recipient at all.**
The candidate gets the list from their own clerk, runs the software on their own machine, and the
seller never touches a single elector record. That is exactly what this project already is: a
`docker compose` stack on the campaign's own hardware. So the sellable thing is **software and
open-licensed reference data, shipped to the candidate — never a service that ingests their list.**
Every recommendation in §6 respects that line, and it is the single design constraint that should
govern any commercial version.

### 1.3 Aggregate geographic context is clearly viable, and there is an OPC decision almost exactly on point

The OPC has already ruled on the neighbouring fact pattern. A company built consumer mailing lists
by taking publicly available names/addresses and **sorting them by dissemination-area and
postal-code census statistics** (average income, median age, home-ownership rate). The Assistant
Commissioner found no consent was required, on the reasoning that:

> "Nothing changes the fact that the information included in the consumer list is publicly available;
> it merely has been sorted according to geo-demographic data" — and neighbourhood characteristics
> are "information about the neighbourhood, not about the individual."
> — [PIPEDA Case Summary #2009-004](https://www.priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2009/pipeda-2009-004/)

Two important caveats. (a) The names in that case were from telephone directories, which are
**prescribed publicly available information** under PIPEDA's regulations. The municipal voters list
is *not* publicly available in that sense — it is a statutory list released under conditions — so the
"no consent needed" half of the reasoning does **not** transfer. (b) What *does* transfer is the
second half: **attaching area statistics to a record does not create new personal information about
the person.** That is the doctrinal foothold for option (b) in §4.

The openness complaint in that same case *was* well-founded. Meaning: even where the matching is
lawful, failing to say plainly what you are doing is itself a finding against you.

### 1.4 The local facts gut the most-cited data ideas, and hand you a better one

**Middlesex Centre votes by internet and telephone.** Verbatim from the 2026 candidate guide:
"Voting is by internet and telephone." Same method in 2014, 2018 and 2022. Consequences:

- **There are no polls, so there are no poll-level results — ever.** The entire "historical poll
  results / turnout propensity by poll" idea, which dominates the campaign-tech literature, does not
  exist as a dataset for this municipality. The finest historical grain available is the **ward**,
  of which there are five, plus two at-large offices.
- Worse for modelling: in 2022 the **Mayor and Deputy Mayor were both acclaimed**
  ([certified results](https://www.middlesexcentre.ca/sites/default/files/2023-02/Final%20Summary%20of%20Election%20Results%20-%20Middlesex%20Centre%20-%20Certified.pdf)),
  and the contested ward races were decided by hundreds of votes (Ward 1: 615–494; Ward 2: 312–270;
  Ward 4: 903–73; Ward 3 acclaimed). There is essentially no historical signal to model on.
- But the same e-voting system produces something far more valuable: **a live "who has already
  voted" feed, given to candidates by the clerk.**

> "Candidates may view the names of the electors who have already voted through the Candidate's
> Module where the Form EL14 ... has been completed and returned to the Municipal Clerk."
> — Middlesex Centre 2026 candidate guide, p.18

Voting runs **09:00 Monday 19 October to 20:00 Monday 26 October 2026** — an eight-day window with a
continuously updating strike-off list. Ingesting that into the canvass tool so the GOTV list shrinks
in real time is worth more than every third-party dataset in this report combined, costs nothing to
license, and is unambiguously an "electoral purpose" within s. 23(7)(a). **That is the add-on.**

**With one large caveat that has to be stated up front.** The City of Hamilton's Auditor General
surveyed all 150 registered candidates after the 2022 election and found **36% had problems with the
electronic elector list on election day**. Two candidate comments from that survey:

> "On election day the portal was useless. The idea that the candidate could get up to the minute
> updates on who voted just didn't happen."
> "The list stopped updating … I wasted my time waiting for the email that never arrived, so I could
> print the list and focus our team's efforts on those voters who hadn't yet voted."

The Auditor General also identified the structural cause: **"there is no legislative requirement to
provide strike off data on voting day to candidates."** The Candidate Access Portal is an *optional
paid module the municipality buys*, not a candidate entitlement — and Intelivote's candidate module
is reported to be read-only search with **no documented CSV export or API**.

So the opportunity is real and the gap is real, but the feed is a **dependency you do not control and
may not get**. Design for a manual paste or a downloaded file as the primary path and treat any live
sync as a bonus — and ask the clerk before assuming either. See §4 and §6.

### 1.5 And the budget is the size of a used car

The general spending limit is set by **O. Reg. 101/97 s. 5** under MEA s. 88.20(6), verbatim:

> "In the case of a candidate for the office of head of council of a municipality, the amount shall
> be calculated by adding together **$7,500 plus 85 cents for each elector** entitled to vote for the
> office."

The amount was last set in 2016 and is **not indexed**. MEA s. 88.20(11) uses the greater of the
previous election's list or the current one; the 2022 certified count was **14,313**, this project's
loaded list is **16,892**, so the latter governs:

| | Formula | Amount (CAD) |
|---|---|---|
| Mayor — general spending limit | 7,500 + 0.85 × 16,892 | **$21,858.20** |
| Mayor — self-funding cap (candidate + spouse) | 7,500 + 0.20 × 16,892 | **$10,878.40** |
| Mayor — parties and expressions of appreciation | 10% of the limit | **$2,185.82** |
| Ward councillor (~3,378 electors/ward) | 5,000 + 0.85 × 3,378 | **~$7,871** |

Any individual contributor is capped at **$1,200**, and at **$5,000** across all candidates for the
same council. So the money must come from roughly a hundred separate donors, or from a self-funding
envelope of about $10,900. One thing that *is* exempt from the limit: fundraising expenses, entirely
(MEA s. 88.20(8) via s. 88.19(3) para. 5) — the separate 10% cap covers parties and appreciation, not
fundraising. **The operative number is the clerk's certificate, due on or before 30 September 2026;
s. 88.20(14) makes the clerk's calculation final.**

Against that, the cheapest credible commercial alternative — Ecanvasser Core at US$99/mo — runs about
US$400 over a four-month campaign, roughly **2.5% of the legal budget**. That is affordable, which
matters: it sets the ceiling. A municipal candidate's realistic tolerance for a *data add-on*, as
distinct from the core tool, is **low three figures, one-time**. See §5.

---

## 2. Legal analysis

### 2.1 What the Act and the paperwork actually say

| Instrument | What it does | Verified? |
|---|---|---|
| **MEA s. 23(4)** | The clerk shall, on a certified candidate's written request, provide the part of the voters' list for that office | **Verified verbatim** ([e-Laws](https://www.ontario.ca/laws/statute/96m32)) |
| **MEA s. 23(7)** | **The use restriction.** No copy is released without a written acknowledgement that the person will "only use it for electoral purposes and shall not use it for commercial purposes", is bound by 23(7)–(8), and may disclose only after obtaining the recipient's own written acknowledgement. In force 1 Jan 2023 | **Verified verbatim** |
| **MEA s. 23(8)** | The downstream regime: no onward sharing, **no further copies print or electronic**, return/destroy, written acknowledgement of destruction, candidate destroys by end of the campaign period (s. 88.24(1)), acknowledgements retained for the council's term | **Verified verbatim** |
| **MEA s. 88** | Election *records* — 120-day retention (88(1)–(2)); public inspection (88(5)); no extracts/copies of the voters' list from that route without a court order (88(7.1)); no use of public-record info except for election purposes (88(10)); no public posting of the list (88(11)) | **Verified verbatim. The repo's s. 88 citation is misplaced** — 88(10) governs the *public-inspection* pathway, not the candidate's s. 23(4) copy |
| **O. Reg. 101/97 s. 9** | Prescribes, for s. 88(11)(b), the prohibited ways of making the list available to the public: "1. Posting on an Internet website. 2. Any other print or electronic medium of mass communication" | **Verified verbatim** |
| **Form EL14 / equivalents** | The clerk's implementing form. Wording varies by municipality and some are **stale**: Peterborough's 2026 form still cites the pre-2023 "s. 23(4)(5)" and carries only the bare use clause; Midland's cites s. 23(7) and reproduces the full restrictions | **Verified verbatim** ([Peterborough](https://www.peterborough.ca/media/4p2nxsoj/el14-2026-candidates-declaration-proper-use-of-voters-list.pdf) · [Midland](https://www.midland.ca/your-government/2026-elections/information-for-candidates/)) |
| **MEA s. 94 / 94.1** | General offence. Up to **$25,000** for an individual, **$50,000** for a corporation or trade union; six months' imprisonment where done knowingly; corrupt-practice consequences including forfeiture of office. Limitation: 15 November of the fourth year after the election | **Verified** |
| **MFIPPA ss. 31–33** | Bind the **clerk**, not the candidate: the institution may not use or disclose personal information except for the purpose it was compiled or a consistent purpose (s. 33: one "the individual might reasonably have expected"). MEA s. 88(5) expressly overrides MFIPPA for the 120-day public-record window | **Verified verbatim** |

**Reading.** The prohibition is on *use*, and it has two limbs: the use must be an **electoral
purpose**, and it must not be **commercial**. Neither limb says anything about the *shape* of the
record. That matters for the three questions asked:

**(a) Is appending third-party data to list-derived records permissible?**
On the statute, **appending is not prohibited**. There is no merging, combining, linking or
enrichment restriction anywhere in the MEA, in O. Reg. 101/97, or in any clerk's form located
(§1.1, Correction 1). What is prohibited is using the list for a non-electoral or commercial purpose.
Appending census or turnout context *in order to canvass more efficiently in this election* is, on a
plain reading, an electoral purpose.

Two things nonetheless constrain it in practice. First, the resulting merged record is **harder to
destroy credibly** at the end of the campaign period, and destruction is mandatory under s. 23(8)
para. 4 — a merged store means proving that the third-party columns went too. Second, and decisively,
if the append comes from a paid vendor then **s. 23(8) para. 1(i) bites**: that vendor is a
downstream recipient forbidden from making further copies. See 1.1.

The IPC has read these provisions the same way. In **Order MO-4176** (City of Mississauga, 18 March
2022) — itself a case about a *ward council candidate* seeking the list of who voted — the
adjudicator held the MEA restrictions "**only limit what can be done with the records once
disclosed**", following Order M-1154's distinction that "a distinction must be drawn between
disclosure and use in this context"
([MO-4176](https://decisions.ipc.on.ca/ipc-cipvp/orders/en/item/520943/index.do)). The same order
notes at footnote 21 that enforcing the MEA is **outside the IPC's jurisdiction** — so the remedy for
misuse is a prosecution under s. 94, not a privacy complaint.

**(a2) One provision that touches this project's architecture directly.** MEA s. 88(11) plus
O. Reg. 101/97 s. 9 prohibit making the voters' list available to the public by "posting on an
Internet website" or "any other print or electronic medium of mass communication." This tool *is* a
website. What keeps it on the right side of that line is precisely what the repo already does —
login on every page, TLS only, role-gated fields, volunteers seeing anonymous points rather than
names. Those are not merely good hygiene; they are the reason s. 88(11) is not engaged. Any feature
that would render list-derived data at a public URL — a shareable map link, an unauthenticated
embed, a public "have you voted" widget — would engage it. **Worth a comment in the code.**

**(b) Is *deriving* insight without merging different?**
Yes, materially, and this is the most useful distinction in the whole memo. If the campaign computes
"households on this street sit in DA 3539xxxx, whose census profile is 62% owner-occupied, median age
47" and *displays that beside* the household rather than *writing it onto* the elector record, then:
- no third-party data ever enters the elector table;
- the join key is a **geography**, not a person;
- `make purge` still destroys everything list-derived, and the census layer is public and can stay;
- and per PIPEDA #2009-004, the area statistic is "information about the neighbourhood, not about
  the individual" even when displayed next to a name.

Architecturally this is a **left join at read time on `DAUID`, never a column on `voter`** — exactly
the same instinct the codebase already had when it put `voter_contact` in a separate table instead of
columns on `voter` (`API.md`, "Voter contacts"). The precedent is already in the repo.

**(c) MFIPPA / PIPEDA / CASL.**
- **MFIPPA** binds the municipality and the clerk, not the candidate — ss. 31–33 restrict what *the
  institution* may use and disclose, and s. 33 defines a consistent purpose as one "the individual
  might reasonably have expected." It is why the clerk imposes conditions; it is not a direct
  obligation on the campaign. (MPAC's own release guidelines are governed by the *Assessment Act*,
  MFIPPA and the MPAC Act —
  [MPAC guidelines](https://www.mpac.ca/en/AboutUs/Policies/Guidelinesreleaseassessmentdata).)
  Note MFIPPA was substantially amended effective 1 July 2026; ss. 31–33 were not touched.
- **PIPEDA** does not apply to the campaign (non-commercial). It applies **fully to any vendor**
  selling the add-on. See 1.2. This is the decisive point.
- **CASL** — the campaign is in better shape than it might assume. CASL bites on *commercial*
  electronic messages. A GOTV reminder or a policy update is not commercial. Fundraising asks are
  expressly excluded by regulation: CEMs sent by or on behalf of "a political party or organization,
  or a person who is a candidate — as defined in an Act of Parliament or the legislature of a
  province — for publicly elected office" whose **primary purpose is soliciting a contribution**
  ([Electronic Commerce Protection Regulations, SOR/2013-221](https://gazette.gc.ca/rp-pr/p2/2013/2013-12-18/html/sor-dors221-eng.html)).
  An Ontario municipal candidate *is* defined under a provincial Act (the MEA), so the exclusion
  should reach them. **Note the exclusion is narrow — it covers the fundraising ask only.** The
  project's existing per-purpose consent model (`consent_gotv` / `consent_updates`, withdrawal
  recorded not deleted) is already more conservative than CASL requires, which is the right posture.

### 2.2 Telephone and SMS: the exemption you have, and the one you don't

**First, a correction to my own earlier reading.** Telecommunications Act s. 41.7 gates the National
DNCL political exemption on a **registered political party**, which on its face excludes a
non-partisan Ontario municipal candidate. But the CRTC closed that gap administratively. **Unsolicited
Telecommunications Rules, Part II, Rule 3.1** (added by Telecom Regulatory Policy CRTC 2009-200)
extends the exemption to "a candidate as defined in subsection 2(1) of the *Canada Elections Act*
**or a candidate under provincial law for the purposes of a provincial or municipal election**, or by
or on behalf of the official campaign of such a candidate." No party qualifier.

**So you are exempt from the DNCL** — cite Rule 3.1, not s. 41.7 — and you avoid the national DNCL
subscription entirely. You must still identify yourself at the start of every call and maintain an
**internal do-not-call list** (14 days to add, 3 years to retain), which the existing
`voter_contact.withdrawn_at` design already supports.

**The real constraint is the ADAD rules, and they are sharper.** Part IV applies whether or not you
are DNCL-exempt, and the CRTC's position is that political parties and candidates "**are not allowed
to use ADADs for the purpose of solicitation**" — the sole exception being where the person called
has **expressly agreed**. In plain terms: **a fundraising robocall to a list, without prior express
consent, is illegal in Canada, and there is no political exemption from that.** Non-solicitation
robocalls (GOTV, voting instructions, a town hall notice) are permitted subject to Part IV: identify
at the top, give a valid email or postal address plus a phone number live for at least 60 days,
re-identify if the message runs past 60 seconds, disconnect within 10 seconds, no sequential
dialling, never call emergency or healthcare lines.

**Calling hours** for both the Telemarketing and ADAD rules: **09:00–21:30 weekdays, 10:00–18:00
weekends, in the recipient's local time.** Do not confuse these with Ontario's multi-residential
building canvassing-access hours, which govern door-knocking rather than phoning.

**Two SMS-specific traps that will not be obvious.**

- **Campaign Verify is US-only, and from 17 February 2026 carriers require its Auth Token for
  *political* messaging on 10DLC, toll-free and short code — for traffic to the US *and Canada*.**
  Eligibility is limited to organizations registered with the FEC or a US state/local/tribal election
  authority. A Canadian municipal candidate cannot qualify. The practical workaround is a **Canadian
  local long code**, staying off the toll-free political use-case path. **Confirm with the provider
  before committing** — this is reported behaviour, and whether the 527 scoping actually binds a
  Canadian sender is unresolved.
- **Throughput, not price, is the ceiling.** Unregistered Canadian long codes are informally throttled
  to roughly **100–250 messages per day per number, with the excess failing silently**. Sending to
  ~17,000 electors would take one number about 70–170 days. A two-day GOTV blast needs on the order
  of 40 numbers. Any design that assumes "send to everyone on Sunday night" will fail quietly.
  *(Reseller-reported, not confirmed in first-party carrier documentation — verify before building.)*

**Costs, for scale** (20,000 single-segment messages, Canadian long code, one month, USD, carrier
fees included): Bird ≈ $268 · **Twilio ≈ $326** · CallHub ≈ $685 · EZ Texting ≈ $1,300+. Telnyx does
not publish Canadian messaging rates at all. Note carrier surcharges differ *by provider* for the
same carrier, so never compare base rates alone. And one content trap: a single accented character —
`é`, `à`, or a curly apostrophe — forces UCS-2 encoding, cutting the segment limit from 160
characters to 70 and silently tripling the cost of a message.

**Needs counsel before any voice-dialling or bulk-SMS feature ships** — specifically on the ADAD
solicitation rule and on whether Campaign Verify's requirement reaches a Canadian sender.

### 2.3 The thing you cannot do, stated plainly

**Do not upload list-derived data to an advertising platform's custom-audience tool.** The statutory
argument is short and, I think, decisive. Uploading is a **disclosure** of the list's content, and
s. 23(7)(c) permits disclosure "only ... after obtaining their written acknowledgement that they are
bound by the restrictions in this subsection and subsection (8)". Meta will not sign a candidate's
s. 23(8) acknowledgement. Even if it did, s. 23(8) para. 1(i) would forbid it from making further
copies, which is precisely what a matching pipeline does, and para. 1(iii) would require it to
certify destruction to the candidate.

Meta's own terms point the same way from the other side: the advertiser must "represent and warrant
that you have all necessary rights and permissions and a lawful basis to disclose and use" the data
([Meta terms](https://www.facebook.com/legal/terms/customaudience)). A list released under
"electoral purposes only", with a disclosure-acknowledgement-and-destruction regime attached, cannot
honestly support that warranty. Hashing does not fix it — hashing is a security measure, not a legal
basis, and the disclosure has still occurred.

The compliant alternative is real and costs nothing extra: **geographic targeting.** Postal-code and
radius targeting on both platforms needs no list upload at all. It is less precise and it is legal.

This is, incidentally, the single most common thing a US-trained campaign consultant will suggest,
and it is the one this project should refuse outright.

### 2.4 What the clerk's conditions typically say

Middlesex Centre's published condition is exactly the EL14 wording and nothing further. But clerks
vary a great deal, and **two neighbouring Middlesex County municipalities impose conditions that
would directly constrain this tool:**

> "Each candidate shall be required to sign the 'Declaration of Proper Use of the Voters' List'
> Form EL14. **Access shall be through Intelivote portal or electronic copy only. Electronic copies
> shall be provided on thumb drives.**"
> — [Municipality of West Elgin, 2026 Election Procedures](https://www.westelgin.net/public/download/files/347366)

Thames Centre's 2026 clerk's procedures use near-identical wording ("Access shall be through
Intelivote portal or electronic copy only. Electronic copies shall be provided on USB drives or via a
secure link") and add a further layer — a separate "Policy for Use of the Voters' List", Form TC11,
whose text is not published
([Thames Centre 2026 Clerk's Procedures](https://www.thamescentre.on.ca/media/tzaiesld/2026-tc-clerks-procedures-public-version.pdf)).
Loyalist Township runs a three-form model including a dedicated s. 23(8) acknowledgement form for
each recipient (VL-21, VL-23, VL-24).

Two things follow. **First, the local e-voting vendor is very likely Intelivote** — both Middlesex
County municipalities name it, and Strathroy-Caradoc's 2026 arrangement is reported as a group rate
with Intelivote through Middlesex and Elgin counties. **Second, the Candidate's Module output is
treated as voters'-list data covered by the same declaration.** Midland's 2026 EL14 makes this
explicit, offering as a tick-box "any lists extracted via the **Intelivote Systems Inc. Candidate's
Module**" alongside the paper and electronic list. So the live turnout feed inherits every s. 23(7)–(8)
condition — which is fine, because this tool is already built to those conditions.

**Practical step, and it costs nothing:** ask the Middlesex Centre clerk in writing, before building
anything, (a) whether the release carries conditions beyond EL14 and whether there is an unpublished
use policy like Thames Centre's TC11, (b) whether the Candidate's Module data may be exported or
API'd or is view-only, and (c) what form of destruction confirmation they want under s. 23(8) para. 4.
A one-page written answer from the clerk is worth more than any legal opinion you could buy for the
same effort, and it is the correct first action.

---

## 3. Comparison of sources

Legal-fit column is scored against §2: 🟢 no contact with list data · 🟡 touches list-derived records
or needs care · 🔴 conflicts with the undertaking or with PIPEDA.

| Source | What it adds | Licence / cost | Cadence | Granularity — reaches rural Middlesex Centre? | Access | Legal fit |
|---|---|---|---|---|---|---|
| **StatCan Census Profile 2021** | Age, income, tenure, dwelling type, mother tongue, education, commuting — several hundred variables per area | [StatCan Open Licence](https://www.statcan.gc.ca/en/reference/licence): worldwide, royalty-free, may even resell. Free | Every 5 years (2026 Census data lands ~2027–28, i.e. **after** this election) | **Yes** — dissemination area. 715 DAs in Middlesex CD (verified via StatCan REST) | Bulk CSV per province (~150–740 MB) or the [Census Profile Web Data Service](https://www12.statcan.gc.ca/wds-sdw/2021profile-profil2021-eng.cfm) (SDMX REST) | 🟢 — but note the licence's own bar: you must not "merge or link the Information with any other databases for the purpose of attempting to identify an individual person" |
| **StatCan boundary files (DA/DB/CSD/FSA)** | Geometry to join census to households | StatCan Open Licence. Free | Per census | **Yes** — down to dissemination **block**; 57,932 DAs and 498,547 DBs nationally (verified) | [ArcGIS REST](https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer) or shapefile download | 🟢 |
| **Middlesex County open data** | Address points (already used by `pipeline/build_lists.py`), single-line road network, municipal boundaries | **No licence stated on the portal** (verified: the DCAT feed's `license` and `rights` fields are empty) — a real gap worth resolving in writing | Address points last modified 2026-08-12 | **Yes** — it is the county's own data; 8,016 points in Middlesex Centre | [DCAT feed](https://data-middlesex.opendata.arcgis.com/api/feed/dcat-us/1.1.json); GeoJSON/CSV/SHP/KML + ArcGIS REST | 🟢 — fields are `MUNNUMBER, STREET_NAM, STREET_TYP, STREET_DIR, STREET_UNI, FULLADDRES, POINT_X/Y`. **No owner names.** Pure geometry |
| **Clerk's Candidate's Module (e-voting)** | **Live "has voted" strike-off during the 8-day voting period** | Free — provided by the clerk on filing EL14 | Continuous, 19–26 Oct 2026 | Exact — it *is* the municipality's own electorate | Vendor portal, credentialled. Another Ontario municipality's e-voting procedures describe it as the provider making "available IDs and passwords for candidates and their scrutineers to connect to a Candidate module ... only if they have voted in the election" ([Greenstone e-voting procedures, 2022](https://www.greenstone.ca/media/uohj3ik4/evoting-policies-procedures-2022-final.pdf)). **Export/API availability not established** | 🟡 — squarely an electoral purpose, but it is list data and inherits every s. 23(7)–(8) condition. Midland's 2026 form makes this explicit, listing "any lists extracted via the Intelivote Systems Inc. Candidate's Module" alongside the paper and electronic list |
| **Elections Ontario poll-level results** | Provincial vote pattern by polling division | Shapefiles are under a [Limited Use Data Product Licence](https://www.elections.on.ca/en/voting-in-ontario/electoral-district-shapefiles/limited-use-data-product-licence-agreement.html): **personal, non-commercial use only; no sublicensing; no derivative products for distribution or sale without written permission** | Per provincial election | Provincial polls do not align to municipal wards | CSV / [Data Explorer](https://results.elections.on.ca/en/data-explorer) | 🟡 **Licence is fatal to a paid product.** Fine for the campaign's own use, cannot be resold |
| **Elections Canada poll-by-poll + PD boundaries** | Federal vote pattern at polling-division grain | Open Government Licence – Canada. Free | Per federal election (45th GE, Apr 2025) | Yes, but federal PDs ≠ municipal wards | [Open Canada](https://open.canada.ca/data/en/dataset/97a2a33c-54cc-4f2e-82c1-047ad8212f05) SHP/KMZ/GDB | 🟢 — usable and resellable. Predictive value for a **non-partisan** municipal race is weak |
| **Middlesex Centre's own past results** | Ward-level margins and turnout | Public documents. Free | Every 4 years | Ward only (5 wards) — **no polls, e-voting** | PDF scrape | 🟢 — but see 1.4: mayoralty acclaimed 2022, near-zero signal |
| **MPAC assessment data** | Property type, structure, valuation, ownership | Commercial. Bulk extracts for up to 5.6M Ontario properties via [Property Data Solutions](https://www.mpac.ca/en/CommercialSolutions/PropertyDataSolutions); **pricing not public** | Annual roll | Yes | Contract / `propertyline.ca` | 🔴 for elector-level use. Ownership data joined to a named elector is precisely the enrichment PIPEDA blocks for a vendor. Also expensive and quote-only |
| **Ontario Parcel (Teranet/MPAC/MNR)** | Parcel geometry, PIN, assessment roll number | Commercial via [Teranet](https://www.teranet.ca/geospatial-solutions/ontario-parcel/); not open | Continuous | Yes | Licence | 🟡 useful for turf-cutting; cost almost certainly disproportionate |
| **Canada Post AddressComplete** | Address validation / autocomplete / postal code lookup | **Published, credit-based**: $35/300 lookups up to $20,000/500k; ~7–11.6¢ per lookup at small volumes; no free tier ([pricing](https://www.canadapost-postescanada.ca/ac/pricing/)) | Continuous | Yes | REST API | 🟡 sending an address to a vendor is a disclosure. Cheap and useful for *self-entered* data (sign requests, contact captures); unnecessary for the list, which the county address points already geocode |
| **Environics Analytics PRIZM** | 67 neighbourhood lifestyle segments keyed to six-digit postal code and dissemination area — the same DA unit StatCan uses, so free and paid data align | 🎁 **[PRIZM Segment Explorer is free](https://prizm.environicsanalytics.com/)** — type a postal code, get the segment. SPOTLIGHT pay-as-you-go reports **$199–$399**; unlimited trade-area licence $2,399; PRIZM add-on $5,999. Full ENVISION licensing 🔒 | Annual | Yes, to postal code | Web app / licence | 🟢 at *area* grain this is the legitimate Canadian pattern (cf. PIPEDA #2009-004). **The free explorer and the $199 report are the only paid-tier data products in this report actually within a municipal campaign's reach** |
| **Commercial consumer data brokers (person-level append)** | Age, income, household composition per named individual | Largely does not exist in Canada at this grain. The OPC's own landscape review found Canadian brokers "use fewer information sets than in the United States" and that some US brokers do not operate here or changed practices ([OPC, 2014](https://www.priv.gc.ca/en/opc-actions-and-decisions/research/explore-privacy-research/2014/db_201409/)) | — | — | — | 🔴 **Avoid entirely.** The Canadian market is thin precisely because PIPEDA consent makes it hard |
| **Meta / Google custom audiences** | Digital targeting of known electors | Ad spend | — | Yes | Platform upload | 🔴 See §2.3. Do not upload list-derived data |
| **Meta / Google *geographic* targeting** | Digital ads by postal code / radius, no list upload | Ad spend only | — | Yes | Ads Manager | 🟢 the compliant way to do digital. Both platforms require political-advertiser verification and a "Paid for by" disclaimer ([Meta SIEP policy](https://transparency.meta.com/policies/ad-standards/SIEP-advertising/SIEP/)) |
| **Mapping / tiles** | Basemaps | Mapbox: 50k free web map loads/mo. MapTiler: free tier / $25 Flex / $295 Unlimited. **Self-hosted Protomaps: ~$0** | — | Yes | Already MapLibre in this stack | 🟢 |
| **Routing / turf optimisation** | Walk-order, isochrones, turf cutting | **OSRM / Valhalla self-hosted: free.** Mapbox Directions: 100k free/mo then $2/1k. MapTiler has no routing at any tier | — | Yes | Docker container next to the API | 🟢 **Best value-to-effort of any integration here** — no data leaves the box |
| **SMS / voice** | GOTV and reminders | See §5 | — | Yes | API | 🟡 consent model already exists; DNCL question at §2.2 |

---

## 4. What a paid add-on could actually be — ranked by value-to-risk

### Tier 1 — build these

**1. GOTV strike-off against the clerk's Candidate's Module.**
Value: very high. Risk: low legally, **high on delivery**. In an eight-day internet/telephone voting
window with no polling stations, the only meaningful GOTV question is "who hasn't voted yet", and the
clerk is the only source of that answer. Nothing else in this report comes close on value.

But build it defensively, because the Hamilton Auditor General's evidence (§1.4) says the feed fails
for about a third of candidates, there is no statutory duty to provide it, and the portal may be
read-only with no export. **Design the manual path first** — paste or upload a list of voter
identifiers, diff it against the canvass universe, re-cut the remaining turf — and treat any API or
scheduled export as an optimisation you may never get. A tool that turns a clumsy portal download
into a re-ordered walk list in thirty seconds is worth most of the value and depends on nothing.
Legally it is list data used for the election, so it inherits s. 23(7)–(8) and nothing more.

**2. Turf-cutting and walk-order routing (self-hosted Valhalla/OSRM).**
Value: high. Risk: near zero. Rural Middlesex Centre is exactly where routing pays: long concession
roads, scattered doors, volunteer time is the scarce resource. Self-hosted means no data leaves the
server, no per-request cost, no vendor acknowledgement, nothing to destroy. This is the single best
value-to-risk item in the report and it is a Docker container plus a route-order endpoint.

**3. Aggregate geographic context layer (census DA + boundary join at read time).**
Value: moderate. Risk: low. Age structure, tenure and dwelling type by DA tells you where the
retirees are and where the young families are, which is genuinely actionable for message and timing.
Free, open-licensed, resellable, and — critically — **implemented as a read-time join on `DAUID`,
never a column on `voter`** (§2.1(b)). The only caveat worth stating to a user is honesty about
resolution: a DA in rural Middlesex Centre can cover a lot of ground, and the data is from 2021.

**4. Analytics and modelling on the campaign's **own** canvass data.**
Value: moderate, rising over the campaign. Risk: low. Support-rate by street and by ward, canvasser
productivity, contact-rate decay, re-knock prioritisation, sign-to-support correlation. It is the
campaign's own data, no third party, no licence, nothing to destroy that `make purge` doesn't already
destroy. It has the useful property of getting more valuable the more the tool is used — which is the
right shape for a paid add-on.

### Tier 2 — build if asked, price it as workflow not data

**5. Messaging delivery (SMS / email) on the existing consent model.**
Value: high to the campaign. Risk: moderate, and now better understood. CASL is manageable (§2.1) and
the DNCL exemption **does** reach a municipal candidate via CRTC Rule 3.1 (§2.2). The live
constraints are the ADAD solicitation ban, the Campaign Verify problem, and long-code throttling —
all at §2.2. The consent architecture already in `voter_contact` is the hard part and it is already
built, which puts this project ahead of where most vendors start.

**6. Volunteer scheduling, shift management, fundraising/donation intake.**
Value: moderate. Risk: low. No elector data involved. Commodity in general, but the *compliance* half
is not: Ontario municipal rules require contributions only from **individuals resident in Ontario**
(no corporations, no trade unions), cap each contributor at **$1,200** and at **$5,000** across all
candidates in the same jurisdiction, cap cash at **$25**, require a receipt for **every**
contribution, require the candidate to inform every contributor of the limits, and require names and
addresses of anyone over $100 in the financial statement
([2026 candidates' guide, pp.18–19](https://www.ontario.ca/files/2026-03/mmah-2026-candidates-guide-en-2026-03-31.pdf)).
Ineligible contributions must be returned or turned over to the clerk. **Not one platform surveyed
does the four things Ontario requires**: track a running $1,200-per-contributor total, mandatorily
capture name plus full address, reject corporate/union money and enforce Ontario residency, and
produce the Form 4 Schedule 1 contributor tables. NationBuilder has real limit-tracking machinery but
it is FEC-shaped; Campaign Deputy files for US states. The realistic Ontario pattern today is cheque
plus **Interac e-Transfer** — which the province's guide implicitly blesses, since above $25 a
contribution must use "a method that clearly shows where the funds came from" — with the candidate
collecting name, address and eligibility by hand. Processor rates if you do take cards: **Stripe
2.9% + CA$0.30**, **Square in-person 2.5%**, **Helcim interchange + 0.5% + 25¢** (cheapest all-in).
⚠️ **Zeffy's "free" positioning is unresolved** — its eligibility article lists political campaigns
while its NPO terms prohibit political contributions and exclude individuals. Get that in writing
before depending on it; a mid-campaign account freeze would be catastrophic.

### Tier 3 — do not build

**7. Individual-level elector enrichment from commercial data.** 🔴 The core ask, and the answer is
no. Three independent reasons, any one of which is sufficient: **MEA s. 23(8) para. 1(i)** forbids a
downstream recipient from making further copies "either in printed form or electronically", which no
hosted service can honour (§1.1); **PIPEDA** attaches to the vendor, and the electors being profiled
have not consented (§1.2); and the Canadian person-level append market barely exists, for that same
reason. There is no version of this that is both useful and safe.

**8. Advertising-platform custom audiences from list data.** 🔴 §2.3.

**9. Reselling Elections Ontario shapefiles or derived products.** 🔴 The Limited Use licence
prohibits it explicitly.

---

## 5. Market reality

**Size of the addressable market.** Ontario ran **6,325 council candidates for 2,842 positions** in
2022, an average of 2.23 candidates per seat
([AMO post-election analysis](https://www.amo.on.ca/policy/municipal-governance-indigenous-relations/analysis-2022-municipal-post-election-data)).
That looks like a market until you decompose it: **548 council positions (19%) went by acclamation,
including 139 mayors and reeves**; 32 councils were acclaimed entirely, all in municipalities of
10,000 or fewer; and the candidate count has fallen roughly 20% since 2010. Turnout across 385
municipalities was **32.9%** ([AMCTO](https://www.amcto.com/about-amcto/news-announcements/2022-municipal-elections-survey-key-findings)).
Most of the 6,325 are ward councillors whose spending limit is **$5,000 + $0.85/elector** — in
Middlesex Centre, about **$7,900 per ward**. The number of Ontario municipal campaigns per cycle with
both a contested race and a budget that can absorb software is realistically in the **low hundreds**,
once every four years.

**Where this municipality sits.** 344 of Ontario's ~413 election-holding municipalities have fewer
than 25,000 residents; the median is about 6,500. Middlesex Centre at ~18,900 is a *large* small
municipality — big enough for a real campaign, small enough that no vendor is chasing it. The 2022
local numbers make the point: 14,313 electors, 3,718 votes cast, **26.0% turnout**, and **Ward 2 was
won with 312 votes on a margin of 42**. At that scale organisation beats money, which is precisely
why tooling matters and precisely why nobody sells into it.

**What incumbents charge** (USD unless noted; observed on vendor pages 5–6 September 2026):

| Vendor | Price | Fit for a $21.9k CAD municipal campaign |
|---|---|---|
| **Ecanvasser** | **Core $99–$299/mo** (2,500 → 50,000 contacts) · Pro $599–$1,299/mo · Enterprise 🔒, 12-month minimum. Unlimited users. API access is a **+$99/mo add-on** ([pricing](https://www.ecanvasser.com/pricing)) | Core covers 16.9k electors: **~US$400–600 over four months, 2.5–4% of the budget.** This is the price to beat |
| **CanvassLite** | Starter $99/mo · Growth $199/mo · **Season Pass $399 one-time = 12 months of Growth**; unlimited users, all features on every plan ([pricing](https://canvasslite.com/pricing)) | **The one-time seasonal price is the right commercial shape for a municipal race** — worth studying |
| **WalkLists** | Free (500 contacts) · Local $23/mo · Campaign $49/mo · Party $159/mo (25,000). ⚠️ paid plans auto-renew for 12 months ([pricing](https://walklists.com/pricing)) | Cheapest credible option; the 12-month lock-in is wrong for an 8-week campaign |
| **Qomon** | ≤20,000 contacts: **$217/mo Essential**, $308/mo Advanced (annual) ([pricing](https://qomon.com/pricing/)) | Selectable North American hosting; no partisan gate. Priced above Ecanvasser Core |
| **NationBuilder** | Published to **10,000 contacts** — Pro $505–$575/mo at 9–10k; Election pack +$89/mo ([pricing](https://nationbuilder.com/pricing)) | **16,892 electors exceeds the published ceiling → 🔒 Enterprise quote.** Effectively unpriceable here |
| **CallHub** | Pay-as-you-go, $0 licence: $0.045/dial, $0.034/SMS segment, $0.046/min broadcast. Scale tier 🔒 with $2,500 minimum ([pricing](https://callhub.io/pricing/)) | Usable à la carte; the Scale minimum is a non-starter |
| **Campaign Deputy** | $155–$275/mo ([pricing](https://www.campaigndeputy.com/pricing/)) | Its whole value is FEC and US-state electronic filing — **worthless in Ontario** |
| **NGP VAN, Bonterra/EveryAction, Aristotle, PDI, Impactive, Reach** | 🔒 or US-gated | NGP VAN is gated through US Democratic committees; Impactive and Reach have no Canadian path at all |
| **Party stacks — Liberalist (a modified NGP VAN instance), CIMS, Populus** | Not purchasable | **Irrelevant here** — Ontario municipal elections are non-partisan, so there is no party stack to borrow. That absence is most of why the niche exists |
| **Environics** | 🎁 **PRIZM Segment Explorer is free** ([link](https://prizm.environicsanalytics.com/)); SPOTLIGHT pay-as-you-go reports **$199–$399** | The free explorer and the $199 report are genuinely within reach — the only paid data product in this whole report that is |

**The niche is narrower than it first looks — two Canadian competitors already occupy it.**
I initially wrote that nothing is built for Ontario municipal campaigns. That is wrong, and worth
stating plainly:

- **[Just Canvass](https://www.justcanvass.ca/)** — Canadian-built, explicitly for municipal
  elections, with pre-loaded address data for BC, Ontario and Manitoba municipalities, sign
  management, phone banking and GOTV cross-off. Platform licence is **🔒 quote-only**, though usage
  rates are published ($0.035/text, $0.035/min calling).
- **[Fieldcraft / Campaign Insights](https://www.campaigninsights.ca/)** — "Built in Ontario…
  purpose-built for municipal campaigns." Canvassing, turf cutting, phone banking. **🔒 no pricing
  published anywhere.**

So "canvassing app for Ontario municipal campaigns" is taken, twice. **What neither has done** is the
three things below — and that is where any differentiation has to live.

**What is genuinely unserved.**

1. **List ingest.** Just Canvass's headline feature is that you *don't need the voters' list* — it
   ships address points instead. That is a workaround, not a solution: it throws away elector names
   and per-address elector counts, which is the difference between knocking 3,378 doors and knocking
   the doors where you can greet someone by name. Meanwhile **2026 is the first cycle sourced from
   Elections Ontario rather than MPAC**, so no vendor's 2022-era parser is known-good, and the
   delivery format is **not prescribed anywhere in the Act or the regulation** — it is a per-clerk
   decision. This project's importer already does this work: geocoding, deduplication, residency
   classification, quality flags. **It is quietly the most differentiated thing in the codebase.**
2. **The week-long internet-voting GOTV window.** 217 Ontario municipalities used online or phone
   voting in 2022. Every commercial canvassing tool is built around election-day polls and
   MiniVAN-style poll books. **None models an eight-day voting window with daily strike-off** — see
   the caveat in §4, which is substantial.
3. **The 2026 destroy-and-attest regime.** Track every recipient, collect written destruction
   acknowledgements, destroy all copies at campaign end, retain the acknowledgements for the
   council's term. **No incumbent markets this**, and a candidate who has uploaded the list to US
   multi-tenant SaaS cannot honestly certify destruction. It turns self-hosting from a preference
   into the legally cleanest posture (§1.2).

**Willingness to pay — be honest.** A candidate spending $21,858 in total, once every four years, who
already has the core tool, will pay for something that visibly wins votes in the last ten days. They
will not pay a monthly data subscription, and the benchmark is unforgiving: CanvassLite sells a whole
season for **$399 one-time**. Price any add-on as a **one-time per-campaign fee in the $200–$600 CAD
range**, or bundle it and charge more for the core. Anything framed as "data enrichment" will be
compared, correctly, to a $0 alternative: knocking on more doors.

**A note on where the durable value sits.** Nothing in §4 Tier 1 is expensive to run — routing is a
container, census data is free and open-licensed, the turnout feed comes from the clerk. The cost is
all in *building* it and in the specific knowledge of Ontario municipal election law encoded in §2.
That is the moat, such as it is: not data, and not software, but having read the Act.

---

## 6. Recommendation

**Build first, in this order:**

1. **Ask the clerk three questions in writing** (§2.4), before any code. Zero cost, highest
   information yield in this document.
2. **GOTV strike-off ingestion.** Highest-value item here by a wide margin, and it exists because of
   a local fact — internet/telephone voting over eight days — that no competitor's product model
   accounts for. **Build the manual-import path first** (§4.1); the live feed is a dependency you do
   not control and a third of candidates did not get it working in 2022.
3. **Self-hosted routing (Valhalla or OSRM) for turf cutting and walk order.** Free, offline, no
   third party, immediately useful on rural concession roads.
4. **Census DA context as a read-time join** — a separate `census_da` table keyed on `DAUID`, joined
   at query time, never written onto `voter`. Mirror the `voter_contact` precedent already in the
   schema.
5. **Own-data analytics** — support rate by street/ward, canvasser productivity, re-knock priority.

**Avoid entirely:**

- Individual-level elector enrichment from any commercial source (§1.2). This is the idea the brief
  asked about and the honest answer is no.
- Uploading list-derived data to Meta or Google custom audiences (§2.3).
- Reselling anything under the Elections Ontario Limited Use licence.
- MPAC or Ontario Parcel bulk data — wrong price point, wrong legal shape, negligible marginal value
  over the county address points already in use.

**Needs a lawyer before anyone writes code:**

- Whether appending *any* third-party data to list-derived records is consistent with s. 23(7)(a)'s
  "electoral purposes only", and whether the read-time-join design in §2.1(b) is meaningfully
  different in law from a merge. My reading is that it is, and that nothing in the Act forbids either;
  a court's reading might differ, and the destruction obligation under s. 23(8) para. 4 is easier to
  discharge honestly with the join than with the merge.
- The **ADAD solicitation ban** at §2.2 — the CRTC's position is that candidates may not use
  automated dialling for solicitation without prior express consent, with no political exemption.
  If any voice feature is ever built, get this checked. (The DNCL question is *resolved*: Rule 3.1
  covers municipal candidates, so no DNCL subscription is needed.)
- **First question to counsel, ahead of the others:** the commercial structure, if this is ever sold
  to *other* candidates. Hand them one sentence — MEA s. 23(8) para. 1(i), "shall not make further
  copies, either in printed form or electronically" — and ask whether any hosted service can comply
  with it, and whether a self-hosted, candidate-operated deployment (which is what this project
  already is) avoids the problem by never making the vendor a recipient at all. That distinction is
  probably the whole business model.

**Free fixes to make in the repo regardless** (not part of the add-on question, but they fell out of
this research):

- `README.md` and `CLAUDE.md` cite "s. 23 and s. 88". Change to **s. 23(7) and s. 23(8)**, and note
  s. 88(11) + O. Reg. 101/97 s. 9 separately as the reason the app requires login on every page.
- The docs state "no merging into other contact lists" as though it were the Act. Relabel it as a
  campaign policy choice (§1.1, Correction 1).
- The destruction deadline in `README.md` is framed around election day. The statutory deadline is
  **the end of the campaign period under s. 88.24(1)**, and the written acknowledgements must be kept
  for the council's term (the province says 15 November 2030). `make purge` should print a dated
  record suitable for filing.

**The strategic point.** The instinct behind the question — "supplement the voters list with better
data" — is imported from US campaign tech, where voter files carry party registration and vote
history and a large legal data-append market exists. **None of those three things exists in Ontario.**
The municipal list carries names, addresses and school support, and nothing else. There is no party
registration because the elections are non-partisan; there is no vote history at poll level because
Middlesex Centre has no polls; and there is no append market because PIPEDA suppressed it.

What Ontario has instead is a turnout feed the clerk *may* hand you during an eight-day voting
window, a first-cycle change of list source that has broken everyone's importer, and a legal regime
that rewards a tool which can prove it destroyed everything. Those three are unserved by every vendor
in this report — including the two Canadian municipal specialists who have already found the niche.
That is a narrower and much stronger position than "supplement the voters list with better data",
which is not available to you and would not be worth much if it were.

---

## 7. What I could not determine

Resolved since first draft (kept here so the trail is visible): the verbatim text of MEA ss. 23 and
88, O. Reg. 101/97, MFIPPA ss. 31–33, the penalty provisions, and the existence of on-point IPC
jurisprudence are all now **verified** against the e-Laws consolidation and the IPC decisions
database. The repo's s. 88 citation is confirmed misplaced.

Still open:

1. **Whether the clerk's Candidate's Module offers export or an API.** Load-bearing for the #1
   recommendation, and answerable only by asking the clerk or the vendor. Intelivote's module is
   reported to be read-only search with no documented CSV export or API, and neither Intelivote nor
   DataFix would meet with Hamilton's audit team. Middlesex Centre's 2026 vendor is **not named** in
   the candidate guide; the Intelivote inference comes from neighbouring West Elgin and Thames Centre
   and is **not confirmed for Middlesex Centre**.
2. **Whether Middlesex Centre imposes conditions beyond EL14.** Thames Centre and West Elgin both
   layer an unpublished "Policy for Use of the Voters' List" on top of the declaration; Middlesex
   Centre's published guide mentions none, but absence from a guide is not proof.
3. **Middlesex Centre's own Form EL14 text.** Referenced in the candidate guide but not posted
   online. The quoted wording in §1.1 is Peterborough's, and Peterborough's still cites the pre-2023
   subsection — so Middlesex Centre's may be either the old or the new form.
4. **Resolved, and my first reading was wrong:** the DNCL political exemption *does* reach a
   non-partisan municipal candidate, via CRTC Unsolicited Telecommunications Rules Part II Rule 3.1
   rather than Telecommunications Act s. 41.7. Still open in that area: whether **Campaign Verify's**
   17 February 2026 political-messaging requirement actually binds a Canadian sender, and whether the
   reported **100–250/day long-code throttle** is real — both are reseller-reported and contradicted
   or unaddressed by first-party carrier documentation.
5. **Pricing for the two Canadian municipal competitors** — Just Canvass and Fieldcraft/Campaign
   Insights are both **quote-only with nothing published**, which is itself the finding. Likewise
   MPAC bulk licensing, full Environics ENVISION licensing, Manifold, and every Canadian pollster.
   No figures guessed.
6. **The file format the clerk delivers the voters' list in.** Not prescribed anywhere in the MEA or
   O. Reg. 101/97 — a per-clerk decision. This is the single biggest unknown for the importer, and it
   matters more in 2026 than usual because the source changed to Elections Ontario.
7. **Whether any IPC guidance exists specifically on candidates' use of the voters' list.** The IPC
   site returns HTTP 403 to automated fetches, so the guidance index could not be read directly.
   Orders MO-4176 and MO-4533 were located and are about *access to* election records rather than
   *policing a candidate's use*. Treat "no dedicated IPC guidance exists" as probable, not confirmed.
8. **Exact 2026 elector count for Middlesex Centre.** The certificate issues on or before 30
   September 2026 (the municipality's own package says 1 October — a one-day discrepancy), using the
   greater of the 2022 count (**14,313 certified**) or the current list. The $21,858.20 figure uses
   this project's own 16,892 loaded voters and is therefore **approximate**; at the 2022 count the
   limit would be $19,666.05. Confirm with the clerk.
9. **Whether the county's open data carries an open licence.** The DCAT feed's `license` and `rights`
   fields are **empty** — verified. The project already depends on this data. Worth an email to the
   county, because "no stated licence" is not the same as "open".
10. **Mississauga's reported judicial review of MO-4176** (said to have failed in November 2022) is
   sourced only to a news site, not to a court citation.
11. **Two cited URLs return HTTP 403 to automated checks** and were read via other routes:
    `crtc.gc.ca/eng/phone/rce-vcr/guidepol.htm` and
    `decisions.ipc.on.ca/.../item/520943/index.do` (Order MO-4176). Both open normally in a browser.
    Every other URL in this document was confirmed to return HTTP 200 on 6 September 2026.
