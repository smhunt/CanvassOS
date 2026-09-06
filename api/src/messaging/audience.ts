/**
 * Who gets messaged, and on which channel — the one resolver both the audience count and the send
 * materialisation go through, so the number an organiser approves is the number of messages that
 * actually leave.
 *
 * Three rules, in this order (plan §3.1):
 *
 *  1. **SMS first.** A person with a consented, un-withdrawn phone number is an SMS recipient and
 *     is NOT also counted or queued as an email one. One message per person per campaign, never
 *     two. (SMS first is not a preference — email open rates on a GOTV reminder are a rounding
 *     error next to a text, and the plan makes email an explicit fallback.)
 *  2. **One message per number.** Where a household shares a phone, it is contacted once. Without
 *     this, a house of four adults who gave one number gets four identical texts, which is how a
 *     GOTV list turns into a complaint.
 *  3. **Consent is per purpose.** A `gotv` campaign may only reach `consent_gotv`; an `updates`
 *     campaign only `consent_updates`. That is the entire reason migration 002 has two columns
 *     rather than one boolean, and collapsing them here would throw the distinction away.
 *
 * Withdrawal is excluded here AND re-checked again at dequeue in the worker. Both, deliberately:
 * this is a snapshot, and a list built on Friday must not deliver on Sunday to somebody who said
 * stop on Saturday.
 */
import { q, type Queryable } from '../db.js';

export type CampaignPurpose = 'gotv' | 'updates';

export interface AudienceFilter {
  /** Ward codes ('01'..'05'). Empty/undefined means every ward. */
  ward?: string[] | undefined;
  /** Canada Post communities (ILDERTON, KOMOKA, ...). Empty/undefined means every community. */
  community?: string[] | undefined;
}

export interface AudienceCounts {
  /** SMS messages that would be sent — after SMS-priority and after dedupe by number. */
  sms: number;
  /** Emails that would be sent — only to people with no usable phone. */
  email: number;
  /** Electors in scope no message would reach, directly or through their household's contact. */
  unreachable: number;
  /** Electors in scope. NOT `sms + email + unreachable`: one message can cover a whole household. */
  total: number;
  /** Messages per day the active number pool can carry — the real ceiling (plan §1.1). */
  daily_capacity: number;
  /** `ceil(sms / daily_capacity)`, or null when there is no capacity at all to divide by. */
  estimated_days: number | null;
}

export interface AudienceRow {
  voter_contact_id: string;
  /** `voter_contact.channel`: `phone` or `email`. */
  contact_channel: 'phone' | 'email';
  /** `message_send.channel`: `sms` or `email`. */
  channel: 'sms' | 'email';
  value: string;
}

/**
 * The resolver, as one CTE chain so counting and queueing cannot drift apart.
 *
 * `subject` is the unit of "a person": the named elector when the number was given for one, and
 * otherwise the household — "the number for the house" is a real answer at a door where nobody
 * wants to say whose it is, and migration 002 stores it that way on purpose.
 */
const RESOLVER = `
  WITH filtered AS (
    SELECT vc.id, vc.channel::text AS contact_channel, vc.value, vc.voter_id, vc.household_id,
           coalesce(vc.voter_id::text, 'H:' || vc.household_id) AS subject
    FROM voter_contact vc
    JOIN household h ON h.id = vc.household_id
    WHERE vc.withdrawn_at IS NULL
      AND CASE WHEN $1::text = 'gotv' THEN vc.consent_gotv ELSE vc.consent_updates END
      AND ($2::text[] IS NULL OR h.ward = ANY($2::text[]))
      AND ($3::text[] IS NULL OR h.community = ANY($3::text[]))
  ),
  -- Rule 1: SMS first. One contact per person, a phone always beating an email.
  best AS (
    SELECT DISTINCT ON (subject) *
    FROM filtered
    ORDER BY subject, (contact_channel = 'phone') DESC, id
  ),
  -- Rule 2: one message per number/address. A household sharing a phone is contacted once.
  deduped AS (
    SELECT DISTINCT ON (contact_channel, value) *
    FROM best
    ORDER BY contact_channel, value, id
  ),
  -- The denominator: every elector the filters select, reachable or not.
  scope AS (
    SELECT v.id, v.household_id
    FROM voter v JOIN household h ON h.id = v.household_id
    WHERE ($2::text[] IS NULL OR h.ward = ANY($2::text[]))
      AND ($3::text[] IS NULL OR h.community = ANY($3::text[]))
  )`;

const nullable = (v: string[] | undefined): string[] | null => (v && v.length > 0 ? v : null);

/** Counts only — what `GET /api/messaging/audience` answers, and what the send guard checks. */
export async function audienceCounts(
  db: Queryable,
  purpose: CampaignPurpose,
  filter: AudienceFilter,
): Promise<AudienceCounts> {
  const rows = await q<{ sms: number; email: number; total: number; covered: number; daily_capacity: number }>(
    db,
    `${RESOLVER}
     SELECT
       (SELECT count(*)::int FROM deduped WHERE contact_channel = 'phone') AS sms,
       (SELECT count(*)::int FROM deduped WHERE contact_channel = 'email') AS email,
       (SELECT count(*)::int FROM scope) AS total,
       -- Coverage is measured against best, BEFORE the dedupe. Dropping a duplicate removes a
       -- redundant MESSAGE, not a person's reachability: two households that gave the same number
       -- are one text, and both of those electors still get it.
       (SELECT count(*)::int FROM scope s
          WHERE EXISTS (SELECT 1 FROM best b
                        WHERE b.voter_id = s.id
                           OR (b.voter_id IS NULL AND b.household_id = s.household_id))) AS covered,
       (SELECT coalesce(sum(daily_cap), 0)::int FROM sender_number WHERE active) AS daily_capacity`,
    [purpose, nullable(filter.ward), nullable(filter.community)],
  );
  const r = rows[0] ?? { sms: 0, email: 0, total: 0, covered: 0, daily_capacity: 0 };
  return {
    sms: r.sms,
    email: r.email,
    unreachable: r.total - r.covered,
    total: r.total,
    daily_capacity: r.daily_capacity,
    // A pool of zero numbers cannot be divided into; `null` says "unknown", where a 0 or an
    // Infinity would both read as an answer. An organiser seeing null needs to buy a number.
    estimated_days: r.daily_capacity > 0 ? Math.ceil(r.sms / r.daily_capacity) : null,
  };
}

/** The same resolution, as rows — what `POST /:id/send` turns into `message_send`. */
export async function audienceRows(
  db: Queryable,
  purpose: CampaignPurpose,
  filter: AudienceFilter,
): Promise<AudienceRow[]> {
  const rows = await q<{ id: string; contact_channel: 'phone' | 'email'; value: string }>(
    db,
    `${RESOLVER}
     SELECT id, contact_channel, value FROM deduped ORDER BY contact_channel, value`,
    [purpose, nullable(filter.ward), nullable(filter.community)],
  );
  return rows.map((r) => ({
    voter_contact_id: r.id,
    contact_channel: r.contact_channel,
    channel: r.contact_channel === 'phone' ? 'sms' : 'email',
    value: r.value,
  }));
}

/** Parse the `audience` jsonb column (or a query string) into a filter, ignoring anything unknown. */
export function parseAudience(raw: unknown): AudienceFilter {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const list = (v: unknown): string[] | undefined => {
    if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return undefined;
  };
  const ward = list(obj.ward);
  const community = list(obj.community);
  return {
    ...(ward && ward.length > 0 ? { ward } : {}),
    ...(community && community.length > 0 ? { community: community.map((c) => c.toUpperCase()) } : {}),
  };
}
