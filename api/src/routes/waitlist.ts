/**
 * `POST /api/waitlist` — other campaigns asking to hear when CanvassOS opens to them. Public, no
 * session; the marketing page in web/ posts here from the same origin, so there is no CORS.
 *
 * Built to the same rules as `subscribe.ts` and `public-requests.ts`, the other unauthenticated
 * writes on a stack that holds a voters list:
 *
 *  1. **It never reveals whether an email is already on the list.** New, repeat, honeypot: the
 *     response is byte-identical. Otherwise the form is an oracle over who has enquired.
 *  2. **It writes to its own table and joins nothing.** `product_waitlist` is product enquiries,
 *     not election data; it has no key to `voter`, `household` or `voter_contact` and must never
 *     gain one (migration 009).
 *  3. **Hard per-IP rate limit plus a honeypot**, for the same reason as the sign-up form: a public
 *     form collects bots, and a CAPTCHA would be a third party for a form that takes a name.
 *
 * It sends nothing. Telling these people when the product opens is a human job done later, under
 * the consent wording they read, which is stored verbatim beside their row.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { audit } from '../lib/audit.js';

export const WAITLIST_ROLES = ['candidate', 'campaign_manager', 'volunteer_coordinator', 'other'] as const;
export const WAITLIST_ELECTIONS = ['2026', '2027', '2028', '2029', '2030', 'unsure'] as const;

/** Blank and absent are the same answer; `''` must never be stored as though somebody said it. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : undefined));

const body = z.object({
  // Lower-cased before the uniqueness check, so "Jo@Example.ca" and "jo@example.ca" are one row.
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  role: z.enum(WAITLIST_ROLES),
  municipality: z.string().trim().min(1).max(120),
  province: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'a two-letter province or territory code, e.g. ON'),
  next_election: z.enum(WAITLIST_ELECTIONS),
  notes: optionalText(500),
  /**
   * The verbatim wording shown beside the tick box. Required and stored exactly as given — the same
   * rule as subscribe_pending and public_request: a consent record that cannot say what was agreed
   * to is not a consent record.
   */
  consent_text: z.string().trim().min(20).max(1000),
  /** Honeypot. A person never sees it; anything in it is a bot, answered normally and discarded. */
  website: z.string().max(200).optional(),
});

/** Identical for every outcome: new, already listed, or a honeypot hit. */
const OPAQUE = {
  ok: true,
  message: "You're on the list. We'll email you when CanvassOS opens to new campaigns.",
} as const;

export const waitlistRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/waitlist',
    {
      // Hard, by IP, like /subscribe. A campaign joins a waitlist once, not five times an hour.
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const b = body.parse(req.body);

      if (b.website && b.website.trim() !== '') {
        req.log.info({ route: 'waitlist' }, 'waitlist: honeypot hit, discarded');
        return reply.status(202).send(OPAQUE);
      }

      // Upsert on email: a repeat sign-up is somebody correcting or updating their details, and the
      // answer must not differ from a first one (rule 1).
      const row = await one<{ id: string }>(
        app.db,
        `INSERT INTO product_waitlist (email, name, role, municipality, province, next_election, notes, consent_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email) DO UPDATE
           SET name = excluded.name,
               role = excluded.role,
               municipality = excluded.municipality,
               province = excluded.province,
               next_election = excluded.next_election,
               notes = excluded.notes,
               consent_text = excluded.consent_text,
               updated_at = now()
         RETURNING id`,
        [b.email, b.name, b.role, b.municipality, b.province, b.next_election, b.notes ?? null, b.consent_text],
      );

      // No user id: nobody was signed in. Category answers only — never the email, name,
      // municipality or notes, which would make audit_log a second, undeletable copy of the row.
      await audit(app.db, req.log, {
        userId: null,
        action: 'waitlist_signup',
        target: row?.id ?? null,
        detail: { role: b.role, province: b.province, next_election: b.next_election, has_notes: Boolean(b.notes) },
        ip: req.ip,
      });

      return reply.status(202).send(OPAQUE);
    },
  );

  /** The admin's view of who has asked. Names and emails, so the read is audited. */
  app.get('/waitlist', { preHandler: requireRole('admin') }, async (req) => {
    // An explicit column list, never `*`: the row shape is an allow-list in the serialize.ts sense.
    const rows = await q<Record<string, unknown>>(
      app.db,
      `SELECT id, email, name, role, municipality, province, next_election, notes, consent_text,
              created_at, updated_at
         FROM product_waitlist
        ORDER BY created_at DESC`,
    );

    await audit(app.db, req.log, {
      userId: req.session?.user.id ?? null,
      action: 'view_waitlist',
      detail: { n: rows.length },
      ip: req.ip,
    });

    return { waitlist: rows };
  });
};
