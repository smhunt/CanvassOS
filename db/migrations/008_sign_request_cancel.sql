-- 008 — cancelling a sign request, stamped rather than deleted.
--
-- A request can be wrong: somebody was testing the button, a web form caught a spammer, the
-- resident changed their mind, or the same door asked twice. Until now there was no way to take
-- one off the delivery list except to place a sign that nobody wanted, or — for a door-asked
-- request — nothing at all.
--
-- The stamp lives on `sign` rather than in a table of its own, for three reasons:
--
--   1. There is already exactly one row per waiting door. `POST /api/contacts` raises a `sign` with
--      status 'requested' for every door that ticks "wants a sign" (api/src/routes/contacts.ts),
--      and the map's door card writes the same row directly. Both kinds of request are therefore
--      anchored to the same table, and a cancel that stamps it covers both.
--   2. No new table means no new foreign key to `household`, and so no change to the `dependents`
--      list in importer/import.py that guards `make import-force`. `sign` is already on that list.
--   3. It is NOT a new value on the sign_status enum, deliberately. ALTER TYPE ... ADD VALUE has
--      its own transaction rules, and more to the point PATCH /api/signs/:id treats "any status
--      other than requested" as a placement and fills placed_by/placed_at — so a 'cancelled'
--      status would eventually be stamped as though somebody had planted it.
--
-- Nothing is deleted. Restoring NULLs these four columns, the same way PATCH /api/signs/:id
-- already clears removed_by/removed_at when a sign marked collected turns out to still be
-- standing; the permanent history of both the cancel and the restore is in audit_log
-- (cancel_sign_request / restore_sign_request), which is the record that has to survive.
ALTER TABLE sign ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;
ALTER TABLE sign ADD COLUMN IF NOT EXISTS cancelled_by  uuid REFERENCES app_user(id);
ALTER TABLE sign ADD COLUMN IF NOT EXISTS cancel_note   text;

-- Why it was cancelled, from a fixed list. Free text would make the one column that exists to be
-- reviewed afterwards unreadable in aggregate, and "was this spam or was I testing" is exactly the
-- question somebody will ask of the audit log in November.
ALTER TABLE sign ADD COLUMN IF NOT EXISTS cancel_reason text
  CHECK (cancel_reason IN ('test', 'spam', 'withdrawn', 'duplicate', 'other'));

-- A cancelled request must carry its reason and its author: a stamp that cannot say who or why is
-- not an improvement on a delete.
ALTER TABLE sign DROP CONSTRAINT IF EXISTS sign_cancel_complete;
ALTER TABLE sign ADD CONSTRAINT sign_cancel_complete CHECK (
  (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL AND cancel_note IS NULL)
  OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)
);

-- Both request branches of GET /api/signs/requests filter on this, and it is a small, very
-- selective set — most signs are never cancelled.
CREATE INDEX IF NOT EXISTS sign_cancelled_idx ON sign (household_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;

COMMENT ON COLUMN sign.cancelled_at IS
  'A sign request withdrawn without being delivered. Never set on a sign that was actually placed.';
