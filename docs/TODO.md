# TODO

Running list of what is asked for, in flight, and deliberately not being built. `CHANGELOG.md` is
what shipped; `prompt_plan.md` is the phase plan; this is the working queue between them.

Last updated **2026-09-21**.

---

## Blocking / highest value

- [ ] **Road-test drive mode.** Live in production as 1.1.0, with the selection maths unit-tested
      (`cd web && npm test`) — and that is all that is proven. Drive a concession road with a known
      turf and confirm three things: the card advances at the right moment, it names the correct
      side of the road, and it does not flicker between two neighbouring doors. Also worth checking
      on the actual iPhone: that speech starts after tapping Start, and that the screen stays awake.
- [x] **Deploy 1.3.0.** Done 2026-09-21 with `make restart-tunnel`; the live bundle reports 1.3.0,
      health is green, no migration was pending.
- [ ] **Cloudflare still tells browsers to cache `/sw.js` for four hours.** The origin sends
      `Cache-Control: no-cache` and the edge now revalidates on every request (`cf-cache-status:
      REVALIDATED`), so a deploy reaches the edge at once. But the zone's **Browser Cache TTL is
      14400** and it overwrites the origin header on the way out, so a phone may still sit on an old
      service worker for up to four hours. Fix: one Cache Rule on `webarchitecture.ca` — host
      `canvass.webarchitecture.ca`, path `/sw.js`, Browser TTL "respect origin". The zone has no
      cache rules today. It is a shared zone, so scope it to that one URL.
- [ ] **Listen to it on the actual iPhone.** Speech starts inside a tap everywhere, which is what iOS
      requires, but that has been reasoned and stub-tested, not heard. Check: Start speaks, the
      question mark speaks, and Account → Voice lists voices and the sample plays in the chosen one.
- [ ] **AWS cutover.** The `ca-central-1` host (mode C) is built and rehearsed; the cutover itself
      has not been done, so production is still the office Mac. Never run two tunnel connectors for
      the same hostname at once — Cloudflare load-balances between them, and the two stacks have
      different databases.
- [ ] **Run the e2e suite.** `web/tools/e2e.py` had a stale hard-coded admin password and could not
      log in; it now takes `E2E_BASE` / `E2E_EMAIL` / `E2E_PASSWORD`. Point it at the demo stack and
      run it — nobody has yet, so the new UI checks in it are written but unproven.
- [ ] **Confirm the print fix on the actual iPhone.** The installed-app path now offers "Open in
      Safari to print" instead of a button iOS silently ignores. Verified by reasoning and by the
      platform's documented behaviour, not on the device.

## Asked for, not started

- [ ] **Help button and spoken explanation on the other screens.** The concept shipped on drive mode
      in 1.2.0 (`components/HelpButton.tsx`, a `HelpTopic` of fixed strings per screen). Rolling it
      out is mostly writing: one topic each for the door screen, the map, signs, turfs and messaging.
      Decide per screen whether opening help should speak by default — at a doorstep it should not.

- [ ] **Meta advertising authorization — underway.** Identity confirmation went through on
      2026-09-15; the next step is the confirmation code that arrives by post (3–10 business days
      per the research), then a day or two of disclaimer review. Watch the mail for it.
      `docs/phase-6-advertising-plan.md` has the detail. **TikTok and Spotify are both out** —
      TikTok prohibits political ads globally, and Spotify permits them only in the US, UK,
      Australia, India and Japan. Before spending anything, verify in Ads Manager that political
      ads are *not* subject to the 25 km minimum radius: Meta's API docs say they are not, agency
      blogs say they are, and if the blogs are right the whole approach changes.
- [ ] **Notifications and event hooks.** Designed in `docs/phase-7-notifications-plan.md`, with an
      editable sender/receiver template set already written at
      `api/src/lib/notification-templates.ts`. Nothing is wired up. Phase 7a — an in-app bell with
      no push at all — is the first useful piece and needs no third party. In-app messages between
      organisers and volunteers ride the same delivery path, and carry the retention trap
      `prompt_plan.md` flags: a message WILL contain voters-list data, so it needs the same audit,
      retention and `make purge` treatment as everything else.
- [ ] **Send `consent_text` from the campaign website's form** as the literal wording displayed
      beside the tick boxes, so the stored consent can say exactly what was agreed to. (The address
      field this entry used to ask for is live: the site's form collects one and lawn-sign requests
      arrive with somewhere to deliver them.)
- [ ] **Coverage and support reports** by ward / community / turf / day (Phase 4).
- [ ] **CSV export with an audit entry per download** (Phase 4).

## Recently shipped, worth a second look in the field

- [x] **Drive mode (1.1.0).** The next door *ahead* of a vehicle rather than the nearest, which side
      of the road, spoken aloud, screen kept awake; never speaks a name. Reached from **Drive** on a
      turf's door screen. Design and plan in `docs/superpowers/`. See the road test above.
- [x] **1.0.1:** `TRUST_PROXY` is a hop count, not a flag; backups were being encrypted with an
      empty passphrase on macOS (`.ONESHELL` ignored by Make 3.81) — fixed, and `make backup-offsite`
      added. Worth taking one backup and restoring it somewhere disposable to see it round-trip.
- [x] **Diff-based list re-import (0.7.0).** `make import-diff` previews a newer list, `make
      import-apply` applies it in place, keeping every contact, sign, consent record, turf and
      sign-up. Not yet run against a real second export from the clerk — the first real one is
      worth a careful read of the dry-run report before applying.
- [x] Turf boundaries on the map, scoped; street-picked turfs get an approximate dotted hull.
- [x] Tapping a boundary opens that turf — the map is no longer a dead end.
- [x] Print sheet reachable from the turf drawer, not just the organiser-only Turfs page.
- [x] Loading skeletons shaped like the content, on every list and table screen (0.5.3).
- [x] Website subscriber link (phase 8, 0.6.0–0.6.2): sign-ups from sean-hunt.com are pulled every
      five minutes into the same `public_request` queue the push endpoint writes, with a local
      voter matcher and a Sign-ups screen for confirming matches.
- [x] The unreachable report, with optional Claude-written advice from aggregate counts only.
- [x] Deployed at `https://canvass.webarchitecture.ca`.
- [x] Record a visit from a door on the map, including doors in no turf.
- [x] A lawn sign asked for at the door raises a real `sign` row, with an address prefilled from
      the door and editable for a corner lot, a farm gate or a shop.
- [x] A public endpoint for the campaign website's sign-up form.
- [x] Fixed: OpenStreetMap blocked the app for using their volunteer tile servers as its basemap.
      Streets is Esri now. **Never point a basemap back at `tile.openstreetmap.org`.**

## Not being built, and why

- **Scraping social media profiles of electors.** Asked for on 2026-09-10; declined. Matching
  ~17,000 named private individuals from a government-supplied voters list to their social media
  accounts, and storing what is found, is a different activity from canvassing: it builds a
  surveillance profile of private citizens who never consented and mostly will never know. It also
  runs into the *Municipal Elections Act* s. 23(7)-(8) limits that shape this entire codebase, and
  every major platform's terms of service prohibit the automated collection involved.

  The underlying goal — know more about the people you are trying to reach — has legitimate routes,
  and those are worth building instead:
  - **Consented, at the door.** Already shipped: `voter_contact` records a phone number or email
    with per-purpose consent and a stamped withdrawal. This is the highest-quality data the campaign
    can hold, because the person chose to give it.
  - **Geodemographic, by area not by person.** StatCan census profiles at the dissemination-area
    level — age, income, dwelling type, language — appended to a neighbourhood rather than to a
    named elector. Standard practice, no privacy exposure, and genuinely useful for deciding which
    streets to walk first. See `docs/data-sources-research.md`.
  - **Geographic ad targeting**, which is the request in the section above and reaches the same
    people without holding anything about them.
