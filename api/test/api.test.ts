/**
 * Integration tests. They WRITE to the database they are pointed at, so they are opt-in and
 * refuse to touch the live `canvass` database (see the safety rail below).
 *
 * Set up a throwaway copy once:
 *
 *   docker compose exec -T db psql -U canvass -d postgres -c 'CREATE DATABASE canvass_test'
 *   docker compose exec -T db sh -c 'pg_dump -U canvass canvass | psql -q -U canvass -d canvass_test'
 *       # ...or apply db/schema.sql to it and run:
 *       # python3 importer/import.py --voters data/voters_final.csv --households data/households.csv \
 *       #     --label test --database-url <canvass_test url>
 *
 * Then:
 *
 *   cd api && CANVASS_TEST_DESTRUCTIVE=1 TEST_DATABASE_URL=<canvass_test url> npm test
 *
 * The suite NEVER truncates. It creates its own users under `<who>+<run id>@test.local`, and the
 * after() hook deletes exactly the rows this run created (users, sessions, audit entries, turfs,
 * assignments, contacts) by id — anything already in the database survives untouched.
 *
 * It does expect a freshly imported copy of the voters list: expected counts are computed from the
 * CSVs in ../data, and the canvass aggregates (stats.canvass, /follow-ups, /activity) assume no
 * other contacts exist. Point it at a dedicated test database, not a shared one.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { parse } from 'csv-parse/sync';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { _clearAdviceCache, assertNoPersonalData } from '../src/lib/advice.js';
import { createPool, type Db } from '../src/db.js';
import { clearStreetViewCache, type FetchLike } from '../src/lib/streetview.js';
import { LogProvider } from '../src/messaging/provider.js';
import { normalizeContactValue } from '../src/routes/voter-contacts.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://canvass:canvass@localhost:5443/canvass_test';

const dbName = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
};
const DB_NAME = dbName(DATABASE_URL);

// ------------------------------------------------------------------ safety rail
// This suite writes to whatever database it is handed, and the database it would be handed by
// default holds a voters list supplied under the Municipal Elections Act. Running the tests must
// therefore be a deliberate act against a throwaway copy, never one `npm test` away from the real
// thing. Both checks run at import time, before a single query is issued.
if (process.env.CANVASS_TEST_DESTRUCTIVE !== '1') {
  throw new Error(
    `refusing to run: this suite writes to the database it is pointed at ("${DB_NAME || DATABASE_URL}"). ` +
      'Set CANVASS_TEST_DESTRUCTIVE=1 and point TEST_DATABASE_URL at a throwaway copy to run it.',
  );
}
if (DB_NAME === '' || DB_NAME === 'canvass') {
  throw new Error(
    `refusing to run against database "${DB_NAME || DATABASE_URL}" — that is the live canvass database. ` +
      'Create a throwaway copy (e.g. canvass_test) and point TEST_DATABASE_URL at it.',
  );
}

const DATA_DIR = process.env.CANVASS_DATA_DIR ?? resolve(import.meta.dirname, '../../data');

/** Every user this run creates is `<who>+<RUN>@test.local`, which is also how they are cleaned up. */
const RUN = randomUUID().slice(0, 8);
const email = (who: string): string => `${who}+${RUN}@test.local`;
const EMAIL_PATTERN = `%+${RUN}@test.local`;
const ADMIN_EMAIL = email('admin');
const ADMIN_PASSWORD = 'test-admin-password-1';

type Row = Record<string, string>;
const readCsv = (name: string): Row[] =>
  parse(readFileSync(resolve(DATA_DIR, name), 'utf8'), { columns: true, skip_empty_lines: true }) as Row[];

const RESTRICTED_VOTER_KEYS = ['mailing_address', 'mail_city', 'mail_postal', 'resident_class'];
const RESTRICTED_HH_KEYS = ['n_nonresident', 'n_po_box'];

let app: FastifyInstance;
let db: Db;
/** Sign photos are written to a throwaway directory, never into the repo's data/ volume. */
let photoDir: string;
/** Every sign this run places, so after() can delete exactly those rows (sign_photo cascades). */
const createdSignIds: string[] = [];
/** Messaging rows this run creates — campaigns cascade their message_send rows. */
const createdCampaignIds: string[] = [];
const createdSenderNumberIds: string[] = [];
/**
 * Every number this run pretends to be. Reserved 555-01xx line numbers, so they cannot collide
 * with a real contact even if the test database has one, and they are the handle for cleaning up
 * message_inbound / subscribe_pending rows by value.
 */
const MSG_NUMBERS = [
  '+15195550201',
  '+15195550202',
  '+15195550203',
  '+15195550204',
  '+15195550205',
  '+15195550299',
];
let adminCookie: string;
let volunteerCookie: string;
let organizerCookie: string;

// CSV-derived expectations
const households = readCsv('households.csv');
const voters = readCsv('voters_final.csv');
const nLegal = households.filter((h) => h.household_id!.startsWith('H-LEGAL')).length;
// A household is on the map when it has coordinates and is not a concession/lot description.
// (The rebuilt pipeline maps 3 civic households without coordinates and gives 39 legal rows a
// community, so these have to be counted from the data rather than derived from nLegal.)
const nWithCoords = households.filter((h) => h.lat && !h.household_id!.startsWith('H-LEGAL')).length;
const nWithCommunity = households.filter((h) => h.community).length;
const byWard = new Map<string, { hh: number; v: number }>();
for (const h of households) {
  const w = byWard.get(h.ward!) ?? { hh: 0, v: 0 };
  w.hh += 1;
  w.v += Number(h.n_voters);
  byWard.set(h.ward!, w);
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : sc;
  assert.ok(typeof first === 'string' && first.startsWith('canvass_sid='), 'session cookie set');
  return first.split(';')[0]!;
}

async function login(email: string, password: string): Promise<{ status: number; cookie?: string; body: unknown }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return { status: res.statusCode, cookie: res.statusCode === 200 ? cookieFrom(res) : undefined, body: res.json() };
}

async function inviteAndAccept(email: string, role: string, password: string): Promise<string> {
  const inv = await app.inject({
    method: 'POST',
    url: '/api/users/invite',
    headers: { cookie: adminCookie },
    payload: { email, name: `${role} user`, role },
  });
  assert.equal(inv.statusCode, 201, inv.body);
  const { invite_url } = inv.json() as { invite_url: string };
  assert.match(invite_url, /^https:\/\/.+\/invite\/[A-Za-z0-9_-]{20,}$/);
  const token = invite_url.split('/invite/')[1]!;
  const acc = await app.inject({
    method: 'POST',
    url: '/api/auth/accept-invite',
    payload: { token, name: `${role} accepted`, password },
  });
  assert.equal(acc.statusCode, 200, acc.body);
  return cookieFrom(acc);
}

/** The ids of every user this run created — the unit of cleanup. */
async function testUserIds(): Promise<string[]> {
  const res = await db.query<{ id: string }>(`SELECT id FROM app_user WHERE email LIKE $1`, [EMAIL_PATTERN]);
  return res.rows.map((r) => r.id);
}

before(async () => {
  db = createPool(DATABASE_URL);
  photoDir = await mkdtemp(join(tmpdir(), 'canvass-sign-photos-'));
  const n = await db.query('SELECT count(*)::int AS n FROM household');
  assert.ok(n.rows[0].n > 0, 'household table is empty — run the importer against the test DB first');

  // No ADMIN_EMAIL/ADMIN_PASSWORD: bootstrapAdmin must not create anything, because on a database
  // that already has users it would do nothing anyway and on an empty one it would leave a row
  // behind that this run did not track.
  const config = loadConfig({
    DATABASE_URL,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    DOMAIN: 'canvass.test',
    COOKIE_SECURE: 'false',
    BOUNDARY_PATH: resolve(DATA_DIR, 'mc_boundary.json'),
    SIGN_PHOTO_DIR: photoDir,
    LOG_LEVEL: 'silent',
  });
  app = await buildApp({ config, db, logger: false });
  await app.ready();

  // This run's own admin, created and later deleted by id.
  await db.query(
    `INSERT INTO app_user (email, name, role, password_hash, active)
     VALUES ($1, 'test admin', 'admin', $2, true)`,
    [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)],
  );

  const a = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  adminCookie = a.cookie!;
  volunteerCookie = await inviteAndAccept(email('vol'), 'volunteer', 'volunteer-pass-1');
  organizerCookie = await inviteAndAccept(email('org'), 'organizer', 'organizer-pass-1');
});

after(async () => {
  await app.close();

  // Messaging first: message_campaign.created_by references app_user with no ON DELETE, so a
  // campaign this run composed would otherwise block the deletion of the organizer who composed
  // it. Deleting the campaign cascades its message_send rows, which releases sender_number.
  const inboundIds = (
    await db.query<{ id: string }>(`SELECT id FROM message_inbound WHERE from_e164 = ANY($1::text[])`, [MSG_NUMBERS])
  ).rows.map((r) => r.id);
  const pendingIds = (
    await db.query<{ id: string }>(`SELECT id FROM subscribe_pending WHERE e164 = ANY($1::text[])`, [MSG_NUMBERS])
  ).rows.map((r) => r.id);
  // The inbound/subscribe audit rows carry no user_id (the recipient did them, not the campaign),
  // so they are identified by the row they point at rather than by the test email pattern.
  const anonTargets = [...inboundIds, ...pendingIds];
  if (anonTargets.length > 0) {
    await db.query(`DELETE FROM audit_log WHERE user_id IS NULL AND target = ANY($1::text[])`, [anonTargets]);
  }
  await db.query(`DELETE FROM message_inbound WHERE from_e164 = ANY($1::text[])`, [MSG_NUMBERS]);
  await db.query(`DELETE FROM subscribe_pending WHERE e164 = ANY($1::text[])`, [MSG_NUMBERS]);
  if (createdCampaignIds.length > 0) {
    await db.query(`DELETE FROM message_campaign WHERE id = ANY($1::uuid[])`, [createdCampaignIds]);
  }
  if (createdSenderNumberIds.length > 0) {
    await db.query(`DELETE FROM sender_number WHERE id = ANY($1::uuid[])`, [createdSenderNumberIds]);
  }

  // Delete exactly what this run created, by id, in FK order. Never TRUNCATE: this database may
  // hold rows (users, turfs, contacts) that belong to somebody else.
  const ids = await testUserIds();
  // Signs first: sign.placed_by / removed_by reference app_user without ON DELETE, so a sign this
  // run planted would otherwise block the deletion of the volunteer who planted it.
  if (createdSignIds.length > 0) {
    await db.query(`DELETE FROM sign WHERE id = ANY($1::uuid[])`, [createdSignIds]);
  }
  if (ids.length > 0) {
    await db.query(`DELETE FROM sign WHERE placed_by = ANY($1::uuid[]) OR removed_by = ANY($1::uuid[])`, [ids]);
    // A contact with wants_sign now RAISES a sign row (status 'requested', client_id
    // `<contact key>:signreq`). Those have no placed_by, so the clause above never caught them and
    // they leaked into later suites as a sign attached to a household the next test picked. Deleted
    // via the contact that raised them, before those contacts go.
    await db.query(
      `DELETE FROM sign WHERE requested_from IN (SELECT id FROM contact WHERE user_id = ANY($1::uuid[]))`,
      [ids],
    );
    // voter_contact.collected_by references app_user without ON DELETE, and its rows must also go
    // before the contacts they cite; they are the doorstep phone/email numbers this run collected.
    await db.query(`DELETE FROM voter_contact WHERE collected_by = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM contact WHERE user_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM turf WHERE created_by = ANY($1::uuid[])`, [ids]); // cascades turf_household, assignment
    await db.query(`DELETE FROM assignment WHERE user_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM audit_log WHERE user_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM session WHERE user_id = ANY($1::uuid[])`, [ids]);
    await db.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [ids]);
  }
  // login_failed rows carry no user_id; they are identified by the address that was tried.
  await db.query(`DELETE FROM audit_log WHERE user_id IS NULL AND target LIKE $1`, [EMAIL_PATTERN]);
  await db.end();
  await rm(photoDir, { recursive: true, force: true });
});

describe('auth', () => {
  it('rejects bad credentials with 401 and the error envelope', async () => {
    const r = await login(ADMIN_EMAIL, 'wrong-password-xx');
    assert.equal(r.status, 401);
    assert.deepEqual(Object.keys(r.body as object), ['error']);
    assert.equal((r.body as { error: { code: string } }).error.code, 'invalid_credentials');
  });

  it('login sets an HttpOnly SameSite=Lax cookie and /me returns the user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    const sc = String(res.headers['set-cookie']);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Lax/);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: cookieFrom(res) } });
    assert.equal(me.statusCode, 200);
    const { user } = me.json() as { user: Record<string, unknown> };
    assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(user.role, 'admin');
  });

  it('requires a session for /api/meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/meta' });
    assert.equal(res.statusCode, 401);
  });

  it('logout invalidates the session', async () => {
    const r = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: r.cookie! } });
    assert.equal(out.statusCode, 204);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: r.cookie! } });
    assert.equal(me.statusCode, 401);
  });

  it('accept-invite rejects a used token with 410 and short passwords with 400', async () => {
    const inv = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: { cookie: adminCookie },
      payload: { email: email('once'), name: 'Once', role: 'volunteer' },
    });
    const token = (inv.json() as { invite_url: string }).invite_url.split('/invite/')[1]!;
    const short = await app.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      payload: { token, name: 'x', password: 'short' },
    });
    assert.equal(short.statusCode, 400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      payload: { token, name: 'x', password: 'long-enough-pw' },
    });
    assert.equal(ok.statusCode, 200);
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/accept-invite',
      payload: { token, name: 'x', password: 'long-enough-pw' },
    });
    assert.equal(again.statusCode, 410);
  });

  it('writes login/logout audit rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit?limit=500', headers: { cookie: adminCookie } });
    assert.equal(res.statusCode, 200);
    const { entries } = res.json() as { entries: Array<{ action: string }> };
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['login', 'logout', 'invite', 'login_failed', 'accept_invite']) assert.ok(actions.has(a), a);
  });
});

describe('users (admin)', () => {
  it('lists users with invite_pending and refuses to deactivate the last admin', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    assert.equal(list.statusCode, 200);
    const { users } = list.json() as { users: Array<{ id: string; email: string; role: string; invite_pending: boolean }> };
    const admin = users.find((u) => u.email === ADMIN_EMAIL)!;
    assert.equal(admin.invite_pending, false);

    // The guard fires only when the target is the LAST active admin. The test database may already
    // have an admin of its own (which this suite must not touch), so assert whichever branch
    // applies — and when it is not the last, undo the deactivation we just made to our own row.
    const others = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app_user WHERE role = 'admin' AND active AND id <> $1`,
      [admin.id],
    );
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    if (others.rows[0]!.n === 0) {
      assert.equal(patch.statusCode, 409);
      assert.equal((patch.json() as { error: { code: string } }).error.code, 'last_admin');
    } else {
      assert.equal(patch.statusCode, 200, 'another active admin exists, so the guard must not fire');
      await db.query(`UPDATE app_user SET active = true WHERE id = $1`, [admin.id]);
      const again = await login(ADMIN_EMAIL, ADMIN_PASSWORD); // deactivating dropped our sessions
      adminCookie = again.cookie!;
    }
  });

  it('organizers list users with a reduced projection; volunteers get 403', async () => {
    const org = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: organizerCookie } });
    assert.equal(org.statusCode, 200);
    const { users } = org.json() as { users: Array<Record<string, unknown>> };
    const mine = users.find((u) => u.name === 'organizer accepted')!;
    // enough to fill the "assign this turf to..." picker, and nothing else
    assert.deepEqual(Object.keys(mine).sort(), ['active', 'id', 'name', 'role']);
    for (const u of users) {
      for (const k of ['email', 'last_login_at', 'invite_pending', 'created_at']) {
        assert.ok(!(k in u), `organizer must not see ${k}`);
      }
    }
    const vol = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: volunteerCookie } });
    assert.equal(vol.statusCode, 403);
  });
});

describe('meta', () => {
  it('counts match the CSVs and the boundary is a Polygon', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie: adminCookie } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      wards: Array<{ ward: string; n_households: number; n_voters: number }>;
      communities: Array<{ community: string; n_households: number }>;
      import: { n_voters: number; n_households: number };
      boundary: { type: string };
    };
    assert.equal(body.wards.length, byWard.size);
    for (const w of body.wards) {
      assert.deepEqual({ hh: w.n_households, v: w.n_voters }, byWard.get(w.ward));
    }
    assert.equal(body.wards.reduce((s, w) => s + w.n_households, 0), households.length);
    assert.equal(body.wards.reduce((s, w) => s + w.n_voters, 0), voters.length);
    assert.equal(body.communities.reduce((s, c) => s + c.n_households, 0), nWithCommunity);
    assert.equal(body.import.n_voters, voters.length);
    assert.equal(body.import.n_households, households.length);
    assert.equal(body.boundary.type, 'Polygon');
  });
});

describe('households/points', () => {
  it('returns every civic household as GeoJSON with the full projection for admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/households/points', headers: { cookie: adminCookie } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['cache-control']), /private/);
    const fc = res.json() as { type: string; features: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }> };
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, nWithCoords);
    const p = fc.features[0]!.properties;
    assert.deepEqual(Object.keys(p).sort(), ['community', 'id', 'inst', 'n', 'nonres', 'q', 'status', 'ward']);
    const [lon, lat] = fc.features[0]!.geometry.coordinates as [number, number];
    assert.ok(lon < -80 && lon > -82 && lat > 42 && lat < 44, 'coordinates are lon,lat in Middlesex');
  });

  it('volunteer projection lacks the restricted keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/households/points', headers: { cookie: volunteerCookie } });
    assert.equal(res.statusCode, 200);
    const fc = res.json() as { features: Array<{ properties: Record<string, unknown> }> };
    assert.equal(fc.features.length, nWithCoords);
    // No turfs exist yet at this point in the run; once the volunteer is assigned one, the doors
    // inside it also carry `status` — see "turf scope (volunteer)" below.
    for (const f of fc.features) {
      assert.deepEqual(Object.keys(f.properties).sort(), ['community', 'id', 'inst', 'n', 'ward']);
    }
  });

  it('honours ward / community / quality / bbox filters', async () => {
    const expectWard = households.filter((h) => h.ward === '02' && h.lat).length;
    const r1 = await app.inject({ method: 'GET', url: '/api/households/points?ward=02', headers: { cookie: adminCookie } });
    assert.equal((r1.json() as { features: unknown[] }).features.length, expectWard);

    const expectComm = households.filter((h) => h.community === 'ARVA' && h.record_quality === 'good' && h.lat).length;
    const r2 = await app.inject({
      method: 'GET',
      url: '/api/households/points?community=arva&quality=good',
      headers: { cookie: adminCookie },
    });
    assert.equal((r2.json() as { features: unknown[] }).features.length, expectComm);

    const bbox = [-81.4, 43.05, -81.35, 43.1] as const;
    const expectBbox = households.filter(
      (h) => h.lat && +h.lon! >= bbox[0] && +h.lon! <= bbox[2] && +h.lat! >= bbox[1] && +h.lat! <= bbox[3],
    ).length;
    const r3 = await app.inject({
      method: 'GET',
      url: `/api/households/points?bbox=${bbox.join(',')}`,
      headers: { cookie: adminCookie },
    });
    assert.equal((r3.json() as { features: unknown[] }).features.length, expectBbox);
    assert.ok(expectBbox > 0 && expectBbox < nWithCoords);

    const bad = await app.inject({ method: 'GET', url: '/api/households/points?bbox=1,2', headers: { cookie: adminCookie } });
    assert.equal(bad.statusCode, 400);
  });
});

describe('households/:id', () => {
  it('returns the card with voters for a known id and audits the view', async () => {
    const known = households.find((h) => h.household_id === 'H-ARVA-00001')!;
    const knownVoters = voters.filter((v) => v.household_id === 'H-ARVA-00001');
    const res = await app.inject({ method: 'GET', url: '/api/households/H-ARVA-00001', headers: { cookie: adminCookie } });
    assert.equal(res.statusCode, 200);
    const card = res.json() as {
      id: string;
      address: string;
      n_voters: number;
      voters: Array<Record<string, unknown>>;
      status: { last_result: null };
    };
    assert.equal(card.id, 'H-ARVA-00001');
    assert.equal(card.address, known.address_clean);
    assert.equal(card.voters.length, Number(known.n_voters));
    assert.equal(card.voters.length, card.n_voters);
    assert.equal(card.voters.length, knownVoters.length);
    assert.ok(
      knownVoters.some((v) => v.display_name === card.voters[0]!.display_name),
      'the first voter on the card is one of the CSV voters for this door',
    );
    for (const k of RESTRICTED_VOTER_KEYS) assert.ok(k in card.voters[0]!, `organizer sees ${k}`);
    for (const k of RESTRICTED_HH_KEYS) assert.ok(k in card, `organizer sees ${k}`);
    assert.equal(card.status.last_result, null);

    const aud = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'view_household' AND target = $1`, [
      'H-ARVA-00001',
    ]);
    assert.ok(aud.rows[0].n >= 1);
  });

  it('organizer can view; volunteer gets 403; unknown id 404', async () => {
    const org = await app.inject({ method: 'GET', url: '/api/households/H-ARVA-00001', headers: { cookie: organizerCookie } });
    assert.equal(org.statusCode, 200);
    const vol = await app.inject({ method: 'GET', url: '/api/households/H-ARVA-00001', headers: { cookie: volunteerCookie } });
    assert.equal(vol.statusCode, 403);
    const nf = await app.inject({ method: 'GET', url: '/api/households/H-ARVA-99999', headers: { cookie: adminCookie } });
    assert.equal(nf.statusCode, 404);
  });

  it('lists legal households (unmapped), filtered by ward', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/households/legal', headers: { cookie: adminCookie } });
    assert.equal(all.statusCode, 200);
    assert.equal((all.json() as { households: unknown[] }).households.length, nLegal);
    const w5 = await app.inject({ method: 'GET', url: '/api/households/legal?ward=05', headers: { cookie: adminCookie } });
    const expect = households.filter((h) => h.household_id!.startsWith('H-LEGAL') && h.ward === '05').length;
    assert.equal((w5.json() as { households: unknown[] }).households.length, expect);
    const vol = await app.inject({ method: 'GET', url: '/api/households/legal', headers: { cookie: volunteerCookie } });
    assert.equal(vol.statusCode, 403);
  });
});

describe('search', () => {
  it('finds Adams by name and 119 King by civic address; volunteer gets 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=Adams&limit=50', headers: { cookie: adminCookie } });
    assert.equal(res.statusCode, 200);
    const { voters: hits } = res.json() as { voters: Array<{ display_name: string; address: string; household_id: string }> };
    const expectAdams = voters.filter((v) => /adams/i.test(v.full_name!)).length;
    const exact = hits.filter((h) => /adams/i.test(h.display_name)).length;
    assert.ok(exact >= 5 && exact === expectAdams, `expected ${expectAdams} Adams, got ${exact}`);
    // substring matches come first, fuzzy ones (Adamski, Adam ...) after them
    const firstFuzzy = hits.findIndex((h) => !/adams/i.test(h.display_name));
    assert.ok(firstFuzzy === -1 || firstFuzzy === exact, 'exact matches are ranked before fuzzy matches');
    assert.ok(hits[0]!.address && hits[0]!.household_id);

    const civic = await app.inject({ method: 'GET', url: '/api/search?q=119%20king', headers: { cookie: organizerCookie } });
    const { households: hh } = civic.json() as { households: Array<{ address: string }> };
    assert.equal(hh[0]!.address, '119 KING ST');

    const vol = await app.inject({ method: 'GET', url: '/api/search?q=adams', headers: { cookie: volunteerCookie } });
    assert.equal(vol.statusCode, 403);

    const aud = await db.query(`SELECT detail FROM audit_log WHERE action = 'search' ORDER BY id DESC LIMIT 1`);
    assert.equal(aud.rows[0].detail.q, '119 king');
  });
});

describe('streets', () => {
  it('groups households by street with civic ranges', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/streets?ward=02&community=ARVA', headers: { cookie: adminCookie } });
    assert.equal(res.statusCode, 200);
    const { streets } = res.json() as { streets: Array<Record<string, unknown>> };
    const adelaide = streets.find((s) => s.street_sort === 'ADELAIDE ST N')!;
    assert.ok(adelaide, 'ADELAIDE ST N present');
    assert.deepEqual(Object.keys(adelaide).sort(), [
      'community', 'label', 'max_num', 'min_num', 'n_households', 'n_voters', 'street_sort', 'ward',
    ]);
    assert.equal(adelaide.label, 'Adelaide St N');
    const expect = households.filter((h) => h.ward === '02' && h.community === 'ARVA' && `${h.street} ${h.type} ${h.dir}`.trim() === 'ADELAIDE ST N').length;
    assert.equal(adelaide.n_households, expect);
  });
});

describe('reachability advice (third-party)', () => {
  /** Everything the stub was asked to send — the evidence for "nothing but counts left the building". */
  let sent: { url: string; headers: Record<string, string>; body: string }[] = [];

  const stub: FetchLike = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      url: href,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Knock the 306 PO-box doors.' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  let adviceApp: FastifyInstance;

  before(async () => {
    const config = loadConfig({
      DATABASE_URL,
      SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      DOMAIN: 'canvass.test',
      COOKIE_SECURE: 'false',
      BOUNDARY_PATH: resolve(DATA_DIR, 'mc_boundary.json'),
      SIGN_PHOTO_DIR: photoDir,
      ADVICE_API_KEY: 'test-advice-key',
    });
    adviceApp = await buildApp({ config, db, fetchImpl: stub });
    await adviceApp.ready();
  });

  after(async () => {
    await adviceApp?.close();
  });

  it('is off, and makes no call at all, when no key is configured', async () => {
    sent = [];
    const res = await app.inject({ method: 'GET', url: '/api/stats/reachability', headers: { cookie: organizerCookie } });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { advice: string | null }).advice, null);
    assert.equal(sent.length, 0, 'a stack with no key must not call a provider');
  });

  it('sends counts only — never a row of the list — and never the key to the browser', async () => {
    _clearAdviceCache();
    sent = [];
    const res = await adviceApp.inject({
      method: 'GET',
      url: '/api/stats/reachability',
      headers: { cookie: organizerCookie },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { advice: string | null }).advice, 'Knock the 306 PO-box doors.');

    assert.equal(sent.length, 1);
    const call = sent[0]!;
    assert.match(call.url, /^https:\/\/api\.anthropic\.com\//);
    assert.equal(call.headers['x-api-key'], 'test-advice-key');

    // The whole point of the file. s. 23(8) of the Municipal Elections Act says a recipient of the
    // list "shall not provide it to any other person"; posting a row to a model provider would be
    // exactly that. Assert on the bytes actually sent, not on the type that produced them.
    assert.ok(!/H-[A-Z]+-\d+/.test(call.body), 'no household id may be sent');
    assert.ok(!/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/.test(call.body), 'no postal code may be sent');
    for (const name of voters.slice(0, 40).map((v) => v.last_name).filter(Boolean)) {
      assert.ok(!call.body.includes(name as string), `no elector name may be sent (${name})`);
    }
    for (const h of households.slice(0, 40).map((h) => h.address).filter(Boolean)) {
      assert.ok(!call.body.includes(h as string), 'no address may be sent');
    }

    // And the key must never come back out to the client.
    assert.ok(!res.body.includes('test-advice-key'));
  });

  it('caches on the numbers, so opening the report twice bills once', async () => {
    _clearAdviceCache();
    sent = [];
    for (let i = 0; i < 3; i += 1) {
      await adviceApp.inject({ method: 'GET', url: '/api/stats/reachability', headers: { cookie: organizerCookie } });
    }
    assert.equal(sent.length, 1, 'identical facts must not be re-sent');
  });

  it('refuses to send a payload carrying personal data, rather than sending it', () => {
    assert.throws(() => assertNoPersonalData('doors: 12, id H-KOMOKA-00123'), /household id/);
    assert.throws(() => assertNoPersonalData('someone@example.com'), /email/);
    assert.throws(() => assertNoPersonalData('lives at N0M 2A0'), /postal code/);
    assert.doesNotThrow(() => assertNoPersonalData('no_map_point (structural, blocks door): 73 doors, 1.0%'));
  });
});

describe('stats/reachability', () => {
  it('is organizer-and-above', async () => {
    const vol = await app.inject({ method: 'GET', url: '/api/stats/reachability', headers: { cookie: volunteerCookie } });
    assert.equal(vol.statusCode, 403);
  });

  it('counts doors that cannot be knocked WITHOUT folding in PO-box mail addresses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/reachability', headers: { cookie: organizerCookie } });
    assert.equal(res.statusCode, 200);
    const s = res.json() as {
      totals: { households: number; voters: number };
      categories: { code: string; kind: string; blocks: string[]; parent: string | null; scope: string; count: number }[];
      combined: { households_blocked: number; mail_blocked: number };
    };
    const cat = (code: string) => s.categories.find((c) => c.code === code)!;

    assert.equal(s.totals.households, households.length);
    assert.equal(cat('legal_description').count, nLegal);

    const poBox = households.filter((h) => +h.n_voters! > 0 && +h.n_mail_po_box! >= +h.n_voters!).length;
    assert.equal(cat('po_box_only').count, poBox);
    assert.deepEqual(cat('po_box_only').blocks, ['mail']);

    // The regression this test exists for. `households_blocked` is door-only, so a PO box — which
    // blocks lettermail and nothing else — must not appear in it. Folding it in reported 390
    // unknockable doors where there are 73, which is a planning error, not a cosmetic one.
    assert.equal(s.combined.mail_blocked, poBox);
    assert.ok(
      s.combined.households_blocked < poBox + cat('no_map_point').count,
      'households_blocked must not include the PO-box households',
    );

    // no_map_point is the PARENT of its two causes, so it must equal them rather than add to them.
    assert.equal(cat('no_map_point').count, cat('legal_description').count + cat('geocode_failed').count);
    assert.equal(cat('geocode_failed').parent, 'no_map_point');
    assert.equal(s.combined.households_blocked, cat('no_map_point').count);

    // Electors and doors are different denominators and the response must keep saying which.
    assert.equal(cat('non_resident').scope, 'voter');
    assert.equal(cat('non_resident').count, voters.filter((v) => v.resident_class === 'non-resident').length);
    assert.equal(cat('legal_description').scope, 'household');
  });

  it('returns no personal information at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/reachability', headers: { cookie: organizerCookie } });
    const body = res.body;
    // Aggregates only is the property that would make this safe to send to an advice provider, so
    // it is asserted rather than assumed: no household id, and no name from the list.
    assert.ok(!/H-[A-Z]+-\d+/.test(body), 'must not contain a household id');
    for (const key of ['address', 'display_name', 'full_name', 'last_name', 'mailing_address', 'postal']) {
      assert.ok(!body.includes(key), `must not contain ${key}`);
    }
  });
});

describe('stats/overview', () => {
  it('totals equal the CSV totals', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/overview', headers: { cookie: organizerCookie } });
    assert.equal(res.statusCode, 200);
    const s = res.json() as {
      totals: Record<string, number>;
      by_ward: Array<{ ward: string; households: number; voters: number }>;
      by_community: unknown[];
      quality: Record<string, number>;
      household_size: Array<{ size: string; households: number }>;
      canvass: { contacted_households: number; support_hist: number[] };
    };
    assert.equal(s.totals.households, households.length);
    assert.equal(s.totals.voters, voters.length);
    assert.equal(s.totals.residents, voters.filter((v) => v.resident_class === 'resident').length);
    assert.equal(s.totals.nonresidents, voters.filter((v) => v.resident_class === 'non-resident').length);
    assert.equal(s.totals.legal, nLegal);
    assert.equal(s.totals.institutions, households.filter((h) => /institution/i.test(h.hh_flag!)).length);
    assert.equal(s.totals.po_box_only, households.filter((h) => +h.n_voters! > 0 && +h.n_mail_po_box! >= +h.n_voters!).length);
    for (const w of s.by_ward) assert.deepEqual({ hh: w.households, v: w.voters }, byWard.get(w.ward));
    for (const qk of ['good', 'approx', 'legal', 'check']) {
      assert.equal(s.quality[qk], households.filter((h) => h.record_quality === qk).length, qk);
    }
    assert.equal(s.household_size.reduce((a, b) => a + b.households, 0), households.length);
    assert.equal(s.household_size.at(-1)!.size, '6+');
    assert.equal(s.canvass.contacted_households, 0);
    assert.deepEqual(s.canvass.support_hist, [0, 0, 0, 0, 0]);
    const vol = await app.inject({ method: 'GET', url: '/api/stats/overview', headers: { cookie: volunteerCookie } });
    assert.equal(vol.statusCode, 403);
  });
});

describe('rate limit', () => {
  it('login is limited to 10/min/IP with the error envelope', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '10.9.9.9',
        payload: { email: email('nobody'), password: 'wrong-password-x' },
      });
      last = res.statusCode;
      if (last === 429) {
        assert.equal((res.json() as { error: { code: string } }).error.code, 'rate_limited');
        break;
      }
      assert.equal(last, 401);
    }
    assert.equal(last, 429, 'expected the 11th attempt to be rate limited');
  });
});

describe('health', () => {
  it('reports db and import id without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const b = res.json() as { ok: boolean; db: boolean; import_id: number };
    assert.equal(b.ok, true);
    assert.equal(b.db, true);
    assert.ok(b.import_id >= 1);
  });
});

// ------------------------------------------------------------------ Phase 2: turfs, assignments, contacts
// These run last on purpose: every describe above asserts a canvass-free database
// (stats.canvass zeros, volunteer point properties without `status`).

const RECT = { minLon: -81.4, minLat: 43.05, maxLon: -81.35, maxLat: 43.1 };
const RECT_POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [RECT.minLon, RECT.minLat],
      [RECT.maxLon, RECT.minLat],
      [RECT.maxLon, RECT.maxLat],
      [RECT.minLon, RECT.maxLat],
      [RECT.minLon, RECT.minLat],
    ],
  ],
};
const inRect = households.filter(
  (h) =>
    h.lat &&
    +h.lon! > RECT.minLon &&
    +h.lon! < RECT.maxLon &&
    +h.lat! > RECT.minLat &&
    +h.lat! < RECT.maxLat,
);

interface Ctx {
  volunteerId: string;
  streetTurfId: string;
  polygonTurfId: string;
  streets: string[];
  streetHouseholdIds: string[];
  assignmentId: string;
  outsideHouseholdId: string;
}
const ctx = {} as Ctx;

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });

describe('turfs', () => {
  it('creates a turf from streets, materialised in walking order, taking whole streets across wards', async () => {
    // Deliberately pick streets that CROSS a ward line: street_sort is not unique per ward, and a
    // turf must take the whole road rather than stop at an invisible boundary halfway down it.
    const picked = await db.query<{ street_sort: string; wards: number }>(
      `SELECT street_sort, count(DISTINCT ward)::int AS wards FROM household
       WHERE street_sort IS NOT NULL
       GROUP BY street_sort HAVING count(*) BETWEEN 5 AND 40
       ORDER BY count(DISTINCT ward) DESC, count(*), street_sort LIMIT 2`,
    );
    ctx.streets = picked.rows.map((r) => r.street_sort);
    assert.equal(ctx.streets.length, 2);
    assert.ok(picked.rows.every((r) => r.wards > 1), 'both candidate streets span two wards');

    const expected = await db.query<{ id: string }>(
      `SELECT id FROM household WHERE street_sort = ANY($1::text[])
       ORDER BY street_sort, num_sort, id`,
      [ctx.streets],
    );
    ctx.streetHouseholdIds = expected.rows.map((r) => r.id);
    assert.ok(ctx.streetHouseholdIds.length >= 10);

    const res = await call('POST', '/api/turfs', organizerCookie, {
      name: 'Arva street turf',
      ward: '02',
      streets: ctx.streets,
    });
    assert.equal(res.statusCode, 201, res.body);
    const { turf } = res.json() as { turf: Record<string, unknown> };
    ctx.streetTurfId = turf.id as string;
    assert.equal(turf.name, 'Arva street turf');
    assert.equal(turf.ward, '02');
    assert.equal(turf.n_households, ctx.streetHouseholdIds.length);
    assert.deepEqual((turf.streets as string[]).slice().sort(), ctx.streets.slice().sort());
    assert.equal(turf.contacted, 0);
    assert.equal(turf.created_by_name, 'organizer accepted');
    assert.deepEqual(turf.assignees, []);
    assert.equal(turf.polygon, null);

    const expectedVoters = await db.query<{ n: number }>(
      `SELECT coalesce(sum(n_voters), 0)::int AS n FROM household WHERE id = ANY($1::text[])`,
      [ctx.streetHouseholdIds],
    );
    assert.equal(turf.n_voters, expectedVoters.rows[0]!.n);

    // walk_order is 1..n along street_sort, num_sort, id — and /doors comes back in that order.
    const doors = await call('GET', `/api/turfs/${ctx.streetTurfId}/doors`, organizerCookie);
    assert.equal(doors.statusCode, 200);
    const body = doors.json() as { doors: Array<{ household_id: string; walk_order: number; voters: unknown[] }> };
    assert.deepEqual(
      body.doors.map((d) => d.household_id),
      ctx.streetHouseholdIds,
    );
    assert.deepEqual(
      body.doors.map((d) => d.walk_order),
      ctx.streetHouseholdIds.map((_, i) => i + 1),
    );
    const withVoters = body.doors.find((d) => d.voters.length > 0)!;
    assert.ok(withVoters, 'at least one door has voters');

    // `ward: '02'` on the request was a label only — the turf holds the whole of both streets.
    const wards = new Set(
      (
        await db.query<{ ward: string }>(`SELECT DISTINCT ward FROM household WHERE id = ANY($1::text[])`, [
          ctx.streetHouseholdIds,
        ])
      ).rows.map((r) => r.ward),
    );
    assert.ok(wards.size > 1, `turf spans ${wards.size} wards, ward was not used as a filter`);
  });

  it('creates a turf from a polygon using the ray-casting test', async () => {
    assert.ok(inRect.length > 20 && inRect.length < nWithCoords, `rect holds ${inRect.length} households`);
    const res = await call('POST', '/api/turfs', adminCookie, {
      name: 'Polygon turf',
      polygon: RECT_POLYGON,
    });
    assert.equal(res.statusCode, 201, res.body);
    const { turf } = res.json() as { turf: { id: string; n_households: number; polygon: unknown } };
    ctx.polygonTurfId = turf.id;
    assert.equal(turf.n_households, inRect.length);
    assert.deepEqual(turf.polygon, RECT_POLYGON);

    const doors = await call('GET', `/api/turfs/${turf.id}/doors`, adminCookie);
    const body = doors.json() as { doors: Array<{ household_id: string; lat: number; lon: number }> };
    assert.deepEqual(
      body.doors.map((d) => d.household_id).sort(),
      inRect.map((h) => h.household_id!).sort(),
    );
    for (const d of body.doors) {
      assert.ok(d.lon > RECT.minLon && d.lon < RECT.maxLon && d.lat > RECT.minLat && d.lat < RECT.maxLat);
    }
    // a door just outside the rect, for the volunteer scope tests below
    const outside = households.find((h) => h.lat && !inRect.includes(h) && !ctx.streetHouseholdIds.includes(h.household_id!))!;
    ctx.outsideHouseholdId = outside.household_id!;
  });

  it('rejects a body with both or neither of streets/polygon', async () => {
    const both = await call('POST', '/api/turfs', organizerCookie, {
      name: 'x',
      streets: ['ADELAIDE ST N'],
      polygon: RECT_POLYGON,
    });
    assert.equal(both.statusCode, 400);
    const neither = await call('POST', '/api/turfs', organizerCookie, { name: 'x' });
    assert.equal(neither.statusCode, 400);
    const badPoly = await call('POST', '/api/turfs', organizerCookie, {
      name: 'x',
      polygon: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] },
    });
    assert.equal(badPoly.statusCode, 400);
  });

  it('lists turfs with counts, and volunteers cannot', async () => {
    const res = await call('GET', '/api/turfs', organizerCookie);
    assert.equal(res.statusCode, 200);
    const { turfs } = res.json() as { turfs: Array<Record<string, unknown>> };
    assert.equal(turfs.length, 2);
    const t = turfs.find((x) => x.id === ctx.streetTurfId)!;
    assert.deepEqual(Object.keys(t).sort(), [
      'archived', 'assignees', 'contacted', 'created_at', 'created_by_name', 'id', 'n_households', 'n_voters',
      'name', 'streets', 'ward',
    ]);
    assert.deepEqual((t.streets as string[]).slice().sort(), ctx.streets.slice().sort());
    const vol = await call('GET', '/api/turfs', volunteerCookie);
    assert.equal(vol.statusCode, 403);
  });

  it('omits archived turfs unless archived=true', async () => {
    const arch = await call('PATCH', `/api/turfs/${ctx.polygonTurfId}`, organizerCookie, { archived: true });
    assert.equal(arch.statusCode, 200, arch.body);

    const active = await call('GET', '/api/turfs', organizerCookie);
    const activeIds = (active.json() as { turfs: Array<{ id: string }> }).turfs.map((t) => t.id);
    assert.ok(!activeIds.includes(ctx.polygonTurfId), 'archived turf is absent by default');
    assert.ok(activeIds.includes(ctx.streetTurfId), 'active turf is still listed');

    const all = await call('GET', '/api/turfs?archived=true', organizerCookie);
    const allIds = (all.json() as { turfs: Array<{ id: string }> }).turfs.map((t) => t.id);
    assert.ok(allIds.includes(ctx.polygonTurfId), 'archived turf comes back with archived=true');
    assert.ok(allIds.includes(ctx.streetTurfId));
    // archived=false is the default, explicitly
    const explicit = await call('GET', '/api/turfs?archived=false', organizerCookie);
    assert.deepEqual(
      (explicit.json() as { turfs: Array<{ id: string }> }).turfs.map((t) => t.id),
      activeIds,
    );

    // restore: the later scope/contact tests expect both turfs to be live
    const back = await call('PATCH', `/api/turfs/${ctx.polygonTurfId}`, organizerCookie, { archived: false });
    assert.equal(back.statusCode, 200, back.body);
  });

  it('assigns idempotently, lists the volunteer’s own assignments, and unassigns', async () => {
    const u = await db.query<{ id: string }>(`SELECT id FROM app_user WHERE email = $1`, [email('vol')]);
    ctx.volunteerId = u.rows[0]!.id;

    const a1 = await call('POST', `/api/turfs/${ctx.streetTurfId}/assign`, organizerCookie, {
      user_id: ctx.volunteerId,
      due_date: '2026-10-20',
    });
    assert.equal(a1.statusCode, 201, a1.body);
    const first = (a1.json() as { assignment: Record<string, unknown> }).assignment;
    ctx.assignmentId = first.id as string;
    assert.equal(first.status, 'open');
    assert.equal(first.due_date, '2026-10-20');
    assert.equal(first.user_name, 'volunteer accepted');

    // re-assigning the same pair returns the same row (offline / double-tap safe), never a 500
    const a2 = await call('POST', `/api/turfs/${ctx.streetTurfId}/assign`, organizerCookie, {
      user_id: ctx.volunteerId,
    });
    assert.equal(a2.statusCode, 201, a2.body);
    assert.equal((a2.json() as { assignment: { id: string } }).assignment.id, ctx.assignmentId);

    const list = await call('GET', '/api/turfs', organizerCookie);
    const t = (list.json() as { turfs: Array<{ id: string; assignees: Array<Record<string, unknown>> }> }).turfs.find(
      (x) => x.id === ctx.streetTurfId,
    )!;
    assert.equal(t.assignees.length, 1);
    assert.equal(t.assignees[0]!.user_id, ctx.volunteerId);
    assert.equal(t.assignees[0]!.name, 'volunteer accepted');
    assert.equal(t.assignees[0]!.status, 'open');

    const mine = await call('GET', '/api/assignments/mine', volunteerCookie);
    assert.equal(mine.statusCode, 200);
    const { assignments } = mine.json() as {
      assignments: Array<{ id: string; status: string; turf: { id: string; name: string }; n_households: number; contacted: number }>;
    };
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]!.turf.id, ctx.streetTurfId);
    assert.equal(assignments[0]!.n_households, ctx.streetHouseholdIds.length);
    assert.equal(assignments[0]!.contacted, 0);

    // the organizer has no assignments of their own
    const orgMine = await call('GET', '/api/assignments/mine', organizerCookie);
    assert.deepEqual((orgMine.json() as { assignments: unknown[] }).assignments, []);

    // a volunteer may move their own assignment along, but not someone else's
    const patch = await call('PATCH', `/api/assignments/${ctx.assignmentId}`, volunteerCookie, {
      status: 'in_progress',
    });
    assert.equal(patch.statusCode, 200);
    assert.equal((patch.json() as { assignment: { status: string } }).assignment.status, 'in_progress');
    const bad = await call('PATCH', `/api/assignments/${ctx.assignmentId}`, volunteerCookie, { status: 'nope' });
    assert.equal(bad.statusCode, 400);

    const other = await call('POST', `/api/turfs/${ctx.polygonTurfId}/assign`, adminCookie, {
      user_id: (await db.query<{ id: string }>(`SELECT id FROM app_user WHERE email = $1`, [email('org')])).rows[0]!.id,
    });
    assert.equal(other.statusCode, 201);
    const otherId = (other.json() as { assignment: { id: string } }).assignment.id;
    const stolen = await call('PATCH', `/api/assignments/${otherId}`, volunteerCookie, { status: 'done' });
    assert.equal(stolen.statusCode, 403);
    assert.equal((stolen.json() as { error: { code: string } }).error.code, 'not_your_assignment');

    const del = await call('DELETE', `/api/turfs/${ctx.polygonTurfId}/assign/${(await db.query<{ id: string }>(`SELECT id FROM app_user WHERE email = $1`, [email('org')])).rows[0]!.id}`, adminCookie);
    assert.equal(del.statusCode, 204);
    const gone = await call('GET', `/api/assignments/mine`, organizerCookie);
    assert.deepEqual((gone.json() as { assignments: unknown[] }).assignments, []);
  });

  it('patches and 404s unknown turfs', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    assert.equal((await call('GET', `/api/turfs/${missing}`, adminCookie)).statusCode, 404);
    assert.equal((await call('PATCH', `/api/turfs/${missing}`, adminCookie, { name: 'x' })).statusCode, 404);
    assert.equal((await call('DELETE', `/api/turfs/${missing}`, adminCookie)).statusCode, 404);

    const res = await call('PATCH', `/api/turfs/${ctx.streetTurfId}`, organizerCookie, { name: 'Arva walk' });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { turf: { name: string } }).turf.name, 'Arva walk');
  });
});

// ------------------------------------------------------------------ turf preview
// The preview's whole value is that it cannot disagree with the save, so these tests compare it
// against the turfs created above rather than against numbers computed a second way.

interface PreviewBody {
  n_households: number;
  n_voters: number;
  unmapped: number;
  truncated: boolean;
  doors: Array<{ household_id: string; lat: number; lon: number; ward: string }>;
}

describe('turf preview', () => {
  it('returns exactly what the create path selected for the same streets, and creates nothing', async () => {
    const before = (await call('GET', '/api/turfs?archived=true', organizerCookie)).json() as { turfs: unknown[] };

    const res = await call('POST', '/api/turfs/preview', organizerCookie, {
      // Same body as the street turf above minus the name; `ward` is a label there and must not
      // narrow the match here either, so it is sent and expected to be ignored.
      ward: '02',
      streets: ctx.streets,
    });
    assert.equal(res.statusCode, 200, res.body);
    const preview = res.json() as PreviewBody;

    const created = (await call('GET', `/api/turfs/${ctx.streetTurfId}`, organizerCookie)).json() as {
      turf: { n_households: number; n_voters: number };
    };
    assert.equal(preview.n_households, created.turf.n_households);
    assert.equal(preview.n_voters, created.turf.n_voters);
    assert.equal(preview.n_households, ctx.streetHouseholdIds.length);
    assert.equal(preview.doors.length + preview.unmapped, preview.n_households);
    assert.equal(preview.truncated, false);

    // Door for door, in the same walking order, against the turf that was actually saved.
    const doors = (await call('GET', `/api/turfs/${ctx.streetTurfId}/doors`, organizerCookie)).json() as {
      doors: Array<{ household_id: string; lat: number | null; lon: number | null; ward: string }>;
    };
    assert.deepEqual(
      preview.doors.map((d) => d.household_id),
      doors.doors.filter((d) => d.lat !== null).map((d) => d.household_id),
    );
    const first = preview.doors[0]!;
    const sameDoor = doors.doors.find((d) => d.household_id === first.household_id)!;
    assert.equal(first.lat, sameDoor.lat);
    assert.equal(first.lon, sameDoor.lon);
    assert.equal(first.ward, sameDoor.ward);
    // Coordinates and ward only: a preview is a shape, not a door list.
    assert.deepEqual(Object.keys(first).sort(), ['household_id', 'lat', 'lon', 'ward']);

    // Nothing was written: no new turf, and no stray turf_household rows.
    const after = (await call('GET', '/api/turfs?archived=true', organizerCookie)).json() as { turfs: unknown[] };
    assert.equal(after.turfs.length, before.turfs.length);

    const aud = await db.query<{ detail: { by: string; n_households: number }; target: string | null }>(
      `SELECT target, detail FROM audit_log WHERE action = 'preview_turf' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(aud.rows[0]!.target, null);
    assert.equal(aud.rows[0]!.detail.by, 'streets');
    assert.equal(aud.rows[0]!.detail.n_households, preview.n_households);
  });

  it('previews the polygon branch with the same ray cast the save uses', async () => {
    const res = await call('POST', '/api/turfs/preview', adminCookie, { polygon: RECT_POLYGON });
    assert.equal(res.statusCode, 200, res.body);
    const preview = res.json() as PreviewBody;

    assert.equal(preview.n_households, inRect.length);
    assert.deepEqual(
      preview.doors.map((d) => d.household_id).sort(),
      inRect.map((h) => h.household_id!).sort(),
    );
    for (const d of preview.doors) {
      assert.ok(d.lon > RECT.minLon && d.lon < RECT.maxLon && d.lat > RECT.minLat && d.lat < RECT.maxLat);
    }
    // A household with no coordinates cannot be inside a drawn shape, so this branch is always 0.
    assert.equal(preview.unmapped, 0);
    assert.equal(preview.truncated, false);

    // …and it agrees with the polygon turf that was actually created from the same geometry.
    const created = (await call('GET', `/api/turfs/${ctx.polygonTurfId}`, adminCookie)).json() as {
      turf: { n_households: number; n_voters: number };
    };
    assert.equal(preview.n_households, created.turf.n_households);
    assert.equal(preview.n_voters, created.turf.n_voters);
  });

  it('counts selected households with no coordinates as unmapped', async () => {
    // The three households that would not geocode at all still carry a street_sort, so a street
    // selection can pick them up; the map cannot draw them, and the count has to say so.
    const street = await db.query<{ street_sort: string; missing: number; total: number }>(
      `SELECT street_sort,
              count(*) FILTER (WHERE lat IS NULL)::int AS missing,
              count(*)::int AS total
       FROM household WHERE street_sort IS NOT NULL
       GROUP BY street_sort
       HAVING count(*) FILTER (WHERE lat IS NULL) > 0
       ORDER BY count(*), street_sort LIMIT 1`,
    );
    const pick = street.rows[0];
    assert.ok(pick, 'the loaded data has a street with an ungeocoded household');

    const res = await call('POST', '/api/turfs/preview', organizerCookie, { streets: [pick.street_sort] });
    assert.equal(res.statusCode, 200, res.body);
    const preview = res.json() as PreviewBody;
    assert.equal(preview.n_households, pick.total);
    assert.equal(preview.unmapped, pick.missing);
    assert.equal(preview.doors.length, pick.total - pick.missing);
    assert.ok(preview.unmapped > 0, 'the fixture street really does hold an unmapped door');
  });

  it('is organizer-only and validates the body like the create path', async () => {
    const vol = await call('POST', '/api/turfs/preview', volunteerCookie, { streets: ctx.streets });
    assert.equal(vol.statusCode, 403);
    const anon = await app.inject({ method: 'POST', url: '/api/turfs/preview', payload: { streets: ctx.streets } });
    assert.equal(anon.statusCode, 401);

    const both = await call('POST', '/api/turfs/preview', organizerCookie, {
      streets: ctx.streets,
      polygon: RECT_POLYGON,
    });
    assert.equal(both.statusCode, 400);
    const neither = await call('POST', '/api/turfs/preview', organizerCookie, { ward: '02' });
    assert.equal(neither.statusCode, 400);
    const badPoly = await call('POST', '/api/turfs/preview', organizerCookie, {
      polygon: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] },
    });
    assert.equal(badPoly.statusCode, 400);

    // A street nobody lives on is an empty preview, not a 404 — the builder shows "0 doors".
    const empty = await call('POST', '/api/turfs/preview', organizerCookie, { streets: ['NO SUCH STREET XYZ'] });
    assert.equal(empty.statusCode, 200, empty.body);
    const body = empty.json() as PreviewBody;
    assert.deepEqual(body, { n_households: 0, n_voters: 0, unmapped: 0, doors: [], truncated: false });

    // The builder's picker sends "no ward" as an explicit null; that must not be a 400.
    const nullWard = await call('POST', '/api/turfs/preview', organizerCookie, { ward: null, streets: ctx.streets });
    assert.equal(nullWard.statusCode, 200, nullWard.body);
  });
});

describe('public sign-up form (unauthenticated)', () => {
  const CONSENT =
    'By signing up you consent to receive campaign emails and, if you check the reminders box, a few text messages during the voting window.';
  const post = (payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/public/requests', payload, headers });

  const cleanup: string[] = [];
  after(async () => {
    if (cleanup.length > 0) {
      await db.query(`DELETE FROM audit_log WHERE action = 'public_request' AND target = ANY($1::text[])`, [cleanup]);
      await db.query(`DELETE FROM public_request WHERE id = ANY($1::uuid[])`, [cleanup]);
    }
  });

  it('takes a sign request with no session and stores it away from the voters list', async () => {
    const res = await post({
      name: 'A Neighbour',
      email: `neighbour+${RUN}@example.test`,
      address: '12 Concession Road, at the gate',
      wants: ['sign', 'volunteer'],
      consent_text: CONSENT,
    });
    assert.equal(res.statusCode, 202);

    const row = await db.query<{ id: string; wants: string[]; consent_text: string; address: string }>(
      `SELECT id, wants, consent_text, address FROM public_request WHERE email = $1`,
      [`neighbour+${RUN}@example.test`],
    );
    assert.equal(row.rowCount, 1);
    cleanup.push(row.rows[0]!.id);
    assert.deepEqual(row.rows[0]!.wants, ['sign', 'volunteer']);
    // The wording shown beside the tick box is stored verbatim: a consent record that cannot say
    // what was agreed to is not a consent record.
    assert.equal(row.rows[0]!.consent_text, CONSENT);
    assert.equal(row.rows[0]!.address, '12 Concession Road, at the gate');

    // The point of the separate table: a public form must never grow the voters list.
    const leaked = await db.query(`SELECT 1 FROM voter WHERE full_name = 'A Neighbour'`);
    assert.equal(leaked.rowCount, 0, 'a public submission must not reach the voters list');
  });

  it('says the same thing whether or not we already know them', async () => {
    // Otherwise the form is an oracle: submit an address, read the answer, learn whether that
    // household is on the campaign's list.
    const one = await post({ name: 'X', email: `dup+${RUN}@example.test`, wants: ['sign'], consent_text: CONSENT });
    const two = await post({ name: 'X', email: `dup+${RUN}@example.test`, wants: ['sign'], consent_text: CONSENT });
    assert.equal(one.statusCode, two.statusCode);
    assert.equal(one.body, two.body);
    const rows = await db.query<{ id: string }>(`SELECT id FROM public_request WHERE email = $1`, [
      `dup+${RUN}@example.test`,
    ]);
    for (const r of rows.rows) cleanup.push(r.id);
  });

  it('swallows a honeypot hit without storing it, and answers normally', async () => {
    const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM public_request`);
    const res = await post({
      name: 'Bot',
      email: `bot+${RUN}@example.test`,
      wants: ['sign'],
      consent_text: CONSENT,
      website: 'http://spam.example',
    });
    // Telling a scraper it was detected only teaches it to try again.
    assert.equal(res.statusCode, 202);
    const after2 = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM public_request`);
    assert.equal(after2.rows[0]!.n, before.rows[0]!.n, 'a honeypot hit stores nothing');
  });

  it('refuses a submission with no way to reply', async () => {
    const res = await post({ name: 'No Contact', wants: ['sign'], consent_text: CONSENT });
    assert.equal(res.statusCode, 400);
  });

  it('requires the consent wording', async () => {
    const res = await post({ name: 'X', email: `nc+${RUN}@example.test`, wants: ['sign'] });
    assert.equal(res.statusCode, 400);
  });

  it('only sends CORS headers to an allowlisted origin', async () => {
    // The stack under test configures no origins, so no browser on another site may post here.
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/public/requests',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'never echo an unknown origin');
    assert.match(String(res.headers['vary'] ?? ''), /Origin/);
  });

  it('is organizer-only to read, and a volunteer cannot', async () => {
    const vol = await call('GET', '/api/public/requests', volunteerCookie);
    assert.equal(vol.statusCode, 403);
    const org = await call('GET', '/api/public/requests', organizerCookie);
    assert.equal(org.statusCode, 200);
    assert.ok(Array.isArray((org.json() as { requests: unknown[] }).requests));
    // Reading it is audited: self-submitted, but still names, addresses and phone numbers.
    const a = await db.query(`SELECT 1 FROM audit_log WHERE action = 'view_public_requests' ORDER BY id DESC LIMIT 1`);
    assert.equal(a.rowCount, 1);
    await db.query(`DELETE FROM audit_log WHERE action = 'view_public_requests'`);
  });
});

describe('sign requests from a contact', () => {
  it('records a visit with no turf at all, and raises a sign request row', async () => {
    // A door tapped on the map may be in no turf. `contact.turf_id` is nullable precisely so this
    // works; nothing could record one until the card got a form.
    const pts = await call('GET', '/api/households/points?limit=1', organizerCookie);
    const hhId = (pts.json() as { features: { properties: { id: string } }[] }).features[0]!.properties.id;
    const key = `test-signreq-${RUN}`;

    const res = await call('POST', '/api/contacts', organizerCookie, {
      household_id: hhId,
      result: 'spoke',
      wants_sign: true,
      sign_address: 'At the farm gate on the concession',
      client_id: key,
    });
    assert.equal(res.statusCode, 201);

    const stored = await db.query<{ wants_sign: boolean; sign_address: string; turf_id: string | null }>(
      `SELECT wants_sign, sign_address, turf_id FROM contact WHERE client_id LIKE $1`,
      [`${key}%`],
    );
    assert.ok(stored.rows.length > 0);
    assert.equal(stored.rows[0]!.wants_sign, true);
    assert.equal(stored.rows[0]!.sign_address, 'At the farm gate on the concession');
    assert.equal(stored.rows[0]!.turf_id, null, 'a door outside every turf still records a visit');

    // The request is a row in `sign`, not just a boolean somebody has to go looking for.
    const sign = await db.query<{ status: string; label: string | null }>(
      `SELECT status::text, label FROM sign WHERE client_id = $1`,
      [`${key}:signreq`],
    );
    assert.equal(sign.rows.length, 1, 'wants_sign raises a sign row');
    assert.equal(sign.rows[0]!.status, 'requested');
    assert.equal(sign.rows[0]!.label, 'At the farm gate on the concession');

    // Replaying the same submission must not raise a second request.
    const again = await call('POST', '/api/contacts', organizerCookie, {
      household_id: hhId,
      result: 'spoke',
      wants_sign: true,
      sign_address: 'At the farm gate on the concession',
      client_id: key,
    });
    assert.equal(again.statusCode, 200, 'a replay creates nothing');
    const dupes = await db.query(`SELECT 1 FROM sign WHERE client_id = $1`, [`${key}:signreq`]);
    assert.equal(dupes.rowCount, 1, 'a replay must not raise a second sign request');

    // And the door stays on the delivery list: a row still marked 'requested' IS this request and
    // must not hide the door from the crew who have to deliver it.
    //
    // `/signs/requests` is audited on every call, and the lawn-signs suite asserts an exact count of
    // those rows — so the high-water mark is taken first and this read is removed below.
    const beforeRead = await db.query<{ max: string | null }>(`SELECT max(id)::text FROM audit_log`);
    const auditMark = beforeRead.rows[0]?.max ?? '0';
    const reqs = await call('GET', '/api/signs/requests', organizerCookie);
    const list = (reqs.json() as { requests: { household_id: string; sign_address: string | null }[] }).requests;
    const row = list.find((r) => r.household_id === hhId);
    assert.ok(row, 'a door that asked is still on the delivery list after the sign row exists');
    assert.equal(row!.sign_address, 'At the farm gate on the concession');

    // Everything this test created, in dependency order. The audit rows matter as much as the data:
    // the contacts suite asserts an exact count of `contact` audit rows for this same organizer, so
    // leaving two behind fails a test three suites later with a number nobody can trace back here.
    await db.query(`DELETE FROM audit_log WHERE action = 'view_sign_requests' AND id > $1::bigint`, [auditMark]);
    const mine = await db.query<{ id: string }>(`SELECT id FROM contact WHERE client_id LIKE $1`, [`${key}%`]);
    const contactIds = mine.rows.map((r) => r.id);
    await db.query(`DELETE FROM sign WHERE client_id = $1`, [`${key}:signreq`]);
    if (contactIds.length > 0) {
      await db.query(`DELETE FROM audit_log WHERE action = 'contact' AND target = ANY($1::text[])`, [contactIds]);
    }
    await db.query(`DELETE FROM contact WHERE client_id LIKE $1`, [`${key}%`]);
  });

  it('refuses an address for a sign nobody asked for', async () => {
    const pts = await call('GET', '/api/households/points?limit=1', organizerCookie);
    const hhId = (pts.json() as { features: { properties: { id: string } }[] }).features[0]!.properties.id;
    // An address without the request would be a delivery somebody actually drives to.
    const res = await call('POST', '/api/contacts', organizerCookie, {
      household_id: hhId,
      result: 'spoke',
      sign_address: '12 Nowhere Lane',
      client_id: `test-signreq-bad-${RUN}`,
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('household -> turf (door card actions)', () => {
  it('tells an organiser which turf a door is in', async () => {
    // Any door that is in a turf; the turf suite above has already created one.
    const list = await call('GET', '/api/turfs', organizerCookie);
    const turf = (list.json() as { turfs: { id: string; name: string }[] }).turfs[0]!;
    const doors = await call('GET', `/api/turfs/${turf.id}/doors`, organizerCookie);
    const door = (doors.json() as { doors: { household_id: string }[] }).doors[0]!;

    const res = await call('GET', `/api/households/${door.household_id}`, organizerCookie);
    assert.equal(res.statusCode, 200);
    const hh = res.json() as { turfs: { id: string; name: string }[] };
    assert.ok(Array.isArray(hh.turfs));
    assert.ok(hh.turfs.some((t) => t.id === turf.id), 'the door reports the turf it is in');
    // Name and id only — this must not become a second way to read turf internals.
    for (const t of hh.turfs) assert.deepEqual(Object.keys(t).sort(), ['id', 'name']);
  });

  it('never tells a volunteer about a turf that is not theirs', async () => {
    // The volunteer can only fetch doors inside their own turf, so that is the door to ask about:
    // if scoping leaked, THIS is where a turf they are not assigned to would show up.
    const mine = await call('GET', '/api/assignments/mine', volunteerCookie);
    const assigned = (mine.json() as { assignments: { turf: { id: string } }[] }).assignments[0]!;
    const doors = await call('GET', `/api/turfs/${assigned.turf.id}/doors`, volunteerCookie);
    const door = (doors.json() as { doors: { household_id: string }[] }).doors[0]!;

    const res = await call('GET', `/api/households/${door.household_id}`, volunteerCookie);
    assert.equal(res.statusCode, 200);
    const hh = res.json() as { turfs: { id: string }[] };
    for (const t of hh.turfs) {
      assert.equal(t.id, assigned.turf.id, 'a volunteer is only told about turfs assigned to them');
    }
  });

  it('reports an empty list for a door in no turf, rather than failing', async () => {
    // A door outside every turf is an ordinary state — it is most of the municipality — and the
    // card has to render actions for it.
    const search = await call('GET', '/api/households/legal?limit=1', organizerCookie);
    const rows = (search.json() as { households: { id: string }[] }).households;
    if (rows.length === 0) return; // no legal-description rows in this dataset
    const res = await call('GET', `/api/households/${rows[0]!.id}`, organizerCookie);
    assert.equal(res.statusCode, 200);
    assert.deepEqual((res.json() as { turfs: unknown[] }).turfs, []);
  });
});

describe('turf shapes (map overlay)', () => {
  interface Shape { id: string; name: string; polygon: unknown; approx: boolean; mine: boolean; n_households: number }
  const shapes = async (cookie: string) => {
    const res = await call('GET', '/api/turfs/shapes', cookie);
    assert.equal(res.statusCode, 200);
    return (res.json() as { turfs: Shape[] }).turfs;
  };

  it('gives an organiser every turf, with their own marked', async () => {
    const all = await shapes(organizerCookie);
    assert.ok(all.length >= 1);
    // `mine` is what makes an organiser's own work findable among everyone else's on one map.
    assert.ok(all.every((t) => typeof t.mine === 'boolean'));
    assert.ok(all.some((t) => t.polygon !== null), 'a drawn turf must carry its polygon');
    // A turf built by picking streets has no drawn shape, so one is approximated from its doors.
    // Every turf with mapped doors gets an outline; `approx` is what says which kind it is.
    assert.ok(all.every((t) => typeof t.approx === 'boolean'));
    assert.ok(all.every((t) => !(t.approx && t.polygon === null)), 'approx implies a shape');
    const streetPicked = all.filter((t) => t.approx);
    for (const t of streetPicked) assert.ok(t.polygon, `${t.name} should have an approximated outline`);
  });

  it('gives a volunteer only the turfs assigned to them', async () => {
    const mine = await shapes(volunteerCookie);
    const all = await shapes(organizerCookie);
    // The Phase 2 rule, on this endpoint too: scoped in the WHERE clause, not filtered afterwards.
    assert.ok(mine.length < all.length, 'a volunteer must not see every turf');
    assert.ok(mine.length > 0, 'the volunteer has an assigned turf and should see it');
    assert.ok(mine.every((t) => t.mine === true), 'every turf a volunteer sees is their own');
  });

  it('carries no elector or door data', async () => {
    const res = await call('GET', '/api/turfs/shapes', organizerCookie);
    const body = res.body;
    // A whole-municipality fetch, so it must stay a list of shapes rather than becoming a bulk
    // read of the list by another name.
    assert.ok(!/H-[A-Z]+-\d+/.test(body), 'must not contain a household id');
    for (const key of ['address', 'display_name', 'last_name', 'lat', 'lon']) {
      assert.ok(!body.includes(key), `must not contain ${key}`);
    }
  });
});

describe('turf scope (volunteer)', () => {
  it('403s on an unassigned turf and serves the assigned one without organizer-only fields', async () => {
    const denied = await call('GET', `/api/turfs/${ctx.polygonTurfId}/doors`, volunteerCookie);
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'not_your_turf');

    const ok = await call('GET', `/api/turfs/${ctx.streetTurfId}/doors`, volunteerCookie);
    assert.equal(ok.statusCode, 200);
    const body = ok.json() as {
      turf: { id: string };
      doors: Array<{ household_id: string; voters: Array<Record<string, unknown>> }>;
    };
    assert.equal(body.turf.id, ctx.streetTurfId);
    assert.equal(body.doors.length, ctx.streetHouseholdIds.length);

    // volunteers DO get names at the door, and nothing else that Phase 1 kept from them
    const raw = ok.body;
    for (const k of [...RESTRICTED_VOTER_KEYS, ...RESTRICTED_HH_KEYS]) {
      assert.ok(!raw.includes(`"${k}"`), `door payload must not contain ${k}`);
    }
    const someone = body.doors.flatMap((d) => d.voters)[0]!;
    assert.ok(typeof someone.display_name === 'string' && someone.display_name.length > 0);
    for (const k of RESTRICTED_VOTER_KEYS) assert.ok(!(k in someone), k);

    const orgDoors = await call('GET', `/api/turfs/${ctx.streetTurfId}/doors`, organizerCookie);
    const orgVoter = (orgDoors.json() as { doors: Array<{ voters: Array<Record<string, unknown>> }> }).doors.flatMap(
      (d) => d.voters,
    )[0]!;
    for (const k of RESTRICTED_VOTER_KEYS) assert.ok(k in orgVoter, `organizer keeps ${k}`);

    const aud = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'view_turf_doors' AND target = $1`, [
      ctx.streetTurfId,
    ]);
    assert.ok(aud.rows[0].n >= 1, 'one audit row per door-list view');
  });

  it('opens the household card for a door in the turf and keeps 403 elsewhere', async () => {
    const inTurf = ctx.streetHouseholdIds[0]!;
    const ok = await call('GET', `/api/households/${inTurf}`, volunteerCookie);
    assert.equal(ok.statusCode, 200);
    const card = ok.json() as { id: string; voters: Array<Record<string, unknown>> };
    assert.equal(card.id, inTurf);
    for (const k of RESTRICTED_HH_KEYS) assert.ok(!(k in card), k);
    for (const k of RESTRICTED_VOTER_KEYS) assert.ok(!(k in card.voters[0]!), k);

    const denied = await call('GET', `/api/households/${ctx.outsideHouseholdId}`, volunteerCookie);
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'not_your_turf');
  });

  it('adds `status` to map points inside the volunteer’s turf only', async () => {
    const res = await call('GET', '/api/households/points', volunteerCookie);
    assert.equal(res.statusCode, 200);
    const fc = res.json() as { features: Array<{ properties: Record<string, unknown> }> };
    const scoped = fc.features.filter((f) => 'status' in f.properties);
    const mapped = ctx.streetHouseholdIds.filter((id) => households.find((h) => h.household_id === id)?.lat);
    assert.equal(scoped.length, mapped.length);
    assert.deepEqual(scoped.map((f) => f.properties.id).sort(), mapped.slice().sort());
    for (const f of fc.features) {
      assert.ok(!('nonres' in f.properties) && !('q' in f.properties), 'organizer-only point keys stay hidden');
    }
  });
});

describe('contacts', () => {
  it('records a contact, is idempotent on client_id, and refuses doors outside the turf', async () => {
    const door = ctx.streetHouseholdIds[0]!;
    const voter = await db.query<{ id: string }>(`SELECT id FROM voter WHERE household_id = $1 LIMIT 1`, [door]);

    const payload = {
      household_id: door,
      voter_id: voter.rows[0]?.id,
      turf_id: ctx.streetTurfId,
      result: 'spoke',
      support: 4,
      issues: ['roads', 'taxes'],
      wants_sign: true,
      note: 'Wants a sign on the corner.',
      client_id: 'test-client-id-0001',
    };
    const first = await call('POST', '/api/contacts', volunteerCookie, payload);
    assert.equal(first.statusCode, 201, first.body);
    const c1 = (first.json() as { contact: Record<string, unknown> }).contact;
    assert.equal(c1.result, 'spoke');
    assert.equal(c1.support, 4);
    assert.deepEqual(c1.issues, ['roads', 'taxes']);
    assert.equal(c1.wants_sign, true);
    assert.equal(c1.user_name, 'volunteer accepted');

    // the offline queue replaying the same client_id must not create a second door knock
    const replay = await call('POST', '/api/contacts', volunteerCookie, { ...payload, note: 'changed' });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal((replay.json() as { contact: { id: string; note: string } }).contact.id, c1.id);
    assert.equal((replay.json() as { contact: { note: string } }).contact.note, 'Wants a sign on the corner.');
    const n = await db.query(`SELECT count(*)::int AS n FROM contact WHERE household_id = $1`, [door]);
    assert.equal(n.rows[0].n, 1);

    // no client_id → always a new row
    const second = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: ctx.streetHouseholdIds[1]!,
      result: 'not_home',
    });
    assert.equal(second.statusCode, 201);

    const outside = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: ctx.outsideHouseholdId,
      result: 'not_home',
    });
    assert.equal(outside.statusCode, 403);
    assert.equal((outside.json() as { error: { code: string } }).error.code, 'not_your_turf');

    // organizers are not turf-bound
    const org = await call('POST', '/api/contacts', organizerCookie, {
      household_id: ctx.outsideHouseholdId,
      result: 'left_literature',
      follow_up: true,
      note: 'Call back about the sign.',
    });
    assert.equal(org.statusCode, 201, org.body);

    const aud = await db.query(`SELECT detail FROM audit_log WHERE action = 'contact' ORDER BY id DESC LIMIT 1`);
    assert.ok(aud.rows[0], 'a contact audit row was written');
    assert.equal(aud.rows[0].detail.household_id, ctx.outsideHouseholdId);
    assert.equal(aud.rows[0].detail.result, 'left_literature');
    const naud = await db.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'contact' AND user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`,
      [EMAIL_PATTERN],
    );
    assert.equal(naud.rows[0].n, 3, 'the replay is not audited a second time');
  });

  it('validates the body', async () => {
    const door = ctx.streetHouseholdIds[0]!;
    const cases = [
      { household_id: door, result: 'shouted' },
      { household_id: door, result: 'spoke', support: 6 },
      { household_id: door, result: 'spoke', note: 'x'.repeat(2001) },
      { household_id: 'nope', result: 'spoke' },
    ];
    for (const c of cases) {
      const res = await call('POST', '/api/contacts', volunteerCookie, c);
      assert.equal(res.statusCode, 400, JSON.stringify(c));
    }
    const missing = await call('POST', '/api/contacts', volunteerCookie, { household_id: 'H-ARVA-99999', result: 'spoke' });
    assert.equal(missing.statusCode, 404);
  });

  it('lists a door’s history and reflects the contact in the door list and the card', async () => {
    const door = ctx.streetHouseholdIds[0]!;
    const res = await call('GET', `/api/contacts?household_id=${door}`, volunteerCookie);
    assert.equal(res.statusCode, 200);
    const { contacts } = res.json() as { contacts: Array<Record<string, unknown>> };
    assert.equal(contacts.length, 1);
    assert.deepEqual(Object.keys(contacts[0]!).sort(), [
      'at', 'follow_up', 'id', 'issues', 'needs_ride', 'note', 'result', 'support', 'user_name',
      'voter_id', 'voter_name', 'wants_sign', 'wants_volunteer',
    ]);
    assert.equal(contacts[0]!.user_name, 'volunteer accepted');
    assert.ok(contacts[0]!.voter_name);

    const denied = await call('GET', `/api/contacts?household_id=${ctx.outsideHouseholdId}`, volunteerCookie);
    assert.equal(denied.statusCode, 403);

    const doors = await call('GET', `/api/turfs/${ctx.streetTurfId}/doors`, volunteerCookie);
    const d = (doors.json() as { doors: Array<{ household_id: string; last_result: string | null }> }).doors.find(
      (x) => x.household_id === door,
    )!;
    assert.equal(d.last_result, 'spoke');

    const card = await call('GET', `/api/households/${door}`, adminCookie);
    const status = (card.json() as { status: { last_result: string; last_user_name: string } }).status;
    assert.equal(status.last_result, 'spoke');
    assert.equal(status.last_user_name, 'volunteer accepted');

    const turf = await call('GET', `/api/turfs/${ctx.streetTurfId}`, organizerCookie);
    assert.equal((turf.json() as { turf: { contacted: number } }).turf.contacted, 2);

    const points = await call('GET', '/api/households/points', volunteerCookie);
    const f = (points.json() as { features: Array<{ properties: Record<string, unknown> }> }).features.find(
      (x) => x.properties.id === door,
    )!;
    assert.equal(f.properties.status, 'spoke');
  });

  it('serves the follow-up queue and per-user activity to organizers only', async () => {
    const fu = await call('GET', '/api/follow-ups', organizerCookie);
    assert.equal(fu.statusCode, 200);
    const { follow_ups } = fu.json() as { follow_ups: Array<Record<string, unknown>> };
    assert.equal(follow_ups.length, 1);
    assert.equal(follow_ups[0]!.household_id, ctx.outsideHouseholdId);
    assert.equal(follow_ups[0]!.user_name, 'organizer accepted');
    assert.equal(follow_ups[0]!.last_result, 'left_literature');
    assert.ok(follow_ups[0]!.address);

    const act = await call('GET', '/api/activity?days=14', organizerCookie);
    assert.equal(act.statusCode, 200);
    const { by_user, by_day } = act.json() as {
      by_user: Array<{ user_id: string; name: string; contacts: number; doors: number; last_at: string }>;
      by_day: Array<{ day: string; contacts: number }>;
    };
    const volRow = by_user.find((u) => u.user_id === ctx.volunteerId)!;
    assert.equal(volRow.contacts, 2);
    assert.equal(volRow.doors, 2);
    assert.equal(by_user.reduce((s, u) => s + u.contacts, 0), 3);
    assert.equal(by_day.length, 1);
    assert.match(by_day[0]!.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(by_day[0]!.contacts, 3);

    for (const url of ['/api/follow-ups', '/api/activity']) {
      assert.equal((await call('GET', url, volunteerCookie)).statusCode, 403, url);
    }
  });

  it('reports canvass progress in stats/overview', async () => {
    const res = await call('GET', '/api/stats/overview', adminCookie);
    const s = res.json() as { canvass: { contacted_households: number; contacts_today: number; support_hist: number[] } };
    assert.equal(s.canvass.contacted_households, 3);
    assert.equal(s.canvass.contacts_today, 3);
    assert.deepEqual(s.canvass.support_hist, [0, 0, 0, 1, 0]);
  });

  // Last, because it adds a contact the counting assertions above do not expect.
  it('absorbs the explicit nulls a serialized door form sends', async () => {
    const res = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: ctx.streetHouseholdIds[2]!,
      result: 'not_home',
      voter_id: null,
      turf_id: null,
      support: null,
      issues: null,
      wants_sign: null,
      wants_volunteer: null,
      needs_ride: null,
      follow_up: null,
      note: null,
      client_id: null,
    });
    assert.equal(res.statusCode, 201, res.body);
    const c = (res.json() as { contact: Record<string, unknown> }).contact;
    assert.equal(c.support, null);
    assert.equal(c.voter_id, null);
    assert.equal(c.note, null);
    assert.equal(c.client_id, null);
    assert.deepEqual(c.issues, []);
    assert.equal(c.wants_sign, false);
    assert.equal(c.follow_up, false);
  });
});

// ------------------------------------------------------------------ lawn signs
// Runs last: it plants signs against the doors the contact tests created, and
// `GET /api/signs/requests` depends on those `wants_sign` contacts already existing.

/** Inside RECT, and therefore inside the municipality's sanity box. */
const SIGN_LAT = 43.06;
const SIGN_LON = -81.38;

/** A 1×1 PNG — real magic bytes and a real IHDR, so the sniffer must accept it and read 1×1. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Build a one-part multipart/form-data body for app.inject(), carrying the caller's session. */
function upload(cookie: string, filename: string, contentType: string, data: Buffer) {
  const boundary = `----canvasstest${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([head, data, tail]),
  };
}

interface SignCtx {
  cornerId: string;
  strayId: string;
  doorSignId: string;
  photoId: string;
  photoPath: string;
}
const signCtx = {} as SignCtx;

/** Remember a sign so after() can delete exactly this run's rows. */
const track = (id: string): string => {
  createdSignIds.push(id);
  return id;
};

describe('lawn signs', () => {
  it('places a sign with a GPS fix, defaults to placed, and replays client_id idempotently', async () => {
    const payload = {
      lat: SIGN_LAT,
      lon: SIGN_LON,
      accuracy_m: 8.5,
      label: 'corner of Ilderton Rd',
      size: 'large',
      note: 'behind the hydro pole',
      permission_by: 'farm owner',
      client_id: `test-sign-${RUN}-0001`,
    };
    const first = await call('POST', '/api/signs', volunteerCookie, payload);
    assert.equal(first.statusCode, 201, first.body);
    const s1 = (first.json() as { sign: Record<string, unknown> }).sign;
    signCtx.cornerId = track(s1.id as string);
    assert.equal(s1.status, 'placed', 'status defaults to placed');
    assert.equal(s1.household_id, null, 'a road-allowance sign has no door');
    assert.equal(s1.address, null);
    assert.equal(s1.placed_by_name, 'volunteer accepted');
    assert.ok(s1.placed_at, 'placed_at is stamped');
    assert.equal(s1.removed_at, null);
    assert.equal(s1.photo_count, 0);
    assert.equal(s1.accuracy_m, 8.5);

    // The volunteer in the field with one bar retries: the same client_id must not plant twice.
    const replay = await call('POST', '/api/signs', volunteerCookie, { ...payload, note: 'changed' });
    assert.equal(replay.statusCode, 200, replay.body);
    const s2 = (replay.json() as { sign: { id: string; note: string } }).sign;
    assert.equal(s2.id, signCtx.cornerId);
    assert.equal(s2.note, 'behind the hydro pole', 'the stored row wins');
    const n = await db.query(`SELECT count(*)::int AS n FROM sign WHERE client_id = $1`, [payload.client_id]);
    assert.equal(n.rows[0].n, 1);

    const naud = await db.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'place_sign' AND user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`,
      [EMAIL_PATTERN],
    );
    assert.equal(naud.rows[0].n, 1, 'the replay is not audited a second time');
  });

  it('refuses an implausible GPS fix with a clear message', async () => {
    for (const bad of [
      { lat: 45.4, lon: -75.7 }, // Ottawa
      { lat: 43.06, lon: -79.0 }, // Niagara
      { lat: 0, lon: 0 }, // null island — the classic bad fix
    ]) {
      const res = await call('POST', '/api/signs', volunteerCookie, bad);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      const err = (res.json() as { error: { code: string; message: string } }).error;
      assert.equal(err.code, 'coordinate_out_of_range', JSON.stringify(bad));
      assert.match(err.message, /Middlesex Centre/);
    }
    // and non-numbers are still a plain validation error
    const nan = await call('POST', '/api/signs', volunteerCookie, { lat: 'north', lon: SIGN_LON });
    assert.equal(nan.statusCode, 400);
    const missing = await call('POST', '/api/signs', volunteerCookie, { lat: SIGN_LAT });
    assert.equal(missing.statusCode, 400);
    const unknownDoor = await call('POST', '/api/signs', volunteerCookie, {
      lat: SIGN_LAT,
      lon: SIGN_LON,
      household_id: 'H-ARVA-99999',
    });
    assert.equal(unknownDoor.statusCode, 404);
  });

  it('lists signs with photo_count and filters by status, ward and bbox', async () => {
    const stray = await call('POST', '/api/signs', organizerCookie, {
      lat: SIGN_LAT + 0.005,
      lon: SIGN_LON + 0.005,
      label: 'church driveway',
      status: 'damaged',
    });
    assert.equal(stray.statusCode, 201, stray.body);
    signCtx.strayId = track((stray.json() as { sign: { id: string } }).sign.id);

    const all = await call('GET', '/api/signs', volunteerCookie);
    assert.equal(all.statusCode, 200);
    const { signs } = all.json() as { signs: Array<Record<string, unknown>> };
    const mine = signs.filter((s) => createdSignIds.includes(s.id as string));
    assert.equal(mine.length, 2);
    assert.deepEqual(Object.keys(mine[0]!).sort(), [
      'accuracy_m', 'address', 'client_id', 'created_at', 'household_id', 'id', 'label', 'lat', 'lon', 'note',
      'permission_by', 'photo_count', 'placed_at', 'placed_by', 'placed_by_name', 'removed_at', 'removed_by',
      'removed_by_name', 'requested_at', 'requested_from', 'size', 'status', 'ward',
    ]);

    const damaged = await call('GET', '/api/signs?status=damaged', volunteerCookie);
    const dIds = (damaged.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id);
    assert.ok(dIds.includes(signCtx.strayId));
    assert.ok(!dIds.includes(signCtx.cornerId));

    // Neither sign has a household, so a ward filter necessarily drops both.
    const byWard = await call('GET', '/api/signs?ward=01,02,03,04', volunteerCookie);
    const wIds = (byWard.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id);
    assert.ok(!wIds.includes(signCtx.cornerId));

    const inBox = await call('GET', `/api/signs?bbox=${RECT.minLon},${RECT.minLat},${RECT.maxLon},${RECT.maxLat}`, volunteerCookie);
    const bIds = (inBox.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id);
    assert.ok(bIds.includes(signCtx.cornerId));
    const outBox = await call('GET', '/api/signs?bbox=-81.2,42.9,-81.15,42.95', volunteerCookie);
    assert.ok(!(outBox.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id).includes(signCtx.cornerId));
    assert.equal((await call('GET', '/api/signs?bbox=1,2,3', volunteerCookie)).statusCode, 400);
    assert.equal((await call('GET', '/api/signs?status=eaten', volunteerCookie)).statusCode, 400);
  });

  it('accepts an image, refuses anything else, and never trusts the client filename', async () => {
    const good = await app.inject({
      method: 'POST',
      url: `/api/signs/${signCtx.cornerId}/photo`,
      ...upload(volunteerCookie, '../../../etc/passwd.jpg', 'image/jpeg', PNG_1PX), // lying type AND a nasty name
    });
    assert.equal(good.statusCode, 201, good.body);
    const photo = (good.json() as { photo: Record<string, unknown> }).photo;
    signCtx.photoId = photo.id as string;
    assert.equal(photo.content_type, 'image/png', 'the sniffed type wins over the declared one');
    assert.equal(photo.width, 1);
    assert.equal(photo.height, 1);
    assert.equal(photo.bytes, PNG_1PX.length);
    assert.equal(photo.taken_by_name, 'volunteer accepted');
    assert.equal(photo.sign_id, signCtx.cornerId);
    assert.equal((photo as { path?: string }).path, undefined, 'the on-disk path never leaves the API');

    const row = await db.query<{ path: string }>(`SELECT path FROM sign_photo WHERE id = $1`, [signCtx.photoId]);
    signCtx.photoPath = row.rows[0]!.path;
    assert.match(signCtx.photoPath, /^[0-9a-f-]{36}\.png$/, 'stored under a generated uuid, not the sent filename');
    const files = await readdir(photoDir);
    assert.ok(files.includes(signCtx.photoPath));

    // A PDF (or anything else) wearing an image content-type is refused on its magic bytes.
    const notAnImage = await app.inject({
      method: 'POST',
      url: `/api/signs/${signCtx.cornerId}/photo`,
      ...upload(volunteerCookie, 'sign.jpg', 'image/jpeg', Buffer.from('%PDF-1.4\n%âãÏÓ\nnot a photograph at all\n')),
    });
    assert.equal(notAnImage.statusCode, 400, notAnImage.body);
    assert.equal((notAnImage.json() as { error: { code: string } }).error.code, 'unsupported_image');
    assert.equal((await readdir(photoDir)).length, 1, 'the rejected upload left nothing on disk');

    const noFile = await app.inject({
      method: 'POST',
      url: `/api/signs/${signCtx.cornerId}/photo`,
      headers: { cookie: volunteerCookie },
      payload: { not: 'multipart' },
    });
    assert.equal(noFile.statusCode, 400);

    const unknownSign = await app.inject({
      method: 'POST',
      url: `/api/signs/${randomUUID()}/photo`,
      ...upload(volunteerCookie, 'a.png', 'image/png', PNG_1PX),
    });
    assert.equal(unknownSign.statusCode, 404);

    const one = await call('GET', `/api/signs/${signCtx.cornerId}`, volunteerCookie);
    const sign = (one.json() as { sign: { photo_count: number; photos: Array<{ id: string }> } }).sign;
    assert.equal(sign.photo_count, 1);
    assert.equal(sign.photos.length, 1);
    assert.equal(sign.photos[0]!.id, signCtx.photoId);
  });

  it('serves photo bytes only to signed-in users, and audits every view', async () => {
    const anon = await app.inject({ method: 'GET', url: `/api/signs/photo/${signCtx.photoId}` });
    assert.equal(anon.statusCode, 401, 'a photo of somebody’s house is not public');
    assert.equal((anon.json() as { error: { code: string } }).error.code, 'unauthorized');

    const res = await call('GET', `/api/signs/photo/${signCtx.photoId}`, volunteerCookie);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'private');
    assert.deepEqual(res.rawPayload, PNG_1PX);

    const aud = await db.query(
      `SELECT target, detail FROM audit_log WHERE action = 'view_sign_photo' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(aud.rows[0].target, signCtx.photoId);
    assert.equal(aud.rows[0].detail.sign_id, signCtx.cornerId);

    assert.equal((await call('GET', `/api/signs/photo/${randomUUID()}`, volunteerCookie)).statusCode, 404);
    assert.equal((await call('GET', '/api/signs/photo/not-a-uuid', volunteerCookie)).statusCode, 400);
  });

  it('builds the pickup list from standing signs only, and stamps who removed one', async () => {
    const before = await call('GET', '/api/signs/pickup', volunteerCookie);
    assert.equal(before.statusCode, 200);
    const beforeIds = (before.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id);
    assert.ok(beforeIds.includes(signCtx.cornerId), 'a placed sign is on the worklist');
    assert.ok(beforeIds.includes(signCtx.strayId), 'a damaged sign still has to be collected');

    const line = (before.json() as { signs: Array<Record<string, unknown>> }).signs.find(
      (s) => s.id === signCtx.cornerId,
    )!;
    assert.deepEqual(Object.keys(line).sort(), [
      'accuracy_m', 'address', 'id', 'label', 'lat', 'lon', 'note', 'photo_ids', 'placed_at', 'placed_by_name',
      'size', 'status', 'ward',
    ]);
    assert.equal(line.lat, SIGN_LAT);
    assert.equal(line.accuracy_m, 8.5);
    assert.deepEqual(line.photo_ids, [signCtx.photoId], 'the photo that makes it findable is on the list');

    const removed = await call('PATCH', `/api/signs/${signCtx.cornerId}`, volunteerCookie, {
      status: 'removed',
      note: 'collected 2026-11-02',
    });
    assert.equal(removed.statusCode, 200, removed.body);
    const r = (removed.json() as { sign: Record<string, unknown> }).sign;
    assert.equal(r.status, 'removed');
    assert.equal(r.removed_by_name, 'volunteer accepted');
    assert.ok(r.removed_at, 'removed_at is stamped');
    assert.equal(r.note, 'collected 2026-11-02');

    const after = await call('GET', '/api/signs/pickup', volunteerCookie);
    const afterIds = (after.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id);
    assert.ok(!afterIds.includes(signCtx.cornerId), 'a removed sign is off the pickup list');
    assert.ok(afterIds.includes(signCtx.strayId));

    // Putting it back clears the removal stamp rather than leaving a removal date on a live sign.
    const back = await call('PATCH', `/api/signs/${signCtx.cornerId}`, organizerCookie, { status: 'placed' });
    const b = (back.json() as { sign: Record<string, unknown> }).sign;
    assert.equal(b.removed_at, null);
    assert.equal(b.removed_by_name, null);
    assert.equal(b.placed_by_name, 'volunteer accepted', 'the original placer is not overwritten');
    const relisted = await call('GET', '/api/signs/pickup', volunteerCookie);
    assert.ok(
      (relisted.json() as { signs: Array<{ id: string }> }).signs.map((s) => s.id).includes(signCtx.cornerId),
      'putting a sign back puts it back on the pickup list',
    );

    assert.equal((await call('PATCH', `/api/signs/${randomUUID()}`, organizerCookie, { status: 'missing' })).statusCode, 404);
    assert.equal((await call('PATCH', `/api/signs/${signCtx.cornerId}`, organizerCookie, {})).statusCode, 400);
  });

  it('lists doors that asked for a sign, and drops one as soon as its sign is placed', async () => {
    const door = ctx.streetHouseholdIds[0]!; // the contacts suite ticked wants_sign here

    const before = await call('GET', '/api/signs/requests', organizerCookie);
    assert.equal(before.statusCode, 200);
    const rows = (before.json() as { requests: Array<Record<string, unknown>> }).requests;
    const wanted = rows.find((r) => r.household_id === door);
    assert.ok(wanted, 'the door that asked for a sign is on the list');
    assert.ok(wanted.address, 'with the address needed to deliver it');
    assert.equal(wanted.last_result, 'spoke');
    assert.equal(wanted.user_name, 'volunteer accepted');
    for (const k of [...RESTRICTED_VOTER_KEYS, ...RESTRICTED_HH_KEYS]) {
      assert.equal(k in wanted, false, `sign requests must not carry ${k}`);
    }
    // The follow-up door said nothing about a sign, so it is not here.
    assert.ok(!rows.some((r) => r.household_id === ctx.outsideHouseholdId));

    const placed = await call('POST', '/api/signs', organizerCookie, {
      household_id: door,
      lat: SIGN_LAT,
      lon: SIGN_LON,
      accuracy_m: 12,
      size: 'small',
    });
    assert.equal(placed.statusCode, 201, placed.body);
    const s = (placed.json() as { sign: Record<string, unknown> }).sign;
    signCtx.doorSignId = track(s.id as string);
    assert.equal(s.household_id, door);
    assert.ok(s.address, 'the joined household address comes back');
    assert.ok(s.ward);

    const after = await call('GET', '/api/signs/requests', organizerCookie);
    const afterRows = (after.json() as { requests: Array<{ household_id: string }> }).requests;
    assert.ok(!afterRows.some((r) => r.household_id === door), 'a door with a sign is no longer a request');

    // A volunteer sees only requests inside their own turfs — same rule as every other door read.
    const volBefore = await call('GET', '/api/signs/requests', volunteerCookie);
    assert.equal(volBefore.statusCode, 200);

    const naud = await db.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'view_sign_requests' AND user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`,
      [EMAIL_PATTERN],
    );
    assert.equal(naud.rows[0].n, 3, 'every read of the request list is audited');
  });

  it('deletes signs and photos for organizers only, and takes the file with them', async () => {
    const volDelete = await call('DELETE', `/api/signs/photo/${signCtx.photoId}`, volunteerCookie);
    assert.equal(volDelete.statusCode, 403);
    const volSign = await call('DELETE', `/api/signs/${signCtx.doorSignId}`, volunteerCookie);
    assert.equal(volSign.statusCode, 403);

    const del = await call('DELETE', `/api/signs/photo/${signCtx.photoId}`, organizerCookie);
    assert.equal(del.statusCode, 204);
    assert.equal((await readdir(photoDir)).length, 0, 'the file is gone, not just the row');
    const gone = await db.query(`SELECT count(*)::int AS n FROM sign_photo WHERE id = $1`, [signCtx.photoId]);
    assert.equal(gone.rows[0].n, 0);
    assert.equal((await call('DELETE', `/api/signs/photo/${signCtx.photoId}`, organizerCookie)).statusCode, 404);

    const delSign = await call('DELETE', `/api/signs/${signCtx.doorSignId}`, organizerCookie);
    assert.equal(delSign.statusCode, 204);
    assert.equal((await call('GET', `/api/signs/${signCtx.doorSignId}`, organizerCookie)).statusCode, 404);
    assert.equal((await call('DELETE', `/api/signs/${signCtx.doorSignId}`, organizerCookie)).statusCode, 404);
  });

  it('requires a session for every sign route', async () => {
    for (const [method, url] of [
      ['GET', '/api/signs'],
      ['GET', '/api/signs/pickup'],
      ['GET', '/api/signs/requests'],
      ['POST', '/api/signs'],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });
});

// ------------------------------------------------------------------ two people at one door
// Runs after the counting assertions above (stats.canvass, /activity, /follow-ups), because it
// writes several more contacts at doors those tests have already measured.

interface MultiCtx {
  /** A door in the volunteer's turf where more than one person is on the list. */
  householdId: string;
  voterIds: string[];
  /** A voter at a household the turf does not contain — used for the cross-household check. */
  strayVoterId: string;
}
const multi = {} as MultiCtx;

describe('contacts (more than one person at the door)', () => {
  before(async () => {
    const door = await db.query<{ household_id: string }>(
      `SELECT household_id FROM voter WHERE household_id = ANY($1::text[])
       GROUP BY household_id HAVING count(*) >= 2
       ORDER BY household_id LIMIT 1`,
      [ctx.streetHouseholdIds],
    );
    assert.ok(door.rows[0], 'the test turf needs at least one door with two voters on the list');
    multi.householdId = door.rows[0]!.household_id;
    const voters = await db.query<{ id: string }>(
      `SELECT id FROM voter WHERE household_id = $1 ORDER BY id LIMIT 2`,
      [multi.householdId],
    );
    multi.voterIds = voters.rows.map((r) => r.id);
    const stray = await db.query<{ id: string }>(`SELECT id FROM voter WHERE household_id = $1 LIMIT 1`, [
      ctx.outsideHouseholdId,
    ]);
    assert.ok(stray.rows[0], 'the out-of-turf household needs a voter for the cross-household check');
    multi.strayVoterId = stray.rows[0]!.id;
  });

  it('writes one row per named voter in one transaction, with per-person support levels', async () => {
    const [a, b] = multi.voterIds as [string, string];
    const payload = {
      household_id: multi.householdId,
      voter_ids: [a, b],
      turf_id: ctx.streetTurfId,
      result: 'spoke',
      support: 3, // the door-level default...
      supports: { [b]: 5 }, // ...overridden for the person who actually said so
      issues: ['roads'],
      wants_volunteer: true,
      note: 'Two at the door.',
      client_id: 'multi-voter-key-0001',
    };
    const res = await call('POST', '/api/contacts', volunteerCookie, payload);
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { contacts: Array<Record<string, unknown>>; contact: Record<string, unknown> };

    assert.equal(body.contacts.length, 2);
    // the singular field stays populated with the first row so the existing web client keeps working
    assert.deepEqual(body.contact, body.contacts[0]);

    assert.deepEqual(body.contacts.map((c) => c.voter_id), [a, b]);
    assert.deepEqual(body.contacts.map((c) => c.support), [3, 5]);
    for (const c of body.contacts) {
      assert.equal(c.result, 'spoke');
      assert.equal(c.household_id, multi.householdId);
      assert.deepEqual(c.issues, ['roads']);
      assert.equal(c.wants_volunteer, true);
      assert.equal(c.note, 'Two at the door.');
      assert.equal(c.user_name, 'volunteer accepted');
    }
    // per-row idempotency keys derived from the submitted one — client_id is UNIQUE, so N rows
    // cannot all carry the same key
    assert.deepEqual(body.contacts.map((c) => c.client_id), [
      `multi-voter-key-0001:${a}`,
      `multi-voter-key-0001:${b}`,
    ]);

    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contact WHERE client_id LIKE 'multi-voter-key-0001:%'`,
    );
    assert.equal(rows.rows[0]!.n, 2, 'both rows landed');

    // `voter_status` takes the latest row per voter, which is what makes two different support
    // levels at one door expressible at all.
    const status = await db.query<{ id: string; last_support: number }>(
      `SELECT voter_id AS id, last_support FROM voter_status WHERE voter_id = ANY($1::uuid[]) ORDER BY voter_id`,
      [[a, b]],
    );
    assert.deepEqual(status.rows.map((r) => r.last_support), [3, 5]);
  });

  it('collapses a replay of a multi-voter submission onto the same rows', async () => {
    const [a, b] = multi.voterIds as [string, string];
    const before = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'contact'
       AND user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`,
      [EMAIL_PATTERN],
    );
    const first = await call('GET', `/api/contacts?household_id=${multi.householdId}`, volunteerCookie);
    const nBefore = (first.json() as { contacts: unknown[] }).contacts.length;

    const replay = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      voter_ids: [a, b],
      result: 'spoke',
      support: 3,
      supports: { [b]: 5 },
      note: 'changed on the retry',
      client_id: 'multi-voter-key-0001',
    });
    assert.equal(replay.statusCode, 200, replay.body);
    const body = replay.json() as { contacts: Array<Record<string, unknown>> };
    assert.equal(body.contacts.length, 2);
    // the stored rows win: a replay with a changed body updates nothing
    for (const c of body.contacts) assert.equal(c.note, 'Two at the door.');

    const after = await call('GET', `/api/contacts?household_id=${multi.householdId}`, volunteerCookie);
    assert.equal((after.json() as { contacts: unknown[] }).contacts.length, nBefore, 'no double write');

    const audits = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'contact'
       AND user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`,
      [EMAIL_PATTERN],
    );
    assert.equal(audits.rows[0]!.n, before.rows[0]!.n, 'a replay is not audited a second time');
  });

  it('keeps the single-voter and no-voter forms exactly as they were', async () => {
    const [a] = multi.voterIds as [string];
    const single = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      voter_id: a,
      result: 'refused',
    });
    assert.equal(single.statusCode, 201, single.body);
    const sb = single.json() as { contact: Record<string, unknown>; contacts: unknown[] };
    assert.equal(sb.contacts.length, 1);
    assert.equal(sb.contact.voter_id, a);

    // nobody named: one door-level row, client_id stored verbatim
    const door = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      result: 'not_home',
      client_id: 'door-level-key-0001',
    });
    assert.equal(door.statusCode, 201, door.body);
    const db1 = (door.json() as { contact: Record<string, unknown> }).contact;
    assert.equal(db1.voter_id, null);
    assert.equal(db1.client_id, 'door-level-key-0001');
    const again = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      result: 'not_home',
      client_id: 'door-level-key-0001',
    });
    assert.equal(again.statusCode, 200);
    assert.equal((again.json() as { contact: { id: string } }).contact.id, db1.id);
  });

  it('refuses a voter from another household, and a support level for somebody not named', async () => {
    const [a] = multi.voterIds as [string];
    const stray = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      voter_ids: [a, multi.strayVoterId],
      result: 'spoke',
    });
    assert.equal(stray.statusCode, 400, stray.body);
    assert.equal((stray.json() as { error: { code: string } }).error.code, 'voter_not_in_household');
    const none = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contact WHERE voter_id = $1`,
      [multi.strayVoterId],
    );
    assert.equal(none.rows[0]!.n, 0, 'nothing was written for the rejected submission');

    const unnamed = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      voter_ids: [a],
      result: 'spoke',
      supports: { [multi.strayVoterId]: 4 },
    });
    assert.equal(unnamed.statusCode, 400, unnamed.body);
    assert.equal((unnamed.json() as { error: { code: string } }).error.code, 'support_voter_not_named');

    const tooMany = await call('POST', '/api/contacts', volunteerCookie, {
      household_id: multi.householdId,
      voter_ids: Array.from({ length: 13 }, () => randomUUID()),
      result: 'spoke',
    });
    assert.equal(tooMany.statusCode, 400);
  });
});

// ------------------------------------------------------------------ phone / email at the door

interface VcCtx {
  householdId: string;
  voterId: string;
  phoneId: string;
  emailId: string;
}
const vc = {} as VcCtx;

const PHONE_TYPED = '(519) 555-0134';
const PHONE_E164 = '+15195550134';

describe('voter contacts (phone / email collected at the door)', () => {
  before(async () => {
    vc.householdId = ctx.streetHouseholdIds[0]!;
    const v = await db.query<{ id: string }>(`SELECT id FROM voter WHERE household_id = $1 LIMIT 1`, [
      vc.householdId,
    ]);
    vc.voterId = v.rows[0]!.id;
  });

  it('refuses to store a value nobody consented to', async () => {
    for (const consent of [{}, { consent_gotv: false, consent_updates: false }]) {
      const res = await call('POST', '/api/voter-contacts', volunteerCookie, {
        household_id: vc.householdId,
        channel: 'phone',
        value: PHONE_TYPED,
        ...consent,
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'consent_required');
    }
    const none = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM voter_contact WHERE household_id = $1`, [
      vc.householdId,
    ]);
    assert.equal(none.rows[0]!.n, 0, 'nothing was stored');
  });

  it('normalises a phone number and lower-cases an email, and rejects what is neither', async () => {
    const phone = await call('POST', '/api/voter-contacts', volunteerCookie, {
      household_id: vc.householdId,
      voter_id: vc.voterId,
      channel: 'phone',
      value: PHONE_TYPED,
      consent_gotv: true,
      consent_note: 'Text me the day before.',
    });
    assert.equal(phone.statusCode, 201, phone.body);
    const p = (phone.json() as { voter_contact: Record<string, unknown> }).voter_contact;
    vc.phoneId = p.id as string;
    assert.equal(p.value, PHONE_E164);
    assert.equal(p.consent_gotv, true);
    assert.equal(p.consent_updates, false);
    assert.equal(p.withdrawn_at, null);
    assert.equal(p.collected_by_name, 'volunteer accepted');
    assert.ok(p.voter_name, 'the named person travels with the value');

    const email = await call('POST', '/api/voter-contacts', volunteerCookie, {
      household_id: vc.householdId,
      channel: 'email',
      value: '  Sean.Voter@Example.CA ',
      consent_updates: true,
    });
    assert.equal(email.statusCode, 201, email.body);
    const e = (email.json() as { voter_contact: Record<string, unknown> }).voter_contact;
    vc.emailId = e.id as string;
    assert.equal(e.value, 'sean.voter@example.ca');
    assert.equal(e.voter_id, null, 'a number can belong to the house rather than a named person');

    // every common way of writing the same number lands on the one stored value
    for (const written of ['519.555.0134', '1-519-555-0134', '+1 (519) 555 0134']) {
      assert.equal(normalizeContactValue('phone', written), PHONE_E164, written);
    }
    for (const bad of [
      { channel: 'phone', value: '12345', code: 'invalid_phone' },
      { channel: 'phone', value: '019-555-0134', code: 'invalid_phone' },
      { channel: 'phone', value: '519-555-0134 ext 22', code: 'invalid_phone' },
      { channel: 'email', value: 'not-an-email', code: 'invalid_email' },
      { channel: 'email', value: 'two@@example.ca', code: 'invalid_email' },
    ] as const) {
      const res = await call('POST', '/api/voter-contacts', volunteerCookie, {
        household_id: vc.householdId,
        channel: bad.channel,
        value: bad.value,
        consent_gotv: true,
      });
      assert.equal(res.statusCode, 400, `${bad.value}: ${res.body}`);
      assert.equal((res.json() as { error: { code: string } }).error.code, bad.code, bad.value);
    }

    const stray = await call('POST', '/api/voter-contacts', volunteerCookie, {
      household_id: vc.householdId,
      voter_id: multi.strayVoterId,
      channel: 'phone',
      value: '519-555-0199',
      consent_gotv: true,
    });
    assert.equal(stray.statusCode, 400);
    assert.equal((stray.json() as { error: { code: string } }).error.code, 'voter_not_in_household');
  });

  it('treats a re-offer of the same value as consent granted again, not a conflict', async () => {
    const res = await call('POST', '/api/voter-contacts', volunteerCookie, {
      household_id: vc.householdId,
      channel: 'phone',
      value: '519.555.0134', // the same number, written differently
      consent_updates: true,
      consent_note: 'And campaign updates too.',
    });
    assert.equal(res.statusCode, 200, res.body);
    const p = (res.json() as { voter_contact: Record<string, unknown> }).voter_contact;
    assert.equal(p.id, vc.phoneId, 'the same row, not a second one');
    assert.equal(p.consent_gotv, true, 'the earlier consent is not silently revoked');
    assert.equal(p.consent_updates, true, 'the new one is granted');
    assert.equal(p.consent_note, 'And campaign updates too.');
    assert.equal(p.voter_id, vc.voterId, 'the named person is kept');

    const n = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM voter_contact WHERE household_id = $1`, [
      vc.householdId,
    ]);
    assert.equal(n.rows[0]!.n, 2, 'still one phone and one email at this door');
  });

  it('serves the door’s details to the volunteer whose turf it is, and nobody else’s', async () => {
    const res = await call('GET', `/api/voter-contacts?household_id=${vc.householdId}`, volunteerCookie);
    assert.equal(res.statusCode, 200);
    const { voter_contacts } = res.json() as { voter_contacts: Array<Record<string, unknown>> };
    assert.equal(voter_contacts.length, 2);
    assert.deepEqual(Object.keys(voter_contacts[0]!).sort(), [
      'channel', 'collected_by', 'collected_by_name', 'consent_gotv', 'consent_note', 'consent_updates',
      'consented_at', 'contact_id', 'created_at', 'household_id', 'id', 'value', 'voter_id', 'voter_name',
      'withdrawn_at', 'withdrawn_note',
    ]);

    const denied = await call('GET', `/api/voter-contacts?household_id=${ctx.outsideHouseholdId}`, volunteerCookie);
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'not_your_turf');

    const write = await call('POST', '/api/voter-contacts', volunteerCookie, {
      household_id: ctx.outsideHouseholdId,
      channel: 'phone',
      value: '519-555-0177',
      consent_gotv: true,
    });
    assert.equal(write.statusCode, 403);
    assert.equal((write.json() as { error: { code: string } }).error.code, 'not_your_turf');

    const aud = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'view_voter_contacts' AND target = $1`,
      [vc.householdId],
    );
    assert.ok(aud.rows[0]!.n >= 1, 'reading somebody’s phone number is audited');
  });

  it('serves the GOTV send list to organizers only, and audits every call', async () => {
    assert.equal((await call('GET', '/api/voter-contacts/gotv', volunteerCookie)).statusCode, 403);

    const res = await call('GET', '/api/voter-contacts/gotv?channel=phone', organizerCookie);
    assert.equal(res.statusCode, 200);
    const { contacts } = res.json() as { contacts: Array<Record<string, unknown>> };
    const mine = contacts.find((c) => c.id === vc.phoneId)!;
    assert.ok(mine, 'the consented number is on the send list');
    assert.equal(mine.value, PHONE_E164);
    assert.ok(mine.address, 'the list carries enough to segment a send');

    // the email consented to updates only — never to GOTV — must not be on it
    assert.ok(!contacts.some((c) => c.id === vc.emailId), 'consent is per purpose');

    const aud = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'view_gotv_list'
       AND user_id IN (SELECT id FROM app_user WHERE email LIKE $1)`,
      [EMAIL_PATTERN],
    );
    assert.equal(aud.rows[0]!.n, 1, 'the send list is audited on every call');
  });

  it('records a withdrawal without deleting the row, and drops it from the send list', async () => {
    const res = await call('PATCH', `/api/voter-contacts/${vc.phoneId}`, volunteerCookie, {
      withdrawn: true,
      withdrawn_note: 'Asked us to stop texting.',
    });
    assert.equal(res.statusCode, 200, res.body);
    const p = (res.json() as { voter_contact: Record<string, unknown> }).voter_contact;
    assert.ok(p.withdrawn_at, 'the withdrawal is stamped');
    assert.equal(p.withdrawn_note, 'Asked us to stop texting.');
    assert.equal(p.consent_gotv, true, 'what they once agreed to is still on the record');

    // The row STAYS: a deleted row would just be re-collected at the next canvass.
    const still = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM voter_contact WHERE id = $1`, [
      vc.phoneId,
    ]);
    assert.equal(still.rows[0]!.n, 1);

    const gotv = await call('GET', '/api/voter-contacts/gotv', organizerCookie);
    assert.ok(
      !(gotv.json() as { contacts: Array<{ id: string }> }).contacts.some((c) => c.id === vc.phoneId),
      'a withdrawn number is off the send list',
    );

    const aud = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'withdraw_voter_contact' AND target = $1`,
      [vc.phoneId],
    );
    assert.equal(aud.rows[0]!.n, 1);

    // a re-offer at the door must not quietly resurrect it — only an explicit lift does
    const reoffer = await call('POST', '/api/voter-contacts', volunteerCookie, {
      household_id: vc.householdId,
      channel: 'phone',
      value: PHONE_TYPED,
      consent_gotv: true,
    });
    assert.equal(reoffer.statusCode, 200);
    assert.ok((reoffer.json() as { voter_contact: { withdrawn_at: string | null } }).voter_contact.withdrawn_at);

    const lift = await call('PATCH', `/api/voter-contacts/${vc.phoneId}`, organizerCookie, { withdrawn: false });
    assert.equal(lift.statusCode, 200);
    const lifted = (lift.json() as { voter_contact: Record<string, unknown> }).voter_contact;
    assert.equal(lifted.withdrawn_at, null);
    assert.equal(lifted.withdrawn_note, null);
    const back = await call('GET', '/api/voter-contacts/gotv?channel=phone', organizerCookie);
    assert.ok((back.json() as { contacts: Array<{ id: string }> }).contacts.some((c) => c.id === vc.phoneId));
  });

  it('deletes only for a genuine mistake, and only for an organizer', async () => {
    const mistake = await call('POST', '/api/voter-contacts', organizerCookie, {
      household_id: ctx.outsideHouseholdId,
      channel: 'phone',
      value: '519-555-0166',
      consent_gotv: true,
    });
    assert.equal(mistake.statusCode, 201, mistake.body);
    const id = (mistake.json() as { voter_contact: { id: string } }).voter_contact.id;

    assert.equal((await call('DELETE', `/api/voter-contacts/${id}`, volunteerCookie)).statusCode, 403);
    assert.equal((await call('DELETE', `/api/voter-contacts/${id}`, organizerCookie)).statusCode, 204);
    assert.equal((await call('DELETE', `/api/voter-contacts/${id}`, organizerCookie)).statusCode, 404);
    const gone = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM voter_contact WHERE id = $1`, [id]);
    assert.equal(gone.rows[0]!.n, 0);

    const aud = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'delete_voter_contact' AND target = $1`,
      [id],
    );
    assert.equal(aud.rows[0]!.n, 1);
  });

  it('requires a session for every voter-contact route', async () => {
    for (const [method, url] of [
      ['GET', '/api/voter-contacts?household_id=H-ARVA-1'],
      ['GET', '/api/voter-contacts/gotv'],
      ['POST', '/api/voter-contacts'],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });
});

/**
 * Street-level imagery of a door.
 *
 * Nothing in here talks to Google: the provider is a stub, so the suite never makes a billed call
 * and never sends a real coordinate anywhere. What is actually under test is the set of rails that
 * make the feature safe to turn on — it is off by default, it is scoped exactly like the household
 * card, and it cannot be made to spend money by asking for a wall-sized image.
 */
describe('street-level imagery', () => {
  /** A 1×1 PNG. The route does not parse the bytes; this is just something plausible to serve. */
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  /** Every provider URL the stub was asked for, in order — the evidence for "nothing left the building". */
  let provider: string[] = [];
  /** What the (free) metadata endpoint should claim about the next door asked about. */
  let metaStatus = 'OK';

  const stub: FetchLike = async (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    provider.push(url.pathname);
    // A stub that leaked the key or an address would be a bug worth failing on, so assert here.
    assert.equal(url.searchParams.get('key'), 'test-streetview-key');
    const location = url.searchParams.get('location') ?? '';
    assert.match(location, /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'only coordinates are ever sent to the provider');
    if (url.pathname.endsWith('/metadata')) {
      return new Response(JSON.stringify({ status: metaStatus }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
  };

  /** The same stack with a key configured — the only place in the suite where the feature is on. */
  let svApp: FastifyInstance;
  /** Mapped doors inside the volunteer's turf, and one mapped door outside it. */
  let inTurf: string[];

  const sv = (url: string, cookie: string) => svApp.inject({ method: 'GET', url, headers: { cookie } });

  const auditFor = async (id: string) =>
    (
      await db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_log WHERE action = 'view_streetview' AND target = $1 ORDER BY id DESC LIMIT 1`,
        [id],
      )
    ).rows[0]?.detail;

  before(async () => {
    const config = loadConfig({
      DATABASE_URL,
      SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      DOMAIN: 'canvass.test',
      COOKIE_SECURE: 'false',
      BOUNDARY_PATH: resolve(DATA_DIR, 'mc_boundary.json'),
      SIGN_PHOTO_DIR: photoDir,
      STREETVIEW_API_KEY: 'test-streetview-key',
      LOG_LEVEL: 'silent',
    });
    svApp = await buildApp({ config, db, fetchImpl: stub, logger: false });
    await svApp.ready();
    inTurf = ctx.streetHouseholdIds.filter((id) => households.find((h) => h.household_id === id)?.lat);
    assert.ok(inTurf.length >= 3, 'need a few mapped doors inside the volunteer turf');
  });

  after(async () => {
    await svApp.close();
    clearStreetViewCache();
  });

  beforeEach(() => {
    // Each case starts with an empty memory cache so a cache hit from a neighbouring test can
    // never be mistaken for a provider call that did not happen.
    clearStreetViewCache();
    provider = [];
    metaStatus = 'OK';
  });

  it('is off unless a key is configured, and says so cleanly', async () => {
    // `app` (the rest of the suite) has no STREETVIEW_API_KEY, which is the default deployment.
    for (const [door, cookie] of [
      [ctx.streetHouseholdIds[0]!, volunteerCookie],
      [ctx.outsideHouseholdId, organizerCookie],
    ] as const) {
      const res = await call('GET', `/api/households/${door}/streetview`, cookie);
      assert.equal(res.statusCode, 503, res.body);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'streetview_disabled');
    }
    // And with the feature off nothing is recorded, because nothing was looked at.
    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'view_streetview'
        AND target = $1 AND at > now() - interval '1 minute'`,
      [ctx.outsideHouseholdId],
    );
    assert.equal(n.rows[0]!.n, 0);
  });

  it('requires a session', async () => {
    const res = await svApp.inject({ method: 'GET', url: `/api/households/${inTurf[0]}/streetview` });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(provider, [], 'an anonymous request never reaches the provider');
  });

  it('refuses a volunteer a door outside their turfs, without asking the provider about it', async () => {
    const res = await sv(`/api/households/${ctx.outsideHouseholdId}/streetview`, volunteerCookie);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'not_your_turf');
    // The point of checking scope before anything else: the coordinates of a door this volunteer
    // may not see are never sent anywhere, and no charge is incurred on their behalf.
    assert.deepEqual(provider, []);
    assert.equal(await auditFor(ctx.outsideHouseholdId), undefined);

    // ...and an organizer is not turf-bound, on the same door.
    const org = await sv(`/api/households/${ctx.outsideHouseholdId}/streetview`, organizerCookie);
    assert.equal(org.statusCode, 200, org.body);
  });

  it('caps the requested size so the endpoint cannot bill the campaign arbitrarily', async () => {
    for (const qs of ['w=4000', 'h=4000', 'w=2048&h=2048', 'w=10', 'w=abc']) {
      const res = await sv(`/api/households/${inTurf[0]}/streetview?${qs}`, volunteerCookie);
      assert.equal(res.statusCode, 400, `${qs} → ${res.body}`);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'validation_error');
    }
    assert.deepEqual(provider, [], 'a rejected size never reaches the provider');

    const ok = await sv(`/api/households/${inTurf[0]}/streetview?w=320&h=200`, volunteerCookie);
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('checks the free metadata endpoint before the billed image, and caches the bytes', async () => {
    const door = inTurf[1]!;
    const res = await sv(`/api/households/${door}/streetview`, volunteerCookie);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'private, max-age=900');
    assert.deepEqual(res.rawPayload, PIXEL);
    // Metadata is free and answers "is there imagery here?"; it must come first, every time.
    assert.deepEqual(provider, ['/maps/api/streetview/metadata', '/maps/api/streetview']);
    assert.deepEqual(await auditFor(door), { available: true, provider: 'google', size: '640x400' });

    // The same door again re-fetches the image — the bytes are never kept, because Google's ToS
    // §3.2.3 forbids caching Street View imagery. Only the (expressly exempt) panorama id is
    // remembered, so the second request skips the free metadata call and nothing else.
    const again = await sv(`/api/households/${door}/streetview`, volunteerCookie);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(provider, [
      '/maps/api/streetview/metadata',
      '/maps/api/streetview',
      '/maps/api/streetview',
    ]);
  });

  it('returns an honest 404 where the provider has no imagery — common on concession roads', async () => {
    metaStatus = 'ZERO_RESULTS';
    const door = inTurf[2]!;
    const res = await sv(`/api/households/${door}/streetview`, volunteerCookie);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'no_imagery');
    // The billed image endpoint was never touched: no paying for a grey placeholder.
    assert.deepEqual(provider, ['/maps/api/streetview/metadata']);
    // Still audited: this door's coordinates did go to a third party, and the log must say so.
    assert.deepEqual(await auditFor(door), { available: false, provider: 'google' });
  });

  it('404s a door with no coordinates without sending anything anywhere', async () => {
    const legal = households.find((h) => h.household_id!.startsWith('H-LEGAL'))!.household_id!;
    const res = await sv(`/api/households/${legal}/streetview`, organizerCookie);
    assert.equal(res.statusCode, 404, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'no_imagery');
    assert.deepEqual(provider, []);
  });

  it('turns a provider failure into a 502, never into a broken image or a 500', async () => {
    metaStatus = 'REQUEST_DENIED'; // e.g. the key was revoked or billing lapsed
    const res = await sv(`/api/households/${inTurf[0]}/streetview`, organizerCookie);
    assert.equal(res.statusCode, 502, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'streetview_unavailable');
    // The provider's own status stays in the log; the volunteer at the door gets a generic message.
    assert.doesNotMatch(res.body, /REQUEST_DENIED/);
  });
});

// ------------------------------------------------------------------ Phase 5: messaging

/**
 * Opt-in SMS and email.
 *
 * Nothing in here sends a message: `MESSAGING_PROVIDER` is unset, so the stack runs on the `log`
 * provider and the last inch is a log line. That is not a limitation of the tests, it is the
 * property under test — the default configuration of this system writes the send rows and puts
 * nothing on the wire, and a second app instance below is built with a `fetch` that throws to
 * prove the send path never reaches for one.
 *
 * What is actually under test is the set of brakes that make the feature safe to switch on: SMS
 * priority and dedupe so nobody is messaged twice, approval before sending, a ceiling on the
 * audience, a consent re-check at dequeue rather than at queue time, quiet hours, daily caps, and
 * STOP honoured from a number that matches nothing at all.
 */
describe('messaging (opt-in SMS and email)', () => {
  interface MsgCtx {
    community: string;
    /** Households in that community, in id order; [0] and [1] share a phone number. */
    hh: string[];
    voters: string[];
    contacts: Record<string, string>;
    totalElectors: number;
    numberId: string;
    campaignId: string;
    organizerId: string;
  }
  const m = {} as MsgCtx;

  /** A second stack: audience ceiling of one, a webhook token, and a `fetch` that must never run. */
  let msgApp: FastifyInstance;
  let fetchCalls = 0;
  const WEBHOOK_TOKEN = 'test-webhook-token-0123456789';

  const provider = (): LogProvider => app.messaging.provider as LogProvider;

  /** A Tuesday, 14:00 in Toronto — comfortably inside the weekday window. */
  const WEEKDAY_AFTERNOON = new Date('2026-09-08T18:00:00Z');
  /** A Sunday, 07:00 in Toronto — before even the weekday window opens. */
  const SUNDAY_DAWN = new Date('2026-09-06T11:00:00Z');

  const form = (target: FastifyInstance, url: string, fields: Record<string, string>) =>
    target.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(fields).toString(),
    });

  const newCampaign = async (body: Record<string, unknown>): Promise<string> => {
    const res = await call('POST', '/api/messaging/campaigns', organizerCookie, body);
    assert.equal(res.statusCode, 201, res.body);
    const id = (res.json() as { campaign: { id: string } }).campaign.id;
    createdCampaignIds.push(id);
    return id;
  };

  const sendRows = async (campaignId: string) =>
    (
      await db.query<{ id: string; status: string; skip_reason: string | null; channel: string; value: string }>(
        `SELECT ms.id, ms.status::text AS status, ms.skip_reason, ms.channel::text AS channel, vc.value
         FROM message_send ms JOIN voter_contact vc ON vc.id = ms.voter_contact_id
         WHERE ms.campaign_id = $1 ORDER BY vc.value`,
        [campaignId],
      )
    ).rows;

  before(async () => {
    m.organizerId = (await db.query<{ id: string }>(`SELECT id FROM app_user WHERE email = $1`, [email('org')]))
      .rows[0]!.id;

    // A community no other part of this run has touched, so the audience counts below are exactly
    // the rows this block creates and nothing else.
    const busy = (
      await db.query<{ community: string }>(
        `SELECT DISTINCT h.community FROM voter_contact vc JOIN household h ON h.id = vc.household_id
         WHERE h.community IS NOT NULL`,
      )
    ).rows.map((r) => r.community);
    const pick = await db.query<{ community: string }>(
      `SELECT h.community
       FROM household h JOIN voter v ON v.household_id = h.id
       WHERE h.community IS NOT NULL AND NOT (h.community = ANY($1::text[]))
       GROUP BY h.community
       HAVING count(DISTINCT h.id) >= 4
       ORDER BY count(DISTINCT h.id) DESC
       LIMIT 1`,
      [busy],
    );
    assert.ok(pick.rows[0], 'need a community with four contact-free households');
    m.community = pick.rows[0].community;

    const hh = await db.query<{ id: string; voter_id: string }>(
      `SELECT h.id, (SELECT v.id FROM voter v WHERE v.household_id = h.id ORDER BY v.id LIMIT 1) AS voter_id
       FROM household h
       WHERE h.community = $1 AND EXISTS (SELECT 1 FROM voter v WHERE v.household_id = h.id)
       ORDER BY h.id LIMIT 4`,
      [m.community],
    );
    assert.equal(hh.rows.length, 4);
    m.hh = hh.rows.map((r) => r.id);
    m.voters = hh.rows.map((r) => r.voter_id);
    m.totalElectors = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM voter v JOIN household h ON h.id = v.household_id WHERE h.community = $1`,
        [m.community],
      )
    ).rows[0]!.n;

    const contact = async (
      i: number,
      channel: 'phone' | 'email',
      value: string,
      gotv: boolean,
      updates: boolean,
    ): Promise<string> => {
      const row = await db.query<{ id: string }>(
        `INSERT INTO voter_contact (voter_id, household_id, channel, value, consent_gotv, consent_updates,
                                    consent_note, collected_by)
         VALUES ($1, $2, $3::contact_channel, $4, $5, $6, 'agreed at the door on the test doorstep', $7)
         RETURNING id`,
        [m.voters[i], m.hh[i], channel, value, gotv, updates, m.organizerId],
      );
      return row.rows[0]!.id;
    };

    m.contacts = {
      // Two DIFFERENT households that gave the same number — a couple, or a number written down
      // twice. One message, not two.
      sharedA: await contact(0, 'phone', MSG_NUMBERS[0]!, true, false),
      sharedB: await contact(1, 'phone', MSG_NUMBERS[0]!, true, false),
      // Somebody who gave us both. SMS wins; the address is never also messaged.
      bothPhone: await contact(2, 'phone', MSG_NUMBERS[1]!, true, false),
      bothEmail: await contact(2, 'email', `both+${RUN}@test.local`, true, false),
      // Email only, and only for updates — so it proves BOTH that email is the fallback and that
      // consent is per purpose.
      updatesEmail: await contact(3, 'email', `updates+${RUN}@test.local`, false, true),
    };

    // Added INACTIVE. Everything up to the quiet-hours test must be able to queue without the
    // worker quietly draining the queue underneath the assertions.
    const num = await db.query<{ id: string }>(
      `INSERT INTO sender_number (e164, provider, label, daily_cap, active)
       VALUES ($1, 'log', 'test pool', 5, false) RETURNING id`,
      [MSG_NUMBERS[4]],
    );
    m.numberId = num.rows[0]!.id;
    createdSenderNumberIds.push(m.numberId);

    const config = loadConfig({
      DATABASE_URL,
      SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      DOMAIN: 'canvass.test',
      COOKIE_SECURE: 'false',
      BOUNDARY_PATH: resolve(DATA_DIR, 'mc_boundary.json'),
      SIGN_PHOTO_DIR: photoDir,
      MESSAGING_MAX_AUDIENCE: '1',
      MESSAGING_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      LOG_LEVEL: 'silent',
    });
    msgApp = await buildApp({
      config,
      db,
      // If any part of the send path reaches for the network, this fails the test rather than
      // billing somebody. No test may make a real, billed call.
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('a test tried to make a real outbound HTTP call');
      },
      logger: false,
    });
    await msgApp.ready();
  });

  after(async () => {
    await msgApp.close();
  });

  it('resolves SMS first, dedupes by number, and keeps the two consents apart', async () => {
    const res = await call(
      'GET',
      `/api/messaging/audience?purpose=gotv&community=${encodeURIComponent(m.community)}`,
      organizerCookie,
    );
    assert.equal(res.statusCode, 200, res.body);
    const gotv = res.json() as Record<string, number | null>;

    // Three consented phone rows across three households, but two of them are the SAME number:
    // that household pair is contacted once.
    assert.equal(gotv.sms, 2, 'the shared number is one message, not two');
    // The person who gave us both a phone and an email is an SMS recipient and is NOT also an
    // email one. One message per person per campaign, never two.
    assert.equal(gotv.email, 0, 'SMS wins; the address is not also messaged');
    assert.equal(gotv.total, m.totalElectors);
    assert.equal(gotv.unreachable, m.totalElectors - 3, 'three electors are covered by those two messages');

    // The email-only contact agreed to updates, not to GOTV, so it appears in one audience and
    // not the other. That is the whole reason migration 002 has two columns.
    const upd = await call(
      'GET',
      `/api/messaging/audience?purpose=updates&community=${encodeURIComponent(m.community)}`,
      organizerCookie,
    );
    const updates = upd.json() as Record<string, number | null>;
    assert.equal(updates.sms, 0);
    assert.equal(updates.email, 1);
  });

  it('reports the throughput ceiling honestly, and refuses volunteers', async () => {
    const res = await call(
      'GET',
      `/api/messaging/audience?purpose=gotv&community=${encodeURIComponent(m.community)}`,
      organizerCookie,
    );
    const a = res.json() as { sms: number; daily_capacity: number; estimated_days: number | null };
    // The pool number is still inactive, so there is no capacity and no honest estimate to give.
    assert.equal(a.daily_capacity, 0);
    assert.equal(a.estimated_days, null, 'null, not zero and not Infinity — the answer is unknown');

    await db.query(`UPDATE sender_number SET active = true WHERE id = $1`, [m.numberId]);
    const withPool = (
      await call('GET', `/api/messaging/audience?purpose=gotv&community=${encodeURIComponent(m.community)}`, organizerCookie)
    ).json() as { sms: number; daily_capacity: number; estimated_days: number };
    assert.equal(withPool.daily_capacity, 5);
    assert.equal(withPool.estimated_days, Math.ceil(withPool.sms / 5));
    await db.query(`UPDATE sender_number SET active = false WHERE id = $1`, [m.numberId]);

    assert.equal((await call('GET', '/api/messaging/audience?purpose=gotv', volunteerCookie)).statusCode, 403);

    const audited = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'view_audience' AND user_id = $1`,
      [m.organizerId],
    );
    assert.ok(audited.rows[0]!.n >= 3, 'every audience read is audited');
  });

  it('counts segments and names the character that would triple the bill', async () => {
    const res = await call('POST', '/api/messaging/segments', volunteerCookie, {
      text: 'Polls close at 8pm — don’t forget!',
    });
    assert.equal(res.statusCode, 200, res.body);
    const info = res.json() as { segments: number; encoding: string; offending: string[] };
    assert.equal(info.encoding, 'UCS-2');
    assert.deepEqual(info.offending, ['—', '’']);
    assert.equal(info.segments, 1);
  });

  it('refuses to send a campaign nobody approved', async () => {
    m.campaignId = await newCampaign({
      name: 'GOTV reminder (test)',
      purpose: 'gotv',
      body_sms: 'Election day is Monday. Polls open 10am to 8pm. Reply STOP to opt out.',
      audience: { community: [m.community] },
    });

    const res = await call('POST', `/api/messaging/campaigns/${m.campaignId}/send`, organizerCookie);
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'not_approved');

    assert.equal((await sendRows(m.campaignId)).length, 0, 'nothing was queued');
    const status = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM message_campaign WHERE id = $1`,
      [m.campaignId],
    );
    assert.equal(status.rows[0]!.status, 'draft', 'a campaign cannot leave draft without an approver');
  });

  it('refuses an audience over MESSAGING_MAX_AUDIENCE unless the request overrides it', async () => {
    const create = await msgApp.inject({
      method: 'POST',
      url: '/api/messaging/campaigns',
      headers: { cookie: organizerCookie },
      payload: {
        name: 'Too big (test)',
        purpose: 'gotv',
        body_sms: 'This one is larger than the ceiling allows.',
        audience: { community: [m.community] },
      },
    });
    assert.equal(create.statusCode, 201, create.body);
    const id = (create.json() as { campaign: { id: string } }).campaign.id;
    createdCampaignIds.push(id);

    const approve = await msgApp.inject({
      method: 'POST',
      url: `/api/messaging/campaigns/${id}/approve`,
      headers: { cookie: organizerCookie },
    });
    assert.equal(approve.statusCode, 200, approve.body);

    const blocked = await msgApp.inject({
      method: 'POST',
      url: `/api/messaging/campaigns/${id}/send`,
      headers: { cookie: organizerCookie },
      payload: {},
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal((blocked.json() as { error: { code: string } }).error.code, 'audience_too_large');
    assert.equal((await sendRows(id)).length, 0, 'the guard queued nothing at all');

    const overridden = await msgApp.inject({
      method: 'POST',
      url: `/api/messaging/campaigns/${id}/send`,
      headers: { cookie: organizerCookie },
      payload: { override_max_audience: true },
    });
    assert.equal(overridden.statusCode, 200, overridden.body);
    assert.equal((overridden.json() as { queued: number }).queued, 2);
    // Cancel it again so it cannot compete for the number pool in the tests below.
    const cancelled = await msgApp.inject({
      method: 'POST',
      url: `/api/messaging/campaigns/${id}/cancel`,
      headers: { cookie: organizerCookie },
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    const rows = await sendRows(id);
    assert.ok(
      rows.every((r) => r.status === 'skipped' && r.skip_reason === 'cancelled'),
      'cancelling skips the unsent rows with a reason rather than deleting them',
    );
  });

  it('approve is its own call, freezes the draft, and then send queues one row per recipient', async () => {
    const approve = await call('POST', `/api/messaging/campaigns/${m.campaignId}/approve`, organizerCookie);
    assert.equal(approve.statusCode, 200, approve.body);
    const approved = (approve.json() as { campaign: Record<string, unknown> }).campaign;
    assert.equal(approved.approved_by, m.organizerId);
    assert.ok(approved.approved_at);
    assert.equal(approved.status, 'draft', 'approval does not itself start a send');

    // An approved campaign is frozen: approve something harmless, then swap the body, must not work.
    const edit = await call('PATCH', `/api/messaging/campaigns/${m.campaignId}`, organizerCookie, {
      body_sms: 'Something entirely different.',
    });
    assert.equal(edit.statusCode, 409, edit.body);
    assert.equal((edit.json() as { error: { code: string } }).error.code, 'already_approved');

    const send = await call('POST', `/api/messaging/campaigns/${m.campaignId}/send`, organizerCookie);
    assert.equal(send.statusCode, 200, send.body);
    assert.equal((send.json() as { queued: number }).queued, 2);

    const rows = await sendRows(m.campaignId);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.status), ['queued', 'queued']);
    assert.deepEqual(rows.map((r) => r.value), [MSG_NUMBERS[0], MSG_NUMBERS[1]]);
    assert.equal(provider().sent.length, 0, 'queuing sends nothing by itself');

    // Sending twice must not queue twice: the UNIQUE key and the status guard both hold.
    const again = await call('POST', `/api/messaging/campaigns/${m.campaignId}/send`, organizerCookie);
    assert.equal(again.statusCode, 409, again.body);
    assert.equal((await sendRows(m.campaignId)).length, 2);
  });

  it('waits for quiet hours rather than sending at 07:00 on a Sunday', async () => {
    await db.query(`UPDATE sender_number SET active = true, sent_today = 0 WHERE id = $1`, [m.numberId]);
    const before = provider().sent.length;

    const result = await app.messaging.worker.drain({ at: SUNDAY_DAWN, limit: 10 });
    assert.equal(result.stopped, 'quiet_hours');
    assert.equal(result.sent, 0);
    // 07:00 on a Sunday: the weekend window does not open until 10:00 local (14:00 UTC).
    assert.equal(result.next_attempt_at?.toISOString(), '2026-09-06T14:00:00.000Z');
    assert.equal(provider().sent.length, before, 'nothing left the building');
    assert.ok(
      (await sendRows(m.campaignId)).every((r) => r.status === 'queued'),
      'the rows are still queued — waiting, not dropped',
    );
  });

  it('re-checks withdrawal at DEQUEUE: a Saturday STOP skips a Friday queue', async () => {
    // The queue above was built while this number was consented. Now the person withdraws — as a
    // STOP reply would do — and the message that is already sitting in the queue must not go.
    await db.query(`UPDATE voter_contact SET withdrawn_at = now() WHERE channel = 'phone' AND value = $1`, [
      MSG_NUMBERS[0],
    ]);

    const before = provider().sent.length;
    const result = await app.messaging.worker.drain({ at: WEEKDAY_AFTERNOON, limit: 10 });
    assert.equal(result.stopped, 'empty');
    assert.equal(result.sent, 1);
    assert.equal(result.skipped, 1);

    const rows = await sendRows(m.campaignId);
    const withdrawn = rows.find((r) => r.value === MSG_NUMBERS[0])!;
    assert.equal(withdrawn.status, 'skipped', 'skipped, not sent');
    assert.equal(withdrawn.skip_reason, 'withdrawn');
    assert.equal(rows.find((r) => r.value === MSG_NUMBERS[1])!.status, 'sent');

    // Exactly one message, to the one number that had not withdrawn.
    const outbound = provider().sent.slice(before);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]!.to, MSG_NUMBERS[1]);
    assert.equal(outbound[0]!.from, MSG_NUMBERS[4], 'it went out on a number from the pool');

    // Nothing queued left → the campaign finished on its own.
    const done = await db.query<{ status: string }>(
      `SELECT status::text AS status FROM message_campaign WHERE id = $1`,
      [m.campaignId],
    );
    assert.equal(done.rows[0]!.status, 'done');
  });

  it('runs on the log provider, which writes the rows and sends nothing', async () => {
    // The default configuration of this system cannot text anybody: MESSAGING_PROVIDER is unset.
    assert.equal(app.messaging.provider.name, 'log');
    assert.ok(app.messaging.provider instanceof LogProvider);
    // The send above marked a row `sent` with a provider id and a segment count — the whole
    // pipeline ran — and no HTTP request was made by either app instance.
    const sent = await db.query<{ provider_message_id: string; segments: number }>(
      `SELECT provider_message_id, segments FROM message_send WHERE campaign_id = $1 AND status = 'sent'`,
      [m.campaignId],
    );
    assert.equal(sent.rows.length, 1);
    assert.match(sent.rows[0]!.provider_message_id, /^log:/);
    assert.equal(sent.rows[0]!.segments, 1);
    assert.equal(fetchCalls, 0, 'no test made a real, billed call');
  });

  it('stops when a number has used its daily cap, leaving the rest queued for tomorrow', async () => {
    // Put the pool at its ceiling. Over the cap a Canadian long code drops messages SILENTLY, so
    // the only safe behaviour is to stop.
    await db.query(`UPDATE sender_number SET sent_today = daily_cap WHERE id = $1`, [m.numberId]);
    await db.query(`UPDATE voter_contact SET withdrawn_at = NULL WHERE channel = 'phone' AND value = $1`, [
      MSG_NUMBERS[0],
    ]);

    const id = await newCampaign({
      name: 'Capped (test)',
      purpose: 'gotv',
      body_sms: 'A second reminder that will not fit inside today’s cap.',
      audience: { community: [m.community] },
    });
    assert.equal((await call('POST', `/api/messaging/campaigns/${id}/approve`, organizerCookie)).statusCode, 200);
    assert.equal((await call('POST', `/api/messaging/campaigns/${id}/send`, organizerCookie)).statusCode, 200);

    const before = provider().sent.length;
    const result = await app.messaging.worker.drain({ at: WEEKDAY_AFTERNOON, limit: 10 });
    assert.equal(result.stopped, 'no_capacity');
    assert.equal(result.sent, 0);
    assert.equal(provider().sent.length, before, 'nothing was posted into the void');
    assert.ok(
      (await sendRows(id)).every((r) => r.status === 'queued'),
      'the messages wait for the cap to roll over; they are not failed and not dropped',
    );

    // Pause / resume / cancel, on the campaign that is now stalled behind the cap.
    assert.equal((await call('POST', `/api/messaging/campaigns/${id}/pause`, organizerCookie)).statusCode, 200);
    assert.equal((await call('POST', `/api/messaging/campaigns/${id}/pause`, organizerCookie)).statusCode, 409);
    const paused = await app.messaging.worker.drain({ at: WEEKDAY_AFTERNOON, limit: 10 });
    assert.equal(paused.sent, 0, 'a paused campaign is invisible to the worker');
    assert.equal((await call('POST', `/api/messaging/campaigns/${id}/resume`, organizerCookie)).statusCode, 200);
    assert.equal((await call('POST', `/api/messaging/campaigns/${id}/cancel`, organizerCookie)).statusCode, 200);
    assert.ok((await sendRows(id)).every((r) => r.skip_reason === 'cancelled'));
  });

  it('lists campaigns with progress counted off the send rows', async () => {
    const res = await call('GET', '/api/messaging/campaigns', organizerCookie);
    assert.equal(res.statusCode, 200, res.body);
    const { campaigns } = res.json() as {
      campaigns: Array<{ id: string; progress: Record<string, number>; sms_encoding: string }>;
    };
    const mine = campaigns.find((c) => c.id === m.campaignId)!;
    // `sent` and `delivered` are separate counts, not cumulative — a `sent` pile that never turns
    // into `delivered` is the signature of a carrier silently eating the send.
    assert.deepEqual(mine.progress, { total: 2, queued: 0, sent: 1, delivered: 0, failed: 0, skipped: 1 });
    assert.equal(mine.sms_encoding, 'GSM-7');
  });

  it('turns a delivery receipt into `delivered`, which is how a silent throttle is detected', async () => {
    const row = (
      await db.query<{ provider_message_id: string }>(
        `SELECT provider_message_id FROM message_send WHERE campaign_id = $1 AND status = 'sent'`,
        [m.campaignId],
      )
    ).rows[0]!;
    const res = await form(app, '/api/messaging/status', {
      MessageSid: row.provider_message_id,
      MessageStatus: 'delivered',
    });
    assert.equal(res.statusCode, 200, res.body);
    const after = await db.query<{ status: string; delivered_at: Date | null }>(
      `SELECT status::text AS status, delivered_at FROM message_send WHERE provider_message_id = $1`,
      [row.provider_message_id],
    );
    assert.equal(after.rows[0]!.status, 'delivered');
    assert.ok(after.rows[0]!.delivered_at);
  });

  it('sends a test message to one number, bypassing the audience entirely', async () => {
    const before = provider().sent.length;
    const res = await call('POST', `/api/messaging/campaigns/${m.campaignId}/test`, organizerCookie, {
      to: '(519) 555-0203',
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { sent: boolean; provider: string; segments: number; encoding: string };
    assert.equal(body.sent, true);
    assert.equal(body.provider, 'log');
    assert.equal(body.encoding, 'GSM-7');

    const outbound = provider().sent.slice(before);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0]!.to, MSG_NUMBERS[2], 'the typed number was normalised to E.164');
    const auditedTest = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'test_send' AND target = $1`,
      [m.campaignId],
    );
    assert.equal(auditedTest.rows[0]!.n, 1, 'a test send is still a real send, and audited');
    // Nothing was queued: a test bypasses the audience and the message_send table entirely.
    assert.equal((await sendRows(m.campaignId)).length, 2);
  });

  it('honours STOP from a number that matches nothing, and still records it', async () => {
    const unknown = MSG_NUMBERS[3]!;
    const res = await form(app, '/api/messaging/inbound', { From: unknown, Body: ' stop ', MessageSid: `SM-${RUN}-1` });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { ok: true, action: 'stop', matched: 0 });

    const inbound = await db.query<{ action: string; matched_contact_id: string | null }>(
      `SELECT action::text AS action, matched_contact_id FROM message_inbound WHERE from_e164 = $1`,
      [unknown],
    );
    assert.equal(inbound.rows.length, 1, 'a person telling us to stop is recorded whether we know them or not');
    assert.equal(inbound.rows[0]!.action, 'stop');
    assert.equal(inbound.rows[0]!.matched_contact_id, null);

    const audited = await db.query<{ detail: { matched: number; from_known: boolean } }>(
      `SELECT detail FROM audit_log WHERE action = 'inbound_stop' ORDER BY id DESC LIMIT 1`,
    );
    assert.deepEqual(audited.rows[0]!.detail, { matched: 0, from_known: false });

    // A carrier retrying its webhook must not produce a second confirmation text.
    const replay = await form(app, '/api/messaging/inbound', { From: unknown, Body: 'STOP', MessageSid: `SM-${RUN}-1` });
    assert.equal((replay.json() as { duplicate?: boolean }).duplicate, true);
  });

  it('STOP from a known number stamps every matching contact, in any spelling', async () => {
    const res = await form(app, '/api/messaging/inbound', {
      From: MSG_NUMBERS[0]!,
      Body: 'Arrêt',
      MessageSid: `SM-${RUN}-2`,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { matched: number }).matched, 2, 'both households that share the number');

    const rows = await db.query<{ withdrawn_at: Date | null; withdrawn_note: string | null }>(
      `SELECT withdrawn_at, withdrawn_note FROM voter_contact WHERE channel = 'phone' AND value = $1`,
      [MSG_NUMBERS[0]],
    );
    assert.equal(rows.rows.length, 2);
    assert.ok(rows.rows.every((r) => r.withdrawn_at !== null && r.withdrawn_note === 'replied STOP by SMS'));
    // The row STAYS: a deleted row is simply re-collected at the next canvass.
    assert.ok(rows.rows.length > 0);

    // And they drop straight out of the send list.
    const audience = (
      await call('GET', `/api/messaging/audience?purpose=gotv&community=${encodeURIComponent(m.community)}`, organizerCookie)
    ).json() as { sms: number };
    assert.equal(audience.sms, 1);
  });

  it('JOIN confirms an outstanding self-serve request and records what was agreed to', async () => {
    const CONSENT = 'Yes, text me reminders about voting in the 2026 Middlesex Centre election.';
    await db.query(
      `INSERT INTO subscribe_pending (e164, token, wants_gotv, wants_updates, consent_text, source)
       VALUES ($1, $2, true, true, $3, 'web')`,
      [MSG_NUMBERS[0], `tok-${RUN}`, CONSENT],
    );

    const res = await form(app, '/api/messaging/inbound', {
      From: MSG_NUMBERS[0]!,
      Body: 'YES',
      MessageSid: `SM-${RUN}-3`,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { action: string }).action, 'join');

    const pending = await db.query<{ confirmed_at: Date | null }>(
      `SELECT confirmed_at FROM subscribe_pending WHERE token = $1`,
      [`tok-${RUN}`],
    );
    assert.ok(pending.rows[0]!.confirmed_at, 'the pending request is confirmed by the handset itself');

    const contacts = await db.query<{ consent_gotv: boolean; consent_updates: boolean; consent_note: string; withdrawn_at: Date | null }>(
      `SELECT consent_gotv, consent_updates, consent_note, withdrawn_at
       FROM voter_contact WHERE channel = 'phone' AND value = $1`,
      [MSG_NUMBERS[0]],
    );
    for (const c of contacts.rows) {
      assert.equal(c.consent_gotv, true);
      assert.equal(c.consent_updates, true);
      // A consent record that cannot say what was agreed to is not a consent record.
      assert.equal(c.consent_note, CONSENT);
      // Their own text, timestamped by the carrier, is the one thing that lifts a withdrawal.
      assert.equal(c.withdrawn_at, null);
    }
  });

  it('answers HELP with who we are and how to stop', async () => {
    const before = provider().sent.length;
    const res = await form(app, '/api/messaging/inbound', {
      From: MSG_NUMBERS[3]!,
      Body: 'help',
      MessageSid: `SM-${RUN}-4`,
    });
    assert.equal(res.statusCode, 200, res.body);
    const reply = provider().sent.slice(before);
    assert.equal(reply.length, 1);
    assert.match(reply[0]!.body, /Reply STOP to unsubscribe/);
  });

  it('rejects a webhook without the configured shared secret', async () => {
    const res = await form(msgApp, '/api/messaging/inbound', { From: MSG_NUMBERS[3]!, Body: 'STOP' });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'invalid_webhook_token');
    const ok = await form(msgApp, `/api/messaging/inbound?token=${WEBHOOK_TOKEN}`, {
      From: MSG_NUMBERS[3]!,
      Body: 'STOP',
      MessageSid: `SM-${RUN}-5`,
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('subscribes opaquely, never texts a number that withdrew, and is rate limited by IP', async () => {
    const CONSENT = 'I agree to receive text messages about voting from this campaign.';
    // A number that said STOP is silently ignored — but the caller cannot tell, because that would
    // turn the public form into an oracle over the campaign's contact list.
    await db.query(`UPDATE voter_contact SET withdrawn_at = now() WHERE channel = 'phone' AND value = $1`, [
      MSG_NUMBERS[1],
    ]);
    const beforeWithdrawn = provider().sent.length;
    const ignored = await app.inject({
      method: 'POST',
      url: '/api/subscribe',
      payload: { phone: MSG_NUMBERS[1], consent_text: CONSENT },
    });
    assert.equal(ignored.statusCode, 202, ignored.body);
    assert.equal(provider().sent.length, beforeWithdrawn, 'no confirmation text to somebody who said stop');
    const none = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM subscribe_pending WHERE e164 = $1`, [
      MSG_NUMBERS[1],
    ]);
    assert.equal(none.rows[0]!.n, 0);

    // A fresh number gets a pending row and exactly one confirmation.
    const fresh = MSG_NUMBERS[5]!;
    const before = provider().sent.length;
    const first = await app.inject({
      method: 'POST',
      url: '/api/subscribe',
      payload: { phone: '519-555-0299', wants_gotv: true, consent_text: CONSENT },
    });
    assert.equal(first.statusCode, 202, first.body);
    // Byte-identical to the response for the withdrawn number: the endpoint reveals nothing.
    assert.deepEqual(first.json(), ignored.json());
    const pending = await db.query<{ consent_text: string; wants_gotv: boolean }>(
      `SELECT consent_text, wants_gotv FROM subscribe_pending WHERE e164 = $1`,
      [fresh],
    );
    assert.equal(pending.rows.length, 1);
    assert.equal(pending.rows[0]!.consent_text, CONSENT, 'stored verbatim, never summarised');
    const outbound = provider().sent.slice(before);
    assert.equal(outbound.length, 1);
    assert.match(outbound[0]!.body, /reply YES to confirm/i);
    // Consent does NOT exist yet — only a reply from the handset creates it.
    assert.equal(pending.rows[0]!.wants_gotv, true);

    // A second request for the same number does not text it again.
    const repeat = await app.inject({
      method: 'POST',
      url: '/api/subscribe',
      payload: { phone: fresh, consent_text: CONSENT },
    });
    assert.equal(repeat.statusCode, 202);
    assert.equal(provider().sent.length, before + 1, 'one confirmation per outstanding request');

    // Hard per-IP limit: this endpoint spends money and buzzes strangers' phones.
    let limited = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/subscribe',
        payload: { phone: fresh, consent_text: CONSENT },
      });
      if (res.statusCode === 429) limited += 1;
    }
    assert.ok(limited > 0, 'the public subscribe form is rate limited by IP');
  });

  it('requires a session for every messaging route except the public and webhook ones', async () => {
    for (const [method, url] of [
      ['GET', '/api/messaging/audience?purpose=gotv'],
      ['GET', '/api/messaging/campaigns'],
      ['POST', '/api/messaging/campaigns'],
      ['POST', '/api/messaging/segments'],
      ['GET', '/api/messaging/numbers'],
      ['POST', '/api/messaging/numbers'],
    ] as const) {
      const res = await app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  it('manages the number pool, and reports the pool capacity that caps everything', async () => {
    const create = await call('POST', '/api/messaging/numbers', organizerCookie, {
      e164: '(519) 555-0204',
      label: 'second line',
      daily_cap: 120,
    });
    assert.equal(create.statusCode, 201, create.body);
    const num = (create.json() as { number: { id: string; e164: string; daily_cap: number } }).number;
    createdSenderNumberIds.push(num.id);
    assert.equal(num.e164, MSG_NUMBERS[3]);
    assert.equal(num.daily_cap, 120);
    assert.equal((await call('POST', '/api/messaging/numbers', organizerCookie, { e164: '5195550204' })).statusCode, 409);

    const patched = await call('PATCH', `/api/messaging/numbers/${num.id}`, organizerCookie, { active: false });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal((patched.json() as { number: { active: boolean } }).number.active, false);

    const list = await call('GET', '/api/messaging/numbers', organizerCookie);
    const body = list.json() as { numbers: Array<{ id: string }>; daily_capacity: number };
    assert.ok(body.numbers.some((n) => n.id === num.id));
    assert.equal(typeof body.daily_capacity, 'number');
    assert.equal((await call('GET', '/api/messaging/numbers', volunteerCookie)).statusCode, 403);
  });
});
