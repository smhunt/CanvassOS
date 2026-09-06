-- 003: opt-in SMS and email to electors.
--
-- Consent already lives in voter_contact (migration 002) with per-purpose flags and a withdrawal
-- that is stamped rather than deleted. This is everything downstream of that: campaigns, a per
-- recipient send row, the pool of sending numbers, and inbound messages.
--
-- Two facts from docs/phase-5-messaging-plan.md shape these tables:
--   * Canadian long codes are throttled to ~100-250 messages/day/number and the excess fails
--     SILENTLY. Hence sender_number.daily_cap and a send worker that drips rather than blasts.
--   * Delivery receipts are the only way to detect that throttle eating a send, so message_send
--     tracks delivered separately from sent.

CREATE TYPE message_channel  AS ENUM ('sms', 'email');
CREATE TYPE campaign_purpose AS ENUM ('gotv', 'updates');
CREATE TYPE campaign_status  AS ENUM ('draft', 'scheduled', 'sending', 'paused', 'done', 'cancelled');
CREATE TYPE send_status      AS ENUM ('queued', 'sent', 'delivered', 'failed', 'skipped');
CREATE TYPE inbound_action   AS ENUM ('join', 'stop', 'help', 'other');

CREATE TABLE message_campaign (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  -- Which consent column a recipient must hold. A gotv campaign may not go to someone who only
  -- agreed to updates, and vice versa — that is the whole point of separate flags.
  purpose       campaign_purpose NOT NULL,
  body_sms      text,
  email_subject text,
  body_email    text,
  status        campaign_status NOT NULL DEFAULT 'draft',
  scheduled_for timestamptz,
  -- Optional narrowing of the audience: {"ward": ["01"], "community": ["KOMOKA"]}.
  audience      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  -- Set when a human confirms the real send. A campaign cannot leave 'draft' without it; this is
  -- the deliberate speed bump between composing and texting a few thousand people.
  approved_by   uuid REFERENCES app_user(id),
  approved_at   timestamptz
);
CREATE INDEX message_campaign_status_idx ON message_campaign(status, scheduled_for);

-- One row per recipient per campaign. This is what makes "did she get it?" answerable, and what
-- stops a retry sending twice.
CREATE TABLE message_send (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES message_campaign(id) ON DELETE CASCADE,
  voter_contact_id uuid NOT NULL REFERENCES voter_contact(id) ON DELETE CASCADE,
  channel          message_channel NOT NULL,
  status           send_status NOT NULL DEFAULT 'queued',
  -- Why a queued row was not sent: 'withdrawn', 'quiet_hours', 'no_consent', 'duplicate_number'.
  -- Re-checked at dequeue, never trusted from queue time — a list built on Friday must not deliver
  -- on Sunday to somebody who said stop on Saturday.
  skip_reason      text,
  sender_number_id uuid,
  provider_message_id text,
  segments         smallint,
  attempts         smallint NOT NULL DEFAULT 0,
  error            text,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  delivered_at     timestamptz,
  UNIQUE (campaign_id, voter_contact_id)
);
CREATE INDEX message_send_campaign_idx ON message_send(campaign_id, status);
CREATE INDEX message_send_pending_idx  ON message_send(status, queued_at) WHERE status = 'queued';

CREATE TABLE sender_number (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  e164       text NOT NULL UNIQUE,
  provider   text NOT NULL DEFAULT 'log',
  label      text,
  -- The throttle. Conservative by default: the reported ceiling is 100-250/day and the excess is
  -- dropped without an error, so guessing high loses messages invisibly.
  daily_cap  integer NOT NULL DEFAULT 100,
  sent_today integer NOT NULL DEFAULT 0,
  cap_reset_on date NOT NULL DEFAULT current_date,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_send
  ADD CONSTRAINT message_send_sender_fk FOREIGN KEY (sender_number_id) REFERENCES sender_number(id);

-- Everything arriving on a campaign number. STOP has to be honoured whether or not we can match it
-- to a known contact, so matched_contact_id is nullable and the raw number is always kept.
CREATE TABLE message_inbound (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_e164     text NOT NULL,
  to_e164       text,
  body          text,
  action        inbound_action NOT NULL,
  matched_contact_id uuid REFERENCES voter_contact(id) ON DELETE SET NULL,
  provider_message_id text UNIQUE,
  received_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_inbound_from_idx ON message_inbound(from_e164, received_at DESC);

-- A self-serve subscriber has to prove the number is theirs before consent counts, so the web form
-- writes a pending row here and only a matching reply flips consent_gotv on voter_contact.
CREATE TABLE subscribe_pending (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  e164       text NOT NULL,
  token      text NOT NULL UNIQUE,
  wants_gotv boolean NOT NULL DEFAULT true,
  wants_updates boolean NOT NULL DEFAULT false,
  -- Wording the subscriber actually agreed to. A consent record that cannot say what was agreed
  -- to is not a consent record.
  consent_text text NOT NULL,
  source     text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  confirmed_at timestamptz
);
CREATE INDEX subscribe_pending_e164_idx ON subscribe_pending(e164) WHERE confirmed_at IS NULL;
