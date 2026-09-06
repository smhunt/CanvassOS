import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireRole } from '../auth/guard.js';
import { hashToken, newInviteToken } from '../auth/password.js';
import { INVITE_DAYS } from '../config.js';
import { one, q, withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import type { Role } from '../lib/serialize.js';

const roleSchema = z.enum(['admin', 'organizer', 'volunteer']);

const inviteBody = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(200),
  role: roleSchema,
});

const patchBody = z
  .object({
    role: roleSchema.optional(),
    active: z.boolean().optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => b.role !== undefined || b.active !== undefined || b.name !== undefined, {
    message: 'nothing to update',
  });

const idParams = z.object({ id: z.string().uuid() });

interface UserListRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  created_at: Date;
  last_login_at: Date | null;
  invite_pending: boolean;
}

const USER_SELECT = `
  SELECT id, email, name, role, active, created_at, last_login_at,
         (password_hash IS NULL AND invite_token IS NOT NULL) AS invite_pending
  FROM app_user`;

export const userRoutes: FastifyPluginAsync = async (app) => {
  const adminOnly = requireRole('admin');
  const inviteUrl = (token: string): string => `https://${app.config.DOMAIN}/invite/${token}`;

  // GET /api/users
  app.get('/', { preHandler: adminOnly }, async () => {
    const users = await q<UserListRow>(app.db, `${USER_SELECT} ORDER BY created_at, email`);
    return { users };
  });

  // POST /api/users/invite → 201 { user, invite_url }
  app.post('/invite', { preHandler: adminOnly }, async (req, reply) => {
    const body = inviteBody.parse(req.body);
    const admin = currentSession(req).user;
    const token = newInviteToken();
    const user = await withTx(app.db, async (tx) => {
      const exists = await one<{ id: string }>(tx, `SELECT id FROM app_user WHERE email = $1`, [body.email]);
      if (exists) throw conflict('a user with this email already exists', 'email_exists');
      const created = await one<UserListRow>(
        tx,
        `WITH ins AS (
           INSERT INTO app_user (email, name, role, invite_token, invite_expires)
           VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
           RETURNING *
         )
         SELECT id, email, name, role, active, created_at, last_login_at,
                (password_hash IS NULL AND invite_token IS NOT NULL) AS invite_pending
         FROM ins`,
        [body.email, body.name, body.role, hashToken(token), INVITE_DAYS],
      );
      if (!created) throw new Error('insert returned no row');
      return created;
    });
    await audit(app.db, req.log, {
      userId: admin.id,
      action: 'invite',
      target: user.id,
      detail: { email: user.email, role: user.role },
      ip: req.ip,
    });
    return reply.status(201).send({ user, invite_url: inviteUrl(token) });
  });

  // POST /api/users/:id/reinvite → { invite_url }  (also serves as an admin-driven password reset)
  app.post('/:id/reinvite', { preHandler: adminOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const admin = currentSession(req).user;
    const token = newInviteToken();
    const row = await one<{ id: string; email: string }>(
      app.db,
      `UPDATE app_user SET invite_token = $2, invite_expires = now() + make_interval(days => $3)
       WHERE id = $1 AND active RETURNING id, email`,
      [id, hashToken(token), INVITE_DAYS],
    );
    if (!row) throw notFound('user not found or inactive');
    await audit(app.db, req.log, {
      userId: admin.id,
      action: 'reinvite',
      target: id,
      detail: { email: row.email },
      ip: req.ip,
    });
    return { invite_url: inviteUrl(token) };
  });

  // PATCH /api/users/:id → { user }
  app.patch('/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const admin = currentSession(req).user;

    const user = await withTx(app.db, async (tx) => {
      const cur = await one<UserListRow>(tx, `${USER_SELECT} WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur) throw notFound('user not found');

      const nextRole = body.role ?? cur.role;
      const nextActive = body.active ?? cur.active;
      const losesAdmin = cur.role === 'admin' && cur.active && (nextRole !== 'admin' || !nextActive);
      if (losesAdmin) {
        const others = await one<{ n: number }>(
          tx,
          `SELECT count(*)::int AS n FROM app_user WHERE role = 'admin' AND active AND id <> $1`,
          [id],
        );
        if (!others || others.n === 0) {
          throw conflict('cannot deactivate or demote the last active admin', 'last_admin');
        }
      }

      const updated = await one<UserListRow>(
        tx,
        `WITH upd AS (
           UPDATE app_user SET role = $2, active = $3, name = $4 WHERE id = $1 RETURNING *
         )
         SELECT id, email, name, role, active, created_at, last_login_at,
                (password_hash IS NULL AND invite_token IS NOT NULL) AS invite_pending
         FROM upd`,
        [id, nextRole, nextActive, body.name ?? cur.name],
      );
      if (!updated) throw notFound('user not found');
      if (!nextActive) await tx.query(`DELETE FROM session WHERE user_id = $1`, [id]);
      return updated;
    });

    await audit(app.db, req.log, {
      userId: admin.id,
      action: 'update_user',
      target: id,
      detail: body,
      ip: req.ip,
    });
    return { user };
  });
};
