import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../db.js';

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'accept_invite'
  | 'change_password'
  | 'view_household'
  | 'search'
  | 'invite'
  | 'reinvite'
  | 'update_user'
  | 'export'
  | 'import'
  // Phase 2 — canvassing
  | 'create_turf'
  | 'update_turf'
  | 'delete_turf'
  | 'assign_turf'
  | 'unassign_turf'
  | 'update_assignment'
  | 'view_turf_doors'
  | 'view_follow_ups'
  | 'contact';

export interface AuditEntry {
  userId: string | null;
  action: AuditAction;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Append one row to audit_log. Awaited by the caller so the entry is written before the
 * response goes out, but a failure to audit never turns into a 500 for the user — it is
 * logged at error level instead (the request is still served; ops must watch the log).
 */
export async function audit(db: Queryable, log: FastifyBaseLogger, e: AuditEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, action, target, detail, ip) VALUES ($1, $2, $3, $4, $5)`,
      [e.userId, e.action, e.target ?? null, e.detail ? JSON.stringify(e.detail) : null, normalizeIp(e.ip)],
    );
  } catch (err) {
    log.error({ err, audit: e }, 'audit write failed');
  }
}

/** pg inet rejects "::ffff:1.2.3.4"-with-port and some proxy forms; keep it simple and safe. */
function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}
