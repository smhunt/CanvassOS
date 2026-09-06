-- Middlesex Centre Canvass — Phase 1 schema
-- Plain PostgreSQL 16. PostGIS is available in the production image (postgis/postgis:16-3.4)
-- but Phase 1 deliberately uses lat/lon columns so the schema also runs on a bare Postgres.
-- Phase 2 (turfs) adds:  CREATE EXTENSION postgis;  and a geometry column via migration 002.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy name/address search

-- ---------------------------------------------------------------- users & auth
CREATE TYPE user_role AS ENUM ('admin', 'organizer', 'volunteer');

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  name          text   NOT NULL,
  role          user_role NOT NULL DEFAULT 'volunteer',
  password_hash text,                       -- NULL until the invite is accepted
  invite_token  text UNIQUE,                -- random, single use
  invite_expires timestamptz,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text,
  ip         inet
);
CREATE INDEX session_user_idx ON session(user_id);

-- ---------------------------------------------------------------- imports
CREATE TABLE import_run (
  id            serial PRIMARY KEY,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  source_label  text NOT NULL,              -- e.g. "voters list export 2026-09-03"
  voters_sha256 text NOT NULL,
  households_sha256 text NOT NULL,
  n_voters      integer,
  n_households  integer,
  notes         text
);

-- ---------------------------------------------------------------- households & voters
-- One row per door. id is the pipeline household_id, e.g. H-KOMOKA-00123 / H-LEGAL-0007.
CREATE TABLE household (
  id             text PRIMARY KEY,
  import_run_id  integer NOT NULL REFERENCES import_run(id),
  ward           char(2) NOT NULL,          -- '01'..'05'
  community      text,                      -- Canada Post community: ILDERTON, KOMOKA, ... (NULL for legal)
  postal         text,
  locality       text,                      -- nearest settlement: Ilderton, Kilworth, Ballymote ...
  address        text NOT NULL,             -- canonical one-line: "21584 ADELAIDE ST N" / "93 STONE FIELD LN UNIT 106"
  property_address_raw text NOT NULL,       -- as it appeared on the voters list
  civic_num      text,
  street         text,                      -- STREET_NAM from open data
  street_type    text,                      -- ST, RD, DR, CRES, LN ...
  street_dir     text,                      -- N S E W or NULL
  unit           text,
  lat            double precision,
  lon            double precision,
  addr_match     text NOT NULL,             -- exact | normalized | unit-stripped | nearest-on-street | legal
  record_quality text NOT NULL,             -- good | approx | legal | check
  is_legal       boolean NOT NULL DEFAULT false,   -- concession/lot description, no civic address
  is_institution boolean NOT NULL DEFAULT false,   -- 8+ voters, no units (care home / apartment block)
  n_voters       integer NOT NULL DEFAULT 0,
  n_nonresident  integer NOT NULL DEFAULT 0,
  n_po_box       integer NOT NULL DEFAULT 0,
  street_sort    text,                      -- street||type||dir for walking order
  num_sort       integer                    -- numeric civic number for walking order
);
CREATE INDEX household_ward_idx      ON household(ward);
CREATE INDEX household_community_idx ON household(community);
CREATE INDEX household_latlon_idx    ON household(lat, lon);
CREATE INDEX household_street_idx    ON household(street_sort, num_sort);
CREATE INDEX household_address_trgm  ON household USING gin (address gin_trgm_ops);

CREATE TABLE voter (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id   integer NOT NULL REFERENCES import_run(id),
  household_id    text NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  ward            char(2) NOT NULL,
  first_name      text NOT NULL,
  middle_names    text,
  last_name       text NOT NULL,
  suffix          text,
  display_name    text NOT NULL,            -- "Jeff Adams"
  full_name       text NOT NULL,            -- "Jeff John Adams"
  name_raw        text NOT NULL,            -- "ADAMS, JEFF JOHN" as on the list
  resident_class  text NOT NULL,            -- resident | non-resident | unknown
  mail_kind       text NOT NULL,            -- street | po_box | rural_route | general_delivery | none
  mail_same_property boolean NOT NULL,
  mail_differs_real  boolean NOT NULL,      -- mailing address is a genuinely different place
  mailing_address text,                     -- ORGANIZER/ADMIN ONLY — never sent to volunteers
  mail_city       text,
  mail_postal     text,
  record_quality  text NOT NULL,
  -- stable key for matching across re-imports: lower(name_raw) || '|' || property_address_raw
  natural_key     text NOT NULL UNIQUE
);
CREATE INDEX voter_household_idx ON voter(household_id);
CREATE INDEX voter_ward_idx      ON voter(ward);
CREATE INDEX voter_name_trgm     ON voter USING gin (full_name gin_trgm_ops);
CREATE INDEX voter_last_idx      ON voter(last_name, first_name);

-- ---------------------------------------------------------------- canvassing (Phase 2 uses these; created now so the API can stub them)
CREATE TYPE contact_result AS ENUM (
  'not_home', 'spoke', 'refused', 'moved', 'deceased', 'do_not_knock', 'inaccessible', 'left_literature'
);

CREATE TABLE turf (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  ward        char(2),
  polygon     jsonb,                        -- GeoJSON Polygon; PostGIS geometry added in migration 002
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived    boolean NOT NULL DEFAULT false
);

CREATE TABLE turf_household (
  turf_id      uuid REFERENCES turf(id) ON DELETE CASCADE,
  household_id text REFERENCES household(id) ON DELETE CASCADE,
  walk_order   integer,
  PRIMARY KEY (turf_id, household_id)
);

CREATE TABLE assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  turf_id     uuid NOT NULL REFERENCES turf(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'open',  -- open | in_progress | done
  assigned_at timestamptz NOT NULL DEFAULT now(),
  due_date    date,
  UNIQUE (turf_id, user_id)
);

-- Append-only. voter_id NULL = applies to the whole door (e.g. not_home).
CREATE TABLE contact (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id text NOT NULL REFERENCES household(id) ON DELETE CASCADE,
  voter_id     uuid REFERENCES voter(id) ON DELETE SET NULL,
  user_id      uuid NOT NULL REFERENCES app_user(id),
  turf_id      uuid REFERENCES turf(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  client_id    text UNIQUE,                 -- idempotency key from offline queue
  result       contact_result NOT NULL,
  support      smallint CHECK (support BETWEEN 1 AND 5),
  issues       text[] NOT NULL DEFAULT '{}',
  wants_sign   boolean NOT NULL DEFAULT false,
  wants_volunteer boolean NOT NULL DEFAULT false,
  needs_ride   boolean NOT NULL DEFAULT false,
  follow_up    boolean NOT NULL DEFAULT false,
  note         text
);
CREATE INDEX contact_household_idx ON contact(household_id, at DESC);
CREATE INDEX contact_voter_idx     ON contact(voter_id, at DESC);
CREATE INDEX contact_user_idx      ON contact(user_id, at DESC);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  uuid REFERENCES app_user(id),
  action   text NOT NULL,                   -- login | logout | view_household | search | export | invite | import | ...
  target   text,
  detail   jsonb,
  ip       inet
);
CREATE INDEX audit_user_idx ON audit_log(user_id, at DESC);

-- ---------------------------------------------------------------- views
-- Latest door-level status per household (Phase 2 populates contact).
CREATE VIEW household_status AS
SELECT h.id AS household_id,
       c.result AS last_result, c.at AS last_contact_at, c.user_id AS last_user_id
FROM household h
LEFT JOIN LATERAL (
  SELECT result, at, user_id FROM contact WHERE household_id = h.id ORDER BY at DESC LIMIT 1
) c ON true;

-- Latest voter-level support.
CREATE VIEW voter_status AS
SELECT v.id AS voter_id,
       c.support AS last_support, c.result AS last_result, c.at AS last_contact_at
FROM voter v
LEFT JOIN LATERAL (
  SELECT support, result, at FROM contact WHERE voter_id = v.id ORDER BY at DESC LIMIT 1
) c ON true;
