/**
 * Everything arriving on a campaign number.
 *
 * STOP was built before send was (plan §4: "ship the ability to stop BEFORE the ability to send —
 * non-negotiable"), and this module is written from that direction:
 *
 *   * **STOP is honoured unconditionally and immediately**, whether or not the number matches
 *     anything we hold. A number we cannot match is still a person telling us to stop; the inbound
 *     row is written regardless, so that if the number ever *is* collected at a door we can see
 *     that they already said no. Withdrawal stamps `withdrawn_at` on EVERY matching contact row —
 *     the row stays, because a deleted row is simply re-collected at the next canvass.
 *   * **JOIN is the only route by which a message can create consent**, and it records the exact
 *     wording agreed to. A consent record that cannot say what was agreed to is not a consent
 *     record.
 *   * **HELP says who we are and how to stop.** It is a carrier requirement and it is also just
 *     what a person deserves when a number they do not recognise texts them.
 *
 * Keyword matching is accent- and punctuation-insensitive, which is how `ARRÊT` typed without the
 * circumflex, `arret`, and `Arrêt.` all reach the same branch.
 */
import { one, q, type Queryable } from '../db.js';

export type InboundAction = 'stop' | 'join' | 'help' | 'other';

/**
 * Fold a message body to a comparison key: uppercase, accents stripped, everything that is not a
 * letter or digit removed. `Arrêt`, `ARRET`, ` arrêt. ` and `A R R E T` all become `ARRET`.
 */
export function normalizeKeyword(body: string): string {
  return body
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Accents already stripped by normalizeKeyword, so ARRÊT is listed as ARRET and DÉSABONNEMENT as
// DESABONNEMENT. Both spellings therefore match either way they are typed.
const STOP_WORDS = new Set(['STOP', 'UNSUBSCRIBE', 'ARRET', 'DESABONNEMENT', 'CANCEL', 'QUIT', 'END', 'STOPALL']);
const JOIN_WORDS = new Set(['JOIN', 'YES', 'OUI', 'START', 'UNSTOP']);
const HELP_WORDS = new Set(['HELP', 'AIDE', 'INFO']);

export function classifyInbound(body: string | null | undefined): InboundAction {
  const key = normalizeKeyword(body ?? '');
  if (STOP_WORDS.has(key)) return 'stop';
  if (JOIN_WORDS.has(key)) return 'join';
  if (HELP_WORDS.has(key)) return 'help';
  return 'other';
}

/**
 * STOP. Stamps every matching contact, in one statement, before anything else can happen.
 *
 * `coalesce` keeps the moment they FIRST asked, so a second STOP does not restart the clock, and
 * the queued messages they have not received yet are caught by the worker's dequeue-time re-check
 * rather than needing to be hunted down here.
 */
export async function applyStop(db: Queryable, e164: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    db,
    `UPDATE voter_contact
     SET withdrawn_at = coalesce(withdrawn_at, now()),
         withdrawn_note = coalesce(withdrawn_note, 'replied STOP by SMS')
     WHERE channel = 'phone' AND value = $1
     RETURNING id`,
    [e164],
  );
  return rows.map((r) => r.id);
}

export interface ConsentGrant {
  gotv: boolean;
  updates: boolean;
  /** Verbatim wording the person agreed to — stored on the row, never summarised. */
  consentText: string;
}

/**
 * Turn a confirmed consent into `voter_contact` rows for this number.
 *
 * ---------------------------------------------------------------------------------------------
 * KNOWN LIMIT — `voter_contact.household_id` is NOT NULL and references `household`.
 * ---------------------------------------------------------------------------------------------
 * That is right for a number collected at a door: it belongs to an address on the list. It has no
 * answer for a self-serve subscriber who is not on the list, or who has not told us where they
 * live. So this function can only attach consent to a number we ALREADY hold from a door.
 *
 * When the number is unknown, the consent is still recorded and provable — `subscribe_pending` is
 * marked confirmed and the inbound message is stored with the carrier's own timestamp — but there
 * is nowhere to write a `voter_contact` row, so that subscriber is not yet in a send audience.
 * Closing that needs a schema decision (a nullable `household_id`, or a separate subscriber table),
 * which is flagged rather than guessed at here.
 *
 * A JOIN also LIFTS a previous withdrawal. That is the one place withdrawal is reversible, and it
 * is reversible only by the person's own outbound text, timestamped by the carrier — the strictest
 * proof available. Nothing an organiser can click undoes a STOP.
 */
export async function attachConsent(db: Queryable, e164: string, grant: ConsentGrant): Promise<string[]> {
  const rows = await q<{ id: string }>(
    db,
    `UPDATE voter_contact
     SET consent_gotv    = consent_gotv OR $2,
         consent_updates = consent_updates OR $3,
         consent_note    = $4,
         consented_at    = now(),
         withdrawn_at    = NULL,
         withdrawn_note  = NULL
     WHERE channel = 'phone' AND value = $1
     RETURNING id`,
    [e164, grant.gotv, grant.updates, grant.consentText],
  );
  return rows.map((r) => r.id);
}

export interface PendingRow {
  id: string;
  wants_gotv: boolean;
  wants_updates: boolean;
  consent_text: string;
}

/** The newest un-confirmed, un-expired self-serve request for this number, if there is one. */
export async function outstandingPending(db: Queryable, e164: string): Promise<PendingRow | undefined> {
  return one<PendingRow>(
    db,
    `SELECT id, wants_gotv, wants_updates, consent_text
     FROM subscribe_pending
     WHERE e164 = $1 AND confirmed_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [e164],
  );
}

export const stopReply = (org: string): string =>
  `${org}: you have been unsubscribed and will get no further messages. Reply JOIN to opt back in.`;

export const helpReply = (org: string): string =>
  `${org} sends election reminders to people who asked for them. Reply STOP to unsubscribe, JOIN to subscribe.`;

export const joinReply = (org: string): string =>
  `${org}: you are subscribed and will get election reminders. Msg&data rates may apply. Reply STOP to unsubscribe.`;

/** The wording a text-to-join subscriber agreed to: their own message, quoted verbatim. */
export const textToJoinConsent = (body: string): string =>
  `Text-to-join: replied "${body.trim().slice(0, 200)}" to the campaign number.`;
