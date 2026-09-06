/**
 * `POST /api/subscribe` — the self-serve route in. Public, no session.
 *
 * This is the only consent route where we cannot see the person, so it gets the strictest proof:
 * **double opt-in**. The form writes a `subscribe_pending` row and we text that number once; the
 * number does not become a consented contact until the *number itself* replies YES to the inbound
 * webhook. Anyone can type a stranger's number into a form; only the person holding the handset
 * can reply from it.
 *
 * Three rules make this endpoint safe to expose:
 *
 *  1. **It never reveals whether a number is already known.** Subscribed, withdrawn, never heard
 *     of — the response is byte-identical. Otherwise the form is a free oracle over the campaign's
 *     contact list: type a number, read the answer, learn whether that person gave the campaign
 *     their phone number. Under the *Municipal Elections Act* that is exactly the disclosure the
 *     rest of this system is built to prevent.
 *  2. **A number that previously said STOP is never texted by this route.** Silently. Otherwise
 *     the public form is a way to make us message somebody who asked us not to — from our side it
 *     would look like a legitimate subscription, and from theirs it would look like we ignored
 *     them. They can still come back: replying JOIN from their own handset lifts it.
 *  3. **One confirmation per number, ever, while it is outstanding**, on top of a hard per-IP rate
 *     limit. Both are needed: the rate limit stops one caller texting a thousand people, and the
 *     outstanding-pending check stops a thousand callers texting one person.
 */
import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { one } from '../db.js';
import { audit } from '../lib/audit.js';
import { normalizeContactValue } from './voter-contacts.js';

const subscribeBody = z.object({
  phone: z.string().trim().min(3).max(30),
  wants_gotv: z.boolean().optional(),
  wants_updates: z.boolean().optional(),
  /**
   * The verbatim wording shown beside the tick box, sent back by the page that displayed it. A
   * consent record that cannot say what was agreed to is not a consent record, so this is required
   * and stored exactly as given — never summarised, never replaced with a canned string here.
   */
  consent_text: z.string().trim().min(20).max(1000),
});

/**
 * The identical answer for every outcome. Deliberately says "if" — it promises nothing about
 * whether that number exists, is already subscribed, or asked us to stop.
 */
const OPAQUE = {
  ok: true,
  message:
    'If that number can receive text messages, we have sent it a confirmation. ' +
    'Reply YES to that message to finish subscribing.',
} as const;

export const subscribeRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/subscribe',
    {
      // Hard, by IP. This endpoint spends money and buzzes strangers' phones; a generous limit
      // here would be an open SMS relay pointed at the campaign's bill.
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const body = subscribeBody.parse(req.body);
      // A malformed number is rejected: that discloses nothing about our data, and silently
      // swallowing a typo would leave the person waiting for a text that can never arrive.
      const e164 = normalizeContactValue('phone', body.phone);
      const wantsGotv = body.wants_gotv ?? true;
      const wantsUpdates = body.wants_updates ?? false;
      if (!wantsGotv && !wantsUpdates) {
        // Not an information leak — it is about the request, not about the number.
        return reply.status(400).send({
          error: { code: 'consent_required', message: 'choose at least one of wants_gotv or wants_updates' },
        });
      }

      // Rule 2 — a withdrawal is never overridden by a form somebody else could have filled in.
      const withdrawn = await one<{ id: string }>(
        app.db,
        `SELECT id FROM voter_contact WHERE channel = 'phone' AND value = $1 AND withdrawn_at IS NOT NULL LIMIT 1`,
        [e164],
      );
      if (withdrawn) {
        req.log.info({ route: 'subscribe' }, 'subscribe: ignored, this number has withdrawn consent');
        return reply.status(202).send(OPAQUE);
      }

      // Rule 3 — an outstanding request is not re-sent.
      const outstanding = await one<{ id: string }>(
        app.db,
        `SELECT id FROM subscribe_pending WHERE e164 = $1 AND confirmed_at IS NULL AND expires_at > now() LIMIT 1`,
        [e164],
      );
      if (outstanding) return reply.status(202).send(OPAQUE);

      const token = randomBytes(24).toString('base64url');
      const pending = await one<{ id: string }>(
        app.db,
        `INSERT INTO subscribe_pending (e164, token, wants_gotv, wants_updates, consent_text, source)
         VALUES ($1, $2, $3, $4, $5, 'web')
         RETURNING id`,
        [e164, token, wantsGotv, wantsUpdates, body.consent_text],
      );
      if (!pending) throw new Error('subscribe_pending insert returned no row');

      const sender = await one<{ e164: string }>(
        app.db,
        `SELECT e164 FROM sender_number WHERE active AND sent_today < daily_cap ORDER BY sent_today, e164 LIMIT 1`,
      );
      const confirmation =
        `${app.config.MESSAGING_ORG_NAME}: reply YES to confirm you want election reminders by text. ` +
        'Reply STOP at any time to unsubscribe. Msg&data rates may apply.';
      try {
        await app.messaging.provider.send(e164, confirmation, sender ? { from: sender.e164 } : {});
      } catch (err) {
        // The pending row stays: a failed confirmation is a retry (after it expires), not a lost
        // consent. And the caller is told nothing either way — see rule 1.
        req.log.error({ err, pending: pending.id }, 'subscribe: confirmation send failed');
      }

      // userId is null because nobody on the campaign did this — the subscriber did. The number
      // itself never enters audit_log; the pending row id is the handle.
      await audit(app.db, req.log, {
        userId: null,
        action: 'subscribe_request',
        target: pending.id,
        detail: { wants_gotv: wantsGotv, wants_updates: wantsUpdates, source: 'web' },
        ip: req.ip,
      });
      return reply.status(202).send(OPAQUE);
    },
  );
};
