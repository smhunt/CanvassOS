import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth } from '../auth/guard.js';
import { hashPassword, hashToken, verifyPassword } from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  destroyOtherSessions,
  destroySession,
  setSessionCookie,
} from '../auth/session.js';
import { MIN_PASSWORD } from '../config.js';
import { one } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, gone, unauthorized } from '../lib/errors.js';
import { serializeUser, type Role } from '../lib/serialize.js';

const loginBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1024),
});

const acceptInviteBody = z.object({
  token: z.string().min(16).max(128),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(MIN_PASSWORD, `password must be at least ${MIN_PASSWORD} characters`).max(1024),
});

const changePasswordBody = z.object({
  current: z.string().min(1).max(1024),
  next: z.string().min(MIN_PASSWORD, `password must be at least ${MIN_PASSWORD} characters`).max(1024),
});

interface UserAuthRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  password_hash: string | null;
}

const RATE_LIMIT_10_PER_MIN = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const authRoutes: FastifyPluginAsync = async (app) => {
  const secure = app.config.COOKIE_SECURE;

  // POST /api/auth/login
  app.post('/login', { config: RATE_LIMIT_10_PER_MIN }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const user = await one<UserAuthRow>(
      app.db,
      `SELECT id, email, name, role, active, password_hash FROM app_user WHERE email = $1`,
      [body.email],
    );
    const ok = await verifyPassword(user?.password_hash ?? null, body.password);
    if (!user || !ok || !user.active) {
      await audit(app.db, req.log, {
        userId: user?.id ?? null,
        action: 'login_failed',
        target: body.email.toLowerCase(),
        ip: req.ip,
      });
      throw unauthorized('invalid email or password', 'invalid_credentials');
    }
    const sid = await createSession(app.db, user.id, req);
    await app.db.query(`UPDATE app_user SET last_login_at = now() WHERE id = $1`, [user.id]);
    await audit(app.db, req.log, { userId: user.id, action: 'login', ip: req.ip });
    setSessionCookie(reply, sid, secure);
    return { user: serializeUser(user) };
  });

  // POST /api/auth/logout
  app.post('/logout', async (req, reply) => {
    if (req.session) {
      await destroySession(app.db, req.session.id);
      await audit(app.db, req.log, { userId: req.session.user.id, action: 'logout', ip: req.ip });
    }
    clearSessionCookie(reply, secure);
    return reply.status(204).send();
  });

  // GET /api/auth/me
  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const { user } = currentSession(req);
    return { user: serializeUser(user) };
  });

  // POST /api/auth/accept-invite
  app.post('/accept-invite', { config: RATE_LIMIT_10_PER_MIN }, async (req, reply) => {
    const body = acceptInviteBody.parse(req.body);
    const tokenHash = hashToken(body.token);
    const user = await one<UserAuthRow & { invite_expires: Date | null }>(
      app.db,
      `SELECT id, email, name, role, active, password_hash, invite_expires
       FROM app_user WHERE invite_token = $1`,
      [tokenHash],
    );
    if (!user || !user.invite_expires || user.invite_expires.getTime() < Date.now()) {
      throw gone('this invite link is invalid, expired, or has already been used', 'invite_invalid');
    }
    if (!user.active) throw gone('this account has been deactivated', 'invite_invalid');

    const hash = await hashPassword(body.password);
    await app.db.query(
      `UPDATE app_user
       SET name = $2, password_hash = $3, invite_token = NULL, invite_expires = NULL, last_login_at = now()
       WHERE id = $1`,
      [user.id, body.name, hash],
    );
    // A (re)invite doubles as a password reset: drop any old sessions.
    await app.db.query(`DELETE FROM session WHERE user_id = $1`, [user.id]);
    const sid = await createSession(app.db, user.id, req);
    await audit(app.db, req.log, { userId: user.id, action: 'accept_invite', ip: req.ip });
    await audit(app.db, req.log, { userId: user.id, action: 'login', detail: { via: 'invite' }, ip: req.ip });
    setSessionCookie(reply, sid, secure);
    return { user: serializeUser({ ...user, name: body.name }) };
  });

  // POST /api/auth/change-password
  app.post('/change-password', { preHandler: requireAuth }, async (req, reply) => {
    const body = changePasswordBody.parse(req.body);
    const sess = currentSession(req);
    const row = await one<{ password_hash: string | null }>(
      app.db,
      `SELECT password_hash FROM app_user WHERE id = $1`,
      [sess.user.id],
    );
    if (!(await verifyPassword(row?.password_hash ?? null, body.current))) {
      throw badRequest('current password is incorrect', 'wrong_password');
    }
    if (body.current === body.next) throw badRequest('new password must differ from the current one', 'same_password');
    const hash = await hashPassword(body.next);
    await app.db.query(`UPDATE app_user SET password_hash = $2 WHERE id = $1`, [sess.user.id, hash]);
    await destroyOtherSessions(app.db, sess.user.id, sess.id);
    await audit(app.db, req.log, { userId: sess.user.id, action: 'change_password', ip: req.ip });
    return reply.status(204).send();
  });
};
