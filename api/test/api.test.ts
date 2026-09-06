/**
 * Integration tests — run against the test database AFTER the importer has loaded it:
 *
 *   python3 importer/import.py --voters data/voters_final.csv --households data/households.csv \
 *       --label test --database-url postgresql://canvass:canvass@localhost:5443/canvass
 *   cd api && npm test
 *
 * The suite TRUNCATES app_user / session / audit_log on the test DB (it needs a known admin).
 * Expected numbers are computed from the CSVs in ../data so the tests follow the data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'csv-parse/sync';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db.js';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgresql://canvass:canvass@localhost:5443/canvass';
const DATA_DIR = process.env.CANVASS_DATA_DIR ?? resolve(import.meta.dirname, '../../data');
const ADMIN_EMAIL = 'admin@test.local';
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
const nWithCoords = households.filter((h) => h.lat).length;
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

before(async () => {
  db = createPool(DATABASE_URL);
  const n = await db.query('SELECT count(*)::int AS n FROM household');
  assert.ok(n.rows[0].n > 0, 'household table is empty — run the importer against the test DB first');
  await db.query('TRUNCATE app_user, session, audit_log CASCADE');

  const config = loadConfig({
    DATABASE_URL,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    DOMAIN: 'canvass.test',
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    COOKIE_SECURE: 'false',
    BOUNDARY_PATH: resolve(DATA_DIR, 'mc_boundary.json'),
    LOG_LEVEL: 'silent',
  });
  app = await buildApp({ config, db, logger: false });
  await app.ready();

  const a = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  adminCookie = a.cookie!;
  volunteerCookie = await inviteAndAccept('vol@test.local', 'volunteer', 'volunteer-pass-1');
  organizerCookie = await inviteAndAccept('org@test.local', 'organizer', 'organizer-pass-1');
});

after(async () => {
  await app.close();
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
      payload: { email: 'once@test.local', name: 'Once', role: 'volunteer' },
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
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { active: false },
    });
    assert.equal(patch.statusCode, 409);
    assert.equal((patch.json() as { error: { code: string } }).error.code, 'last_admin');
  });

  it('volunteers and organizers get 403 on /api/users', async () => {
    for (const cookie of [volunteerCookie, organizerCookie]) {
      const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
      assert.equal(res.statusCode, 403);
    }
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
    assert.equal(body.communities.reduce((s, c) => s + c.n_households, 0), households.length - nLegal);
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
    assert.equal(fc.features.length, households.length - nLegal);
    assert.equal(fc.features.length, nWithCoords);
    assert.equal(fc.features.length, 7069);
    const p = fc.features[0]!.properties;
    assert.deepEqual(Object.keys(p).sort(), ['community', 'id', 'inst', 'n', 'nonres', 'q', 'status', 'ward']);
    const [lon, lat] = fc.features[0]!.geometry.coordinates as [number, number];
    assert.ok(lon < -80 && lon > -82 && lat > 42 && lat < 44, 'coordinates are lon,lat in Middlesex');
  });

  it('volunteer projection lacks the restricted keys', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/households/points', headers: { cookie: volunteerCookie } });
    assert.equal(res.statusCode, 200);
    const fc = res.json() as { features: Array<{ properties: Record<string, unknown> }> };
    assert.equal(fc.features.length, 7069);
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
    assert.equal(card.voters[0]!.display_name, known.voter_names.split('; ')[0]);
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
        payload: { email: 'nobody@test.local', password: 'wrong-password-x' },
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
