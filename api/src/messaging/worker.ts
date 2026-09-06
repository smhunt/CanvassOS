/**
 * The send worker — a drip, not a blast.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS A LONG-RUNNING THROTTLED LOOP AND NOT A `for` OVER THE LIST
 * ---------------------------------------------------------------------------------------------
 * An unregistered Canadian local long code carries roughly 100–250 messages per day, and the
 * excess **fails silently** — not queued, dropped (plan §1.1). So the transport cannot honour
 * "text everyone on Sunday night", and a system that offers that button is lying. What it can do
 * is spread a send across hours or days and a pool of numbers, show honest progress, and be paused.
 * Every constraint below exists because of that one fact:
 *
 *   * each `sender_number` has a `daily_cap` and a `sent_today` that rolls over on `cap_reset_on`;
 *     when the pool is exhausted the worker STOPS for the day rather than posting into a void;
 *   * outside quiet hours it WAITS — the rows stay queued and go out when the window reopens;
 *   * one row is claimed at a time with `FOR UPDATE ... SKIP LOCKED`, so calling `POST /:id/send`
 *     twice, or two workers racing, cannot send the same message twice;
 *   * **consent and withdrawal are re-checked at dequeue, never trusted from queue time.** A list
 *     built on Friday must not deliver on Sunday to somebody who said stop on Saturday. Those rows
 *     become `skipped` with a `skip_reason`, which is a different and much more useful fact than
 *     `failed`.
 *
 * The transaction is held open across the provider call. That is deliberate: it is the simplest
 * construction in which a crash mid-call cannot leave a row marked sent that was not, and the
 * throughput ceiling this whole file exists to respect is ~100 messages per number per DAY — there
 * is no scenario in which holding one connection for one HTTP round trip is the bottleneck.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db.js';
import { isSendable, nextOpen, type QuietHoursConfig } from '../lib/quiet-hours.js';
import { segmentInfo } from '../lib/segments.js';
import { ProviderError, type MessageProvider } from './provider.js';

/** Transient failures are retried this many times in total before the row is marked failed. */
export const MAX_ATTEMPTS = 5;

/** Exponential-ish backoff for a transient provider failure, capped. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1));
}

export type StopReason = 'empty' | 'quiet_hours' | 'no_capacity' | 'limit';

export interface DrainResult {
  sent: number;
  skipped: number;
  failed: number;
  /** Why the drain stopped — the honest answer an organiser needs when progress plateaus. */
  stopped: StopReason;
  /** When it is worth trying again, or null when there is simply nothing queued. */
  next_attempt_at: Date | null;
}

export interface WorkerDeps {
  db: Db;
  log: FastifyBaseLogger;
  provider: MessageProvider;
  quiet: QuietHoursConfig;
  /** Injectable clock — the tests drive quiet hours and cap rollover without waiting on a real one. */
  now?: () => Date;
  /** Injectable sleep, so a backoff test does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

interface ClaimedRow {
  id: string;
  campaign_id: string;
  channel: 'sms' | 'email';
  attempts: number;
  value: string;
  withdrawn_at: Date | null;
  consent_gotv: boolean;
  consent_updates: boolean;
  purpose: 'gotv' | 'updates';
  body_sms: string | null;
  email_subject: string | null;
  body_email: string | null;
}

interface SenderRow {
  id: string;
  e164: string;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SendWorker {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly provider: MessageProvider;
  private readonly quiet: QuietHoursConfig;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  /** One drain at a time in this process. `POST /:id/send` twice must not start two loops. */
  private running = false;
  private rerun = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(deps: WorkerDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.provider = deps.provider;
    this.quiet = deps.quiet;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
  }

  /** Ask the worker to drain, now. Safe to call from any endpoint, any number of times. */
  kick(): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    void this.loop();
  }

  /** Stop scheduling. Called from the app's onClose hook; an in-flight drain finishes on its own. */
  stopScheduling(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      do {
        this.rerun = false;
        try {
          const result = await this.drain();
          if (result.next_attempt_at) this.scheduleAt(result.next_attempt_at);
        } catch (err) {
          // A drain failure (database down mid-send) must not kill the process or silently end the
          // campaign: log it and try again shortly.
          this.log.error({ err }, 'messaging: send worker drain failed');
          this.scheduleAt(new Date(this.now().getTime() + 60_000));
        }
      } while (this.rerun);
    } finally {
      this.running = false;
    }
  }

  private scheduleAt(at: Date): void {
    if (this.stopped || this.timer) return;
    const delay = Math.max(1_000, Math.min(2_147_483_000, at.getTime() - this.now().getTime()));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delay);
    // Never hold the process (or a test run) open on a wake-up that may be twelve hours away.
    this.timer.unref?.();
  }

  /**
   * Drain queued rows until there are none, the quiet-hours window closes, the number pool is
   * exhausted for the day, or `limit` messages have been handled. Exposed directly so tests can
   * run it once against a fixed clock.
   */
  async drain(opts: { at?: Date; limit?: number } = {}): Promise<DrainResult> {
    const limit = opts.limit ?? 10_000;
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    await this.rollDailyCaps();

    for (let handled = 0; handled < limit; ) {
      const at = opts.at ?? this.now();

      // Checked before every message, not once per drain: a long send crosses 21:30.
      if (!isSendable(at, this.quiet)) {
        await this.finishCompletedCampaigns();
        return { sent, skipped, failed, stopped: 'quiet_hours', next_attempt_at: nextOpen(at, this.quiet) };
      }

      const outcome = await this.sendOne(at);
      if (outcome.kind === 'empty') {
        await this.finishCompletedCampaigns();
        return { sent, skipped, failed, stopped: 'empty', next_attempt_at: null };
      }
      if (outcome.kind === 'no_capacity') {
        await this.finishCompletedCampaigns();
        // Nothing more today. The caps roll over on the local date, so the next opening of the
        // window is also the next moment there is capacity.
        return {
          sent,
          skipped,
          failed,
          stopped: 'no_capacity',
          next_attempt_at: nextOpen(new Date(at.getTime() + 86_400_000), this.quiet),
        };
      }
      if (outcome.kind === 'sent') sent += 1;
      else if (outcome.kind === 'skipped') skipped += 1;
      else if (outcome.kind === 'failed') failed += 1;
      else if (outcome.kind === 'retry') await this.sleep(backoffMs(outcome.attempts));

      handled += 1;
    }
    await this.finishCompletedCampaigns();
    return { sent, skipped, failed, stopped: 'limit', next_attempt_at: this.now() };
  }

  /**
   * `sent_today` is a counter against `cap_reset_on`; rolling it over here rather than with a cron
   * means a stack that was switched off overnight still starts the morning with a full pool.
   */
  private async rollDailyCaps(): Promise<void> {
    await this.db.query(
      `UPDATE sender_number SET sent_today = 0, cap_reset_on = current_date WHERE cap_reset_on < current_date`,
    );
  }

  /** A campaign with nothing left queued is done — including one whose every row was skipped. */
  private async finishCompletedCampaigns(): Promise<void> {
    await this.db.query(
      `UPDATE message_campaign mc
       SET status = 'done', finished_at = now()
       WHERE mc.status = 'sending'
         AND NOT EXISTS (SELECT 1 FROM message_send ms WHERE ms.campaign_id = mc.id AND ms.status = 'queued')`,
    );
  }

  private async sendOne(
    at: Date,
  ): Promise<
    | { kind: 'empty' | 'no_capacity' | 'sent' | 'skipped' | 'failed' }
    | { kind: 'retry'; attempts: number }
  > {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Claim exactly one row. SKIP LOCKED is what makes a second caller of POST /:id/send, or a
      // second process, take a DIFFERENT row rather than the same one — no message goes twice.
      const claim = await client.query<ClaimedRow>(
        `SELECT ms.id, ms.campaign_id, ms.channel::text AS channel, ms.attempts,
                vc.value, vc.withdrawn_at, vc.consent_gotv, vc.consent_updates,
                mc.purpose::text AS purpose, mc.body_sms, mc.email_subject, mc.body_email
         FROM message_send ms
         JOIN message_campaign mc ON mc.id = ms.campaign_id
         JOIN voter_contact vc ON vc.id = ms.voter_contact_id
         WHERE ms.status = 'queued' AND mc.status = 'sending'
         ORDER BY ms.queued_at, ms.id
         FOR UPDATE OF ms SKIP LOCKED
         LIMIT 1`,
      );
      const row = claim.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return { kind: 'empty' };
      }

      // ---- the re-check. This is the point of the whole design. ----
      // Consent is read HERE, at dequeue, from the live row — never trusted from the moment the
      // queue was built. Somebody who replied STOP an hour ago has `withdrawn_at` stamped, and
      // their queued message becomes `skipped`, not `sent`.
      const skip = skipReason(row);
      if (skip) {
        await client.query(`UPDATE message_send SET status = 'skipped', skip_reason = $2 WHERE id = $1`, [
          row.id,
          skip,
        ]);
        await client.query('COMMIT');
        this.log.info({ send: row.id, campaign: row.campaign_id, skip }, 'messaging: skipped at dequeue');
        return { kind: 'skipped' };
      }

      const body = row.channel === 'sms' ? (row.body_sms ?? '') : (row.body_email ?? '');
      if (body.trim() === '') {
        await client.query(
          `UPDATE message_send SET status = 'failed', attempts = attempts + 1, error = $2 WHERE id = $1`,
          [row.id, `campaign has no ${row.channel} body`],
        );
        await client.query('COMMIT');
        return { kind: 'failed' };
      }

      // ---- allocate a number out of the pool (SMS only; email has no long-code throttle) ----
      let sender: SenderRow | undefined;
      if (row.channel === 'sms') {
        const pool = await client.query<SenderRow>(
          `SELECT id, e164 FROM sender_number
           WHERE active AND sent_today < daily_cap
           ORDER BY sent_today, e164
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
        );
        sender = pool.rows[0];
        if (!sender) {
          // Roll back so the claimed message row is released untouched and stays queued for
          // tomorrow. Sending anyway is the failure mode this file exists to prevent: over the cap
          // the carrier drops the message without telling anybody.
          await client.query('ROLLBACK');
          return { kind: 'no_capacity' };
        }
      }

      try {
        const result =
          row.channel === 'sms'
            ? await this.provider.send(row.value, body, { from: sender?.e164 })
            : await this.sendEmail(row.value, row.email_subject ?? '', body);

        await client.query(
          `UPDATE message_send
           SET status = 'sent', sent_at = $2, attempts = attempts + 1, error = NULL,
               provider_message_id = $3, segments = $4, sender_number_id = $5
           WHERE id = $1`,
          [row.id, at, result.providerId, result.segments || segmentInfo(body).segments, sender?.id ?? null],
        );
        if (sender) {
          await client.query(`UPDATE sender_number SET sent_today = sent_today + 1 WHERE id = $1`, [sender.id]);
        }
        await client.query('COMMIT');
        return { kind: 'sent' };
      } catch (err) {
        const perr = err instanceof ProviderError ? err : new ProviderError(String((err as Error).message), false);
        const attempts = row.attempts + 1;
        // A hard rejection is final and carries the provider's own reason: an invalid number never
        // becomes valid, and retrying it burns cap a deliverable message needed.
        const giveUp = perr.permanent || attempts >= MAX_ATTEMPTS;
        await client.query(
          `UPDATE message_send SET status = $3::send_status, attempts = $4, error = $2 WHERE id = $1`,
          [row.id, `${perr.providerCode ? `[${perr.providerCode}] ` : ''}${perr.message}`, giveUp ? 'failed' : 'queued', attempts],
        );
        await client.query('COMMIT');
        this.log.warn(
          { send: row.id, attempts, permanent: perr.permanent, err: perr.message },
          giveUp ? 'messaging: send failed permanently' : 'messaging: send failed, will retry',
        );
        return giveUp ? { kind: 'failed' } : { kind: 'retry', attempts };
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async sendEmail(to: string, subject: string, body: string): ReturnType<MessageProvider['send']> {
    if (!this.provider.sendEmail) {
      // Email is the fallback channel and a provider that only carries SMS is a legitimate
      // configuration. Failing loudly with the reason beats silently pretending it went.
      throw new ProviderError(`provider "${this.provider.name}" cannot send email`, true);
    }
    return this.provider.sendEmail(to, subject, body);
  }
}

/** The dequeue-time consent re-check, as one pure function so it is obvious and testable. */
function skipReason(row: ClaimedRow): string | null {
  if (row.withdrawn_at !== null) return 'withdrawn';
  const consented = row.purpose === 'gotv' ? row.consent_gotv : row.consent_updates;
  if (!consented) return 'no_consent';
  return null;
}
