-- 001: lawn signs — placement with GPS, optional photo, and the post-election pickup list.
--
-- Signs are a separate object from households on purpose: many go on road allowances, corners and
-- farm gates that are not a door on the voters list, so household_id is nullable. What matters for
-- retrieval is the coordinate the volunteer actually stood at.
--
-- Ontario municipal sign by-laws require signs to come down within a set period after election day
-- (Middlesex Centre: confirm the exact window with the clerk). A sign that cannot be found is a
-- fine and a bad news story, which is the whole reason for recording GPS and a photo.

CREATE TYPE sign_status AS ENUM ('requested', 'placed', 'removed', 'missing', 'damaged');

CREATE TABLE sign (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL when the sign is not at a door on the list (boulevard, corner lot, business frontage).
  household_id  text REFERENCES household(id) ON DELETE SET NULL,
  status        sign_status NOT NULL DEFAULT 'placed',
  lat           double precision,
  lon           double precision,
  -- The device's reported accuracy in metres. A 60 m fix in a rural back concession is the
  -- difference between finding the sign in November and driving past it three times.
  accuracy_m    real,
  label         text,                      -- what the volunteer called it: "corner of Ilderton Rd"
  size          text,                      -- small / large / frame — free text, campaigns vary
  note          text,
  permission_by text,                      -- who at the property agreed, for private lawns

  requested_at  timestamptz,               -- set when it came from a contact's wants_sign
  requested_from uuid REFERENCES contact(id) ON DELETE SET NULL,
  placed_by     uuid REFERENCES app_user(id),
  placed_at     timestamptz,
  removed_by    uuid REFERENCES app_user(id),
  removed_at    timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Same idempotency contract as contact: a volunteer on a weak rural signal can retry safely.
  client_id     text UNIQUE
);
CREATE INDEX sign_status_idx    ON sign(status);
CREATE INDEX sign_latlon_idx    ON sign(lat, lon);
CREATE INDEX sign_household_idx ON sign(household_id);
CREATE INDEX sign_placed_idx    ON sign(placed_at DESC);

-- Photos live on disk in the `signphotos` volume, not in the database: they are large, they are
-- never queried, and keeping them as files means `make purge` can shred them with the CSVs.
-- A photo of a sign shows someone's house, so it is personal information and is served only
-- through an authenticated endpoint.
CREATE TABLE sign_photo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sign_id      uuid NOT NULL REFERENCES sign(id) ON DELETE CASCADE,
  path         text NOT NULL,              -- relative to SIGN_PHOTO_DIR
  content_type text NOT NULL,
  bytes        integer NOT NULL,
  width        integer,
  height       integer,
  taken_by     uuid REFERENCES app_user(id),
  taken_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_photo_sign_idx ON sign_photo(sign_id);
