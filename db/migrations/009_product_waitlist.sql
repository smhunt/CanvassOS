-- 009 — the CanvassOS product waitlist: other campaigns asking to hear when it opens to them.
--
-- This is NOT election data. Nobody here is an elector of Middlesex Centre by virtue of being on
-- this list; they are candidates, managers and volunteer coordinators elsewhere who typed their own
-- details into the public marketing page. So it is deliberately walled off from everything the
-- Municipal Elections Act governs:
--
--   * no foreign key to `household`, `voter` or `voter_contact`, and no query in the API joins it
--     to any of them. A product enquiry must never become a route by which somebody's details meet
--     the voters list, and a voters-list purge (`make purge`) must not need to think about it;
--   * because nothing references `household`, `importer/import.py`'s `dependents` list (the
--     `--force` guard) is unaffected.
--
-- The governing rule is CASL, as with `subscribe_pending` and `public_request`: `consent_text` is the
-- verbatim wording shown beside the tick box, required, and stored exactly as the page sent it.
--
-- One row per email. A repeat sign-up updates the details and `updated_at` rather than adding a
-- second row, which is also what lets the endpoint answer identically whether or not the address
-- was already here (see api/src/routes/waitlist.ts).
CREATE TABLE IF NOT EXISTS product_waitlist (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,           -- trimmed and lower-cased by the API before insert
  name           text NOT NULL,
  role           text NOT NULL
    CHECK (role IN ('candidate', 'campaign_manager', 'volunteer_coordinator', 'other')),
  municipality   text NOT NULL,                  -- free text: "Middlesex Centre", "Ward 3, Ottawa"
  province       text NOT NULL CHECK (province ~ '^[A-Z]{2}$'),
  -- A fixed list rather than a date: "when is your next election" is answered by year, and
  -- 'unsure' is a real answer from somebody who has not decided to run yet.
  next_election  text NOT NULL
    CHECK (next_election IN ('2026', '2027', '2028', '2029', '2030', 'unsure')),
  notes          text,
  consent_text   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The admin list reads newest first.
CREATE INDEX IF NOT EXISTS product_waitlist_created_idx ON product_waitlist (created_at DESC);

COMMENT ON TABLE product_waitlist IS
  'CanvassOS product waitlist from the public marketing page. Not voter data; never join to voter, household or voter_contact.';
