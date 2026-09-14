/**
 * `POST /api/public/requests` — sign-ups from the public campaign website. No session.
 *
 * The website is a separate, statically-hosted site; this is how its form reaches the campaign's
 * own system. That makes it the second unauthenticated write endpoint on a stack that holds the
 * voters list, so it is built to the same rules as `subscribe.ts`:
 *
 *  1. **It never reveals whether we already know this person.** Every outcome returns the same
 *     bytes. Otherwise the form is a free oracle: submit an address, read the answer, learn whether
 *     that household is on the campaign's list. Under the *Municipal Elections Act* that is exactly
 *     the disclosure the rest of this system exists to prevent.
 *  2. **It writes to its own table and never to `voter` or `household`.** These people typed their
 *     own details into a public form. That is a different provenance and a different legal basis
 *     from the clerk's supply, and merging the two would put rows in the voters list that nobody
 *     can account for. Matching a submission to a real door is a human job — `public_request`
 *     records the answer, it does not guess it.
 *  3. **Hard per-IP rate limit plus a honeypot.** A public form on the internet collects bots. The
 *     rate limit bounds the damage; the honeypot catches the cheap ones without a CAPTCHA, which
 *     would be both a worse experience and a third-party dependency for a form that takes a name.
 *
 * Cross-origin is an explicit allowlist (`PUBLIC_FORM_ORIGINS`), never `*`. Absent, no browser on
 * another origin can post here at all, which is the right default for a write endpoint.
 *
 * What it deliberately does NOT do: send anything. A lawn-sign request from a stranger is a promise
 * to drive somewhere, and a text or email in reply would be a message to an address nobody has
 * confirmed. Phone consent has its own double-opt-in route (`subscribe.ts`) and this endpoint does
 * not short-circuit it.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { audit } from '../lib/audit.js';
import { normalizeContactValue } from './voter-contacts.js';

/** What the form's tick boxes can ask for. An unknown value is dropped rather than stored. */
const WANTS = ['sign', 'volunteer', 'reminders', 'donate', 'other'] as const;

const body = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().min(3).max(30).optional().or(z.literal('').transform(() => undefined)),
  /** Where a sign should go. Free text — a public form has no household id. */
  address: z.string().trim().max(300).optional().or(z.literal('').transform(() => undefined)),
  note: z.string().trim().max(2000).optional().or(z.literal('').transform(() => undefined)),
  wants: z.array(z.enum(WANTS)).max(WANTS.length).default([]),
  /**
   * The verbatim wording shown beside the tick boxes. Required, and stored exactly as given: a
   * consent record that cannot say what was agreed to is not a consent record, and the campaign
   * may have to produce it.
   */
  consent_text: z.string().trim().min(20).max(1000),
  /**
   * Honeypot. A real person never sees this field, so anything in it is a bot. The response is
   * still the normal one — telling a scraper it was detected just teaches it to try again.
   */
  website: z.string().max(200).optional(),
});

/** Identical for every outcome, including a honeypot hit and a duplicate. Promises nothing. */
const OPAQUE = {
  ok: true,
  message: 'Thanks — that has reached the campaign. Somebody will be in touch.',
} as const;

/** A submission with no way to reply is not a request, it is a note to nobody. */
const hasContact = (b: z.infer<typeof body>) => Boolean(b.email || b.phone);

export function allowedOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const publicRequestRoutes: FastifyPluginAsync = async (app) => {
  const origins = allowedOrigins(app.config.PUBLIC_FORM_ORIGINS);

  /**
   * Echo the caller's origin only when it is on the list — never `*`, and never the caller's own
   * value unchecked. `Vary: Origin` because the answer differs per caller and a cache in front of
   * this must not serve one site's headers to another.
   */
  function cors(req: FastifyRequest, reply: FastifyReply): void {
    const origin = req.headers.origin;
    reply.header('Vary', 'Origin');
    if (origin && origins.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type');
      reply.header('Access-Control-Max-Age', '600');
    }
  }

  // Preflight. Answered for any origin, but only an allowlisted one gets the headers that make the
  // real request legal, so a browser on any other site still refuses to send it.
  app.options('/public/requests', async (req, reply) => {
    cors(req, reply);
    return reply.status(204).send();
  });

  app.post(
    '/public/requests',
    {
      // Hard, by IP. Unauthenticated writes on a stack holding the voters list get the strict
      // limit; a campaign form is filled in once, not twenty times an hour.
      config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      cors(req, reply);
      const b = body.parse(req.body);

      // A bot filled the invisible field. Accept it, store nothing, answer normally.
      if (b.website && b.website.trim() !== '') {
        req.log.info({ route: 'public-requests' }, 'public request: honeypot hit, discarded');
        return reply.status(202).send(OPAQUE);
      }

      if (!hasContact(b)) {
        // About the request, not about our data, so this one is safe to say plainly.
        return reply.status(400).send({
          error: { code: 'contact_required', message: 'give an email address or a phone number' },
        });
      }

      // Normalised when it can be, stored as typed when it cannot. A form is not the place to
      // reject somebody's phone number: the campaign would rather have a messy one than none, and a
      // human is going to read this row anyway.
      let phone = b.phone ?? null;
      if (phone) {
        try {
          phone = normalizeContactValue('phone', phone);
        } catch {
          req.log.info({ route: 'public-requests' }, 'public request: phone kept as typed');
        }
      }

      const row = await one<{ id: string }>(
        app.db,
        `INSERT INTO public_request (name, email, phone, address, note, wants, consent_text, origin, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9::inet, $10)
         RETURNING id`,
        [
          b.name,
          b.email ?? null,
          phone,
          b.address ?? null,
          b.note ?? null,
          b.wants,
          b.consent_text,
          req.headers.origin ?? null,
          req.ip,
          (req.headers['user-agent'] ?? '').slice(0, 500) || null,
        ],
      );

      // No user id: nobody was signed in. The row id is the target so the trail leads to what was
      // said, and `wants` is enough to see what the public form is actually being used for.
      await audit(app.db, req.log, {
        userId: null,
        action: 'public_request',
        target: row?.id ?? null,
        detail: { wants: b.wants, has_address: Boolean(b.address) },
        ip: req.ip,
      });

      return reply.status(202).send(OPAQUE);
    },
  );

  /**
   * The organiser's side of it. Without this the endpoint is a black hole that quietly collects
   * people who asked for a sign and never tells anybody — which is worse than not having the form.
   */
  app.get('/public/requests', { preHandler: requireRole('organizer') }, async (req) => {
    const qp = z
      .object({
        open: z
          .enum(['true', 'false'])
          .default('true')
          .transform((v) => v === 'true'),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);

    // Candidates ride along as a JSON array per request (phase 8): the queue is where an
    // organizer confirms or rejects the matcher's suggestions, so the two are one screen and
    // one read. Candidate rows carry voter names and addresses — organizer-only, like /search.
    const rows = await q<Record<string, unknown>>(
      app.db,
      `SELECT pr.id, pr.created_at, pr.name, pr.email, pr.phone, pr.address, pr.note, pr.wants,
              pr.consent_text, pr.handled_at, pr.handled_by, pr.household_id, pr.sign_id,
              pr.source, pr.external_id, pr.website_status,
              coalesce(mc.candidates, '[]'::json) AS candidates
       FROM public_request pr
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', c.id, 'voter_id', c.voter_id, 'natural_key', c.natural_key,
                  'household_id', c.household_id, 'voter_name', c.voter_name,
                  'household_address', c.household_address, 'score', c.score,
                  'method', c.method, 'status', c.status, 'decided_at', c.decided_at)
                ORDER BY c.status = 'accepted' DESC, c.score DESC) AS candidates
         FROM match_candidate c
         WHERE c.public_request_id = pr.id
       ) mc ON true
       ${qp.open ? 'WHERE pr.handled_at IS NULL' : ''}
       ORDER BY pr.created_at DESC
       LIMIT $1`,
      [qp.limit],
    );

    // Self-submitted rather than off the list, but still people's names, addresses and phone
    // numbers — so reading it is audited like any other read of personal data.
    await audit(app.db, req.log, {
      userId: req.session?.user.id ?? null,
      action: 'view_public_requests',
      detail: { n: rows.length, open_only: qp.open },
      ip: req.ip,
    });

    return { requests: rows };
  });

  /** Mark one as dealt with, optionally recording the door it turned out to be. */
  app.patch('/public/requests/:id', { preHandler: requireRole('organizer') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z
      .object({
        handled: z.boolean().default(true),
        household_id: z.string().max(80).nullish(),
        sign_id: z.string().uuid().nullish(),
      })
      .parse(req.body ?? {});
    const me = req.session!.user;

    const row = await one<{ id: string }>(
      app.db,
      `UPDATE public_request
          SET handled_at = CASE WHEN $2 THEN now() ELSE NULL END,
              handled_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
              household_id = coalesce($4, household_id),
              sign_id = coalesce($5::uuid, sign_id)
        WHERE id = $1
        RETURNING id`,
      [id, patch.handled, me.id, patch.household_id ?? null, patch.sign_id ?? null],
    );
    if (!row) return { ok: false };

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'handle_public_request',
      target: id,
      detail: { handled: patch.handled },
      ip: req.ip,
    });
    return { ok: true };
  });

  /**
   * The human verdict on one of the matcher's candidates (phase 8). Accept sets the request's
   * household_id — the same pointer the PATCH above has always recorded, arrived at faster.
   * Either verdict is written to the subscriber_link ledger, which is what survives a voters-list
   * re-import; the matcher re-applies it afterwards. Never touches voter/household, never mints
   * consent, never sends anything.
   */
  app.post('/public/requests/:id/decide', { preHandler: requireRole('organizer') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        candidate_id: z.string().uuid(),
        decision: z.enum(['accept', 'reject']),
      })
      .parse(req.body ?? {});
    const me = req.session!.user;
    const status = b.decision === 'accept' ? 'accepted' : 'rejected';

    const cand = await one<{
      natural_key: string;
      household_id: string | null;
      source: string;
      external_id: string | null;
      linked: string | null;
    }>(
      app.db,
      `UPDATE match_candidate c
          SET status = $3, decided_by = $4, decided_at = now()
         FROM public_request pr
        WHERE c.id = $2 AND c.public_request_id = $1 AND pr.id = c.public_request_id
        RETURNING c.natural_key, c.household_id, pr.source, pr.external_id, pr.household_id AS linked`,
      [id, b.candidate_id, status, me.id],
    );
    if (!cand) {
      return { ok: false };
    }
    const ledgerExternal = cand.external_id ?? id;

    if (status === 'accepted') {
      // One accepted match per request. Demote every OTHER accepted candidate (and its ledger row)
      // to rejected first, so a second accept — two organizers on stale queues, or a correction —
      // cannot leave two 'accepted' rows that then re-apply in an arbitrary order after a re-import.
      const rivals = await q<{ natural_key: string }>(
        app.db,
        `UPDATE match_candidate
            SET status = 'rejected', decided_by = $3, decided_at = now()
          WHERE public_request_id = $1 AND id <> $2 AND status = 'accepted'
          RETURNING natural_key`,
        [id, b.candidate_id, me.id],
      );
      for (const r of rivals) {
        await q(
          app.db,
          `UPDATE subscriber_link SET status = 'rejected', decided_by = $3, decided_at = now()
            WHERE source = $1 AND external_id = $2 AND natural_key = $4`,
          [cand.source, ledgerExternal, me.id, r.natural_key],
        );
      }
      if (cand.household_id) {
        await q(app.db, `UPDATE public_request SET household_id = $2 WHERE id = $1`, [id, cand.household_id]);
      }
    } else if (cand.linked && cand.household_id && cand.linked === cand.household_id) {
      // Rejecting the very candidate the request is currently linked to (a wrong auto-accept, or a
      // human undoing an accept) must UNLINK it — otherwise household_id would keep pointing at the
      // rejected door with no way back. Clearing matched_at lets the matcher re-examine the row and
      // surface other candidates; the ledger now says 'rejected', so it will not re-link this one.
      await q(app.db, `UPDATE public_request SET household_id = NULL, matched_at = NULL WHERE id = $1`, [id]);
    }

    await one(
      app.db,
      `INSERT INTO subscriber_link (source, external_id, natural_key, status, decided_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source, external_id, natural_key) DO UPDATE
         SET status = excluded.status, decided_by = excluded.decided_by, decided_at = now()
       RETURNING natural_key`,
      [cand.source, ledgerExternal, cand.natural_key, status, me.id],
    );

    await audit(app.db, req.log, {
      // candidate_id, not natural_key: the natural_key is lowercased name + address, i.e. personal
      // data that must never enter audit_log. The candidate/request ids resolve it when needed.
      userId: me.id,
      action: 'decide_match',
      target: id,
      detail: { decision: b.decision, candidate_id: b.candidate_id },
      ip: req.ip,
    });
    return { ok: true };
  });
};
