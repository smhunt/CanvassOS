import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q, withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertHouseholdAccess } from '../lib/scope.js';

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
  voter_id: z.string().uuid().nullish(),
  turf_id: z.string().uuid().nullish(),
  result: z.enum(RESULTS),
  support: z.coerce.number().int().min(1).max(5).nullish(),
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

interface ContactRow {
  id: string;
  household_id: string;
  voter_id: string | null;
  turf_id: string | null;
  at: Date;
  client_id: string | null;
  result: string;
  support: number | null;
  issues: string[];
  wants_sign: boolean;
  wants_volunteer: boolean;
  needs_ride: boolean;
  follow_up: boolean;
  note: string | null;
  user_id: string;
  user_name: string;
}

export const contactRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');

  /**
   * POST /api/contacts → 201 { contact }, or 200 { contact } when `client_id` has been seen.
   *
   * Append-only: a correction is a new row, never an UPDATE. The `client_id` unique index is what
   * makes the Phase 3 offline queue safe to retry — an interrupted request that actually landed
   * comes back as the stored row instead of a duplicate door knock.
   */
  app.post('/contacts', { preHandler: requireAuth }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const me = currentSession(req).user;

    const hh = await one<{ id: string }>(app.db, `SELECT id FROM household WHERE id = $1`, [body.household_id]);
    if (!hh) throw notFound('household not found');
    // Volunteers may only record contacts inside a turf assigned to them.
    await assertHouseholdAccess(app.db, me.role, body.household_id, me.id);

    if (body.voter_id) {
      const v = await one<{ id: string }>(app.db, `SELECT id FROM voter WHERE id = $1 AND household_id = $2`, [
        body.voter_id,
        body.household_id,
      ]);
      if (!v) throw badRequest('voter_id does not belong to household_id', 'voter_not_in_household');
    }

    const { contact, created } = await withTx(app.db, async (tx) => {
      // client_id is NULL-able and NULLs never conflict, so the same statement serves both cases.
      const ins = await one<ContactRow>(
        tx,
        `WITH ins AS (
           INSERT INTO contact (household_id, voter_id, user_id, turf_id, client_id, result, support, issues,
                                wants_sign, wants_volunteer, needs_ride, follow_up, note)
           VALUES ($1, $2, $3, $4, $5, $6::contact_result, $7, $8::text[], $9, $10, $11, $12, $13)
           ON CONFLICT (client_id) DO NOTHING
           RETURNING *
         )
         SELECT ${CONTACT_COLS}, u.name AS user_name FROM ins c JOIN app_user u ON u.id = c.user_id`,
        [
          body.household_id,
          body.voter_id ?? null,
          me.id,
          body.turf_id ?? null,
          body.client_id ?? null,
          body.result,
          body.support ?? null,
          body.issues ?? [],
          body.wants_sign ?? false,
          body.wants_volunteer ?? false,
          body.needs_ride ?? false,
          body.follow_up ?? false,
          body.note ?? null,
        ],
      );
      if (ins) return { contact: ins, created: true };

      const existing = await one<ContactRow>(
        tx,
        `SELECT ${CONTACT_COLS}, u.name AS user_name
         FROM contact c JOIN app_user u ON u.id = c.user_id WHERE c.client_id = $1`,
        [body.client_id ?? null],
      );
      if (!existing) throw new Error('contact insert returned no row');
      return { contact: existing, created: false };
    });

    // A replay of an already-stored client_id is not a new door knock, so it is not re-audited.
    if (created) {
      await audit(app.db, req.log, {
        userId: me.id,
        action: 'contact',
        target: contact.id,
        detail: { result: contact.result, household_id: contact.household_id },
        ip: req.ip,
      });
    }
    return reply.status(created ? 201 : 200).send({ contact });
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
