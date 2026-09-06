/**
 * Phone numbers and email addresses collected AT THE DOOR (`voter_contact`, db/migrations/002).
 *
 * The clerk's list carries no phone numbers and no email addresses. Everything here was given
 * directly by the person standing at the door, for a purpose they were told about, so it is a
 * different kind of data from the list and it has different rules — which is why it is a separate
 * table and a separate route file rather than more columns on `voter`:
 *
 *   * consent is per purpose (`consent_gotv`, `consent_updates`), because a single "ok to contact"
 *     boolean cannot answer "did they agree to THIS?";
 *   * a value with no consent at all is refused (`400 consent_required`) — a number nobody agreed
 *     to us using is not something to keep;
 *   * withdrawal is recorded, never deleted: `withdrawn_at` is stamped and the row stays, because a
 *     deleted row is simply re-collected at the next canvass and the point is to remember that
 *     somebody asked us to stop;
 *   * the send list (`GET /gotv`) is the one thing here that would ever leave the system, so it is
 *     organizer/admin only and audited on every call.
 *
 * Canada's Anti-Spam Legislation governs the messages this data feeds. Recording WHAT was agreed,
 * WHEN and WHO took it is what makes the consent defensible if it is ever questioned — so the
 * consent state travels with the value everywhere (lib/serialize.ts), and every read and every
 * change of consent writes `audit_log`.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireAuth, requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertHouseholdAccess } from '../lib/scope.js';
import {
  serializeGotvContact,
  serializeVoterContact,
  type GotvContactRow,
  type VoterContactRow,
} from '../lib/serialize.js';

// contact_channel enum (db/migrations/002_voter_contact.sql)
const CHANNELS = ['phone', 'email'] as const;

const householdId = z.string().regex(/^H-[A-Z]+-\d{1,8}$/, 'invalid household id');
const idParams = z.object({ id: z.string().uuid() });

const createBody = z.object({
  household_id: householdId,
  // Nullable on purpose: "the number for the house" is a real answer at a door where nobody wants
  // to say which of them it belongs to.
  voter_id: z.string().uuid().nullish(),
  channel: z.enum(CHANNELS),
  value: z.string().trim().min(3).max(254),
  consent_gotv: z.boolean().nullish(),
  consent_updates: z.boolean().nullish(),
  consent_note: z.string().trim().max(500).nullish(),
  // The doorstep conversation this came out of, so the consent has a context.
  contact_id: z.string().uuid().nullish(),
});

const patchBody = z
  .object({
    consent_gotv: z.boolean().optional(),
    consent_updates: z.boolean().optional(),
    withdrawn: z.boolean().optional(),
    withdrawn_note: z.string().trim().max(500).nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });

const listQuery = z.object({ household_id: householdId });
const gotvQuery = z.object({
  channel: z.enum(CHANNELS).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});

// ---------------------------------------------------------------- normalisation

/**
 * North American numbering plan: area code and exchange both start 2–9. A string that fails this
 * is not a number anyone can dial, and storing it means a GOTV send that silently goes nowhere.
 */
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;

/**
 * Accept what a human writes on a clipboard — `(519) 555-0134`, `519.555.0134`, `+1 519 555 0134` —
 * and store one canonical form, because the UNIQUE key is on the stored value: the same number
 * offered twice in two formats must be the same row, not two.
 */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) {
    const national = digits.slice(-10);
    if (!NANP.test(national)) throw badRequest(`"${raw}" is not a dialable phone number`, 'invalid_phone');
    return `+1${national}`;
  }
  // An international number is possible (a student, a snowbird's cell) but it has to be given as
  // one: a bare seven- or nine-digit string is a typo, not a country code we should guess at.
  if (raw.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw badRequest(`"${raw}" is not a phone number we can use`, 'invalid_phone');
}

/** Deliberately stricter than "has an @": a typo'd address is a bounce, and bounces cost sender reputation. */
const EMAIL = /^[^\s@,;]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function normalizeEmail(raw: string): string {
  // Lower-cased so the UNIQUE key treats Sean@Example.ca and sean@example.ca as the one address.
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) throw badRequest(`"${raw}" is not a valid email address`, 'invalid_email');
  return value;
}

export function normalizeContactValue(channel: (typeof CHANNELS)[number], raw: string): string {
  return channel === 'phone' ? normalizePhone(raw) : normalizeEmail(raw);
}

// ---------------------------------------------------------------- SQL

const VC_COLS = `
  vc.id, vc.household_id, vc.voter_id, v.display_name AS voter_name, vc.channel::text AS channel, vc.value,
  vc.consent_gotv, vc.consent_updates, vc.consent_note, vc.consented_at,
  vc.collected_by, cu.name AS collected_by_name, vc.contact_id,
  vc.withdrawn_at, vc.withdrawn_note, vc.created_at`;

const VC_JOINS = `
  LEFT JOIN voter v ON v.id = vc.voter_id
  LEFT JOIN app_user cu ON cu.id = vc.collected_by`;

export const voterContactRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');

  /**
   * POST /api/voter-contacts → 201 { voter_contact }, or 200 when the door re-offered a value we
   * already hold (the consent flags are updated instead of 409 — somebody re-offering their number
   * is granting consent again, not making a mistake).
   */
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const me = currentSession(req).user;

    const consentGotv = body.consent_gotv ?? false;
    const consentUpdates = body.consent_updates ?? false;
    // The whole reason this table is separate from `voter`: a value with no purpose attached to it
    // is not ours to keep, so it is refused at the door rather than stored "just in case".
    if (!consentGotv && !consentUpdates) {
      throw badRequest(
        'a phone number or email may only be stored with consent for at least one purpose ' +
          '(consent_gotv or consent_updates)',
        'consent_required',
      );
    }

    const hh = await one<{ id: string }>(app.db, `SELECT id FROM household WHERE id = $1`, [body.household_id]);
    if (!hh) throw notFound('household not found');
    await assertHouseholdAccess(app.db, me.role, body.household_id, me.id);

    if (body.voter_id) {
      const v = await one<{ id: string }>(app.db, `SELECT id FROM voter WHERE id = $1 AND household_id = $2`, [
        body.voter_id,
        body.household_id,
      ]);
      if (!v) throw badRequest('voter_id does not belong to household_id', 'voter_not_in_household');
    }
    if (body.contact_id) {
      const c = await one<{ id: string }>(app.db, `SELECT id FROM contact WHERE id = $1 AND household_id = $2`, [
        body.contact_id,
        body.household_id,
      ]);
      if (!c) throw badRequest('contact_id is not a contact at this household', 'contact_not_found');
    }

    const value = normalizeContactValue(body.channel, body.value);

    // `xmax = 0` is true only for a row this statement inserted, which is how the 201/200 split is
    // decided without a second query. Consent flags are OR-ed on conflict: a re-offer grants, it
    // never silently revokes — revoking is what PATCH `withdrawn` is for, and it is recorded.
    // `withdrawn_at` is deliberately NOT cleared here: a door-side re-offer must not quietly undo
    // "please stop"; an organizer lifts it explicitly with PATCH { withdrawn: false }.
    const row = await one<VoterContactRow & { inserted: boolean }>(
      app.db,
      `WITH up AS (
         INSERT INTO voter_contact (voter_id, household_id, channel, value, consent_gotv, consent_updates,
                                    consent_note, consented_at, collected_by, contact_id)
         VALUES ($1, $2, $3::contact_channel, $4, $5, $6, $7, now(), $8, $9)
         ON CONFLICT (household_id, channel, value) DO UPDATE SET
           consent_gotv    = voter_contact.consent_gotv OR excluded.consent_gotv,
           consent_updates = voter_contact.consent_updates OR excluded.consent_updates,
           consent_note    = coalesce(excluded.consent_note, voter_contact.consent_note),
           consented_at    = now(),
           collected_by    = excluded.collected_by,
           contact_id      = coalesce(excluded.contact_id, voter_contact.contact_id),
           voter_id        = coalesce(excluded.voter_id, voter_contact.voter_id)
         RETURNING *, (xmax = 0) AS inserted
       )
       SELECT ${VC_COLS}, vc.inserted FROM up vc ${VC_JOINS}`,
      [
        body.voter_id ?? null,
        body.household_id,
        body.channel,
        value,
        consentGotv,
        consentUpdates,
        body.consent_note ?? null,
        me.id,
        body.contact_id ?? null,
      ],
    );
    if (!row) throw new Error('voter_contact upsert returned no row');

    // The audit detail never carries `value`: audit_log is readable by admins and would otherwise
    // become a second, un-withdrawable copy of every number the campaign was ever given.
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'collect_voter_contact',
      target: row.id,
      detail: {
        household_id: row.household_id,
        voter_id: row.voter_id,
        channel: row.channel,
        consent_gotv: row.consent_gotv,
        consent_updates: row.consent_updates,
        re_offered: !row.inserted,
      },
      ip: req.ip,
    });
    return reply.status(row.inserted ? 201 : 200).send({ voter_contact: serializeVoterContact(row) });
  });

  /**
   * GET /api/voter-contacts/gotv?channel=&limit= — organizer/admin. The send list: consented to
   * GOTV and not withdrawn. Declared before /:id because it is the one route here whose output
   * leaves the system, and it should be impossible to miss when reading this file.
   */
  app.get('/gotv', { preHandler: organizerOnly }, async (req) => {
    const qp = gotvQuery.parse(req.query);
    const me = currentSession(req).user;

    const rows = await q<GotvContactRow>(
      app.db,
      `SELECT vc.id, vc.channel::text AS channel, vc.value, vc.voter_id, v.display_name AS voter_name,
              vc.household_id, h.address, h.ward, h.community, vc.consent_note, vc.consented_at
       FROM voter_contact vc
       JOIN household h ON h.id = vc.household_id
       LEFT JOIN voter v ON v.id = vc.voter_id
       WHERE vc.consent_gotv
         AND vc.withdrawn_at IS NULL
         AND ($1::contact_channel IS NULL OR vc.channel = $1::contact_channel)
       ORDER BY h.ward, h.address, vc.value
       LIMIT $2`,
      [qp.channel ?? null, qp.limit],
    );

    // Audited on EVERY call, with no exception for an empty result: this is the list that can be
    // exported and sent, so who pulled it and when is exactly what has to be answerable later.
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_gotv_list',
      detail: { channel: qp.channel ?? 'all', n: rows.length },
      ip: req.ip,
    });
    return { contacts: rows.map(serializeGotvContact) };
  });

  // GET /api/voter-contacts?household_id= — the door's details. Volunteers: their turfs only.
  app.get('/', { preHandler: requireAuth }, async (req) => {
    const qp = listQuery.parse(req.query);
    const me = currentSession(req).user;
    await assertHouseholdAccess(app.db, me.role, qp.household_id, me.id);

    const rows = await q<VoterContactRow>(
      app.db,
      `SELECT ${VC_COLS} FROM voter_contact vc ${VC_JOINS}
       WHERE vc.household_id = $1
       ORDER BY vc.channel, vc.value`,
      [qp.household_id],
    );

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_voter_contacts',
      target: qp.household_id,
      detail: { n: rows.length },
      ip: req.ip,
    });
    return { voter_contacts: rows.map(serializeVoterContact) };
  });

  /**
   * PATCH /api/voter-contacts/:id — change the consent, or record that it was withdrawn.
   *
   * `withdrawn: true` stamps `withdrawn_at` and the row STAYS. Deleting it would look tidier and be
   * worse: the next canvasser at that door would collect the same number again, and nothing would
   * remember that this person asked us to stop. `withdrawn: false` lifts it (a mis-tap, or they
   * changed their mind) and clears the note with it.
   *
   * Any signed-in user may withdraw a value for a door in their scope — the person is standing
   * there asking, and the volunteer must be able to act on it without finding an organizer.
   */
  app.patch('/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const me = currentSession(req).user;

    const before = await one<{ household_id: string; withdrawn_at: Date | null }>(
      app.db,
      `SELECT household_id, withdrawn_at FROM voter_contact WHERE id = $1`,
      [id],
    );
    if (!before) throw notFound('voter contact not found');
    await assertHouseholdAccess(app.db, me.role, before.household_id, me.id);

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.consent_gotv !== undefined) set('consent_gotv', body.consent_gotv);
    if (body.consent_updates !== undefined) set('consent_updates', body.consent_updates);
    if (body.withdrawn === true) {
      // `coalesce` keeps the moment they FIRST asked; a second request does not restart the clock.
      params.push(new Date());
      sets.push(`withdrawn_at = coalesce(withdrawn_at, $${params.length})`);
    } else if (body.withdrawn === false) {
      sets.push('withdrawn_at = NULL', 'withdrawn_note = NULL');
    }
    if (body.withdrawn_note !== undefined && body.withdrawn !== false) set('withdrawn_note', body.withdrawn_note);

    if (sets.length > 0) await app.db.query(`UPDATE voter_contact SET ${sets.join(', ')} WHERE id = $1`, params);

    const row = await one<VoterContactRow>(
      app.db,
      `SELECT ${VC_COLS} FROM voter_contact vc ${VC_JOINS} WHERE vc.id = $1`,
      [id],
    );
    if (!row) throw notFound('voter contact not found');

    await audit(app.db, req.log, {
      userId: me.id,
      action: body.withdrawn === true ? 'withdraw_voter_contact' : 'update_voter_contact',
      target: id,
      detail: {
        household_id: row.household_id,
        channel: row.channel,
        consent_gotv: row.consent_gotv,
        consent_updates: row.consent_updates,
        withdrawn: row.withdrawn_at !== null,
        was_withdrawn: before.withdrawn_at !== null,
      },
      ip: req.ip,
    });
    return { voter_contact: serializeVoterContact(row) };
  });

  /**
   * DELETE /api/voter-contacts/:id → 204. Organizer/admin only, and only for a genuine mistake —
   * a wrong number typed at the door. Somebody asking us to stop is a WITHDRAWAL (PATCH), never a
   * delete: a deleted row is re-collected next canvass, a withdrawn one is remembered.
   */
  app.delete('/:id', { preHandler: organizerOnly }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;

    const row = await one<{ id: string; household_id: string; channel: string; withdrawn_at: Date | null }>(
      app.db,
      `DELETE FROM voter_contact WHERE id = $1
       RETURNING id, household_id, channel::text AS channel, withdrawn_at`,
      [id],
    );
    if (!row) throw notFound('voter contact not found');

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'delete_voter_contact',
      target: id,
      detail: { household_id: row.household_id, channel: row.channel, was_withdrawn: row.withdrawn_at !== null },
      ip: req.ip,
    });
    return reply.status(204).send();
  });
};
