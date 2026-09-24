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
 *
 * The rest of the file is the organizer's side: the queue, the handled/household/sign verdicts, the
 * matcher's candidates — and the three **hand-entered** routes (`source = 'manual'`). Most sign
 * requests do not arrive through a form at all: somebody rings, or stops an organizer outside the
 * arena. Those belong in the same queue or they live on a scrap of paper, so they are ordinary
 * `public_request` rows with `source = 'manual'`, which is also the flag that decides what may be
 * edited. A row that somebody submitted themselves is the record of what *they* said and of the
 * consent wording they read: it is not ours to rewrite or to delete, and the five-minute website
 * sync would re-insert a deleted one anyway. A row we typed in ourselves is ours to correct.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/guard.js';
import { one, q } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { CAMPAIGN_TIMEZONE } from '../lib/quiet-hours.js';
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

/**
 * Blank and absent are the same instruction on a hand-entered form, and `''` must never reach the
 * database: an empty `household_id` is a foreign-key violation (a 500 out of Postgres for what is
 * really an unfilled picker), and an empty address is worse than a NULL one because it reads as an
 * answer somebody gave. Deliberately NOT the `.or(z.literal(''))` shape the public body uses —
 * that only works when the left branch REJECTS `''`, which is true for `.email()` and for phone's
 * `.min(3)` and is dead code for a plain length-capped string, which accepts `''` and stores it.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : undefined));

/**
 * A hand-entered request. Deliberately NOT the public `body` above: there is no honeypot (nobody
 * crawled their way here, the caller is a signed-in organizer), no `consent_text` (built below,
 * never accepted from the client) and one extra field, `household_id`, because the person typing
 * this in usually already knows which door it is — they are looking at the map.
 *
 * `name` runs to 200 rather than the form's 120: the form is a text input somebody fills in about
 * themselves, this is an organizer writing down what they were told ("Jim and Sandra at the farm
 * past the church"), and truncating that loses the only thing that will find them again.
 */
const manualBody = z.object({
  name: z.string().trim().min(1).max(200),
  // `nullish`, not `optional`: a form with three "give us one of these" boxes sends the empty ones
  // as an explicit null, and refusing that would be a 400 on the commonest shape of a real request.
  email: z.string().trim().email().max(200).nullish().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().min(3).max(30).nullish().or(z.literal('').transform(() => undefined)),
  address: optionalText(300),
  note: optionalText(2000),
  /** Hand-entered requests are overwhelmingly lawn signs, so that is the default rather than none. */
  wants: z.array(z.enum(WANTS)).max(WANTS.length).default(['sign']),
  household_id: optionalText(80),
});

/** The fields a manual row may be corrected on, and the order the audit trail lists them in. */
const EDITABLE = ['name', 'email', 'phone', 'address', 'note', 'wants', 'household_id'] as const;
type EditableField = (typeof EDITABLE)[number];

/**
 * Every field nullable except `name`: a typo can leave a phone number that belongs to nobody, and
 * the fix for that is to clear it, not to leave a wrong one on the row. `name` has no empty form —
 * a request with no name is not a request — so it may be changed but never blanked. Which keys
 * were actually sent is read off the raw body, because `null` (clear it) and absent (leave it) are
 * different instructions and zod cannot tell them apart once parsed.
 */
const fieldsBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(200).nullish().or(z.literal('').transform(() => null)),
  phone: z.string().trim().min(3).max(30).nullish().or(z.literal('').transform(() => null)),
  address: optionalText(300),
  note: optionalText(2000),
  // `wants` is NOT NULL in the schema, so an explicit null here means "asked for nothing in
  // particular" and lands as the empty array rather than as a constraint violation.
  wants: z
    .array(z.enum(WANTS))
    .max(WANTS.length)
    .nullish()
    .transform((v) => v ?? []),
  household_id: optionalText(80),
});

/**
 * `YYYY-MM-DD` in the campaign's own timezone, through `Intl` and the shared CAMPAIGN_TIMEZONE
 * constant rather than a UTC slice. A request written down at 20:00 on a Tuesday is already
 * Wednesday in UTC, and a consent record that names the wrong day is a consent record nobody can
 * stand behind.
 */
const CONSENT_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPAIGN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Built on the server, never taken from the client — the one field of a manual row the caller
 * cannot set. On the public form `consent_text` is the verbatim wording the person read, so only
 * the page that showed it can supply it. Nobody read anything here: what actually happened is that
 * a member of the campaign says somebody asked them. The honest record of that is who wrote it
 * down and when, and letting a browser post its own wording would turn the one column that exists
 * to be evidence into free text.
 */
export function manualConsentText(recordedBy: string, at: Date): string {
  return `Asked by phone, text or in person; recorded by ${recordedBy} on ${CONSENT_DATE.format(at)}.`;
}

/**
 * One row of the organizer's queue, the matcher's candidates riding along as a JSON array (phase
 * 8): the queue is where an organizer confirms or rejects the matcher's suggestions, so the two
 * are one screen and one read. Candidate rows carry voter names and addresses — organizer-only,
 * like /search.
 *
 * Kept as one fragment because the manual POST and PATCH answer with exactly the row the GET
 * returns, so a new row drops straight into the list the client is already holding; three copies
 * of this projection would drift the first time a column is added. It is also an explicit
 * allow-list in the sense `serialize.ts` means: `ip`, `user_agent` and `origin` are provenance
 * kept for abuse handling and never leave the server.
 *
 * `tail` is always a literal from this file (a WHERE / ORDER BY / LIMIT clause), never user input.
 */
const REQUEST_ROW = `
    SELECT pr.id, pr.created_at, pr.name, pr.email, pr.phone, pr.address, pr.note, pr.wants,
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
      ) mc ON true`;
const requestQuery = (tail: string): string => `${REQUEST_ROW}\n      ${tail}`;

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

    // Every row carries `source` ('web' straight off the form, 'website' from the sync, 'manual'
    // typed in here), which is how the queue tells them apart and what the edit/delete routes
    // below gate on.
    const rows = await q<Record<string, unknown>>(
      app.db,
      requestQuery(
        `${qp.open ? 'WHERE pr.handled_at IS NULL' : ''}
       ORDER BY pr.created_at DESC
       LIMIT $1`,
      ),
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
   * Write one down by hand. Most sign requests never touch the form: somebody rings the campaign
   * number, texts an organizer, or stops one outside the arena. The row is an ordinary
   * `public_request` with `source = 'manual'`, so the queue, the matcher, the handled verdict and
   * the household/sign pointers all work on it unchanged and nothing needed a new table.
   */
  app.post('/public/requests/manual', { preHandler: requireRole('organizer') }, async (req, reply) => {
    const b = manualBody.parse(req.body ?? {});
    const me = req.session!.user;

    // The public form's rule, one field wider. A hand-entered request often has no email and no
    // phone at all — a neighbour flagged somebody down and gave a street and a house — and an
    // address on its own is enough to go and knock. With none of the three there is nothing to
    // act on: the row would sit in the queue forever because nobody could ever find this person.
    if (!b.email && !b.phone && !b.address) {
      throw badRequest('give an email address, a phone number or an address', 'contact_required');
    }

    // Checked rather than left to the foreign key, so a mistyped door is a plain 404 naming the
    // problem instead of a 500 out of Postgres.
    if (b.household_id) {
      const hh = await one<{ id: string }>(app.db, `SELECT id FROM household WHERE id = $1`, [b.household_id]);
      if (!hh) throw notFound('no household with that id', 'household_not_found');
    }

    // Same treatment as the public form: normalised when it can be, kept as typed when it cannot.
    // Someone reading a number off a note in a car park is exactly who gets this wrong, and the
    // campaign would rather hold a messy number than refuse the request.
    let phone = b.phone ?? null;
    if (phone) {
      try {
        phone = normalizeContactValue('phone', phone);
      } catch {
        req.log.info({ route: 'public-requests' }, 'manual request: phone kept as typed');
      }
    }

    const created = await one<{ id: string }>(
      app.db,
      // `origin`, `ip` and `user_agent` stay NULL on purpose. They are the provenance columns for a
      // browser that posted a form; this row did not come from one, and stamping the organizer's
      // own address into them would put a lie in the three columns that exist to tell a real
      // submission from abuse.
      //
      // `matched_at` is set only when a door was picked. The matcher scans
      // `matched_at IS NULL AND handled_at IS NULL` across every source, so a row that already has
      // its answer must be stamped or the matcher will spend a pass suggesting candidates for a
      // question a human has already settled. With no door picked it stays NULL, which is the
      // useful case: the matcher will offer the organizer three names to choose from.
      `INSERT INTO public_request (name, email, phone, address, note, wants, consent_text, source,
                                   household_id, matched_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, 'manual', $8,
               CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [
        b.name,
        b.email ?? null,
        phone,
        b.address ?? null,
        b.note ?? null,
        b.wants,
        manualConsentText(me.name, new Date()),
        b.household_id ?? null,
      ],
    );
    const id = created!.id;

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'create_manual_request',
      target: id,
      // What was asked for and whether a door was picked — never the name, email, phone or
      // address, which would make audit_log a second copy of the very row it is recording.
      detail: { wants: b.wants, has_household: Boolean(b.household_id) },
      ip: req.ip,
    });

    // Answered with the queue's own row shape so the client can drop it straight into the list.
    const request = await one<Record<string, unknown>>(app.db, requestQuery('WHERE pr.id = $1'), [id]);
    return reply.status(201).send({ request });
  });

  /**
   * Correct one. **Manual rows only.** A website sign-up is the record of what somebody actually
   * submitted, beside the consent wording they actually read; editing it would leave the campaign
   * holding a consent record it had quietly rewritten, which is worse than holding none. (It would
   * also lose: the five-minute website sync upserts that row on `external_id` and would put the
   * original text straight back.) A row an organizer typed in is theirs to fix.
   */
  app.patch('/public/requests/:id/fields', { preHandler: requireRole('organizer') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const patch = fieldsBody.parse(raw);
    const me = req.session!.user;

    // `null` means clear it and absent means leave it alone, so which keys were sent is read off
    // the raw body — after zod has had its say about the values.
    const given = EDITABLE.filter((f) => Object.prototype.hasOwnProperty.call(raw, f));
    if (given.length === 0) throw badRequest('give at least one field to change');

    const current = await one<{
      source: string;
      email: string | null;
      phone: string | null;
      address: string | null;
      household_id: string | null;
    }>(app.db, `SELECT source, email, phone, address, household_id FROM public_request WHERE id = $1`, [id]);
    if (!current) throw notFound('no such request');
    if (current.source !== 'manual') {
      throw forbidden(
        'this request was submitted from the website; it is the record of what that person said, ' +
          'not ours to rewrite. Add a note against it instead.',
        'not_editable',
      );
    }

    let phone = patch.phone ?? null;
    if (phone) {
      try {
        phone = normalizeContactValue('phone', phone);
      } catch {
        req.log.info({ route: 'public-requests' }, 'manual request: phone kept as typed');
      }
    }

    if (given.includes('household_id') && patch.household_id) {
      const hh = await one<{ id: string }>(app.db, `SELECT id FROM household WHERE id = $1`, [patch.household_id]);
      if (!hh) throw notFound('no household with that id', 'household_not_found');
    }

    // The create's rule has to hold after an edit too, or clearing a typo'd phone number is a way
    // to end up with the unactionable row the create refuses to make.
    const after = {
      email: given.includes('email') ? (patch.email ?? null) : current.email,
      phone: given.includes('phone') ? phone : current.phone,
      address: given.includes('address') ? (patch.address ?? null) : current.address,
    };
    if (!after.email && !after.phone && !after.address) {
      throw badRequest('give an email address, a phone number or an address', 'contact_required');
    }

    const params: unknown[] = [id];
    const sets: string[] = [];
    const push = (col: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    for (const f of given) {
      if (f === 'phone') push('phone', phone);
      else if (f === 'wants') push('wants', patch.wants, '::text[]');
      else if (f === 'household_id') {
        push('household_id', patch.household_id ?? null);
        // `matched_at` follows the link, for the same reason the create stamps it: picking a door
        // is a human answering the matcher's question, and unlinking withdraws that answer so the
        // matcher should look again. This is the rule `/decide`'s reject path already follows.
        sets.push(patch.household_id ? 'matched_at = now()' : 'matched_at = NULL');
      } else push(f, patch[f] ?? null);
    }

    await q(app.db, `UPDATE public_request SET ${sets.join(', ')} WHERE id = $1 AND source = 'manual'`, params);

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'update_manual_request',
      target: id,
      // The NAMES of the fields that changed, never their values — an audit log that recorded the
      // old phone number would be an un-withdrawable copy of it. `from_household` is whether the
      // row was already linked to a door before this edit, so the trail shows a link being added,
      // kept or removed without naming it.
      detail: { fields: given, from_household: Boolean(current.household_id) },
      ip: req.ip,
    });

    const request = await one<Record<string, unknown>>(app.db, requestQuery('WHERE pr.id = $1'), [id]);
    return { request };
  });

  /**
   * Remove one. **Manual rows only**, and the reason is not symmetry with the PATCH above. A
   * website sign-up is a CASL consent record: the campaign may have to produce it, and deleting it
   * is destroying the evidence for messages it has already sent. It would also not work — the
   * five-minute sync would re-insert the row from the website on its next pull. A mistyped manual
   * row has no such standing; it is a note somebody wrote in the wrong place.
   */
  app.delete('/public/requests/:id', { preHandler: requireRole('organizer') }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const me = req.session!.user;

    const row = await one<{ source: string; wants: string[]; household_id: string | null }>(
      app.db,
      `SELECT source, wants, household_id FROM public_request WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('no such request');
    if (row.source !== 'manual') {
      throw forbidden(
        'this request came from the website: it is a consent record the campaign may have to ' +
          'produce, and the website sync would re-create it anyway. Mark it handled instead.',
        'not_deletable',
      );
    }

    // `match_candidate` rows die with it (ON DELETE CASCADE, migration 007). The subscriber_link
    // ledger is deliberately FK-free and keyed on this id, but nothing reads a ledger row whose
    // request is gone and a uuid never recurs, so the stale entry is inert.
    await q(app.db, `DELETE FROM public_request WHERE id = $1 AND source = 'manual'`, [id]);

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'delete_manual_request',
      target: id,
      detail: { wants: row.wants, had_household: Boolean(row.household_id) },
      ip: req.ip,
    });
    return reply.status(204).send();
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
