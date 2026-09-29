import type { FastifyPluginAsync } from 'fastify';
import { currentSession, requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { adviseOnReachability } from '../lib/advice.js';
import { audit } from '../lib/audit.js';

interface TotalsRow {
  households: number;
  voters: number;
  residents: number;
  nonresidents: number;
  institutions: number;
  legal: number;
  po_box_only: number;
}
interface WardRow {
  ward: string;
  households: number;
  voters: number;
  nonresidents: number;
  avg_voters_per_door: number;
}
interface CommunityRow {
  community: string;
  households: number;
  voters: number;
  nonresidents: number;
}
interface QualityRow {
  good: number;
  approx: number;
  legal: number;
  check: number;
}
interface SizeRow {
  size: string;
  households: number;
}
interface CanvassRow {
  contacted_households: number;
  contacts_today: number;
  contacts_7d: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
}

// ---------------------------------------------------------------- coverage

/**
 * One group's progress. `attempted` and `spoke` are cumulative and per DOOR — a follow-up
 * `not_home` after a `spoke` must not un-reach the door — while the stance is the LATEST support
 * recorded at each door, so two visits to one supporter count once. The overview's `support_hist`
 * counts visits; this report is about doors, and the two are deliberately not the same number.
 */
interface CoverageRow {
  households: number;
  voters: number;
  attempted: number;
  spoke: number;
  contacts: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  follow_up: number;
}
interface CoverageWardRow extends CoverageRow {
  ward: string;
}
interface CoverageCommunityRow extends CoverageRow {
  community: string;
}
interface CoverageTurfRow extends CoverageRow {
  turf_id: string;
  name: string;
  ward: string | null;
  archived: boolean;
}
/** A day has no denominator — it is cadence, not coverage — so its support is visits, not doors. */
interface CoverageDayRow {
  day: string;
  contacts: number;
  doors: number;
  spoke: number;
  canvassers: number;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
}

/**
 * Per-household facts every grouping is built from, computed once per query so the ward, community
 * and turf tables cannot disagree about what "attempted" means. `stance` is the newest non-null
 * support; `follow_up` is read off the newest visit, the same rule as GET /api/follow-ups.
 */
const COVERAGE_HH = `
  hh AS (
    SELECT h.id, h.ward, h.community, h.n_voters,
           coalesce(c.n, 0) AS contacts, coalesce(c.spoke, false) AS spoke,
           s.support AS stance, coalesce(l.follow_up, false) AS follow_up
    FROM household h
    LEFT JOIN (SELECT household_id, count(*)::int AS n, bool_or(result = 'spoke') AS spoke
               FROM contact GROUP BY household_id) c ON c.household_id = h.id
    LEFT JOIN LATERAL (SELECT support FROM contact WHERE household_id = h.id AND support IS NOT NULL
                       ORDER BY at DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT follow_up FROM contact WHERE household_id = h.id
                       ORDER BY at DESC LIMIT 1) l ON true
  )`;
const COVERAGE_AGG = `
  count(hh.id)::int AS households,
  coalesce(sum(hh.n_voters), 0)::int AS voters,
  count(*) FILTER (WHERE hh.contacts > 0)::int AS attempted,
  count(*) FILTER (WHERE hh.spoke)::int AS spoke,
  coalesce(sum(hh.contacts), 0)::int AS contacts,
  count(*) FILTER (WHERE hh.stance = 1)::int AS s1,
  count(*) FILTER (WHERE hh.stance = 2)::int AS s2,
  count(*) FILTER (WHERE hh.stance = 3)::int AS s3,
  count(*) FILTER (WHERE hh.stance = 4)::int AS s4,
  count(*) FILTER (WHERE hh.stance = 5)::int AS s5,
  count(*) FILTER (WHERE hh.follow_up)::int AS follow_up`;

const coverageOut = <T extends CoverageRow>({ s1, s2, s3, s4, s5, ...rest }: T) => ({ ...rest, support: [s1, s2, s3, s4, s5] });

// ---------------------------------------------------------------- reachability

/** One household's blockers, flattened so the categories can be counted and de-duplicated in TS. */
interface ReachRow {
  ward: string | null;
  is_legal: boolean;
  is_institution: boolean;
  unmapped: boolean;
  bad_geocode: boolean;
  po_box_only: boolean;
  last_result: string | null;
  n_voters: number;
}
/** Which way of reaching somebody a category actually rules out. "Unreachable" is not one thing. */
type Blocks = ('door' | 'mail' | 'gatekeeper')[];

interface ClassRow {
  ward: string | null;
  resident_class: string;
  n: number;
}

/**
 * Why part of the list cannot be knocked.
 *
 * Two different kinds of unreachable, and conflating them would give bad advice. **Structural**
 * blockers come off the list itself and are knowable before anyone leaves the house — no civic
 * address, an owner who lives in Toronto, a care home. **Behavioural** ones are what a canvasser
 * learned at the door, and they are a property of the visit, not the record.
 *
 * Every category also says WHICH CHANNEL it blocks, because "unreachable" is not one thing. A PO-box
 * mailing address (306 households here) blocks addressed mail and nothing else — the door is
 * perfectly knockable — so folding it into a single "unreachable" number would report 390 blocked
 * doors where there are 73. For a candidate deciding where six weeks go, that is the expensive
 * direction to be wrong in.
 *
 * `no_map_point` is the parent of `legal_description` and `geocode_failed`, not a peer: here it is
 * exactly 70 + 3. Categories are counted independently and `combined` is de-duplicated, so nothing
 * is ever the sum of the rows above it.
 *
 * Aggregates only: no name, address or id is in this response, which is what makes it safe to hand
 * to an advice layer later (see ADVICE_* in config) without the voters list leaving the stack.
 */

/** GET /api/stats/overview — organizer/admin. */
export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/overview', { preHandler: requireRole('organizer') }, async () => {
    const [totals, byWard, byCommunity, quality, sizes, canvass] = await Promise.all([
      one<TotalsRow>(
        app.db,
        // nonresidents/residents come from voter.resident_class (the household n_nonresident
        // column from the pipeline also counts the 4 'unknown' voters).
        // po_box_only = doors where every voter gets mail at a PO box (no street mail at all).
        `SELECT (SELECT count(*)::int FROM household) AS households,
                (SELECT count(*)::int FROM voter) AS voters,
                (SELECT count(*)::int FROM voter WHERE resident_class = 'resident') AS residents,
                (SELECT count(*)::int FROM voter WHERE resident_class = 'non-resident') AS nonresidents,
                (SELECT count(*)::int FROM household WHERE is_institution) AS institutions,
                (SELECT count(*)::int FROM household WHERE is_legal) AS legal,
                (SELECT count(*)::int FROM household WHERE n_voters > 0 AND n_po_box >= n_voters) AS po_box_only`,
      ),
      q<WardRow>(
        app.db,
        `SELECT h.ward, count(*)::int AS households, coalesce(sum(h.n_voters), 0)::int AS voters,
                (SELECT count(*)::int FROM voter v WHERE v.ward = h.ward AND v.resident_class = 'non-resident') AS nonresidents,
                round(avg(h.n_voters)::numeric, 2)::float AS avg_voters_per_door
         FROM household h GROUP BY h.ward ORDER BY h.ward`,
      ),
      q<CommunityRow>(
        app.db,
        `SELECT h.community, count(*)::int AS households, coalesce(sum(h.n_voters), 0)::int AS voters,
                (SELECT count(*)::int FROM voter v JOIN household h2 ON h2.id = v.household_id
                  WHERE h2.community = h.community AND v.resident_class = 'non-resident') AS nonresidents
         FROM household h WHERE h.community IS NOT NULL
         GROUP BY h.community ORDER BY households DESC, h.community`,
      ),
      one<QualityRow>(
        app.db,
        `SELECT count(*) FILTER (WHERE record_quality = 'good')::int   AS good,
                count(*) FILTER (WHERE record_quality = 'approx')::int AS approx,
                count(*) FILTER (WHERE record_quality = 'legal')::int  AS legal,
                count(*) FILTER (WHERE record_quality = 'check')::int  AS "check"
         FROM household`,
      ),
      q<SizeRow>(
        app.db,
        // size is a label: "1".."5" and "6+" (API.md: 1,2,3,4,5,6+)
        `SELECT CASE WHEN n_voters >= 6 THEN '6+' ELSE n_voters::text END AS size,
                count(*)::int AS households
         FROM household GROUP BY 1 ORDER BY min(n_voters)`,
      ),
      one<CanvassRow>(
        app.db,
        `SELECT (SELECT count(DISTINCT household_id)::int FROM contact) AS contacted_households,
                (SELECT count(*)::int FROM contact WHERE at >= date_trunc('day', now())) AS contacts_today,
                (SELECT count(*)::int FROM contact WHERE at >= now() - interval '7 days') AS contacts_7d,
                (SELECT count(*)::int FROM contact WHERE support = 1) AS s1,
                (SELECT count(*)::int FROM contact WHERE support = 2) AS s2,
                (SELECT count(*)::int FROM contact WHERE support = 3) AS s3,
                (SELECT count(*)::int FROM contact WHERE support = 4) AS s4,
                (SELECT count(*)::int FROM contact WHERE support = 5) AS s5`,
      ),
    ]);

    const c = canvass ?? { contacted_households: 0, contacts_today: 0, contacts_7d: 0, s1: 0, s2: 0, s3: 0, s4: 0, s5: 0 };
    return {
      totals: totals ?? {
        households: 0,
        voters: 0,
        residents: 0,
        nonresidents: 0,
        institutions: 0,
        legal: 0,
        po_box_only: 0,
      },
      by_ward: byWard,
      by_community: byCommunity,
      quality: quality ?? { good: 0, approx: 0, legal: 0, check: 0 },
      household_size: sizes,
      canvass: {
        contacted_households: c.contacted_households,
        contacts_today: c.contacts_today,
        contacts_7d: c.contacts_7d,
        support_hist: [c.s1, c.s2, c.s3, c.s4, c.s5],
      },
    };
  });

  app.get('/reachability', { preHandler: requireRole('organizer') }, async (req) => {
    const [rows, classes] = await Promise.all([
      q<ReachRow>(
        app.db,
        `SELECT h.ward, h.is_legal, h.is_institution,
                h.lat IS NULL AS unmapped,
                h.record_quality = 'check' AS bad_geocode,
                (h.n_voters > 0 AND h.n_po_box >= h.n_voters) AS po_box_only,
                h.n_voters,
                c.result::text AS last_result
         FROM household h
         LEFT JOIN LATERAL (
           SELECT result FROM contact WHERE household_id = h.id ORDER BY at DESC LIMIT 1
         ) c ON true`,
        [],
      ),
      q<ClassRow>(
        app.db,
        `SELECT ward, resident_class, count(*)::int AS n FROM voter GROUP BY 1, 2`,
        [],
      ),
    ]);

    const households = rows.length;
    const voters = rows.reduce((a, r) => a + (r.n_voters ?? 0), 0);
    const wards = [...new Set(rows.map((r) => r.ward).filter((w): w is string => !!w))].sort();

    // A category is a predicate plus the denominator it should be read against. Keeping the
    // denominator with the predicate is what stops "5% of doors" being quietly compared with
    // "5% of electors" further down the page.
    type Cat = { code: string; kind: string; blocks: Blocks; parent?: string; test: (r: ReachRow) => boolean };
    const householdCats: Cat[] = [
      { code: 'no_map_point', kind: 'structural', blocks: ['door'], test: (r) => r.unmapped },
      { code: 'legal_description', kind: 'structural', blocks: ['door'], parent: 'no_map_point', test: (r) => r.is_legal },
      { code: 'geocode_failed', kind: 'structural', blocks: ['door'], parent: 'no_map_point', test: (r) => r.bad_geocode },
      { code: 'institution', kind: 'structural', blocks: ['gatekeeper'], test: (r) => r.is_institution },
      // Blocks addressed MAIL only. The door is knockable — see the note above about why this must
      // not be folded into a door count.
      { code: 'po_box_only', kind: 'structural', blocks: ['mail'], test: (r) => r.po_box_only },
      { code: 'do_not_knock', kind: 'behavioural', blocks: ['door', 'mail'], test: (r) => r.last_result === 'do_not_knock' },
      { code: 'inaccessible', kind: 'behavioural', blocks: ['door'], test: (r) => r.last_result === 'inaccessible' },
      { code: 'moved', kind: 'behavioural', blocks: ['door', 'mail'], test: (r) => r.last_result === 'moved' },
      { code: 'deceased', kind: 'behavioural', blocks: ['door', 'mail'], test: (r) => r.last_result === 'deceased' },
      { code: 'refused', kind: 'behavioural', blocks: ['door'], test: (r) => r.last_result === 'refused' },
    ];

    const byWardCount = (test: (r: ReachRow) => boolean) => {
      const m = new Map<string, number>();
      for (const w of wards) m.set(w, 0);
      for (const r of rows) if (r.ward && test(r)) m.set(r.ward, (m.get(r.ward) ?? 0) + 1);
      return m;
    };
    const wardTotals = byWardCount(() => true);

    const categories = householdCats.map((c) => {
      const count = rows.filter(c.test).length;
      const per = byWardCount(c.test);
      return {
        code: c.code,
        kind: c.kind,
        blocks: c.blocks,
        parent: c.parent ?? null,
        scope: 'household' as const,
        count,
        share: households ? count / households : 0,
        by_ward: wards.map((w) => {
          const n = per.get(w) ?? 0;
          const total = wardTotals.get(w) ?? 0;
          return { ward: w, count: n, share: total ? n / total : 0 };
        }),
      };
    });

    // Electors, not doors: a non-resident owner is one person on the list, and the household they
    // own may have residents on it too. Counting these as households would double-count the door.
    const voterTotal = classes.reduce((a, c) => a + c.n, 0);
    const voterWardTotal = new Map<string, number>();
    for (const c of classes) if (c.ward) voterWardTotal.set(c.ward, (voterWardTotal.get(c.ward) ?? 0) + c.n);
    for (const cls of ['non-resident', 'unknown']) {
      const hits = classes.filter((c) => c.resident_class === cls);
      const count = hits.reduce((a, c) => a + c.n, 0);
      categories.push({
        code: cls === 'non-resident' ? 'non_resident' : 'class_unknown',
        kind: 'structural',
        // The door exists and someone may well answer it — but not this elector, who lives
        // elsewhere. Reachable by mail or phone at the address the clerk has, not by knocking here.
        blocks: ['door'] as Blocks,
        parent: null,
        scope: 'voter' as unknown as 'household',
        count,
        share: voterTotal ? count / voterTotal : 0,
        by_ward: wards.map((w) => {
          const n = hits.filter((h) => h.ward === w).reduce((a, c) => a + c.n, 0);
          const total = voterWardTotal.get(w) ?? 0;
          return { ward: w, count: n, share: total ? n / total : 0 };
        }),
      });
    }

    // De-duplicated, and door-only: how many doors genuinely cannot be knocked. po_box_only is
    // excluded because it blocks mail, not the door — including it would report 390 here instead of
    // 73. Institutions are excluded too: that door can be knocked, it just goes through a manager.
    const noDoor = (r: ReachRow) => r.is_legal || r.unmapped || r.bad_geocode;
    const blocked = rows.filter(noDoor).length;
    const mailOnlyBlocked = rows.filter((r) => r.po_box_only).length;

    // Aggregates only, and the shape of what is sent is fixed here rather than by the advice layer:
    // it gets counts, never the rows they came from. Null when no key is configured, and null on
    // any failure — the numbers are the product and must render either way.
    const advice = await adviseOnReachability(
      {
        households,
        voters,
        blocked,
        mail_blocked: mailOnlyBlocked,
        facts: categories.map((c) => ({
          code: c.code,
          kind: c.kind,
          blocks: c.blocks,
          scope: c.scope,
          count: c.count,
          share: c.share,
        })),
      },
      app.config,
      req.log,
      app.httpFetch,
    );

    await audit(app.db, req.log, {
      userId: currentSession(req).user.id,
      action: 'view_reachability',
      detail: { households, blocked, advice: advice !== null },
      ip: req.ip,
    });

    return {
      totals: { households, voters, wards },
      categories,
      combined: {
        households_blocked: blocked,
        share: households ? blocked / households : 0,
        mail_blocked: mailOnlyBlocked,
        mail_share: households ? mailOnlyBlocked / households : 0,
      },
      advice,
    };
  });

  /**
   * GET /api/stats/coverage — organizer/admin. Where the canvass has been, by ward, community, turf
   * and day, and how support is spread in each. Aggregates only, same class as /reachability: no
   * name, address or id of a door leaves here (turf names and ids are campaign objects, not list
   * data). A door in two turfs counts towards both — that is each turf's own progress.
   */
  app.get('/coverage', { preHandler: requireRole('organizer') }, async (req) => {
    const [byWard, byCommunity, byTurf, byDay, canvassers] = await Promise.all([
      q<CoverageWardRow>(app.db, `WITH ${COVERAGE_HH} SELECT hh.ward, ${COVERAGE_AGG} FROM hh GROUP BY hh.ward ORDER BY hh.ward`),
      q<CoverageCommunityRow>(
        app.db,
        // Mirrors /overview: legal descriptions have no community and are left out of this table.
        `WITH ${COVERAGE_HH} SELECT hh.community, ${COVERAGE_AGG} FROM hh WHERE hh.community IS NOT NULL
         GROUP BY hh.community ORDER BY households DESC, hh.community`,
      ),
      q<CoverageTurfRow>(
        app.db,
        `WITH ${COVERAGE_HH}
         SELECT t.id AS turf_id, t.name, t.ward, t.archived, ${COVERAGE_AGG}
         FROM turf t
         LEFT JOIN turf_household th ON th.turf_id = t.id
         LEFT JOIN hh ON hh.id = th.household_id
         GROUP BY t.id, t.name, t.ward, t.archived
         ORDER BY t.archived, t.ward NULLS LAST, t.name`,
      ),
      q<CoverageDayRow>(
        app.db,
        // Ontario calendar days, as /activity counts them, so the two tabs agree on "today".
        `SELECT to_char((at AT TIME ZONE 'America/Toronto')::date, 'YYYY-MM-DD') AS day,
                count(*)::int AS contacts,
                count(DISTINCT household_id)::int AS doors,
                count(DISTINCT household_id) FILTER (WHERE result = 'spoke')::int AS spoke,
                count(DISTINCT user_id)::int AS canvassers,
                count(*) FILTER (WHERE support = 1)::int AS s1,
                count(*) FILTER (WHERE support = 2)::int AS s2,
                count(*) FILTER (WHERE support = 3)::int AS s3,
                count(*) FILTER (WHERE support = 4)::int AS s4,
                count(*) FILTER (WHERE support = 5)::int AS s5
         FROM contact GROUP BY 1 ORDER BY 1`,
      ),
      one<{ n: number }>(app.db, `SELECT count(DISTINCT user_id)::int AS n FROM contact`),
    ]);

    // Every household has a ward, so the ward table sums to the municipality.
    const sum = (k: keyof CoverageRow) => byWard.reduce((a, r) => a + r[k], 0);
    const totals = {
      households: sum('households'),
      voters: sum('voters'),
      attempted: sum('attempted'),
      spoke: sum('spoke'),
      contacts: sum('contacts'),
      support: [sum('s1'), sum('s2'), sum('s3'), sum('s4'), sum('s5')],
      follow_up: sum('follow_up'),
      canvassers: canvassers?.n ?? 0,
      first_day: byDay[0]?.day ?? null,
      last_day: byDay[byDay.length - 1]?.day ?? null,
    };

    await audit(app.db, req.log, {
      userId: currentSession(req).user.id,
      action: 'view_coverage',
      detail: { households: totals.households, attempted: totals.attempted, turfs: byTurf.length },
      ip: req.ip,
    });

    return {
      totals,
      by_ward: byWard.map(coverageOut),
      by_community: byCommunity.map(coverageOut),
      by_turf: byTurf.map(coverageOut),
      by_day: byDay.map(({ s1, s2, s3, s4, s5, ...d }) => ({ ...d, support: [s1, s2, s3, s4, s5] })),
    };
  });
};
