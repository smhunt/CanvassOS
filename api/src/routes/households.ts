import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import {
  isOrganizer,
  serializeHousehold,
  serializePointProps,
  serializeVoter,
  type HouseholdRow,
  type PointRow,
  type VoterRow,
} from '../lib/serialize.js';

// ---------------------------------------------------------------- query parsing

const csvList = (re: RegExp, max: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .refine((arr) => !arr || (arr.length <= max && arr.every((x) => re.test(x))), 'invalid list value');

const pointsQuery = z.object({
  ward: csvList(/^\d{2}$/, 10),
  community: csvList(/^[A-Z' .-]{1,30}$/i, 30).transform((a) => a?.map((c) => c.toUpperCase())),
  quality: csvList(/^(good|approx|legal|check)$/, 4),
  bbox: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      const parts = s.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be minLon,minLat,maxLon,maxLat' });
        return z.NEVER;
      }
      const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
      if (minLon > maxLon || minLat > maxLat || Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox out of range' });
        return z.NEVER;
      }
      return { minLon, minLat, maxLon, maxLat };
    }),
});

const legalQuery = z.object({ ward: csvList(/^\d{2}$/, 10) });

const idParams = z.object({ id: z.string().regex(/^H-[A-Z]+-\d{1,8}$/, 'invalid household id') });

// ---------------------------------------------------------------- SQL fragments

const HOUSEHOLD_COLS = `
  h.id, h.ward, h.community, h.postal, h.locality, h.address, h.property_address_raw,
  h.civic_num, h.street, h.street_type, h.street_dir, h.unit, h.lat, h.lon,
  h.addr_match, h.record_quality, h.is_legal, h.is_institution,
  h.n_voters, h.n_nonresident, h.n_po_box`;

const VOTER_COLS = `
  v.id, v.display_name, v.full_name, v.first_name, v.middle_names, v.last_name, v.suffix,
  v.resident_class, v.mail_kind, v.mail_differs_real, v.mailing_address, v.mail_city, v.mail_postal,
  vs.last_support, vs.last_result, vs.last_contact_at`;

/** 6 decimals ≈ 0.1 m; keeps the 7k-point payload small. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export const householdRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');

  // GET /api/households/points — every role; GeoJSON FeatureCollection built in JS from one query.
  app.get('/points', { preHandler: requireAuth }, async (req, reply) => {
    const qp = pointsQuery.parse(req.query);
    const role = currentSession(req).user.role;
    const organizer = isOrganizer(role);

    const params: unknown[] = [];
    const where: string[] = ['h.lat IS NOT NULL', 'h.lon IS NOT NULL', 'NOT h.is_legal'];
    if (qp.ward) {
      params.push(qp.ward);
      where.push(`h.ward = ANY($${params.length}::text[])`);
    }
    if (qp.community) {
      params.push(qp.community);
      where.push(`h.community = ANY($${params.length}::text[])`);
    }
    if (qp.quality) {
      params.push(qp.quality);
      where.push(`h.record_quality = ANY($${params.length}::text[])`);
    }
    if (qp.bbox) {
      params.push(qp.bbox.minLon, qp.bbox.minLat, qp.bbox.maxLon, qp.bbox.maxLat);
      const n = params.length;
      where.push(`h.lon BETWEEN $${n - 3} AND $${n - 1}`, `h.lat BETWEEN $${n - 2} AND $${n}`);
    }

    // Volunteers never receive status, so skip the per-row contact lookup for them entirely.
    const statusJoin = organizer
      ? `LEFT JOIN LATERAL (SELECT c.result AS last_result FROM contact c
                            WHERE c.household_id = h.id ORDER BY c.at DESC LIMIT 1) s ON true`
      : '';
    const statusCol = organizer ? 's.last_result' : 'NULL::text AS last_result';

    const rows = await q<PointRow>(
      app.db,
      `SELECT h.id, h.ward, h.community, h.n_voters, h.is_institution, h.n_nonresident,
              h.record_quality, h.lat, h.lon, ${statusCol}
       FROM household h ${statusJoin}
       WHERE ${where.join(' AND ')}
       ORDER BY h.id`,
      params,
    );

    // Hand-rolled JSON: one string, no intermediate feature objects for 7k rows.
    // Measured on the full 7,069-point set (Postgres 16, local): building the FeatureCollection in
    // SQL with json_agg/json_build_object took ~78 ms in the DB alone (+1.76 MB text transfer);
    // this plain row query takes ~6 ms and the whole request completes in ~45 ms end to end.
    const parts: string[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as PointRow;
      parts[i] =
        `{"type":"Feature","geometry":{"type":"Point","coordinates":[${round6(r.lon)},${round6(r.lat)}]},` +
        `"properties":${JSON.stringify(serializePointProps(r, role))}}`;
    }
    const body = `{"type":"FeatureCollection","features":[${parts.join(',')}]}`;
    reply.header('Cache-Control', 'private, max-age=60');
    reply.type('application/geo+json; charset=utf-8');
    return reply.send(body);
  });

  // GET /api/households/legal?ward= — organizer/admin; the unmapped concession/lot rows.
  app.get('/legal', { preHandler: organizerOnly }, async (req) => {
    const qp = legalQuery.parse(req.query);
    const role = currentSession(req).user.role;
    const params: unknown[] = [];
    let where = 'h.is_legal';
    if (qp.ward) {
      params.push(qp.ward);
      where += ` AND h.ward = ANY($1::text[])`;
    }
    const rows = await q<HouseholdRow & { voter_names: string | null }>(
      app.db,
      `SELECT ${HOUSEHOLD_COLS},
              (SELECT string_agg(v.display_name, '; ' ORDER BY v.last_name, v.first_name)
                 FROM voter v WHERE v.household_id = h.id) AS voter_names
       FROM household h WHERE ${where} ORDER BY h.ward, h.address`,
      params,
    );
    return {
      households: rows.map((r) => ({ ...serializeHousehold(r, role), voter_names: r.voter_names })),
    };
  });

  // GET /api/households/:id — household card (organizer/admin; volunteer → 403 until Phase 2).
  app.get('/:id', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const sess = currentSession(req);
    const role = sess.user.role;

    const hh = await one<HouseholdRow>(app.db, `SELECT ${HOUSEHOLD_COLS} FROM household h WHERE h.id = $1`, [id]);
    if (!hh) throw notFound('household not found');

    const [voters, status] = await Promise.all([
      q<VoterRow>(
        app.db,
        `SELECT ${VOTER_COLS}
         FROM voter v
         LEFT JOIN LATERAL (SELECT c.support AS last_support, c.result AS last_result, c.at AS last_contact_at
                            FROM contact c WHERE c.voter_id = v.id ORDER BY c.at DESC LIMIT 1) vs ON true
         WHERE v.household_id = $1
         ORDER BY v.last_name, v.first_name, v.id`,
        [id],
      ),
      one<{ last_result: string; last_contact_at: Date; last_user_name: string }>(
        app.db,
        `SELECT c.result AS last_result, c.at AS last_contact_at, u.name AS last_user_name
         FROM contact c JOIN app_user u ON u.id = c.user_id
         WHERE c.household_id = $1 ORDER BY c.at DESC LIMIT 1`,
        [id],
      ),
    ]);

    await audit(app.db, req.log, { userId: sess.user.id, action: 'view_household', target: id, ip: req.ip });

    return {
      ...serializeHousehold(hh, role),
      voters: voters.map((v) => serializeVoter(v, role)),
      status: status ?? { last_result: null, last_contact_at: null, last_user_name: null },
    };
  });
};
