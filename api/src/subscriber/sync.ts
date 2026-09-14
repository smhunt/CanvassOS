/**
 * The website subscriber sync — a pull, on purpose.
 *
 * The campaign website (Cloudflare Pages + D1) is the system of record for its own sign-up form:
 * double-opt-in state, consent text, unsubscribes. This worker pulls that list over the site's
 * authenticated admin export every few minutes and upserts it into public_request, where the
 * matcher (subscriber/match.ts) and the organizer queue take over.
 *
 * Pull rather than push because the website must never hold credentials into this stack, this
 * stack going to sleep must cost nothing (the next pull catches up), and nothing new gets exposed
 * to the internet. The fetch goes through app.httpFetch — the same injectable the Street View and
 * advice callers use — so no test ever calls the real website. Outbound only: the request carries
 * the site's own admin token and NOTHING derived from the voters list ever flows back out.
 *
 * Feature off unless WEBSITE_SYNC_URL and WEBSITE_SYNC_TOKEN are both set, like every optional
 * integration here.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { q, type Db } from '../db.js';
import { audit } from '../lib/audit.js';
import type { FetchLike } from '../lib/streetview.js';
import { normalizeContactValue } from '../routes/voter-contacts.js';
import { runMatcher, type MatchStats } from './match.js';

/** The website's export row (functions/api/signups.js in the website repo). */
interface WebsiteSignup {
  id: number | string;
  status: 'pending' | 'confirmed' | 'unsubscribed';
  created_at: string;
  updated_at: string;
  name: string;
  email: string;
  phone: string | null;
  address?: string | null;
  interests: string | null;
  message: string | null;
  consent: string;
}

/** website interests -> the wants[] vocabulary of the public form. Unknown values are dropped. */
const WANTS_MAP: Record<string, string> = {
  volunteer: 'volunteer',
  'lawn-sign': 'sign',
  'sms-reminders': 'reminders',
};

export interface SyncResult {
  pulled: number;
  upserted: number;
  match: MatchStats | null;
}

export interface SubscriberSyncDeps {
  db: Db;
  log: FastifyBaseLogger;
  config: Config;
  fetch: FetchLike;
}

export class SubscriberSync {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly config: Config;
  private readonly fetch: FetchLike;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: SubscriberSyncDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.config = deps.config;
    this.fetch = deps.fetch;
  }

  static enabled(config: Config): boolean {
    return Boolean(config.WEBSITE_SYNC_URL && config.WEBSITE_SYNC_TOKEN);
  }

  /** Every WEBSITE_SYNC_INTERVAL_MS, forever; the first run happens right away. */
  startScheduling(): void {
    if (this.timer) return;
    const tick = (): void => {
      void this.runOnce().catch((err) => this.log.error({ err }, 'subscriber sync failed'));
    };
    tick();
    this.timer = setInterval(tick, this.config.WEBSITE_SYNC_INTERVAL_MS);
    this.timer.unref();
  }

  stopScheduling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pull + upsert + match pass. Serialized: a slow pass and the next tick never overlap. */
  async runOnce(): Promise<SyncResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.pass();
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<SyncResult> {
    const url = `${this.config.WEBSITE_SYNC_URL}?status=all`;
    const res = await this.fetch(url, {
      headers: { Authorization: `Bearer ${this.config.WEBSITE_SYNC_TOKEN}` },
    });
    if (!res.ok) {
      throw new Error(`website export answered ${res.status}`);
    }
    const body = (await res.json()) as { count: number; signups: WebsiteSignup[] };
    const signups = Array.isArray(body.signups) ? body.signups : [];

    let upserted = 0;
    for (const s of signups) {
      if (!s || !s.name || s.id === undefined || s.id === null) continue;

      let phone = (s.phone ?? '').trim() || null;
      if (phone) {
        try {
          phone = normalizeContactValue('phone', phone);
        } catch {
          // Kept as typed, same rule as the public form: a human reads this row anyway.
        }
      }
      const wants = (s.interests ?? '')
        .split(',')
        .map((i) => WANTS_MAP[i.trim()])
        .filter((w): w is string => Boolean(w));

      // Identity fields reset matched_at when they actually change, so the matcher revisits
      // exactly the rows that need another look. website_status alone changing (a later
      // confirm/unsubscribe) is not a reason to re-match.
      const row = await q<{ inserted: boolean }>(
        this.db,
        `INSERT INTO public_request
           (source, external_id, name, email, phone, address, note, wants, consent_text, website_status)
         VALUES ('website', $1, $2, $3, $4, $5, $6, $7::text[], $8, $9)
         ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE
           SET matched_at = CASE
                 WHEN (public_request.name, public_request.email, public_request.phone,
                       public_request.address) IS DISTINCT FROM
                      (excluded.name, excluded.email, excluded.phone, excluded.address)
                 THEN NULL ELSE public_request.matched_at END,
               name = excluded.name,
               email = excluded.email,
               phone = excluded.phone,
               address = excluded.address,
               note = excluded.note,
               wants = excluded.wants,
               consent_text = excluded.consent_text,
               website_status = excluded.website_status
         RETURNING (xmax = 0) AS inserted`,
        [
          String(s.id),
          String(s.name).slice(0, 120),
          (s.email ?? '').trim().toLowerCase() || null,
          phone,
          (s.address ?? '')?.toString().trim().slice(0, 300) || null,
          (s.message ?? '')?.toString().trim().slice(0, 2000) || null,
          wants,
          String(s.consent ?? 'website signup (consent text missing)').slice(0, 1000),
          s.status,
        ],
      );
      if (row[0]?.inserted) upserted += 1;
    }

    // One audit row per pass, counts only — the per-row trail is the matcher's and the queue's.
    await audit(this.db, this.log, {
      userId: null,
      action: 'subscriber_sync',
      target: null,
      detail: { pulled: signups.length, new: upserted },
      ip: null,
    });

    const match = await runMatcher(this.db, this.log, this.config);
    this.log.info({ pulled: signups.length, new: upserted, match }, 'subscriber sync pass done');
    return { pulled: signups.length, upserted, match };
  }
}
