/*
 * The words of the consent, in one place.
 *
 * `docs/phase-5-messaging-plan.md` §3.2: *a consent record that cannot say what was agreed to is
 * not a consent record*. So the page renders these strings and posts these same strings as
 * `consent_text` — the record and the screen are the same source, and no edit to the wording can
 * leave the stored record describing a page that no longer exists.
 *
 * Nothing here is marketing copy and nothing here is a claim the campaign cannot keep. If a line
 * below stops being true, the line changes; the record then changes with it for everyone who
 * subscribes afterwards, and the people who subscribed before still have the text they saw.
 */

export const CAMPAIGN = "Sean Hunt's campaign for Mayor of Middlesex Centre";

/** Election day, stated plainly so "around election day" is not vague about which day. */
export const ELECTION_DAY = 'Monday 26 October 2026';

export type OptInKey = 'wants_gotv' | 'wants_updates';

/**
 * Two separate purposes, because one "ok to contact" box cannot answer *did they agree to this?*
 * — the same reason `voter_contact` has `consent_gotv` and `consent_updates` as separate columns.
 * Both render unticked and there is no default: a pre-ticked box is not consent.
 */
export const OPT_INS: ReadonlyArray<{ key: OptInKey; label: string; detail: string }> = [
  {
    key: 'wants_gotv',
    label: 'Remind me to vote around election day',
    detail: `A few texts in the days around advance voting and ${ELECTION_DAY}.`,
  },
  {
    key: 'wants_updates',
    label: 'Send me campaign updates',
    detail: 'Roughly one or two texts a month until the election.',
  },
];

/** Shown above the button and repeated verbatim inside the stored consent. */
export const TERMS: readonly string[] = [
  'Only what you ticked is sent — nothing more than the boxes above describe.',
  'Message and data rates may apply.',
  'Reply STOP to any message and the texts stop for good.',
  'Your number is used for these texts and nothing else. It is never sold, traded or lent, and it is destroyed after the election.',
];

/**
 * The exact sentence stored with the record: what was ticked, in the words that were on screen,
 * plus the terms that were on screen next to them.
 */
export function buildConsentText(selected: ReadonlySet<OptInKey>): string {
  // The detail is a sentence on screen; inside the parenthesis its full stop would sit next to the
  // sentence's own, so it is dropped — the words themselves are untouched.
  const chosen = OPT_INS.filter((o) => selected.has(o.key)).map((o) => `“${o.label}” (${o.detail.replace(/\.$/, '')})`);
  const agreed = chosen.length === 2 ? `${chosen[0]} and ${chosen[1]}` : (chosen[0] ?? '');
  return [`I agree to receive text messages from ${CAMPAIGN} at this number: ${agreed}.`, ...TERMS].join(' ');
}
