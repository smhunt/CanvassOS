import type { FastifyPluginAsync } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q, withTx, type Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { pointInPolygon, polygonBBox, polygonSchema, type Polygon } from '../lib/geo.js';
import { assertTurfAccess } from '../lib/scope.js';
import { isOrganizer, serializeDoor, type DoorRow, type VoterRow } from '../lib/serialize.js';

// ---------------------------------------------------------------- input

const idParams = z.object({ id: z.string().uuid() });
const assignParams = z.object({ id: z.string().uuid(), user_id: z.string().uuid() });
const wardSchema = z.string().regex(/^\d{2}$/, 'ward must be two digits');
const statusSchema = z.enum(['open', 'in_progress', 'done']);

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    ward: wardSchema.optional(),
    // street_sort keys as returned by GET /api/streets. NOTE: `ward` never narrows these — see
    // materialise() — it is only stored on the turf as a label.
    streets: z
      .array(z.string().trim().min(1).max(120))
      .min(1)
      .max(500)
      .transform((a) => a.map((s) => s.toUpperCase()))
      .optional(),
    polygon: polygonSchema.optional(),
  })
  .refine((b) => (b.streets === undefined) !== (b.polygon === undefined), {
    message: 'provide exactly one of streets or polygon',
  });

const patchBody = z
  .object({ name: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.archived !== undefined, { message: 'nothing to update' });

const assignBody = z.object({
  user_id: z.string().uuid(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'due_date must be YYYY-MM-DD').optional(),
});

const assignmentPatchBody = z.object({ status: statusSchema });

// GET /api/turfs defaults to the working set. An archived turf is a finished walk, and leaving it in
// the list makes the builder's overlap check claim streets that are actually free again.
const listQuery = z.object({
  archived: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

// ---------------------------------------------------------------- SQL

/** Per-turf counts: doors, voters behind them, and doors with at least one contact row. */
const TURF_COUNTS = `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n_households,
           coalesce(sum(h.n_voters), 0)::int AS n_voters,
           count(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM contact ct WHERE ct.household_id = h.id)
           )::int AS contacted
    FROM turf_household x JOIN household h ON h.id = x.household_id
    WHERE x.turf_id = t.id
  ) c ON true`;

const TURF_SELECT = `
  SELECT t.id, t.name, t.ward, t.archived, t.created_at, u.name AS created_by_name,
         c.n_households, c.n_voters, c.contacted
  FROM turf t
  LEFT JOIN app_user u ON u.id = t.created_by
  ${TURF_COUNTS}`;

const TURF_SELECT_DETAIL = `
  SELECT t.id, t.name, t.ward, t.archived, t.created_at, t.polygon, u.name AS created_by_name,
         c.n_households, c.n_voters, c.contacted
  FROM turf t
  LEFT JOIN app_user u ON u.id = t.created_by
  ${TURF_COUNTS}`;

const ASSIGNMENT_SELECT = `
  SELECT a.id, a.turf_id, a.user_id, u.name AS user_name, a.status, a.assigned_at,
         to_char(a.due_date, 'YYYY-MM-DD') AS due_date
  FROM assignment a JOIN app_user u ON u.id = a.user_id`;

interface TurfRow {
  id: string;
  name: string;
  ward: string | null;
  archived: boolean;
  created_at: Date;
  created_by_name: string | null;
  n_households: number;
  n_voters: number;
  contacted: number;
  polygon?: Polygon | null;
}

interface AssigneeRow {
  id: string;
  turf_id: string;
  user_id: string;
  user_name: string;
  status: string;
  due_date: string | null;
}

interface AssignmentRow extends AssigneeRow {
  assigned_at: Date;
}

const assignee = (r: AssigneeRow) => ({
  id: r.id,
  user_id: r.user_id,
  name: r.user_name,
  status: r.status,
  due_date: r.due_date,
});

/**
 * The distinct streets a turf covers, grouped by turf_id. The turf builder uses this to grey out
 * streets that already belong to another turf so organizers do not create overlapping walks.
 */
async function streetsByTurf(db: Queryable, turfIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (turfIds.length === 0) return out;
  const rows = await q<{ turf_id: string; street_sort: string }>(
    db,
    `SELECT x.turf_id, h.street_sort
     FROM turf_household x JOIN household h ON h.id = x.household_id
     WHERE x.turf_id = ANY($1::uuid[]) AND h.street_sort IS NOT NULL
     GROUP BY x.turf_id, h.street_sort
     ORDER BY h.street_sort`,
    [turfIds],
  );
  for (const r of rows) {
    const list = out.get(r.turf_id) ?? [];
    list.push(r.street_sort);
    out.set(r.turf_id, list);
  }
  return out;
}

/** assignees for a set of turfs, grouped by turf_id (one query, no N+1). */
async function assigneesByTurf(
  db: Queryable,
  turfIds: string[],
): Promise<Map<string, ReturnType<typeof assignee>[]>> {
  const out = new Map<string, ReturnType<typeof assignee>[]>();
  if (turfIds.length === 0) return out;
  const rows = await q<AssigneeRow>(
    db,
    `SELECT a.id, a.turf_id, a.user_id, u.name AS user_name, a.status,
            to_char(a.due_date, 'YYYY-MM-DD') AS due_date
     FROM assignment a JOIN app_user u ON u.id = a.user_id
     WHERE a.turf_id = ANY($1::uuid[])
     ORDER BY u.name, u.email`,
    [turfIds],
  );
  for (const r of rows) {
    const list = out.get(r.turf_id) ?? [];
    list.push(assignee(r));
    out.set(r.turf_id, list);
  }
  return out;
}

/**
 * Fill turf_household for a freshly created turf.
 *
 * `walk_order` is assigned by the same window function in both branches so the door list always
 * comes out in walking order: street, then civic number, then id as a stable tiebreak.
 *
 * `ward` is a LABEL on the turf, never a filter on the selection. `street_sort` is not unique per
 * ward — a rural road that crosses a ward line shows up as several rows in GET /api/streets — and a
 * turf that stops halfway down a road at an invisible boundary is worse to walk than one that takes
 * the whole road. The street picker totals the whole street, so this also keeps its preview honest.
 * The same rule applies to a drawn polygon: the geometry the organizer drew is the selection.
 */
async function materialise(
  tx: PoolClient,
  turfId: string,
  body: { ward?: string; streets?: string[]; polygon?: Polygon },
): Promise<number> {
  if (body.streets) {
    const res = await tx.query(
      `INSERT INTO turf_household (turf_id, household_id, walk_order)
       SELECT $1, id, row_number() OVER (ORDER BY street_sort, num_sort, id)
       FROM household
       WHERE street_sort = ANY($2::text[])`,
      [turfId, body.streets],
    );
    return res.rowCount ?? 0;
  }

  const polygon = body.polygon as Polygon;
  const bbox = polygonBBox(polygon);
  // Cheap bbox pre-filter in SQL, exact ray-casting test in TS (see lib/geo.ts for why).
  const candidates = await q<{ id: string; lat: number; lon: number }>(
    tx,
    `SELECT id, lat, lon FROM household
     WHERE lat IS NOT NULL AND lon IS NOT NULL
       AND lon BETWEEN $1 AND $3 AND lat BETWEEN $2 AND $4`,
    [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat],
  );
  const ids = candidates.filter((r) => pointInPolygon(r.lon, r.lat, polygon)).map((r) => r.id);
  if (ids.length === 0) return 0;
  const res = await tx.query(
    `INSERT INTO turf_household (turf_id, household_id, walk_order)
     SELECT $1, id, row_number() OVER (ORDER BY street_sort, num_sort, id)
     FROM household WHERE id = ANY($2::text[])`,
    [turfId, ids],
  );
  return res.rowCount ?? 0;
}

// ---------------------------------------------------------------- routes: /api/turfs

export const turfRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');

  const loadTurf = async (id: string, detail = false): Promise<TurfRow> => {
    const row = await one<TurfRow>(app.db, `${detail ? TURF_SELECT_DETAIL : TURF_SELECT} WHERE t.id = $1`, [id]);
    if (!row) throw notFound('turf not found');
    return row;
  };

  // POST /api/turfs → 201 { turf }
  app.post('/', { preHandler: organizerOnly }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const me = currentSession(req).user;

    const turf = await withTx(app.db, async (tx) => {
      const created = await one<{ id: string }>(
        tx,
        `INSERT INTO turf (name, ward, polygon, created_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
        [body.name, body.ward ?? null, body.polygon ? JSON.stringify(body.polygon) : null, me.id],
      );
      if (!created) throw new Error('turf insert returned no row');
      await materialise(tx, created.id, body);
      const row = await one<TurfRow>(tx, `${TURF_SELECT_DETAIL} WHERE t.id = $1`, [created.id]);
      if (!row) throw new Error('turf disappeared inside the transaction');
      return row;
    });

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'create_turf',
      target: turf.id,
      detail: { name: turf.name, by: body.polygon ? 'polygon' : 'streets', n_households: turf.n_households },
      ip: req.ip,
    });
    const streets = await streetsByTurf(app.db, [turf.id]);
    return reply.status(201).send({ turf: { ...turf, streets: streets.get(turf.id) ?? [], assignees: [] } });
  });

  // GET /api/turfs?archived=true — active turfs only unless archived ones are asked for.
  app.get('/', { preHandler: organizerOnly }, async (req) => {
    const qp = listQuery.parse(req.query);
    const turfs = await q<TurfRow>(
      app.db,
      `${TURF_SELECT} ${qp.archived ? '' : 'WHERE NOT t.archived'} ORDER BY t.archived, t.created_at DESC`,
    );
    const ids = turfs.map((t) => t.id);
    const [byTurf, streets] = await Promise.all([assigneesByTurf(app.db, ids), streetsByTurf(app.db, ids)]);
    return {
      turfs: turfs.map((t) => ({ ...t, streets: streets.get(t.id) ?? [], assignees: byTurf.get(t.id) ?? [] })),
    };
  });

  // GET /api/turfs/:id
  app.get('/:id', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const turf = await loadTurf(id, true);
    const [byTurf, streets] = await Promise.all([assigneesByTurf(app.db, [id]), streetsByTurf(app.db, [id])]);
    return { turf: { ...turf, streets: streets.get(id) ?? [], assignees: byTurf.get(id) ?? [] } };
  });

  // PATCH /api/turfs/:id
  app.patch('/:id', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const me = currentSession(req).user;
    const updated = await one<{ id: string }>(
      app.db,
      `UPDATE turf SET name = coalesce($2, name), archived = coalesce($3, archived) WHERE id = $1 RETURNING id`,
      [id, body.name ?? null, body.archived ?? null],
    );
    if (!updated) throw notFound('turf not found');
    await audit(app.db, req.log, { userId: me.id, action: 'update_turf', target: id, detail: body, ip: req.ip });
    const turf = await loadTurf(id, true);
    const [byTurf, streets] = await Promise.all([assigneesByTurf(app.db, [id]), streetsByTurf(app.db, [id])]);
    return { turf: { ...turf, streets: streets.get(id) ?? [], assignees: byTurf.get(id) ?? [] } };
  });

  // DELETE /api/turfs/:id → 204 (turf_household and assignment cascade; contacts keep turf_id NULL)
  app.delete('/:id', { preHandler: organizerOnly }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;
    const row = await one<{ id: string; name: string }>(app.db, `DELETE FROM turf WHERE id = $1 RETURNING id, name`, [
      id,
    ]);
    if (!row) throw notFound('turf not found');
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'delete_turf',
      target: id,
      detail: { name: row.name },
      ip: req.ip,
    });
    return reply.status(204).send();
  });

  // POST /api/turfs/:id/assign → 201 { assignment } — idempotent on (turf_id, user_id)
  app.post('/:id/assign', { preHandler: organizerOnly }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = assignBody.parse(req.body);
    const me = currentSession(req).user;

    const turf = await one<{ id: string }>(app.db, `SELECT id FROM turf WHERE id = $1`, [id]);
    if (!turf) throw notFound('turf not found');
    const user = await one<{ id: string }>(app.db, `SELECT id FROM app_user WHERE id = $1 AND active`, [body.user_id]);
    if (!user) throw notFound('user not found or inactive');

    // Re-assigning is a no-op that returns the row that is already there.
    const inserted = await one<{ id: string }>(
      app.db,
      `INSERT INTO assignment (turf_id, user_id, due_date) VALUES ($1, $2, $3::date)
       ON CONFLICT (turf_id, user_id) DO NOTHING
       RETURNING id`,
      [id, body.user_id, body.due_date ?? null],
    );
    const assignment = await one<AssignmentRow>(
      app.db,
      `${ASSIGNMENT_SELECT} WHERE a.turf_id = $1 AND a.user_id = $2`,
      [id, body.user_id],
    );
    if (!assignment) throw new Error('assignment insert returned no row');

    if (inserted) {
      await audit(app.db, req.log, {
        userId: me.id,
        action: 'assign_turf',
        target: id,
        detail: { user_id: body.user_id },
        ip: req.ip,
      });
    }
    return reply.status(201).send({ assignment });
  });

  // DELETE /api/turfs/:id/assign/:user_id → 204 (idempotent)
  app.delete('/:id/assign/:user_id', { preHandler: organizerOnly }, async (req, reply) => {
    const { id, user_id } = assignParams.parse(req.params);
    const me = currentSession(req).user;
    const row = await one<{ id: string }>(
      app.db,
      `DELETE FROM assignment WHERE turf_id = $1 AND user_id = $2 RETURNING id`,
      [id, user_id],
    );
    if (row) {
      await audit(app.db, req.log, {
        userId: me.id,
        action: 'unassign_turf',
        target: id,
        detail: { user_id },
        ip: req.ip,
      });
    }
    return reply.status(204).send();
  });

  // GET /api/turfs/:id/doors — the door screen. Volunteers: assigned turfs only.
  app.get('/:id/doors', { preHandler: requireAuth }, async (req) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;
    await assertTurfAccess(app.db, me.role, id, me.id);

    const turf = await loadTurf(id, true);
    const turfStreets = await streetsByTurf(app.db, [id]);
    const [doors, voters] = await Promise.all([
      q<DoorRow>(
        app.db,
        `SELECT h.id AS household_id, h.address, h.community, h.ward, h.lat, h.lon, h.n_voters,
                x.walk_order, s.last_result, s.last_contact_at
         FROM turf_household x
         JOIN household h ON h.id = x.household_id
         LEFT JOIN LATERAL (
           SELECT c.result AS last_result, c.at AS last_contact_at
           FROM contact c WHERE c.household_id = h.id ORDER BY c.at DESC LIMIT 1
         ) s ON true
         WHERE x.turf_id = $1
         ORDER BY x.walk_order NULLS LAST, h.id`,
        [id],
      ),
      q<VoterRow & { household_id: string }>(
        app.db,
        `SELECT v.household_id, v.id, v.display_name, v.full_name, v.first_name, v.middle_names, v.last_name,
                v.suffix, v.resident_class, v.mail_kind, v.mail_differs_real, v.mailing_address, v.mail_city,
                v.mail_postal, vs.last_support, vs.last_result, vs.last_contact_at
         FROM voter v
         JOIN turf_household x ON x.household_id = v.household_id AND x.turf_id = $1
         LEFT JOIN LATERAL (
           SELECT c.support AS last_support, c.result AS last_result, c.at AS last_contact_at
           FROM contact c WHERE c.voter_id = v.id ORDER BY c.at DESC LIMIT 1
         ) vs ON true
         ORDER BY v.household_id, v.last_name, v.first_name, v.id`,
        [id],
      ),
    ]);

    const votersByHousehold = new Map<string, VoterRow[]>();
    for (const v of voters) {
      const list = votersByHousehold.get(v.household_id) ?? [];
      list.push(v);
      votersByHousehold.set(v.household_id, list);
    }

    // One audit row per door-list view, not one per door.
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_turf_doors',
      target: id,
      detail: { n_doors: doors.length },
      ip: req.ip,
    });

    // No `assignees` here: a volunteer has no business knowing who else is on the turf.
    return {
      turf: { ...turf, streets: turfStreets.get(id) ?? [] },
      doors: doors.map((d) => serializeDoor(d, votersByHousehold.get(d.household_id) ?? [], me.role)),
    };
  });
};

// ---------------------------------------------------------------- routes: /api/assignments

interface MineRow {
  id: string;
  status: string;
  due_date: string | null;
  assigned_at: Date;
  turf_id: string;
  turf_name: string;
  turf_ward: string | null;
  n_households: number;
  contacted: number;
}

export const assignmentRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/assignments/mine — any signed-in role. Archived turfs are dropped.
  app.get('/assignments/mine', { preHandler: requireAuth }, async (req) => {
    const me = currentSession(req).user;
    const rows = await q<MineRow>(
      app.db,
      `SELECT a.id, a.status, to_char(a.due_date, 'YYYY-MM-DD') AS due_date, a.assigned_at,
              t.id AS turf_id, t.name AS turf_name, t.ward AS turf_ward,
              c.n_households, c.contacted
       FROM assignment a
       JOIN turf t ON t.id = a.turf_id
       ${TURF_COUNTS}
       WHERE a.user_id = $1 AND NOT t.archived
       ORDER BY a.assigned_at DESC`,
      [me.id],
    );
    return {
      assignments: rows.map((r) => ({
        id: r.id,
        status: r.status,
        due_date: r.due_date,
        assigned_at: r.assigned_at,
        turf: { id: r.turf_id, name: r.turf_name, ward: r.turf_ward },
        n_households: r.n_households,
        contacted: r.contacted,
      })),
    };
  });

  // PATCH /api/assignments/:id { status } — a volunteer may only touch their own.
  app.patch('/assignments/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = assignmentPatchBody.parse(req.body);
    const me = currentSession(req).user;

    const cur = await one<{ id: string; user_id: string }>(app.db, `SELECT id, user_id FROM assignment WHERE id = $1`, [
      id,
    ]);
    if (!cur) throw notFound('assignment not found');
    if (!isOrganizer(me.role) && cur.user_id !== me.id) {
      throw forbidden('this assignment belongs to someone else', 'not_your_assignment');
    }

    const assignment = await one<AssignmentRow>(
      app.db,
      `WITH upd AS (UPDATE assignment SET status = $2 WHERE id = $1 RETURNING *)
       SELECT a.id, a.turf_id, a.user_id, u.name AS user_name, a.status, a.assigned_at,
              to_char(a.due_date, 'YYYY-MM-DD') AS due_date
       FROM upd a JOIN app_user u ON u.id = a.user_id`,
      [id, body.status],
    );
    if (!assignment) throw notFound('assignment not found');
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'update_assignment',
      target: id,
      detail: { status: body.status },
      ip: req.ip,
    });
    return { assignment };
  });
};
