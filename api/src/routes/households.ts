import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { audit } from '../lib/audit.js';
import { ApiError, notFound } from '../lib/errors.js';
import { assertHouseholdAccess } from '../lib/scope.js';
import {
  requestDoorImage,
  STREETVIEW_DEFAULT_H,
  STREETVIEW_DEFAULT_W,
  STREETVIEW_MAX_DIM,
  STREETVIEW_MIN_DIM,
} from '../lib/streetview.js';
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

/**
 * Street View size. Capped hard, because every accepted pixel size is a separately billed image
 * and an uncapped `w`/`h` is a way for a signed-in volunteer — or anyone who gets a session — to
 * spend the campaign's money at will. 640 is also the provider's own unsigned ceiling, so asking
 * for more would not even get you more.
 */
const streetviewQuery = z.object({
  w: z.coerce.number().int().min(STREETVIEW_MIN_DIM).max(STREETVIEW_MAX_DIM).default(STREETVIEW_DEFAULT_W),
  h: z.coerce.number().int().min(STREETVIEW_MIN_DIM).max(STREETVIEW_MAX_DIM).default(STREETVIEW_DEFAULT_H),
});

/**
 * Per-user, not per-IP: this limit exists to bound spending and a canvassing team shares one LTE
 * NAT often enough that an IP bucket would throttle the wrong people. 40/min is far more doors
 * than anyone can look at, and the browser's `Cache-Control: private` means scrolling back through
 * a turf costs nothing at all.
 */
const STREETVIEW_RATE_LIMIT = {
  rateLimit: {
    max: 40,
    timeWindow: '1 minute',
    keyGenerator: (req: FastifyRequest) => req.session?.user.id ?? req.ip,
  },
};

/**
 * Deliberately SHORT. The imagery itself barely changes, so a long max-age would be the obvious
 * choice — but Google's Maps Platform ToS §3.2.3(b) is a flat "No Caching" of Maps Content, with
 * an express carve-out only for `pano_ID` values, so nothing here treats the bytes as something to
 * keep. Fifteen minutes is the window in which a volunteer scrolls back to a door they just looked
 * at, which is transport behaviour rather than a stored copy; `private` keeps it in that
 * volunteer's own browser and out of any shared cache in between. Set it to `no-store` if the
 * campaign wants to be maximally conservative — every re-view then costs an image request.
 */
const STREETVIEW_CACHE_CONTROL = 'private, max-age=900';

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
    const sess = currentSession(req);
    const role = sess.user.role;
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

    // Organizers get `status` everywhere. Volunteers get it only for doors inside a turf assigned
    // to them (Phase 2 — so they can colour their own turf); everything else stays as anonymous as
    // it was in Phase 1. Their scope is materialised once in a CTE rather than tested per row.
    let cte = '';
    let joins: string;
    let extraCols: string;
    if (organizer) {
      joins = `LEFT JOIN LATERAL (SELECT c.result AS last_result FROM contact c
                                  WHERE c.household_id = h.id ORDER BY c.at DESC LIMIT 1) s ON true`;
      extraCols = 's.last_result, true AS in_turf';
    } else {
      params.push(sess.user.id);
      cte = `WITH scope AS (
               SELECT DISTINCT x.household_id
               FROM turf_household x JOIN assignment a ON a.turf_id = x.turf_id
               WHERE a.user_id = $${params.length}
             )`;
      joins = `LEFT JOIN scope sc ON sc.household_id = h.id
               LEFT JOIN LATERAL (SELECT c.result AS last_result FROM contact c
                                  WHERE sc.household_id IS NOT NULL AND c.household_id = h.id
                                  ORDER BY c.at DESC LIMIT 1) s ON true`;
      extraCols = 's.last_result, (sc.household_id IS NOT NULL) AS in_turf';
    }

    const rows = await q<PointRow>(
      app.db,
      `${cte}
       SELECT h.id, h.ward, h.community, h.n_voters, h.is_institution, h.n_nonresident,
              h.record_quality, h.lat, h.lon, ${extraCols}
       FROM household h ${joins}
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

  // GET /api/households/:id — household card. Organizer/admin: any door.
  // Volunteer: only a door inside one of their assigned turfs (Phase 2), else 403.
  app.get('/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParams.parse(req.params);
    const sess = currentSession(req);
    const role = sess.user.role;
    // Scope is checked before the row is loaded: an out-of-turf volunteer gets 403, never a 404
    // that would tell them whether the id exists.
    await assertHouseholdAccess(app.db, role, id, sess.user.id);

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

  /**
   * GET /api/households/:id/streetview → the image bytes for that door.
   *
   * Scoped exactly like GET /api/households/:id above (same helper, not a second implementation):
   * organizer/admin anywhere, volunteers only inside their assigned turfs.
   *
   * What crosses the wire to the provider is two numbers — see lib/streetview.ts for why that
   * matters and for the rest of the privacy argument. Nothing is written to disk.
   */
  app.get('/:id/streetview', { preHandler: requireAuth, config: STREETVIEW_RATE_LIMIT }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { w, h } = streetviewQuery.parse(req.query);
    const sess = currentSession(req);

    // The feature switch is checked first because it is global: the answer is identical for every
    // id, every role and every caller, so it discloses nothing about this household — and when
    // nobody has configured a key there is no reason to touch the database at all.
    const apiKey = app.config.STREETVIEW_API_KEY;
    if (!apiKey) {
      throw new ApiError(503, 'streetview_disabled', 'street-level imagery is not configured');
    }

    // Scope before the row is loaded, exactly as on GET /:id — an out-of-turf volunteer gets 403
    // and never learns whether the id exists.
    await assertHouseholdAccess(app.db, sess.user.role, id, sess.user.id);

    const hh = await one<{ lat: number | null; lon: number | null }>(
      app.db,
      `SELECT h.lat, h.lon FROM household h WHERE h.id = $1`,
      [id],
    );
    if (!hh) throw notFound('household not found');
    // Legal descriptions (concession/lot) and the handful of unmatched civic rows have no point.
    // There is nothing to photograph and nothing to send, so this is the same clean 404 as a door
    // the provider has simply never driven past.
    if (hh.lat === null || hh.lon === null) {
      throw notFound('no street-level imagery for this door', 'no_imagery');
    }

    const result = await requestDoorImage({
      fetchImpl: app.httpFetch,
      apiKey,
      provider: app.config.STREETVIEW_PROVIDER,
      lat: hh.lat,
      lon: hh.lon,
      width: w,
      height: h,
    });

    if (result.kind === 'error') {
      // The provider's own status (REQUEST_DENIED, OVER_QUERY_LIMIT, an HTTP code) is operational
      // detail: it goes to the log where ops can see it, not to the volunteer at the door.
      req.log.error({ provider: app.config.STREETVIEW_PROVIDER, status: result.status }, 'streetview request failed');
      throw new ApiError(502, 'streetview_unavailable', 'street-level imagery is temporarily unavailable');
    }

    // A 404 is the honest answer on most rural concession roads, and the UI renders nothing for it.
    if (result.kind === 'unavailable') {
      // Audited anyway: "we asked about this door and there was nothing" is still a lookup that
      // sent this door's coordinates to a third party, and the log should say so.
      await audit(app.db, req.log, {
        userId: sess.user.id,
        action: 'view_streetview',
        target: id,
        detail: { available: false, provider: app.config.STREETVIEW_PROVIDER },
        ip: req.ip,
      });
      reply.header('Cache-Control', STREETVIEW_CACHE_CONTROL);
      throw notFound('no street-level imagery for this door', 'no_imagery');
    }

    await audit(app.db, req.log, {
      userId: sess.user.id,
      action: 'view_streetview',
      target: id,
      // No `cached` flag: every 200 here is a fresh, billed image request, because the bytes are
      // never kept (Google ToS §3.2.3 — see lib/streetview.ts note 3). One row, one charge.
      detail: { available: true, provider: app.config.STREETVIEW_PROVIDER, size: `${w}x${h}` },
      ip: req.ip,
    });

    reply.header('Cache-Control', STREETVIEW_CACHE_CONTROL);
    reply.header('Content-Length', String(result.image.bytes.length));
    reply.header('Content-Disposition', 'inline');
    // Attribution is the CALLER's job, not something to rely on being burned into the pixels:
    // Google's Street View policies require the app to display Google Maps attribution alongside
    // the content. web/src/map/StreetView.tsx renders it; this header tells any other consumer
    // which source it has to credit.
    reply.header('X-Streetview-Provider', app.config.STREETVIEW_PROVIDER);
    reply.type(result.image.contentType);
    return reply.send(result.image.bytes);
  });
};
