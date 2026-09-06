/**
 * Phase 5 — opt-in SMS (priority) and email (fallback) to electors.
 *
 * ---------------------------------------------------------------------------------------------
 * THE SAFETY RULE, above everything else in this file
 * ---------------------------------------------------------------------------------------------
 * This subsystem can text thousands of real people. It must be impossible to do that by accident,
 * so there are four independent brakes and all four must be released deliberately:
 *
 *   1. **The provider defaults to `log`** and sends nothing. Real sending needs
 *      `MESSAGING_PROVIDER=twilio` *and* credentials — both absent by default (`messaging/provider.ts`).
 *   2. **A campaign cannot leave `draft` without an approver.** `POST /:id/approve` is a separate
 *      call from `POST /:id/send`, by design: composing and authorising are different acts and a
 *      single fat-fingered button must not be both. An approved campaign also becomes immutable —
 *      you cannot approve a benign draft and then edit the body.
 *   3. **`MESSAGING_MAX_AUDIENCE` (5,000) refuses an oversized send** unless the request body says
 *      `override_max_audience: true`. "I meant to test on my ward" cannot become 17,000 texts.
 *   4. **The transport itself is a drip.** Daily caps per number and quiet hours are enforced in
 *      the worker, not here, so no endpoint can bypass them.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THERE IS NO "SEND TO EVERYONE" ENDPOINT
 * ---------------------------------------------------------------------------------------------
 * An unregistered Canadian local long code carries ~100–250 messages a day and drops the excess
 * SILENTLY (plan §1.1). Seventeen thousand electors on ten numbers is a seven-to-seventeen-DAY
 * send. A "text everyone tonight" button cannot be honoured by the transport, so offering one
 * would be a lie that fails after the polls close — the worst way for a GOTV tool to fail. What
 * this API offers instead is an audience count with an honest `estimated_days`, and a send that
 * drips, shows progress, and can be paused.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { currentSession, requireRole } from '../auth/guard.js';
import { one, q, withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { segmentInfo } from '../lib/segments.js';
import {
  audienceCounts,
  audienceRows,
  parseAudience,
  type AudienceFilter,
  type CampaignPurpose,
} from '../messaging/audience.js';
import {
  applyStop,
  attachConsent,
  classifyInbound,
  helpReply,
  joinReply,
  outstandingPending,
  stopReply,
  textToJoinConsent,
} from '../messaging/inbound.js';
import { normalizeContactValue } from './voter-contacts.js';

// ---------------------------------------------------------------- schemas

const PURPOSES = ['gotv', 'updates'] as const;
const idParams = z.object({ id: z.string().uuid() });

const csvList = z
  .string()
  .max(200)
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

const audienceQuery = z.object({
  purpose: z.enum(PURPOSES),
  ward: csvList.optional(),
  community: csvList.optional(),
});

const audienceBody = z.object({
  ward: z.array(z.string().trim().min(1).max(4)).max(20).optional(),
  community: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
});

const createCampaign = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.enum(PURPOSES),
  // The SMS body is where a curly apostrophe costs money, so it is capped at something a human
  // would plausibly send rather than at a database limit. See POST /segments.
  body_sms: z.string().max(1600).nullish(),
  email_subject: z.string().trim().max(200).nullish(),
  body_email: z.string().max(20_000).nullish(),
  audience: audienceBody.nullish(),
  scheduled_for: z.string().datetime().nullish(),
});

const patchCampaign = createCampaign.partial().refine((b) => Object.keys(b).length > 0, {
  message: 'nothing to update',
});

const sendBody = z
  .object({
    /**
     * The explicit release of brake 3. Named for what it does rather than something like `force`,
     * so it reads clearly in a request log six weeks later.
     */
    override_max_audience: z.boolean().optional(),
  })
  .nullish();

const testBody = z.object({ to: z.string().trim().min(3).max(30) });
const segmentsBody = z.object({ text: z.string().max(20_000) });

const createNumber = z.object({
  e164: z.string().trim().min(3).max(30),
  label: z.string().trim().max(100).nullish(),
  provider: z.string().trim().max(40).nullish(),
  // Conservative ceiling. The reported long-code limit is 100–250/day and the excess is DROPPED
  // without an error, so a cap set optimistically loses messages invisibly (plan §1.1).
  daily_cap: z.number().int().min(1).max(1000).optional(),
  active: z.boolean().optional(),
});

const patchNumber = z
  .object({
    label: z.string().trim().max(100).nullish(),
    daily_cap: z.number().int().min(1).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'nothing to update' });

// ---------------------------------------------------------------- rows / serialization

interface CampaignRow {
  id: string;
  name: string;
  purpose: CampaignPurpose;
  body_sms: string | null;
  email_subject: string | null;
  body_email: string | null;
  status: string;
  scheduled_for: Date | null;
  audience: unknown;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
}

const CAMPAIGN_SELECT = `
  SELECT mc.id, mc.name, mc.purpose::text AS purpose, mc.body_sms, mc.email_subject, mc.body_email,
         mc.status::text AS status, mc.scheduled_for, mc.audience,
         mc.created_by, cu.name AS created_by_name, mc.created_at, mc.started_at, mc.finished_at,
         mc.approved_by, au.name AS approved_by_name, mc.approved_at,
         p.total, p.queued, p.sent, p.delivered, p.failed, p.skipped
  FROM message_campaign mc
  LEFT JOIN app_user cu ON cu.id = mc.created_by
  LEFT JOIN app_user au ON au.id = mc.approved_by
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE ms.status = 'queued')::int    AS queued,
           count(*) FILTER (WHERE ms.status = 'sent')::int      AS sent,
           count(*) FILTER (WHERE ms.status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE ms.status = 'failed')::int    AS failed,
           count(*) FILTER (WHERE ms.status = 'skipped')::int   AS skipped
    FROM message_send ms WHERE ms.campaign_id = mc.id
  ) p ON true`;

function serializeCampaign(row: CampaignRow): Record<string, unknown> {
  const info = row.body_sms ? segmentInfo(row.body_sms) : null;
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    body_sms: row.body_sms,
    email_subject: row.email_subject,
    body_email: row.body_email,
    status: row.status,
    scheduled_for: row.scheduled_for,
    audience: row.audience ?? {},
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    approved_by: row.approved_by,
    approved_by_name: row.approved_by_name,
    approved_at: row.approved_at,
    // Segment maths travels with the campaign so a reviewer sees the bill before approving it,
    // not after the send. A UCS-2 body here means one smart quote tripled the cost.
    sms_segments: info?.segments ?? 0,
    sms_encoding: info?.encoding ?? null,
    progress: {
      total: row.total,
      queued: row.queued,
      // `sent` and `delivered` are DISTINCT, not cumulative. A pile of `sent` that never becomes
      // `delivered` is the signature of a carrier silently eating the send — see POST /status.
      sent: row.sent,
      delivered: row.delivered,
      failed: row.failed,
      skipped: row.skipped,
    },
  };
}

interface NumberRow {
  id: string;
  e164: string;
  provider: string;
  label: string | null;
  daily_cap: number;
  sent_today: number;
  cap_reset_on: Date | string;
  active: boolean;
  created_at: Date;
}

// ---------------------------------------------------------------- webhook authentication

/** Constant-time compare of two possibly-undefined strings. */
function secretEquals(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhooks carry no session cookie — the caller is a carrier, not a person — so they are
 * authenticated by the provider's own signature, plus an optional shared secret that applies to
 * EVERY provider including `log`. Both must pass.
 *
 * This matters more than it looks: an unauthenticated `POST /inbound` with `Body=JOIN` would mint
 * consent for a number of the caller's choosing, and that number would then receive campaign
 * texts it never asked for.
 */
function assertWebhookAuth(app: FastifyInstance, req: FastifyRequest): Record<string, string> {
  const cfg = app.config;
  if (cfg.MESSAGING_WEBHOOK_TOKEN) {
    const query = req.query as Record<string, unknown> | undefined;
    const given = query?.token ?? req.headers['x-webhook-token'];
    if (!secretEquals(given, cfg.MESSAGING_WEBHOOK_TOKEN)) {
      throw unauthorized('webhook token missing or wrong', 'invalid_webhook_token');
    }
  }
  const params: Record<string, string> = {};
  const body = req.body;
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string') params[k] = v;
    }
  }
  // The signed material is the URL the provider was configured with, which is the public one —
  // never `req.hostname`, which a caller controls via the Host header.
  const url = `https://${cfg.DOMAIN}${req.url}`;
  const signature = req.headers['x-twilio-signature'];
  if (!app.messaging.provider.verifyWebhook({ signature: typeof signature === 'string' ? signature : undefined, url, params })) {
    throw unauthorized('webhook signature verification failed', 'invalid_signature');
  }
  return params;
}

/** Providers name their form fields differently; accept the Twilio names and plain lower-case ones. */
const field = (p: Record<string, string>, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = p[n];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
};

// ---------------------------------------------------------------- routes

export const messagingRoutes: FastifyPluginAsync = async (app) => {
  const organizerOnly = requireRole('organizer');

  const loadCampaign = async (id: string): Promise<CampaignRow> => {
    const row = await one<CampaignRow>(app.db, `${CAMPAIGN_SELECT} WHERE mc.id = $1`, [id]);
    if (!row) throw notFound('campaign not found');
    return row;
  };

  const filterOf = (row: CampaignRow): AudienceFilter => parseAudience(row.audience);

  /**
   * GET /api/messaging/audience?purpose=gotv&ward=01,02&community=KOMOKA
   *
   * "How many people can we actually reach?" — the question that decides whether any of the rest
   * of this is worth building (plan §4 step 1). `estimated_days` is the honest part: an organiser
   * has to be able to see that a Sunday send will not finish before Tuesday.
   */
  app.get('/audience', { preHandler: organizerOnly }, async (req) => {
    const qp = audienceQuery.parse(req.query);
    const me = currentSession(req).user;
    const filter: AudienceFilter = {
      ...(qp.ward && qp.ward.length ? { ward: qp.ward } : {}),
      ...(qp.community && qp.community.length ? { community: qp.community.map((c) => c.toUpperCase()) } : {}),
    };
    const counts = await audienceCounts(app.db, qp.purpose, filter);
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_audience',
      detail: { purpose: qp.purpose, ...filter, sms: counts.sms, email: counts.email },
      ip: req.ip,
    });
    return counts;
  });

  /**
   * POST /api/messaging/segments { text } → { chars, segments, encoding, offending }
   *
   * Pure arithmetic, no database. It is an endpoint rather than client-side code because the bill
   * is computed from the same function the sender uses, so the composer's warning and the actual
   * cost can never disagree. `offending` is the field that matters: one curly apostrophe drops the
   * limit from 160 characters to 70 and silently triples the cost of every message in the send.
   */
  app.post('/segments', { preHandler: requireRole('volunteer') }, async (req) => {
    const { text } = segmentsBody.parse(req.body);
    return segmentInfo(text);
  });

  // ---------------------------------------------------------------- campaigns

  app.get('/campaigns', { preHandler: organizerOnly }, async () => {
    const rows = await q<CampaignRow>(app.db, `${CAMPAIGN_SELECT} ORDER BY mc.created_at DESC LIMIT 200`);
    return { campaigns: rows.map(serializeCampaign) };
  });

  app.post('/campaigns', { preHandler: organizerOnly }, async (req, reply) => {
    const body = createCampaign.parse(req.body);
    const me = currentSession(req).user;
    // Two statements, not a data-modifying CTE: the outer SELECT of a `WITH ins AS (INSERT ...)`
    // reads the snapshot taken before the statement began, so it cannot see the row just inserted.
    const inserted = await one<{ id: string }>(
      app.db,
      `INSERT INTO message_campaign (name, purpose, body_sms, email_subject, body_email, audience,
                                     scheduled_for, created_by)
       VALUES ($1, $2::campaign_purpose, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id`,
      [
        body.name,
        body.purpose,
        body.body_sms ?? null,
        body.email_subject ?? null,
        body.body_email ?? null,
        JSON.stringify(body.audience ?? {}),
        body.scheduled_for ?? null,
        me.id,
      ],
    );
    if (!inserted) throw new Error('campaign insert returned no row');
    const row = await loadCampaign(inserted.id);
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'create_campaign',
      target: row.id,
      detail: { name: row.name, purpose: row.purpose },
      ip: req.ip,
    });
    return reply.status(201).send({ campaign: serializeCampaign(row) });
  });

  app.get('/campaigns/:id', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    return { campaign: serializeCampaign(await loadCampaign(id)) };
  });

  /**
   * PATCH — draft only, and only while UNAPPROVED. Editing after approval would make approval
   * meaningless: approve something harmless, then swap the body. Re-editing an approved campaign
   * means creating a new one, which costs thirty seconds and closes the hole entirely.
   */
  app.patch('/campaigns/:id', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchCampaign.parse(req.body);
    const me = currentSession(req).user;
    const before = await loadCampaign(id);
    if (before.status !== 'draft') throw conflict(`a ${before.status} campaign cannot be edited`, 'not_draft');
    if (before.approved_at) {
      throw conflict('an approved campaign cannot be edited — create a new one', 'already_approved');
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (body.name !== undefined) set('name', body.name);
    if (body.purpose !== undefined) set('purpose', body.purpose, '::campaign_purpose');
    if (body.body_sms !== undefined) set('body_sms', body.body_sms ?? null);
    if (body.email_subject !== undefined) set('email_subject', body.email_subject ?? null);
    if (body.body_email !== undefined) set('body_email', body.body_email ?? null);
    if (body.audience !== undefined) set('audience', JSON.stringify(body.audience ?? {}), '::jsonb');
    if (body.scheduled_for !== undefined) set('scheduled_for', body.scheduled_for ?? null);
    if (sets.length > 0) {
      await app.db.query(`UPDATE message_campaign SET ${sets.join(', ')} WHERE id = $1`, params);
    }

    const row = await loadCampaign(id);
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'update_campaign',
      target: id,
      detail: { fields: Object.keys(body) },
      ip: req.ip,
    });
    return { campaign: serializeCampaign(row) };
  });

  /**
   * POST /:id/approve — the deliberate speed bump.
   *
   * A campaign cannot leave `draft` without `approved_by`/`approved_at`, and this is the only
   * endpoint that sets them. It is separate from `/send` on purpose: a person authorising a few
   * thousand texts should have to say so in its own request, and the audit trail should record
   * WHO said so, distinctly from who pressed go.
   */
  app.post('/campaigns/:id/approve', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;
    const before = await loadCampaign(id);
    if (before.status !== 'draft') throw conflict(`a ${before.status} campaign cannot be approved`, 'not_draft');
    if (before.approved_at) throw conflict('this campaign is already approved', 'already_approved');
    if (!before.body_sms?.trim() && !before.body_email?.trim()) {
      throw badRequest('a campaign with no body cannot be approved', 'empty_body');
    }
    await app.db.query(`UPDATE message_campaign SET approved_by = $2, approved_at = now() WHERE id = $1`, [id, me.id]);
    const row = await loadCampaign(id);
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'approve_campaign',
      target: id,
      detail: { name: row.name, purpose: row.purpose, sms_segments: row.body_sms ? segmentInfo(row.body_sms).segments : 0 },
      ip: req.ip,
    });
    return { campaign: serializeCampaign(row) };
  });

  /**
   * POST /:id/send — materialise one `message_send` row per recipient and start the worker.
   *
   * The rows are the point: one per recipient per campaign is what makes "did she get it?"
   * answerable and what stops a retry sending twice (the UNIQUE key does the rest). Nothing is
   * sent by this request — it queues, and the worker drips.
   */
  app.post('/campaigns/:id/send', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = sendBody.parse(req.body) ?? {};
    const me = currentSession(req).user;
    const max = app.config.MESSAGING_MAX_AUDIENCE;

    const queued = await withTx(app.db, async (client) => {
      // Lock the campaign row so two clicks of "send" cannot both pass the status check.
      const locked = await one<{ status: string; purpose: CampaignPurpose; approved_at: Date | null; audience: unknown }>(
        client,
        `SELECT status::text AS status, purpose::text AS purpose, approved_at, audience
         FROM message_campaign WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!locked) throw notFound('campaign not found');
      if (locked.status !== 'draft') throw conflict(`a ${locked.status} campaign cannot be sent`, 'not_draft');
      // Brake 2. Without an approver there is no send, full stop.
      if (!locked.approved_at) {
        throw conflict('this campaign has not been approved — POST /approve first', 'not_approved');
      }

      const filter = parseAudience(locked.audience);
      const counts = await audienceCounts(client, locked.purpose, filter);
      const size = counts.sms + counts.email;
      if (size === 0) throw badRequest('nobody in this audience has consented to be messaged', 'empty_audience');
      // Brake 3.
      if (size > max && body?.override_max_audience !== true) {
        throw conflict(
          `audience of ${size} exceeds MESSAGING_MAX_AUDIENCE (${max}); ` +
            'narrow the audience, or resend with { "override_max_audience": true }',
          'audience_too_large',
        );
      }

      const rows = await audienceRows(client, locked.purpose, filter);
      await client.query(
        `INSERT INTO message_send (campaign_id, voter_contact_id, channel)
         SELECT $1, x.vc::uuid, x.ch::message_channel
         FROM unnest($2::uuid[], $3::text[]) AS x(vc, ch)
         ON CONFLICT (campaign_id, voter_contact_id) DO NOTHING`,
        [id, rows.map((r) => r.voter_contact_id), rows.map((r) => r.channel)],
      );
      await client.query(`UPDATE message_campaign SET status = 'sending', started_at = now() WHERE id = $1`, [id]);
      return { size, sms: counts.sms, email: counts.email, estimated_days: counts.estimated_days };
    });

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'send_campaign',
      target: id,
      detail: { ...queued, override_max_audience: body?.override_max_audience === true, provider: app.messaging.provider.name },
      ip: req.ip,
    });
    // Fire and forget: the drip runs for hours or days, and the HTTP response must not wait on it.
    app.messaging.worker.kick();
    return { campaign: serializeCampaign(await loadCampaign(id)), queued: queued.size, estimated_days: queued.estimated_days };
  });

  /** Pause a running drip. Queued rows stay queued; the worker's join excludes a paused campaign. */
  app.post('/campaigns/:id/pause', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;
    const row = await one<{ id: string }>(
      app.db,
      `UPDATE message_campaign SET status = 'paused' WHERE id = $1 AND status = 'sending' RETURNING id`,
      [id],
    );
    if (!row) {
      await loadCampaign(id); // 404 when it does not exist at all
      throw conflict('only a sending campaign can be paused', 'not_sending');
    }
    await audit(app.db, req.log, { userId: me.id, action: 'pause_campaign', target: id, ip: req.ip });
    return { campaign: serializeCampaign(await loadCampaign(id)) };
  });

  app.post('/campaigns/:id/resume', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;
    const row = await one<{ id: string }>(
      app.db,
      `UPDATE message_campaign SET status = 'sending' WHERE id = $1 AND status = 'paused' RETURNING id`,
      [id],
    );
    if (!row) {
      await loadCampaign(id);
      throw conflict('only a paused campaign can be resumed', 'not_paused');
    }
    await audit(app.db, req.log, { userId: me.id, action: 'resume_campaign', target: id, ip: req.ip });
    app.messaging.worker.kick();
    return { campaign: serializeCampaign(await loadCampaign(id)) };
  });

  /**
   * Cancel. Everything still queued becomes `skipped` with a reason rather than being deleted —
   * "we decided not to send this" is a fact about that recipient worth keeping, and it keeps the
   * per-recipient row that answers "did she get it?" honest.
   */
  app.post('/campaigns/:id/cancel', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const me = currentSession(req).user;
    const cancelled = await withTx(app.db, async (client) => {
      const row = await one<{ id: string }>(
        client,
        `UPDATE message_campaign SET status = 'cancelled', finished_at = now()
         WHERE id = $1 AND status IN ('draft', 'scheduled', 'sending', 'paused')
         RETURNING id`,
        [id],
      );
      if (!row) return null;
      const res = await client.query(
        `UPDATE message_send SET status = 'skipped', skip_reason = 'cancelled'
         WHERE campaign_id = $1 AND status = 'queued'`,
        [id],
      );
      return res.rowCount ?? 0;
    });
    if (cancelled === null) {
      await loadCampaign(id);
      throw conflict('this campaign is already finished', 'not_cancellable');
    }
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'cancel_campaign',
      target: id,
      detail: { unsent_skipped: cancelled },
      ip: req.ip,
    });
    return { campaign: serializeCampaign(await loadCampaign(id)) };
  });

  /**
   * POST /:id/test { to } — send the draft to ONE number, bypassing the audience entirely.
   *
   * Always allowed, at any status, approved or not: catching the é trap is cheapest here (plan §4
   * step 4), and a composer you cannot try is a composer nobody trusts. Always audited, because it
   * is still a real message to a real handset when the provider is real.
   */
  app.post('/campaigns/:id/test', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const { to } = testBody.parse(req.body);
    const me = currentSession(req).user;
    const campaign = await loadCampaign(id);
    const body = campaign.body_sms?.trim();
    if (!body) throw badRequest('this campaign has no SMS body to test', 'empty_body');
    const e164 = normalizeContactValue('phone', to);

    // A test does not go through the queue (there is no voter_contact to hang a message_send on),
    // but it DOES take a number out of the pool and count against that number's daily cap — the
    // cap is a real carrier limit and a test message spends it like any other.
    const sender = await one<{ id: string; e164: string }>(
      app.db,
      `SELECT id, e164 FROM sender_number WHERE active AND sent_today < daily_cap ORDER BY sent_today, e164 LIMIT 1`,
    );
    const result = await app.messaging.provider.send(e164, body, sender ? { from: sender.e164 } : {});
    if (sender) {
      await app.db.query(`UPDATE sender_number SET sent_today = sent_today + 1 WHERE id = $1`, [sender.id]);
    }

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'test_send',
      target: id,
      // No phone number in the detail — audit_log must not become a second copy of contact data.
      detail: { provider: app.messaging.provider.name, segments: result.segments, from: sender?.e164 ?? null },
      ip: req.ip,
    });
    return {
      sent: true,
      provider: app.messaging.provider.name,
      provider_message_id: result.providerId,
      ...segmentInfo(body),
    };
  });

  // ---------------------------------------------------------------- sender numbers

  app.get('/numbers', { preHandler: organizerOnly }, async () => {
    const numbers = await q<NumberRow>(
      app.db,
      `SELECT id, e164, provider, label, daily_cap, sent_today, cap_reset_on, active, created_at
       FROM sender_number ORDER BY active DESC, e164`,
    );
    return {
      numbers,
      // The throughput ceiling, in one number. This is the constraint on the whole subsystem —
      // cost is not (plan §1.1, §3.6).
      daily_capacity: numbers.filter((n) => n.active).reduce((sum, n) => sum + n.daily_cap, 0),
    };
  });

  app.post('/numbers', { preHandler: organizerOnly }, async (req, reply) => {
    const body = createNumber.parse(req.body);
    const me = currentSession(req).user;
    const e164 = normalizeContactValue('phone', body.e164);
    const existing = await one<{ id: string }>(app.db, `SELECT id FROM sender_number WHERE e164 = $1`, [e164]);
    if (existing) throw conflict('this number is already in the pool', 'number_exists');
    const row = await one<NumberRow>(
      app.db,
      `INSERT INTO sender_number (e164, provider, label, daily_cap, active)
       VALUES ($1, $2, $3, coalesce($4, 100), coalesce($5, true))
       RETURNING id, e164, provider, label, daily_cap, sent_today, cap_reset_on, active, created_at`,
      [e164, body.provider ?? app.config.MESSAGING_PROVIDER, body.label ?? null, body.daily_cap ?? null, body.active ?? null],
    );
    if (!row) throw new Error('sender_number insert returned no row');
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'create_sender_number',
      target: row.id,
      detail: { e164: row.e164, daily_cap: row.daily_cap, provider: row.provider },
      ip: req.ip,
    });
    return reply.status(201).send({ number: row });
  });

  app.patch('/numbers/:id', { preHandler: organizerOnly }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = patchNumber.parse(req.body);
    const me = currentSession(req).user;
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.label !== undefined) set('label', body.label ?? null);
    if (body.daily_cap !== undefined) set('daily_cap', body.daily_cap);
    if (body.active !== undefined) set('active', body.active);
    const row = await one<NumberRow>(
      app.db,
      `UPDATE sender_number SET ${sets.join(', ')} WHERE id = $1
       RETURNING id, e164, provider, label, daily_cap, sent_today, cap_reset_on, active, created_at`,
      params,
    );
    if (!row) throw notFound('sender number not found');
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'update_sender_number',
      target: id,
      detail: { e164: row.e164, daily_cap: row.daily_cap, active: row.active },
      ip: req.ip,
    });
    return { number: row };
  });

  // ---------------------------------------------------------------- webhooks (no session auth)

  /**
   * POST /api/messaging/inbound — everything a recipient texts back.
   *
   * STOP is honoured IMMEDIATELY and unconditionally, including from a number that matches nothing
   * we hold: a person telling us to stop is telling us to stop whether or not we can find them in
   * the database, and if that number is ever collected at a door later, the inbound row is there
   * to say they already said no. Queued messages to a withdrawn number are caught by the worker's
   * dequeue-time re-check, so there is nothing to chase down here.
   */
  app.post(
    '/inbound',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const params = assertWebhookAuth(app, req);
      const rawFrom = field(params, 'From', 'from');
      const rawBody = field(params, 'Body', 'body') ?? '';
      const to = field(params, 'To', 'to') ?? null;
      const providerId = field(params, 'MessageSid', 'SmsSid', 'message_sid') ?? null;
      if (!rawFrom) throw badRequest('missing From', 'missing_from');

      let e164: string;
      try {
        e164 = normalizeContactValue('phone', rawFrom);
      } catch {
        // Never reject an inbound because we could not parse the sender — record it verbatim and
        // move on. A malformed From is the provider's problem; dropping a STOP is ours.
        e164 = rawFrom.trim().slice(0, 30);
      }
      const action = classifyInbound(rawBody);

      // Insert first, with the provider's own id as the idempotency key: a carrier retrying its
      // webhook must not produce a second confirmation text. A provider that sends no id cannot be
      // de-duplicated (UNIQUE permits many NULLs), which is acceptable — the actions are all
      // idempotent in their own right, only the reply would repeat.
      const inbound = await one<{ id: string }>(
        app.db,
        `INSERT INTO message_inbound (from_e164, to_e164, body, action, provider_message_id)
         VALUES ($1, $2, $3, $4::inbound_action, $5)
         ON CONFLICT (provider_message_id) DO NOTHING
         RETURNING id`,
        [e164, to, rawBody.slice(0, 2000), action, providerId],
      );
      if (!inbound) return reply.status(200).send({ ok: true, action, duplicate: true });

      let matched: string[] = [];
      let replyText: string | null = null;
      let confirmedPending: string | null = null;

      if (action === 'stop') {
        matched = await applyStop(app.db, e164);
        replyText = stopReply(app.config.MESSAGING_ORG_NAME);
        await audit(app.db, req.log, {
          userId: null,
          action: 'inbound_stop',
          target: inbound.id,
          // `matched: 0` is the interesting case and is deliberately recorded, not swallowed.
          detail: { matched: matched.length, from_known: matched.length > 0 },
          ip: req.ip,
        });
      } else if (action === 'join') {
        const pending = await outstandingPending(app.db, e164);
        if (pending) {
          await app.db.query(`UPDATE subscribe_pending SET confirmed_at = now() WHERE id = $1`, [pending.id]);
          confirmedPending = pending.id;
          matched = await attachConsent(app.db, e164, {
            gotv: pending.wants_gotv,
            updates: pending.wants_updates,
            consentText: pending.consent_text,
          });
        } else {
          // Text-to-join: the act of texting us IS the consent, and it carries the carrier's own
          // timestamp — the strongest proof of any of the three routes in (plan §3.2).
          matched = await attachConsent(app.db, e164, {
            gotv: true,
            updates: false,
            consentText: textToJoinConsent(rawBody),
          });
        }
        replyText = joinReply(app.config.MESSAGING_ORG_NAME);
        await audit(app.db, req.log, {
          userId: null,
          action: 'inbound_join',
          target: inbound.id,
          detail: {
            matched: matched.length,
            confirmed_pending: confirmedPending !== null,
            // True when consent is recorded but there is no household to hang a voter_contact on —
            // see the KNOWN LIMIT note in messaging/inbound.ts.
            unattached: matched.length === 0,
          },
          ip: req.ip,
        });
      } else if (action === 'help') {
        replyText = helpReply(app.config.MESSAGING_ORG_NAME);
      }

      if (matched.length > 0) {
        await app.db.query(`UPDATE message_inbound SET matched_contact_id = $2 WHERE id = $1`, [inbound.id, matched[0]]);
      }

      if (replyText) {
        const sender = await one<{ e164: string }>(
          app.db,
          `SELECT e164 FROM sender_number WHERE active AND ($1::text IS NULL OR e164 = $1) ORDER BY e164 LIMIT 1`,
          [to],
        );
        try {
          await app.messaging.provider.send(e164, replyText, sender ? { from: sender.e164 } : {});
        } catch (err) {
          // A failed confirmation must never undo the action: the STOP is already stamped.
          req.log.error({ err, inbound: inbound.id, action }, 'messaging: could not send inbound confirmation');
        }
      }
      return reply.status(200).send({ ok: true, action, matched: matched.length });
    },
  );

  /**
   * POST /api/messaging/status — delivery receipts.
   *
   * ---------------------------------------------------------------------------------------------
   * THIS IS HOW A SILENT CARRIER THROTTLE IS DETECTED, and it is the entire reason `message_send`
   * has a `delivered_at` column distinct from `sent_at`.
   * ---------------------------------------------------------------------------------------------
   * An unregistered Canadian long code over its daily allowance does not return an error. The
   * provider accepts the message, we mark it `sent`, and the carrier drops it on the floor. From
   * our side that failure is INVISIBLE — the send looks like a complete success right up until
   * election day, when it turns out nobody was reminded to vote.
   *
   * The only signal is the receipt that never arrives. A campaign whose `sent` count climbs while
   * `delivered` stays flat is being throttled, and the dashboard's job is to make that gap
   * impossible to miss. So receipts are not polish: they are the smoke detector for the one
   * failure mode that would otherwise be discovered after the polls close.
   */
  app.post(
    '/status',
    { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const params = assertWebhookAuth(app, req);
      const providerId = field(params, 'MessageSid', 'SmsSid', 'message_sid');
      const status = (field(params, 'MessageStatus', 'SmsStatus', 'status') ?? '').toLowerCase();
      const errorCode = field(params, 'ErrorCode', 'error_code') ?? null;
      if (!providerId) throw badRequest('missing MessageSid', 'missing_message_sid');

      if (status === 'delivered') {
        await app.db.query(
          `UPDATE message_send SET status = 'delivered', delivered_at = now()
           WHERE provider_message_id = $1 AND status IN ('sent', 'queued')`,
          [providerId],
        );
      } else if (status === 'undelivered' || status === 'failed') {
        // A receipt-reported failure is final: the carrier has already decided. It carries the
        // provider's own reason so an organiser can tell a blocked number from a dead one.
        await app.db.query(
          `UPDATE message_send SET status = 'failed', error = coalesce($2, 'carrier reported ' || $3)
           WHERE provider_message_id = $1 AND status <> 'delivered'`,
          [providerId, errorCode ? `carrier error ${errorCode}` : null, status],
        );
      }
      // 'queued'/'sending'/'sent' receipts are informational; the row is already in that state.
      return reply.status(200).send({ ok: true, status });
    },
  );
};
