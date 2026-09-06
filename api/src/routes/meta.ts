import type { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireAuth } from '../auth/guard.js';
import { one, q } from '../db.js';

interface WardRow {
  ward: string;
  n_households: number;
  n_voters: number;
}
interface CommunityRow {
  community: string;
  n_households: number;
  n_voters: number;
}
interface ImportRow {
  id: number;
  source_label: string;
  finished_at: Date;
  n_voters: number;
  n_households: number;
}

/** Load the municipal boundary (GeoJSON Polygon, or the Feature wrapping one) once. */
async function loadBoundary(path: string, log: { warn: (o: unknown, m: string) => void }): Promise<unknown> {
  try {
    const raw = JSON.parse(await readFile(resolve(path), 'utf8')) as {
      type?: string;
      geometry?: unknown;
      features?: Array<{ geometry?: unknown }>;
    };
    if (raw.type === 'Feature') return raw.geometry ?? null;
    if (raw.type === 'FeatureCollection') return raw.features?.[0]?.geometry ?? null;
    return raw;
  } catch (err) {
    log.warn({ err, path }, 'boundary file not readable; /api/meta will return boundary: null');
    return null;
  }
}

/** GET /api/meta → wards, communities, latest import, boundary polygon. Any logged-in role. */
export const metaRoutes: FastifyPluginAsync = async (app) => {
  const boundary = await loadBoundary(app.config.BOUNDARY_PATH, app.log);

  app.get('/meta', { preHandler: requireAuth }, async () => {
    const [wards, communities, imp] = await Promise.all([
      q<WardRow>(
        app.db,
        `SELECT ward, count(*)::int AS n_households, coalesce(sum(n_voters), 0)::int AS n_voters
         FROM household GROUP BY ward ORDER BY ward`,
      ),
      q<CommunityRow>(
        app.db,
        `SELECT community, count(*)::int AS n_households, coalesce(sum(n_voters), 0)::int AS n_voters
         FROM household WHERE community IS NOT NULL GROUP BY community ORDER BY n_households DESC, community`,
      ),
      one<ImportRow>(
        app.db,
        `SELECT id, source_label, finished_at, n_voters, n_households
         FROM import_run WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
      ),
    ]);
    return { wards, communities, import: imp ?? null, boundary };
  });
};
