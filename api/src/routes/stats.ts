import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';

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
};
