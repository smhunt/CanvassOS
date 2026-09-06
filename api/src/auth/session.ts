import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, SESSION_DAYS } from '../config.js';
import { one, type Queryable } from '../db.js';
import type { Role } from '../lib/serialize.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}

export interface CurrentSession {
  id: string;
  user: SessionUser;
}

interface SessionJoinRow {
  session_id: string;
  expires_at: Date;
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Insert a session row for the user; returns its id (= cookie value, signed by @fastify/cookie). */
export async function createSession(db: Queryable, userId: string, req: FastifyRequest): Promise<string> {
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO session (user_id, expires_at, user_agent, ip)
     VALUES ($1, now() + make_interval(days => $2), $3, $4::inet)
     RETURNING id`,
    [userId, SESSION_DAYS, (req.headers['user-agent'] ?? '').slice(0, 500), safeInet(req.ip)],
  );
  if (!row) throw new Error('session insert returned no row');
  return row.id;
}

/**
 * Resolve the signed cookie to a session + user. Implements the 30-day *sliding* expiry:
 * whenever less than 29 days remain, the expiry is pushed back out to 30 days (at most one
 * UPDATE per session per day — cheap).
 */
export async function loadSession(db: Queryable, req: FastifyRequest): Promise<CurrentSession | null> {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value || !UUID_RE.test(unsigned.value)) return null;
  const sid = unsigned.value;

  const row = await one<SessionJoinRow>(
    db,
    `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name, u.role, u.active
     FROM session s JOIN app_user u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sid],
  );
  if (!row || !row.active) return null;

  const msLeft = row.expires_at.getTime() - Date.now();
  if (msLeft < (SESSION_DAYS - 1) * 86_400_000) {
    // fire-and-forget; a lost bump is harmless
    void db
      .query(`UPDATE session SET expires_at = now() + make_interval(days => $2) WHERE id = $1`, [sid, SESSION_DAYS])
      .catch(() => undefined);
  }
  return {
    id: row.session_id,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active },
  };
}

export async function destroySession(db: Queryable, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM session WHERE id = $1`, [sessionId]);
}

/** Drop every other session of the user (after a password change). */
export async function destroyOtherSessions(db: Queryable, userId: string, keepSessionId: string): Promise<void> {
  await db.query(`DELETE FROM session WHERE user_id = $1 AND id <> $2`, [userId, keepSessionId]);
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    signed: true,
    maxAge: SESSION_DAYS * 86_400,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure, sameSite: 'lax' });
}

function safeInet(ip: string | undefined): string | null {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}
