-- 004: let somebody subscribe who is not a door on the voters list.
--
-- voter_contact.household_id was NOT NULL because every contact detail arrived at a door. The public
-- opt-in page breaks that assumption: a stranger scanning a QR code on a lawn sign gives us a number
-- we have never seen, and there is no household to attach it to. Without this the subscribe page can
-- record a pending confirmation and then do nothing with it — the list cannot grow, which is the one
-- thing the whole channel depends on.
--
-- The number is the subject here, not the household. That is the honest model: consent was given by
-- a person about their own phone, not by an address.

ALTER TABLE voter_contact ALTER COLUMN household_id DROP NOT NULL;

-- The existing UNIQUE (household_id, channel, value) does not constrain rows where household_id is
-- NULL, because NULLs are never equal in Postgres — so without this a number could be subscribed
-- twice and be texted twice.
CREATE UNIQUE INDEX voter_contact_unattached_uniq
  ON voter_contact (channel, value)
  WHERE household_id IS NULL;

-- Where the row came from, so an unattached subscriber can be told apart from a doorstep record
-- without inferring it from a NULL. Existing rows are all doorstep by definition.
ALTER TABLE voter_contact ADD COLUMN source text NOT NULL DEFAULT 'door';
COMMENT ON COLUMN voter_contact.source IS 'door | web | inbound — how the consent reached us';
UPDATE voter_contact SET source = 'door' WHERE source IS NULL;
