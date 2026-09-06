import type { FastifyBaseLogger } from 'fastify';
import type { Queryable } from '../db.js';

export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'accept_invite'
  | 'change_password'
  | 'view_household'
  // Looking at a photograph of somebody's front door is a read of that door, and it is also the
  // one action in this API that sends anything at all to a third party — so it is audited like any
  // other read of personal data, with a note of whether the bytes came from cache or from Google.
  | 'view_streetview'
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
  | 'contact'
  // Lawn signs
  | 'place_sign'
  | 'update_sign'
  | 'delete_sign'
  | 'view_sign_photo'
  | 'upload_sign_photo'
  // GET /api/signs/requests reads doors off the voters list, so it audits like any other
  // personal-data read; the rest of /api/signs is campaign logistics and does not.
  | 'view_sign_requests'
  // Phone / email collected at the door (voter_contact). Everything here touches data the person
  // handed over under a consent, so every read AND every change to that consent is recorded — the
  // consent is only defensible if we can say what was agreed, when, and who took or changed it.
  | 'collect_voter_contact'
  | 'view_voter_contacts'
  | 'update_voter_contact'
  | 'withdraw_voter_contact'
  | 'delete_voter_contact'
  | 'view_gotv_list'
  // Phase 5 — messaging. Every one of these either sends something to a real person or changes
  // whether we may, so the trail has to answer "who authorised this, and when" without needing
  // the provider's own logs. Note that the two `inbound_*` and `subscribe_request` rows carry a
  // NULL user_id: nobody on the campaign did them, the recipient did — and that is the whole
  // point of recording them, because a consent or a withdrawal is only defensible if we can show
  // when it arrived. As everywhere else in this API, the audit detail never carries the phone
  // number or address itself; audit_log would otherwise become a second, un-withdrawable copy.
  | 'view_audience'
  | 'create_campaign'
  | 'update_campaign'
  | 'approve_campaign'
  | 'send_campaign'
  | 'pause_campaign'
  | 'resume_campaign'
  | 'cancel_campaign'
  | 'test_send'
  | 'create_sender_number'
  | 'update_sender_number'
  | 'inbound_stop'
  | 'inbound_join'
  | 'subscribe_request';

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
