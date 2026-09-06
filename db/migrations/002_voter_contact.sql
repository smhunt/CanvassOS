-- 002: phone numbers and email addresses collected AT THE DOOR, with explicit consent.
--
-- This is deliberately NOT part of the `voter` table, and that separation is the point.
--
-- The clerk's list carries no phone numbers or email addresses. Everything here was given directly
-- by the person standing at the door, for a purpose they were told about. So it is a different kind
-- of data with different rules from the list:
--   * it must never be merged back into an export of the voters list;
--   * it can only be used for the purpose consented to, which is why consent is per-purpose columns
--     rather than one "ok to contact" boolean;
--   * withdrawal has to be recorded, not deleted, so a later import cannot resurrect a number
--     somebody asked us to stop using;
--   * Canada's Anti-Spam Legislation governs electronic messages. Recording WHAT was agreed, WHEN,
--     and WHO took it is what makes a consent defensible if it is ever questioned.
-- It is still destroyed by `make purge` with everything else after the election.

CREATE TYPE contact_channel AS ENUM ('phone', 'email');

CREATE TABLE voter_contact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Either a named person or the door generally ("the number for the house").
  voter_id      uuid REFERENCES voter(id) ON DELETE CASCADE,
  household_id  text NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  channel       contact_channel NOT NULL,
  value         text NOT NULL,

  -- Per-purpose consent. A single "consented" flag cannot answer "did they agree to THIS?".
  consent_gotv     boolean NOT NULL DEFAULT false,  -- a reminder to vote, around election day
  consent_updates  boolean NOT NULL DEFAULT false,  -- general campaign updates
  consent_note     text,                            -- anything they qualified it with
  consented_at     timestamptz NOT NULL DEFAULT now(),
  collected_by     uuid REFERENCES app_user(id),
  -- The doorstep conversation this came out of, so the consent has a context.
  contact_id       uuid REFERENCES contact(id) ON DELETE SET NULL,

  -- Consent withdrawn. The row STAYS: a deleted row would just be re-collected next canvass.
  withdrawn_at  timestamptz,
  withdrawn_note text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, channel, value)
);
CREATE INDEX voter_contact_voter_idx     ON voter_contact(voter_id);
CREATE INDEX voter_contact_household_idx ON voter_contact(household_id);
-- The GOTV send list: consented, not withdrawn.
CREATE INDEX voter_contact_gotv_idx      ON voter_contact(channel) WHERE consent_gotv AND withdrawn_at IS NULL;
