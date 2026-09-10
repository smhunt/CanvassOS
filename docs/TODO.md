# TODO

Running list of what is asked for, in flight, and deliberately not being built. `CHANGELOG.md` is
what shipped; `prompt_plan.md` is the phase plan; this is the working queue between them.

Last updated **2026-09-10**.

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

## Asked for, not started

- [ ] **Geo-targeted advertising proposals** — Meta/Instagram, Spotify, TikTok, aimed at the rural
      communities. Planning document in progress at `docs/phase-6-advertising-plan.md`. Note the
      first question it has to answer is whether these platforms accept political advertising in
      Canada at all; at least one probably does not, and a plan that assumes otherwise would waste
      real money.
- [ ] **Notifications and in-app messages between organisers and volunteers.** Web Push, free, and
      the installed-PWA prerequisite already shipped. See `prompt_plan.md` "Requested, not yet
      built".
- [ ] **Coverage and support reports** by ward / community / turf / day (Phase 4).
- [ ] **CSV export with an audit entry per download** (Phase 4).

## Recently shipped, worth a second look in the field

- [x] Turf boundaries on the map, scoped; street-picked turfs get an approximate dotted hull.
- [x] Tapping a boundary opens that turf — the map is no longer a dead end.
- [x] Print sheet reachable from the turf drawer, not just the organiser-only Turfs page.
- [x] List skeletons instead of a bare spinner on the door screen and the sheet.
- [x] The unreachable report, with optional Claude-written advice from aggregate counts only.
- [x] Deployed at `https://canvass.webarchitecture.ca`.

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
