import type { FastifyPluginAsync } from 'fastify';
import type { BuildInfo } from '../build.js';
import { one } from '../db.js';

/**
 * GET /api/health → { ok, db, import_id, version, commit, env } — no auth; used by the compose
 * healthcheck, and by the deploy workflow to show what it just put live.
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { logLevel: 'warn' }, async (_req, reply) => {
    try {
      const row = await one<{ import_id: number | null }>(
        app.db,
        `SELECT max(id) AS import_id FROM import_run WHERE finished_at IS NOT NULL`,
      );
      return { ok: true, db: true, import_id: row?.import_id ?? null, ...publicBuild(app.build) };
    } catch (err) {
      app.log.error({ err }, 'health: database unreachable');
      return reply.status(503).send({ ok: false, db: false, import_id: null, ...publicBuild(app.build) });
    }
  });
};

/** Version, commit and environment only: the build time stays behind sign-in on /api/meta. */
function publicBuild(b: BuildInfo): Pick<BuildInfo, 'version' | 'commit' | 'env'> {
  return { version: b.version, commit: b.commit, env: b.env };
}
