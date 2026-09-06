import type { FastifyPluginAsync } from 'fastify';
import { one } from '../db.js';

/** GET /api/health → { ok, db, import_id } — no auth; used by the compose healthcheck. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { logLevel: 'warn' }, async (_req, reply) => {
    try {
      const row = await one<{ import_id: number | null }>(
        app.db,
        `SELECT max(id) AS import_id FROM import_run WHERE finished_at IS NOT NULL`,
      );
      return { ok: true, db: true, import_id: row?.import_id ?? null };
    } catch (err) {
      app.log.error({ err }, 'health: database unreachable');
      return reply.status(503).send({ ok: false, db: false, import_id: null });
    }
  });
};
