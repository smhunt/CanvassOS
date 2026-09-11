/**
 * Lawn signs.
 *
 * Signs are campaign logistics, not voter data: any signed-in role may place one and see the list.
 * The one thing that matters months later is being able to FIND the sign again — Ontario municipal
 * sign by-laws require them down within a set period after election day, and a sign nobody can
 * find is a fine. "Third gate past the church" is not a location in November, so the GPS fix and
 * the photo are the whole point, and `POST /api/signs` is idempotent on `client_id` because the
 * volunteer standing at that gate has one bar of signal.
 *
 * `sign.household_id` is nullable on purpose: road allowances, corners and business frontages are
 * not doors on the voters list. Where a household IS joined, only `address`/`ward` come back —
 * both already inside `HouseholdPublic`, so a volunteer learns nothing new (see lib/serialize.ts).
 */
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q, withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { IMAGE_EXT, sniffImage } from '../lib/images.js';
import {
  isOrganizer,
  serializePickup,
  serializeSign,
  serializeSignPhoto,
  serializeSignRequest,
  type PickupRow,
  type SignPhotoRow,
  type SignRequestRow,
  type SignRow,
} from '../lib/serialize.js';

// ---------------------------------------------------------------- input

const STATUSES = ['requested', 'placed', 'removed', 'missing', 'damaged'] as const;
/** Statuses that still have a sign standing somewhere that has to be collected. */
const PICKUP_STATUSES = ['placed', 'damaged'] as const;

/** 8 MB is a phone photo with room to spare; anything larger is a mistake, not a sign. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * Middlesex Centre plus a generous margin. A GPS fix that lands in Lake Huron or in Toronto is a
 * bad fix, and a bad fix is worse than no fix: it sends the pickup crew to the wrong concession
 * and the real sign stays up past the by-law deadline. Reject it at the door with a clear message
 * so the volunteer knows to wait for a better lock.
 */
const MC_BBOX = { minLat: 42.8, maxLat: 43.2, minLon: -81.7, maxLon: -81.1 };

const householdId = z.string().regex(/^H-[A-Z]+-\d{1,8}$/, 'invalid household id');
const idParams = z.object({ id: z.string().uuid() });
const photoParams = z.object({ photoId: z.string().uuid() });

// Optional fields are `.nullish()` for the same reason as contacts: an offline form serialises the
// boxes nobody filled in as `null`, and null and absent both mean "leave it at the column default".
const createBody = z.object({
  household_id: householdId.nullish(),
  lat: z.coerce.number().finite(),
  lon: z.coerce.number().finite(),
  accuracy_m: z.coerce.number().finite().min(0).max(100000).nullish(),
  label: z.string().trim().max(200).nullish(),
  size: z.string().trim().max(40).nullish(),
  note: z.string().trim().max(2000).nullish(),
  permission_by: z.string().trim().max(200).nullish(),
  status: z.enum(STATUSES).default('placed'),
  requested_from: z.string().uuid().nullish(),
  client_id: z.string().trim().min(6).max(100).nullish(),
});

const patchBody = z
  .object({
    status: z.enum(STATUSES).optional(),
    label: z.string().trim().max(200).nullish(),
    size: z.string().trim().max(40).nullish(),
    note: z.string().trim().max(2000).nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });

const csvList = (re: RegExp, max: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
    .refine((arr) => !arr || (arr.length <= max && arr.every((x) => re.test(x))), 'invalid list value');

// bbox parsing follows routes/households.ts exactly — same order, same messages.
const listQuery = z.object({
  status: csvList(/^(requested|placed|removed|missing|damaged)$/, 5),
  ward: csvList(/^\d{2}$/, 10),
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

const requestsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) });

// ---------------------------------------------------------------- SQL

const SIGN_JOINS = `
  FROM sign s
  LEFT JOIN household h ON h.id = s.household_id
  LEFT JOIN app_user pu ON pu.id = s.placed_by
  LEFT JOIN app_user ru ON ru.id = s.removed_by`;

const SIGN_COLS = `
  s.id, s.household_id, h.address, h.ward, s.status::text AS status, s.lat, s.lon, s.accuracy_m,
  s.label, s.size, s.note, s.permission_by, s.requested_at, s.requested_from,
  s.placed_by, pu.name AS placed_by_name, s.placed_at,
  s.removed_by, ru.name AS removed_by_name, s.removed_at,
  s.created_at, s.client_id,
  (SELECT count(*)::int FROM sign_photo p WHERE p.sign_id = s.id) AS photo_count`;

const PHOTO_COLS = `
  p.id, p.sign_id, p.path, p.content_type, p.bytes, p.width, p.height,
  p.taken_by, tu.name AS taken_by_name, p.taken_at`;

const PHOTO_FROM = `FROM sign_photo p LEFT JOIN app_user tu ON tu.id = p.taken_by`;

/** Generated names only — never a client-supplied filename, and never a path that can escape the dir. */
const SAFE_PHOTO_FILE = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

export const signRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');
  const photoDir = resolve(app.config.SIGN_PHOTO_DIR);
  // Created on boot: the operator only has to provide the volume, not remember to mkdir into it.
  await mkdir(photoDir, { recursive: true });

  const loadPhotos = async (signId: string) =>
    (await q<SignPhotoRow>(app.db, `SELECT ${PHOTO_COLS} ${PHOTO_FROM} WHERE p.sign_id = $1 ORDER BY p.taken_at, p.id`, [
      signId,
    ])).map(serializeSignPhoto);

  // ---------------------------------------------------------------- place

  /**
   * POST /api/signs → 201 { sign }, or 200 { sign } when `client_id` has already been seen.
   * Same idempotency contract as POST /api/contacts, for the same reason: the offline queue on a
   * rural road retries, and a retry must not plant a second sign in the database.
   */
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const me = currentSession(req).user;

    if (
      body.lat < MC_BBOX.minLat ||
      body.lat > MC_BBOX.maxLat ||
      body.lon < MC_BBOX.minLon ||
      body.lon > MC_BBOX.maxLon
    ) {
      throw badRequest(
        `lat/lon (${body.lat}, ${body.lon}) is outside Middlesex Centre ` +
          `(lat ${MC_BBOX.minLat}..${MC_BBOX.maxLat}, lon ${MC_BBOX.minLon}..${MC_BBOX.maxLon}); ` +
          'wait for a better GPS fix rather than recording a wrong one',
        'coordinate_out_of_range',
      );
    }

    if (body.household_id) {
      const hh = await one<{ id: string }>(app.db, `SELECT id FROM household WHERE id = $1`, [body.household_id]);
      if (!hh) throw notFound('household not found');
    }
    if (body.requested_from) {
      const c = await one<{ id: string }>(app.db, `SELECT id FROM contact WHERE id = $1`, [body.requested_from]);
      if (!c) throw badRequest('requested_from is not a known contact', 'contact_not_found');
    }

    // A `requested` sign has not been planted yet, so stamping placed_by/placed_at would lie to the
    // pickup list; it gets requested_at instead. Anything else is a placement happening right now.
    const isRequest = body.status === 'requested';
    const params = [
      body.household_id ?? null,
      body.status,
      body.lat,
      body.lon,
      body.accuracy_m ?? null,
      body.label ?? null,
      body.size ?? null,
      body.note ?? null,
      body.permission_by ?? null,
      isRequest || body.requested_from ? new Date() : null,
      body.requested_from ?? null,
      isRequest ? null : me.id,
      isRequest ? null : new Date(),
      body.client_id ?? null,
    ];

    const { sign, created } = await withTx(app.db, async (tx) => {
      // client_id is NULL-able and NULLs never conflict, so one statement serves both cases.
      const ins = await one<SignRow>(
        tx,
        `WITH ins AS (
           INSERT INTO sign (household_id, status, lat, lon, accuracy_m, label, size, note, permission_by,
                             requested_at, requested_from, placed_by, placed_at, client_id)
           VALUES ($1, $2::sign_status, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (client_id) DO NOTHING
           RETURNING *
         )
         SELECT ${SIGN_COLS}
         FROM ins s
         LEFT JOIN household h ON h.id = s.household_id
         LEFT JOIN app_user pu ON pu.id = s.placed_by
         LEFT JOIN app_user ru ON ru.id = s.removed_by`,
        params,
      );
      if (ins) return { sign: ins, created: true };

      const existing = await one<SignRow>(tx, `SELECT ${SIGN_COLS} ${SIGN_JOINS} WHERE s.client_id = $1`, [
        body.client_id ?? null,
      ]);
      if (!existing) throw new Error('sign insert returned no row');
      return { sign: existing, created: false };
    });

    // A replay of a stored client_id planted nothing new, so it is not audited a second time.
    if (created) {
      await audit(app.db, req.log, {
        userId: me.id,
        action: 'place_sign',
        target: sign.id,
        detail: { status: sign.status, household_id: sign.household_id, lat: sign.lat, lon: sign.lon },
        ip: req.ip,
      });
    }
    return reply.status(created ? 201 : 200).send({ sign: serializeSign(sign) });
  });

  // ---------------------------------------------------------------- read
  // NOTE: /pickup and /requests are declared before /:id — they are static segments, so find-my-way
  // prefers them over the parameter either way, but keeping them first keeps that obvious.

  /**
   * GET /api/signs/pickup — the retrieval worklist: everything still standing.
   *
   * Ordered ward → label/address → latitude. That is a "drive north up the concession" ordering,
   * not a travelling-salesman solve: it is stable, explainable to the volunteer holding the list,
   * and good enough to collect a few hundred signs in a weekend.
   */
  app.get('/pickup', { preHandler: requireAuth }, async () => {
    const rows = await q<PickupRow>(
      app.db,
      `SELECT s.id, s.status::text AS status, h.ward, h.address, s.label, s.size, s.note,
              s.lat, s.lon, s.accuracy_m, s.placed_at, pu.name AS placed_by_name,
              coalesce((SELECT array_agg(p.id::text ORDER BY p.taken_at, p.id)
                        FROM sign_photo p WHERE p.sign_id = s.id), '{}') AS photo_ids
       FROM sign s
       LEFT JOIN household h ON h.id = s.household_id
       LEFT JOIN app_user pu ON pu.id = s.placed_by
       WHERE s.status = ANY($1::sign_status[])
       ORDER BY h.ward NULLS LAST, coalesce(nullif(s.label, ''), h.address) NULLS LAST, s.lat NULLS LAST, s.id`,
      [PICKUP_STATUSES],
    );
    return { signs: rows.map(serializePickup) };
  });

  /**
   * GET /api/signs/requests — doors that asked for a sign and have not had one placed.
   *
   * This is the loop back from the door screen (`contact.wants_sign`) to sign delivery, and unlike
   * the rest of /api/signs it IS voter data: it lists addresses off the list. So it audits like
   * every other personal-data read, and a volunteer sees only doors inside their own turfs — the
   * Phase 2 rule, unchanged.
   */
  app.get('/requests', { preHandler: requireAuth }, async (req) => {
    const qp = requestsQuery.parse(req.query);
    const me = currentSession(req).user;
    const params: unknown[] = [qp.limit];
    let scope = '';
    if (!isOrganizer(me.role)) {
      params.push(me.id);
      scope = `AND EXISTS (SELECT 1 FROM turf_household x JOIN assignment a ON a.turf_id = x.turf_id
                           WHERE x.household_id = h.id AND a.user_id = $${params.length})`;
    }

    const rows = await q<SignRequestRow>(
      app.db,
      `SELECT h.id AS household_id, h.address, h.ward, h.community, h.lat, h.lon,
              -- Where they asked for it, when that is not the door: a corner lot, a farm gate, the
              -- shop. Null means nobody captured one, not that the door is the answer.
              c.sign_address,
              c.id AS contact_id, c.at AS last_contact_at, c.result::text AS last_result, c.note,
              c.user_id, u.name AS user_name, c.voter_id, v.display_name AS voter_name
       FROM (SELECT DISTINCT household_id FROM contact WHERE wants_sign) d
       JOIN household h ON h.id = d.household_id
       JOIN LATERAL (SELECT * FROM contact WHERE household_id = h.id ORDER BY at DESC LIMIT 1) c ON true
       JOIN app_user u ON u.id = c.user_id
       LEFT JOIN voter v ON v.id = c.voter_id
       WHERE c.wants_sign
         -- Only a sign that exists in some OTHER form excludes the door. A row still marked
         -- 'requested' is this same request, written by POST /api/contacts, and must not hide the
         -- door from the list of doors still waiting for one.
         AND NOT EXISTS (SELECT 1 FROM sign s WHERE s.household_id = h.id AND s.status <> 'requested')
         ${scope}
       ORDER BY c.at DESC
       LIMIT $1`,
      params,
    );

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_sign_requests',
      detail: { n: rows.length },
      ip: req.ip,
    });
    return { requests: rows.map(serializeSignRequest) };
  });

  // GET /api/signs?status=&ward=&bbox= — any signed-in role.
  app.get('/', { preHandler: requireAuth }, async (req) => {
    const qp = listQuery.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    if (qp.status) {
      params.push(qp.status);
      where.push(`s.status = ANY($${params.length}::sign_status[])`);
    }
    if (qp.ward) {
      // A sign on a road allowance has no household and therefore no ward; filtering by ward
      // necessarily drops it.
      params.push(qp.ward);
      where.push(`h.ward = ANY($${params.length}::text[])`);
    }
    if (qp.bbox) {
      params.push(qp.bbox.minLon, qp.bbox.minLat, qp.bbox.maxLon, qp.bbox.maxLat);
      const n = params.length;
      where.push(`s.lon BETWEEN $${n - 3} AND $${n - 1}`, `s.lat BETWEEN $${n - 2} AND $${n}`);
    }

    const rows = await q<SignRow>(
      app.db,
      `SELECT ${SIGN_COLS} ${SIGN_JOINS}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY s.created_at DESC, s.id`,
      params,
    );
    return { signs: rows.map(serializeSign) };
  });

  // GET /api/signs/:id → one sign plus its photos' ids and metadata (never the bytes, never `path`).
  app.get('/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParams.parse(req.params);
    const sign = await one<SignRow>(app.db, `SELECT ${SIGN_COLS} ${SIGN_JOINS} WHERE s.id = $1`, [id]);
    if (!sign) throw notFound('sign not found');
    return { sign: { ...serializeSign(sign), photos: await loadPhotos(id) } };
  });

  // ---------------------------------------------------------------- update / delete

  /**
   * PATCH /api/signs/:id — status, label, size, note.
   *
   * `removed` is the by-law-relevant transition, so it stamps who took it down and when; moving a
   * sign back off `removed` (it was marked collected by mistake, or it went back up) clears the
   * stamp again rather than leaving a removal date on a sign that is still standing.
   */
  app.patch('/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const me = currentSession(req).user;

    const before = await one<{ status: string }>(app.db, `SELECT status::text AS status FROM sign WHERE id = $1`, [id]);
    if (!before) throw notFound('sign not found');

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.status !== undefined) {
      params.push(body.status);
      sets.push(`status = $${params.length}::sign_status`);
      if (body.status === 'removed') {
        set('removed_by', me.id);
        set('removed_at', new Date());
      } else if (before.status === 'removed') {
        sets.push('removed_by = NULL', 'removed_at = NULL');
      }
      // requested → placed is a real delivery; give it a placement stamp if it never had one.
      // `coalesce` so re-flagging an existing sign `damaged` does not rewrite who planted it.
      if (body.status !== 'requested') {
        params.push(me.id);
        sets.push(`placed_by = coalesce(placed_by, $${params.length})`);
        params.push(new Date());
        sets.push(`placed_at = coalesce(placed_at, $${params.length})`);
      }
    }
    if (body.label !== undefined) set('label', body.label);
    if (body.size !== undefined) set('size', body.size);
    if (body.note !== undefined) set('note', body.note);

    await app.db.query(`UPDATE sign SET ${sets.join(', ')} WHERE id = $1`, params);
    const sign = await one<SignRow>(app.db, `SELECT ${SIGN_COLS} ${SIGN_JOINS} WHERE s.id = $1`, [id]);
    if (!sign) throw notFound('sign not found');

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'update_sign',
      target: id,
      detail: { ...body, from_status: before.status },
      ip: req.ip,
    });
    return { sign: { ...serializeSign(sign), photos: await loadPhotos(id) } };
  });

  /**
   * DELETE /api/signs/:id → 204. Organizer/admin only: a sign recorded by mistake should be
   * deletable, but the record of where a sign is standing is not a volunteer's to erase.
   * `sign_photo` rows cascade; their files are unlinked here so nothing is orphaned on disk.
   */
  app.delete('/:id', { preHandler: organizerOnly }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;

    const photos = await q<{ path: string }>(app.db, `SELECT path FROM sign_photo WHERE sign_id = $1`, [id]);
    const row = await one<{ id: string; label: string | null; status: string }>(
      app.db,
      `DELETE FROM sign WHERE id = $1 RETURNING id, label, status::text AS status`,
      [id],
    );
    if (!row) throw notFound('sign not found');
    for (const p of photos) await removePhotoFile(photoDir, p.path, req.log);

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'delete_sign',
      target: id,
      detail: { label: row.label, status: row.status, photos: photos.length },
      ip: req.ip,
    });
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- photos

  /**
   * POST /api/signs/:id/photo — one `multipart/form-data` image.
   *
   * The declared content-type is not trusted: the bytes are sniffed and the sniffed type is what
   * is stored and later served. The filename is not trusted either — it is discarded entirely and
   * the file is written under a generated uuid, which is also the row id.
   */
  app.post('/:id/photo', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;

    const sign = await one<{ id: string }>(app.db, `SELECT id FROM sign WHERE id = $1`, [id]);
    if (!sign) throw notFound('sign not found');
    if (!req.isMultipart()) throw badRequest('expected a multipart/form-data upload', 'not_multipart');

    const part = await req.file();
    if (!part) throw badRequest('no file part in the upload', 'no_file');

    let buf: Buffer;
    try {
      buf = await part.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new ApiError(
          413,
          'file_too_large',
          `image exceeds the ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} MB limit`,
        );
      }
      throw err;
    }
    if (buf.length === 0) throw badRequest('the uploaded file is empty', 'empty_file');

    const img = sniffImage(buf);
    if (!img) {
      throw badRequest(
        'unsupported image: the file does not begin with JPEG, PNG or WebP magic bytes',
        'unsupported_image',
      );
    }

    const photoId = randomUUID();
    const file = `${photoId}.${IMAGE_EXT[img.contentType]}`;
    // `wx` — a uuid collision must fail loudly rather than overwrite somebody else's photo.
    await writeFile(join(photoDir, file), buf, { flag: 'wx' });

    let photo: SignPhotoRow | undefined;
    try {
      photo = await one<SignPhotoRow>(
        app.db,
        `WITH ins AS (
           INSERT INTO sign_photo (id, sign_id, path, content_type, bytes, width, height, taken_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *
         )
         SELECT ${PHOTO_COLS} FROM ins p LEFT JOIN app_user tu ON tu.id = p.taken_by`,
        [photoId, id, file, img.contentType, buf.length, img.width, img.height, me.id],
      );
    } catch (err) {
      // Never leave a file on disk that no row points at — `make purge` shreds the directory, but
      // between now and then an orphan is just an untracked photo of someone's house.
      await removePhotoFile(photoDir, file, req.log);
      throw err;
    }
    if (!photo) throw new Error('sign_photo insert returned no row');

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'upload_sign_photo',
      target: photo.id,
      detail: { sign_id: id, content_type: img.contentType, bytes: buf.length },
      ip: req.ip,
    });
    return reply.status(201).send({ photo: serializeSignPhoto(photo) });
  });

  /**
   * GET /api/signs/photo/:photoId — the bytes.
   *
   * Auth required and audited: a photo of a lawn sign is a photo of somebody's house, which makes
   * it personal information however mundane it looks. `Cache-Control: private` keeps it out of any
   * shared cache between here and the browser.
   */
  app.get('/photo/:photoId', { preHandler: requireAuth }, async (req, reply) => {
    const { photoId } = photoParams.parse(req.params);
    const me = currentSession(req).user;

    const photo = await one<{ sign_id: string; path: string; content_type: string }>(
      app.db,
      `SELECT sign_id, path, content_type FROM sign_photo WHERE id = $1`,
      [photoId],
    );
    if (!photo) throw notFound('photo not found');

    const file = safePhotoPath(photoDir, photo.path);
    if (!file) throw notFound('photo not found');
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      // The row survived but the file did not (restored database, half-restored volume).
      throw notFound('photo file is missing from the photo directory', 'photo_file_missing');
    }

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_sign_photo',
      target: photoId,
      detail: { sign_id: photo.sign_id },
      ip: req.ip,
    });

    reply.header('Cache-Control', 'private');
    reply.header('Content-Length', size);
    reply.header('Content-Disposition', 'inline');
    reply.type(photo.content_type);
    return reply.send(createReadStream(file));
  });

  /** DELETE /api/signs/photo/:photoId → 204. Organizer/admin; removes the row and the file. */
  app.delete('/photo/:photoId', { preHandler: organizerOnly }, async (req, reply) => {
    const { photoId } = photoParams.parse(req.params);
    const me = currentSession(req).user;

    const row = await one<{ sign_id: string; path: string }>(
      app.db,
      `DELETE FROM sign_photo WHERE id = $1 RETURNING sign_id, path`,
      [photoId],
    );
    if (!row) throw notFound('photo not found');
    await removePhotoFile(photoDir, row.path, req.log);

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'delete_sign',
      target: photoId,
      detail: { photo_id: photoId, sign_id: row.sign_id },
      ip: req.ip,
    });
    return reply.status(204).send();
  });
};

// ---------------------------------------------------------------- disk helpers

/**
 * Resolve a stored `path` inside the photo directory, or null. The values are generated by this
 * file and can only be uuid filenames, but the check is here because the string makes a round trip
 * through the database and a path that escapes SIGN_PHOTO_DIR would read arbitrary files.
 */
function safePhotoPath(dir: string, path: string): string | null {
  const name = basename(path);
  if (name !== path || !SAFE_PHOTO_FILE.test(name)) return null;
  return join(dir, name);
}

async function removePhotoFile(
  dir: string,
  path: string,
  log: { warn: (o: unknown, m: string) => void },
): Promise<void> {
  const file = safePhotoPath(dir, path);
  if (!file) return;
  try {
    await unlink(file);
  } catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') log.warn({ err, file }, 'sign photo file not removed');
  }
}
