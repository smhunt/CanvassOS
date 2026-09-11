# TODO

Running list of what is asked for, in flight, and deliberately not being built. `CHANGELOG.md` is
what shipped; `prompt_plan.md` is the phase plan; this is the working queue between them.

Last updated **2026-09-11**.

---

## Blocking / highest value

- [ ] **Diff-based list re-import.** The biggest gap in the whole project. Today `make import-force`
      runs `TRUNCATE household CASCADE`, which also empties `contact`, `sign`, `sign_photo`,
      `voter_contact` and `turf_household`. If the clerk issues an updated list before 26 October
      there is currently no way to take it without destroying every canvass result, lawn sign and
      consent record collected so far. Needs: match on `natural_key`, classify new / removed / moved,
      show the diff before applying, keep everything that references a surviving household.
- [ ] **Run the e2e suite.** `web/tools/e2e.py` had a stale hard-coded admin password and could not
      log in; it now takes `E2E_BASE` / `E2E_EMAIL` / `E2E_PASSWORD`. Point it at the demo stack and
      run it — nobody has yet, so the new UI checks in it are written but unproven.
- [ ] **Confirm the print fix on the actual iPhone.** The installed-app path now offers "Open in
      Safari to print" instead of a button iOS silently ignores. Verified by reasoning and by the
      platform's documented behaviour, not on the device.

## In flight

- [ ] **Loading skeletons on the remaining screens.** An agent is converting the rest (stats,
      reports, turfs, signs, messaging, users, audit, account, and the route-level Suspense
      fallbacks). Door screen and turf sheet are already done.

## Asked for, not started

- [ ] **Start the Meta advertising authorization today.** Zero development effort, ~2-3 weeks of
      calendar against 46 days, and it is the critical path: the confirmation code arrives by post.
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
- [ ] **An address field on the public campaign website's form.** The endpoint
      (`POST /api/public/requests`) is live and takes one, but the site's form has no address
      input, so a lawn-sign request currently arrives with nowhere to deliver it. Also send
      `consent_text` as the literal wording displayed beside the tick boxes.
- [ ] **Coverage and support reports** by ward / community / turf / day (Phase 4).
- [ ] **CSV export with an audit entry per download** (Phase 4).

## Recently shipped, worth a second look in the field

- [x] Turf boundaries on the map, scoped; street-picked turfs get an approximate dotted hull.
- [x] Tapping a boundary opens that turf — the map is no longer a dead end.
- [x] Print sheet reachable from the turf drawer, not just the organiser-only Turfs page.
- [x] List skeletons instead of a bare spinner on the door screen and the sheet.
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
