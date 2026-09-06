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
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'csv-parse/sync';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';

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
  // Delete exactly what this run created, by id, in FK order. Never TRUNCATE: this database may
  // hold rows (users, turfs, contacts) that belong to somebody else.
  const ids = await testUserIds();
  if (ids.length > 0) {
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
