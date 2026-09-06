import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q, withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertHouseholdAccess } from '../lib/scope.js';
import { serializeContact, type ContactRow } from '../lib/serialize.js';

/** Nobody speaks to thirteen people at one door; a longer list is a client bug, not a canvass. */
const MAX_NAMED_VOTERS = 12;

// contact_result enum (db/schema.sql)
const RESULTS = [
  'not_home',
  'spoke',
  'refused',
  'moved',
  'deceased',
  'do_not_knock',
  'inaccessible',
  'left_literature',
] as const;

const householdId = z.string().regex(/^H-[A-Z]+-\d{1,8}$/, 'invalid household id');

// Every optional field is `.nullish()`, not `.optional()`: a client serialising a door form sends
// `null` for the boxes nobody ticked, and the server absorbs that instead of 400ing. (ZodNullable
// short-circuits on null, so `z.coerce.number().nullish()` never coerces null into 0 either.)
// Null and absent mean the same thing here and both become the column default below.
const createBody = z.object({
  household_id: householdId,
  // A door where two people answer is the common case, not an edge case, so a contact may name
  // several voters. `voter_id` stays for existing callers and is folded into `voter_ids`.
  voter_id: z.string().uuid().nullish(),
  voter_ids: z.array(z.string().uuid()).max(MAX_NAMED_VOTERS).nullish(),
  turf_id: z.string().uuid().nullish(),
  result: z.enum(RESULTS),
  // One support level for everyone spoken to, or a per-person map when they differ (the usual
  // outcome of a two-person doorstep). `supports` wins over `support` for the voters it names.
  support: z.coerce.number().int().min(1).max(5).nullish(),
  supports: z.record(z.string().uuid(), z.coerce.number().int().min(1).max(5)).nullish(),
  issues: z.array(z.string().trim().min(1).max(40)).max(20).nullish(),
  wants_sign: z.boolean().nullish(),
  wants_volunteer: z.boolean().nullish(),
  needs_ride: z.boolean().nullish(),
  follow_up: z.boolean().nullish(),
  note: z.string().trim().max(2000).nullish(),
  // idempotency key minted by the offline queue (Phase 3); replays return the stored row
  client_id: z.string().trim().min(6).max(100).nullish(),
});

const listQuery = z.object({
  household_id: householdId,
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const followUpQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) });
const activityQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(14) });

const CONTACT_COLS = `
  c.id, c.household_id, c.voter_id, c.turf_id, c.at, c.client_id, c.result, c.support, c.issues,
  c.wants_sign, c.wants_volunteer, c.needs_ride, c.follow_up, c.note, c.user_id`;

export const contactRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');

  /**
   * POST /api/contacts → 201 { contacts, contact }, or 200 when every row already existed.
   *
   * Append-only: a correction is a new row, never an UPDATE. The `client_id` unique index is what
   * makes the Phase 3 offline queue safe to retry — an interrupted request that actually landed
   * comes back as the stored rows instead of a duplicate door knock.
   *
   * A door where two people answer writes ONE ROW PER NAMED VOTER in one transaction, sharing the
   * door-level fields (result, flags, note). That is not a join table because the rest of the
   * system already reads `contact` per voter: `voter_status` takes the latest row for each voter,
   * so per-person rows are what makes "he is a 5, she is a 2" — the common outcome, not an edge
   * case — expressible at all. With nobody named it is one door-level row with `voter_id` NULL,
   * exactly as before.
   */
  app.post('/contacts', { preHandler: requireAuth }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const me = currentSession(req).user;

    const hh = await one<{ id: string }>(app.db, `SELECT id FROM household WHERE id = $1`, [body.household_id]);
    if (!hh) throw notFound('household not found');
    // Volunteers may only record contacts inside a turf assigned to them.
    await assertHouseholdAccess(app.db, me.role, body.household_id, me.id);

    // `voter_id` is the one-element form of `voter_ids`; a client sending both (an old field plus a
    // new one) means one door, one list of people, so they are merged and de-duplicated.
    const named = [...new Set([...(body.voter_id ? [body.voter_id] : []), ...(body.voter_ids ?? [])])];
    if (named.length > MAX_NAMED_VOTERS) {
      throw badRequest(`at most ${MAX_NAMED_VOTERS} voters may be named on one contact`, 'too_many_voters');
    }

    if (named.length > 0) {
      const rows = await q<{ id: string }>(
        app.db,
        `SELECT id FROM voter WHERE id = ANY($1::uuid[]) AND household_id = $2`,
        [named, body.household_id],
      );
      const known = new Set(rows.map((r) => r.id));
      const stray = named.filter((id) => !known.has(id));
      if (stray.length > 0) {
        // Same code as before the plural form existed: the message names who, the code does not change.
        throw badRequest(
          `voter_id does not belong to household_id: ${stray.join(', ')}`,
          'voter_not_in_household',
        );
      }
    }

    const supports = body.supports ?? {};
    for (const id of Object.keys(supports)) {
      // A support level for somebody who is not on the contact would be silently dropped, and a
      // dropped support level is a wrong canvass number later. Say so instead.
      if (!named.includes(id)) {
        throw badRequest(`supports names a voter that is not on this contact: ${id}`, 'support_voter_not_named');
      }
    }

    /**
     * One insert per named voter, with a deterministic idempotency key each.
     *
     * `contact.client_id` is UNIQUE, so N rows cannot all carry the submitted key. Deriving
     * `<client_id>:<voter_id>` keeps the retry safe: the phone that lost signal halfway through
     * re-sends the same body and every row collapses onto the row it already wrote. With nobody
     * named there is a single row and the key is stored exactly as submitted — unchanged from
     * before this endpoint learned to take a list.
     */
    const targets =
      named.length === 0
        ? [{ voter_id: null, support: body.support ?? null, client_id: body.client_id ?? null }]
        : named.map((voter_id) => ({
            voter_id,
            support: supports[voter_id] ?? body.support ?? null,
            client_id: body.client_id ? `${body.client_id}:${voter_id}` : null,
          }));
    const keys = targets.map((t) => t.client_id);

    const { contacts, created } = await withTx(app.db, async (tx) => {
      // client_id is NULL-able and NULLs never conflict, so the same statement serves both cases.
      // The door-level fields are scalars (every row shares them); only the per-person columns are
      // unnested, which also keeps `issues` a single text[] instead of an array of arrays.
      const inserted = await q<ContactRow>(
        tx,
        `WITH ins AS (
           INSERT INTO contact (household_id, voter_id, user_id, turf_id, client_id, result, support, issues,
                                wants_sign, wants_volunteer, needs_ride, follow_up, note)
           SELECT $1, t.voter_id, $2, $3, t.client_id, $4::contact_result, t.support, $5::text[],
                  $6, $7, $8, $9, $10
           FROM unnest($11::uuid[], $12::smallint[], $13::text[]) AS t(voter_id, support, client_id)
           ON CONFLICT (client_id) DO NOTHING
           RETURNING *
         )
         SELECT ${CONTACT_COLS}, u.name AS user_name FROM ins c JOIN app_user u ON u.id = c.user_id`,
        [
          body.household_id,
          me.id,
          body.turf_id ?? null,
          body.result,
          body.issues ?? [],
          body.wants_sign ?? false,
          body.wants_volunteer ?? false,
          body.needs_ride ?? false,
          body.follow_up ?? false,
          body.note ?? null,
          targets.map((t) => t.voter_id),
          targets.map((t) => t.support),
          keys,
        ],
      );

      // Without a client_id nothing can conflict, so the insert is the whole answer. With one, a
      // replay may have inserted some rows and skipped others (a client that added a second person
      // to a submission it already sent), so the stored set is re-read inside the same transaction.
      if (!body.client_id) return { contacts: inserted, created: inserted };
      const stored = await q<ContactRow>(
        tx,
        `SELECT ${CONTACT_COLS}, u.name AS user_name
         FROM contact c JOIN app_user u ON u.id = c.user_id WHERE c.client_id = ANY($1::text[])`,
        [keys],
      );
      if (stored.length !== targets.length) throw new Error('contact insert returned no row');
      return { contacts: stored, created: inserted };
    });

    // Answer in the order the door screen named them, not in whatever order postgres returned.
    const order = new Map(targets.map((t, i) => [t.voter_id ?? '', i]));
    contacts.sort((a, b) => (order.get(a.voter_id ?? '') ?? 0) - (order.get(b.voter_id ?? '') ?? 0));

    // A replay of an already-stored client_id is not a new door knock, so it is not re-audited.
    // One entry per row actually written: each names a different person on the list.
    for (const c of created) {
      await audit(app.db, req.log, {
        userId: me.id,
        action: 'contact',
        target: c.id,
        detail: { result: c.result, household_id: c.household_id, voter_id: c.voter_id },
        ip: req.ip,
      });
    }

    const serialized = contacts.map(serializeContact);
    // `contact` (singular) is the pre-multi-voter shape, kept populated with the first row so a
    // client written against it keeps working across this deploy. See API.md.
    return reply.status(created.length > 0 ? 201 : 200).send({ contacts: serialized, contact: serialized[0] });
  });

  // GET /api/contacts?household_id=&limit= — history for one door. Volunteers: their turfs only.
  app.get('/contacts', { preHandler: requireAuth }, async (req) => {
    const qp = listQuery.parse(req.query);
    const me = currentSession(req).user;
    await assertHouseholdAccess(app.db, me.role, qp.household_id, me.id);

    const contacts = await q(
      app.db,
      `SELECT c.id, c.at, u.name AS user_name, c.result, c.support, c.issues, c.wants_sign, c.wants_volunteer,
              c.needs_ride, c.follow_up, c.note, c.voter_id, v.display_name AS voter_name
       FROM contact c
       JOIN app_user u ON u.id = c.user_id
       LEFT JOIN voter v ON v.id = c.voter_id
       WHERE c.household_id = $1
       ORDER BY c.at DESC, c.id DESC
       LIMIT $2`,
      [qp.household_id, qp.limit],
    );
    return { contacts };
  });

  // GET /api/follow-ups — organizer/admin. Doors whose MOST RECENT contact asked for a follow-up.
  app.get('/follow-ups', { preHandler: organizerOnly }, async (req) => {
    const qp = followUpQuery.parse(req.query);
    const me = currentSession(req).user;
    const follow_ups = await q(
      app.db,
      `SELECT h.id AS household_id, h.address, h.ward, h.community, h.lat, h.lon,
              c.id AS contact_id, c.at AS last_contact_at, c.result AS last_result, c.support AS last_support,
              c.issues, c.wants_sign, c.wants_volunteer, c.needs_ride, c.note,
              c.user_id, u.name AS user_name, c.voter_id, v.display_name AS voter_name
       FROM (SELECT DISTINCT household_id FROM contact WHERE follow_up) d
       JOIN household h ON h.id = d.household_id
       JOIN LATERAL (
         SELECT * FROM contact WHERE household_id = h.id ORDER BY at DESC LIMIT 1
       ) c ON true
       JOIN app_user u ON u.id = c.user_id
       LEFT JOIN voter v ON v.id = c.voter_id
       WHERE c.follow_up
       ORDER BY c.at DESC
       LIMIT $1`,
      [qp.limit],
    );
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_follow_ups',
      detail: { n: follow_ups.length },
      ip: req.ip,
    });
    return { follow_ups };
  });

  // GET /api/activity?days=14 — organizer/admin. Aggregates only; no personal data, no audit row.
  app.get('/activity', { preHandler: organizerOnly }, async (req) => {
    const qp = activityQuery.parse(req.query);
    const [by_user, by_day] = await Promise.all([
      q(
        app.db,
        `SELECT c.user_id, u.name, count(*)::int AS contacts,
                count(DISTINCT c.household_id)::int AS doors, max(c.at) AS last_at
         FROM contact c JOIN app_user u ON u.id = c.user_id
         WHERE c.at >= now() - make_interval(days => $1)
         GROUP BY c.user_id, u.name
         ORDER BY contacts DESC, u.name`,
        [qp.days],
      ),
      // Local calendar days — a 9pm knock belongs to that evening, not to the next UTC day.
      q(
        app.db,
        `SELECT to_char((c.at AT TIME ZONE 'America/Toronto')::date, 'YYYY-MM-DD') AS day, count(*)::int AS contacts
         FROM contact c
         WHERE c.at >= now() - make_interval(days => $1)
         GROUP BY 1 ORDER BY 1`,
        [qp.days],
      ),
    ]);
    return { by_user, by_day };
  });
};
