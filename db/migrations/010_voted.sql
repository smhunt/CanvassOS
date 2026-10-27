-- 010 — who has already voted (the clerk's strike-off / "voted" list), and the file it came from.
--
-- Advance polls open before election day and the clerk tells candidates who has voted. A canvasser
-- at a door on the last weekend should not be asking somebody who voted on Tuesday to vote, and the
-- map should show where the campaign's remaining voters actually are. So each elector carries a
-- `voted_at` stamp, and every file that set or cleared stamps is recorded in `voted_import`.
--
-- It is a column on `voter`, not a table of its own, for the same reason 008 put the cancel stamp
-- on `sign`: there is already exactly one row per elector, every read of a voter already goes
-- through serialize.ts, and a column needs no new foreign key to `household` and so no change to
-- the `--force` guard's table list in importer/import.py (the guard counts the stamps themselves —
-- see `dependents` there). NULL means "not known to have voted", never "has not voted": the clerk's
-- list is only ever a snapshot.
--
-- `voted_import` is the provenance: one row per applied file, with its sha256 so the same file is
-- recognised, who uploaded it, and the counts the operator saw. A dry run writes no row here (and
-- changes nothing) — the audit log records it instead.
CREATE TABLE IF NOT EXISTS voted_import (
  id            serial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       uuid REFERENCES app_user(id),
  label         text NOT NULL,                  -- "advance poll day 2, 2026-10-18"
  mode          text NOT NULL CHECK (mode IN ('merge', 'replace')),
  sha256        text NOT NULL,                  -- of the canonical JSON the API received
  n_entries     integer NOT NULL,
  n_matched     integer NOT NULL,
  n_unmatched   integer NOT NULL,
  n_ambiguous   integer NOT NULL,
  n_marked      integer NOT NULL,               -- voters newly stamped by this file
  n_cleared     integer NOT NULL                -- stamps removed (explicit "not voted", or replace)
);

ALTER TABLE voter ADD COLUMN IF NOT EXISTS voted_at timestamptz;
-- Which file stamped this voter. SET NULL rather than CASCADE: deleting an import's bookkeeping
-- must never un-vote anybody.
ALTER TABLE voter ADD COLUMN IF NOT EXISTS voted_import_id integer REFERENCES voted_import(id) ON DELETE SET NULL;

-- Per-door counts for the map and the door list read "how many at this door have voted", and the
-- stamped set is small until the final days — a partial index keeps that cheap on 17k rows.
CREATE INDEX IF NOT EXISTS voter_voted_idx ON voter (household_id) WHERE voted_at IS NOT NULL;

COMMENT ON COLUMN voter.voted_at IS
  'When the clerk''s list said this elector had voted. NULL = not known to have voted. Set and cleared only by POST /api/voted/import.';
