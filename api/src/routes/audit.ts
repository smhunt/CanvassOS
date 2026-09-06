import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/guard.js';
import { q } from '../db.js';

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  before: z.coerce.number().int().positive().optional(),
  user_id: z.string().uuid().optional(),
  action: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
});

interface AuditRow {
  id: number;
  at: Date;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

/** GET /api/audit?limit=200&before=<id> — admin. Newest first; page with `before` = smallest id seen. */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get('/audit', { preHandler: requireRole('admin') }, async (req) => {
    const qp = auditQuery.parse(req.query);
    const params: unknown[] = [qp.limit];
    const where: string[] = [];
    if (qp.before !== undefined) {
      params.push(qp.before);
      where.push(`a.id < $${params.length}`);
    }
    if (qp.user_id) {
      params.push(qp.user_id);
      where.push(`a.user_id = $${params.length}`);
    }
    if (qp.action) {
      params.push(qp.action);
      where.push(`a.action = $${params.length}`);
    }
    const entries = await q<AuditRow>(
      app.db,
      `SELECT a.id, a.at, a.user_id, u.email AS user_email, u.name AS user_name,
              a.action, a.target, a.detail, host(a.ip) AS ip
       FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.id DESC
       LIMIT $1`,
      params,
    );
    return { entries };
  });
};
