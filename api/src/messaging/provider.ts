/**
 * The provider adapter — the layer between "the API decided to send something" and "a carrier
 * actually charged us and buzzed a real phone".
 *
 * ---------------------------------------------------------------------------------------------
 * THE SAFETY ARGUMENT — read this before changing anything in this file
 * ---------------------------------------------------------------------------------------------
 * This system can text thousands of real people. It must be impossible to do that by accident, so
 * the default implementation sends NOTHING:
 *
 *   * `MESSAGING_PROVIDER` defaults to `log`. The log provider writes the `message_send` rows and
 *     logs one line per message, and no packet leaves the building. Every endpoint, the worker,
 *     the number pool, the daily caps and the quiet hours all run exactly as they would in
 *     production — the only difference is that the last inch is a `log.info`.
 *   * Real sending needs `MESSAGING_PROVIDER=twilio` AND credentials. Both are absent by default,
 *     and `loadConfig` refuses to boot with the first without the second, so a half-configured
 *     deployment fails loudly at startup rather than quietly at 3am mid-send.
 *   * The Twilio adapter takes its `fetch` by injection, exactly as `lib/streetview.ts` does. No
 *     test can make a real, billed call, because no test hands it the real `fetch`.
 *
 * The interface is deliberately tiny — `send(to, body) -> { providerId, segments }` — so that a
 * second provider is a small file rather than a refactor, and so that the worker, which holds all
 * the throttling and consent logic, cannot be bypassed by a provider that decides to be clever.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { segmentInfo } from '../lib/segments.js';
import type { FetchLike } from '../lib/streetview.js';

export interface SendResult {
  /** The carrier's own id for the message. Delivery receipts arrive keyed on this. */
  providerId: string | null;
  /** Billed segments, as the provider counted them (we compute our own estimate too). */
  segments: number;
}

/**
 * A provider failure, carrying the one distinction the worker cares about.
 *
 * `permanent` means do not retry: an invalid number, a carrier block, a body the provider will
 * never accept. Retrying those burns daily cap that a deliverable message needed — and daily cap,
 * not money, is the binding constraint on this whole system.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface WebhookRequest {
  /** The provider's signature header, if it sent one. */
  signature: string | undefined;
  /** The absolute URL the provider was configured to POST to — part of the signed material. */
  url: string;
  /** Form fields exactly as received. */
  params: Record<string, string>;
}

export interface MessageProvider {
  readonly name: string;
  /** Send one SMS. `from` is the number the worker allocated out of the pool. */
  send(to: string, body: string, opts?: { from?: string }): Promise<SendResult>;
  /**
   * Send one email. Optional: email is the FALLBACK channel (plan §3.1), and a provider that only
   * carries SMS is a legitimate configuration — the worker fails those rows with a clear reason
   * rather than pretending they went.
   */
  sendEmail?(to: string, subject: string, body: string): Promise<SendResult>;
  /** Is this inbound webhook genuinely from the provider? */
  verifyWebhook(req: WebhookRequest): boolean;
}

/** What the log provider recorded. Tests assert on this; nothing in production reads it. */
export interface LoggedMessage {
  channel: 'sms' | 'email';
  to: string;
  from?: string | undefined;
  subject?: string | undefined;
  body: string;
  at: Date;
}

/**
 * The default. Writes the rows, logs the line, sends nothing.
 *
 * Not a stub — this is the provider a campaign runs on until the day it has a written answer from
 * a carrier (plan §4 step 0: Campaign Verify scope for a Canadian sender, and real long-code
 * throughput). Everything downstream is exercised for real against it.
 */
export class LogProvider implements MessageProvider {
  readonly name = 'log';
  /** Bounded so a long dry run cannot grow without limit. */
  private static readonly KEEP = 500;
  readonly sent: LoggedMessage[] = [];

  constructor(private readonly log: FastifyBaseLogger) {}

  private record(entry: LoggedMessage): void {
    this.sent.push(entry);
    if (this.sent.length > LogProvider.KEEP) this.sent.splice(0, this.sent.length - LogProvider.KEEP);
  }

  async send(to: string, body: string, opts?: { from?: string }): Promise<SendResult> {
    const info = segmentInfo(body);
    this.record({ channel: 'sms', to, from: opts?.from, body, at: new Date() });
    this.log.info(
      { to, from: opts?.from, chars: info.chars, segments: info.segments, encoding: info.encoding },
      'messaging: NOT SENT (MESSAGING_PROVIDER=log) — sms',
    );
    return { providerId: `log:${randomUUID()}`, segments: info.segments };
  }

  async sendEmail(to: string, subject: string, body: string): Promise<SendResult> {
    this.record({ channel: 'email', to, subject, body, at: new Date() });
    this.log.info({ to, subject }, 'messaging: NOT SENT (MESSAGING_PROVIDER=log) — email');
    return { providerId: `log:${randomUUID()}`, segments: 1 };
  }

  /**
   * There is no signature to check, because there is no provider. The webhook routes apply the
   * shared-secret check (`MESSAGING_WEBHOOK_TOKEN`) on top of this for every provider, which is
   * what protects a `log`-provider deployment that is nonetheless reachable from the internet.
   */
  verifyWebhook(): boolean {
    return true;
  }
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/**
 * Twilio error codes that mean "this will never work". Everything else — 429, 5xx, a dropped
 * connection — is treated as transient and retried with backoff.
 * https://www.twilio.com/docs/api/errors
 */
const TWILIO_PERMANENT = new Set([
  '21211', // invalid 'To' number
  '21214', // 'To' is not a valid mobile number
  '21408', // permission to send to this region is not enabled
  '21610', // recipient has replied STOP — the carrier is enforcing the opt-out for us
  '21612', // unreachable via this route
  '21614', // 'To' is not SMS-capable
  '30003', // handset unreachable / powered off, permanently undeliverable
  '30005', // unknown destination handset
  '30006', // landline or unreachable carrier
]);

export class TwilioProvider implements MessageProvider {
  readonly name = 'twilio';

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly creds: TwilioCredentials,
  ) {}

  async send(to: string, body: string, opts?: { from?: string }): Promise<SendResult> {
    if (!opts?.from) throw new ProviderError('no sender number was allocated for this message', true);
    const form = new URLSearchParams({ To: to, From: opts.from, Body: body });
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.creds.accountSid)}/Messages.json`;
    const auth = Buffer.from(`${this.creds.accountSid}:${this.creds.authToken}`).toString('base64');

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A network failure is transient by definition; the message has not been billed or sent.
      throw new ProviderError(`provider unreachable: ${(err as Error).message}`, false);
    }

    const text = await res.text();
    let payload: { sid?: string; num_segments?: string; code?: number; message?: string } = {};
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      /* fall through to the status-code branches with an empty payload */
    }

    if (!res.ok) {
      const code = payload.code === undefined ? undefined : String(payload.code);
      const permanent = res.status !== 429 && res.status < 500 && (code === undefined || TWILIO_PERMANENT.has(code));
      throw new ProviderError(payload.message ?? `provider returned ${res.status}`, permanent, code);
    }
    return {
      providerId: payload.sid ?? null,
      segments: Number(payload.num_segments ?? '1') || segmentInfo(body).segments,
    };
  }

  /**
   * Twilio signs a webhook as base64(HMAC-SHA1(authToken, url + every POST field sorted by name and
   * concatenated as name+value)). An unverified webhook is not a nuisance — `POST /inbound` with
   * `Body=JOIN` would mint consent for a number of the caller's choosing.
   */
  verifyWebhook(req: WebhookRequest): boolean {
    if (!req.signature) return false;
    const keys = Object.keys(req.params).sort();
    let material = req.url;
    for (const k of keys) material += k + req.params[k];
    const expected = createHmac('sha1', this.creds.authToken).update(Buffer.from(material, 'utf8')).digest('base64');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(req.signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export interface ProviderConfig {
  MESSAGING_PROVIDER: 'log' | 'twilio';
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
}

/**
 * Build the configured provider. `loadConfig` has already refused to boot a `twilio` configuration
 * without credentials, so the throw here is a belt-and-braces invariant rather than a user-facing
 * error path.
 */
export function createProvider(cfg: ProviderConfig, log: FastifyBaseLogger, fetchImpl: FetchLike): MessageProvider {
  if (cfg.MESSAGING_PROVIDER === 'twilio') {
    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) {
      throw new Error('MESSAGING_PROVIDER=twilio requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN');
    }
    log.warn(
      { provider: 'twilio' },
      'messaging: LIVE PROVIDER CONFIGURED — approved campaigns will send real, billed messages',
    );
    return new TwilioProvider(fetchImpl, {
      accountSid: cfg.TWILIO_ACCOUNT_SID,
      authToken: cfg.TWILIO_AUTH_TOKEN,
    });
  }
  return new LogProvider(log);
}
