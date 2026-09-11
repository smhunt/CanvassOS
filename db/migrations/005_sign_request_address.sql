-- Where a lawn sign was actually asked for.
--
-- `wants_sign` has been a bare boolean since Phase 2, and the delivery list derived an address from
-- the household. That is wrong often enough to matter: a corner lot wants the sign on the side
-- street, a farm wants it at the gate rather than the house 400 m up the lane, and a business owner
-- answering their own door frequently means the shop. The driver crews were rediscovering that at
-- every stop.
--
-- Nullable on purpose. Every contact already recorded keeps its boolean and answers "no address was
-- captured", which is the truth about it — backfilling the household address would invent a
-- confirmation nobody gave.
ALTER TABLE contact ADD COLUMN IF NOT EXISTS sign_address text;

COMMENT ON COLUMN contact.sign_address IS
  'Where the resident asked for the lawn sign, when it is not simply the door. Null = not captured.';
