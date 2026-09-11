-- Sign-ups from the public campaign website (sean-hunt.pages.dev and anything after it).
--
-- These people are NOT on the voters list and must never be merged into it. They typed their own
-- details into a public form: that is a different provenance, a different legal basis (CASL consent
-- they gave, not the Municipal Elections Act s. 23 supply), and a different retention story. Keeping
-- them in their own table is what stops a website form quietly becoming a route by which the
-- clerk's list grows rows nobody can account for.
--
-- The address is free text on purpose. A public form has no household id and no coordinates — only
-- what somebody typed, which may be a farm name, a rural route, or a lot and concession. Resolving
-- it to a door is a human job, and `household_id` records the answer once somebody has done it.
CREATE TABLE IF NOT EXISTS public_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),

  name          text NOT NULL,
  email         text,
  phone         text,                      -- E.164 when it could be normalised, else as typed
  address       text,                      -- where a sign should go; free text, see above
  note          text,

  -- What they actually asked for. An array because the form's tick boxes are not exclusive.
  wants         text[] NOT NULL DEFAULT '{}',

  -- The verbatim wording shown beside the tick boxes, sent back by the page that displayed it. A
  -- consent record that cannot say what was agreed to is not a consent record — same rule as
  -- subscribe_pending.consent_text.
  consent_text  text NOT NULL,

  -- Provenance, because a public endpoint will also collect abuse and we need to tell them apart.
  source        text NOT NULL DEFAULT 'web',
  origin        text,                       -- the Origin header the browser sent
  ip            inet,
  user_agent    text,

  -- Worked by a human: who dealt with it and when. `household_id` is set if and when the address is
  -- matched to a real door, and `sign_id` if a sign was raised from it.
  handled_at    timestamptz,
  handled_by    uuid REFERENCES app_user(id),
  household_id  text REFERENCES household(id) ON DELETE SET NULL,
  sign_id       uuid REFERENCES sign(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS public_request_open_idx
  ON public_request (created_at DESC)
  WHERE handled_at IS NULL;

COMMENT ON TABLE public_request IS
  'Self-submitted sign-ups from the public campaign site. Never merge into voter/household.';
