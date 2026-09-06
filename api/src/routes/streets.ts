import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/guard.js';
import { q } from '../db.js';

const streetsQuery = z.object({
  ward: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
  community: z
    .string()
    .regex(/^[A-Z' .-]{1,30}$/i)
    .transform((s) => s.toUpperCase())
    .optional(),
});

interface StreetRow {
  street_sort: string;
  street: string;
  street_type: string | null;
  street_dir: string | null;
  ward: string;
  community: string | null;
  n_households: number;
  n_voters: number;
  min_num: number | null;
  max_num: number | null;
}

/** "STONE FIELD" + "LN" + null → "Stone Field Ln" (display only; street_sort is the key). */
function label(r: StreetRow): string {
  const title = (s: string) =>
    s
      .toLowerCase()
      .replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
      .replace(/\bMc([a-z])/g, (_m, ch: string) => `Mc${ch.toUpperCase()}`);
  return [title(r.street), r.street_type ? title(r.street_type) : null, r.street_dir]
    .filter(Boolean)
    .join(' ');
}

/** GET /api/streets?ward=&community= — organizer/admin. One row per street × ward × community. */
export const streetRoutes: FastifyPluginAsync = async (app) => {
  app.get('/streets', { preHandler: requireRole('organizer') }, async (req) => {
    const qp = streetsQuery.parse(req.query);
    const params: unknown[] = [];
    const where = ['h.street_sort IS NOT NULL'];
    if (qp.ward) {
      params.push(qp.ward);
      where.push(`h.ward = $${params.length}`);
    }
    if (qp.community) {
      params.push(qp.community);
      where.push(`h.community = $${params.length}`);
    }
    const rows = await q<StreetRow>(
      app.db,
      `SELECT h.street_sort, min(h.street) AS street, min(h.street_type) AS street_type, min(h.street_dir) AS street_dir,
              h.ward, h.community,
              count(*)::int AS n_households, coalesce(sum(h.n_voters), 0)::int AS n_voters,
              min(h.num_sort) AS min_num, max(h.num_sort) AS max_num
       FROM household h
       WHERE ${where.join(' AND ')}
       GROUP BY h.street_sort, h.ward, h.community
       ORDER BY h.street_sort, h.ward, h.community`,
      params,
    );
    return {
      streets: rows.map((r) => ({
        street_sort: r.street_sort,
        label: label(r),
        ward: r.ward,
        community: r.community,
        n_households: r.n_households,
        n_voters: r.n_voters,
        min_num: r.min_num,
        max_num: r.max_num,
      })),
    };
  });
};
