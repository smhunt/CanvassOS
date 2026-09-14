/**
 * The subscriber matcher — who on the voters list is this person from the website?
 *
 * Runs entirely inside Postgres and this process. No voter row is ever sent anywhere (see
 * docs/phase-8-subscriber-link-plan.md and the advice.ts precedent): the "AI" here is a nickname
 * table, trigram similarity over the GIN indexes that already power /api/search, and exact joins
 * on contact info people handed over at the door.
 *
 * Three passes per unmatched request, cheapest and most certain first:
 *
 *   ledger — a decision already made for this subscriber (by a human, or an earlier exact hit)
 *            is re-applied by natural_key. This is what makes decisions survive a voters-list
 *            re-import, which truncates public_request and match_candidate wholesale.
 *   tier 0 — the subscriber's email or E.164 phone exactly equals a door-collected
 *            voter_contact value. When that resolves to exactly ONE voter and
 *            MATCH_AUTO_ACCEPT=exact, the matcher links it on its own; a value shared by two
 *            voters (a household email) is only ever a suggestion.
 *   tier 1 — fuzzy: every nickname expansion of the first name against voter.full_name, plus
 *            address trigram + civic-number agreement against household.address when the
 *            subscriber gave an address. Top three stay as suggestions for the organizer queue.
 *
 * A match never writes to voter/household and never mints consent. Accepting one sets
 * public_request.household_id — a pointer, exactly what the organizer PATCH has always set.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.js';
import { one, q, type Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { firstNameVariants } from '../lib/nicknames.js';

/** Keep at most this many fuzzy suggestions per request — a queue, not a search page. */
const TOP_N = 3;
/** Fuzzy floor with an address to corroborate; without one the name must carry more weight. */
const MIN_SCORE_WITH_ADDRESS = 0.45;
const MIN_SCORE_NAME_ONLY = 0.5;
/** How many changed rows one pass will take on; the next pass gets the rest five minutes later. */
const BATCH = 200;

export interface MatchStats {
  examined: number;
  auto_accepted: number;
  suggested: number;
  ledger_applied: number;
}

interface RequestRow {
  id: string;
  source: string;
  external_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  household_id: string | null;
}

interface CandidateRow {
  voter_id: string;
  natural_key: string;
  household_id: string;
  full_name: string;
  address: string | null;
  score: number;
  method: 'email' | 'phone' | 'name' | 'name_address';
}

/** lowercase, punctuation squashed to spaces — the shape voter.full_name compares best in. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9àâçéèêëîïôûùüÿæœ' -]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The full-name variants a nickname might hide behind: "bob smith" -> ["bob smith", "robert smith", ...]. */
function nameVariants(name: string): string[] {
  const norm = normName(name);
  if (!norm) return [];
  const parts = norm.split(' ');
  const first = parts[0];
  if (parts.length < 2 || !first) return [norm];
  const variants = firstNameVariants(first);
  const rest = parts.slice(1).join(' ');
  const out = variants.map((v) => `${v} ${rest}`);
  return out.length ? out : [norm];
}

/** The leading civic number of a free-text address, if there is one. */
function civicNum(address: string): string | null {
  const m = address.trim().match(/^(\d+[a-z]?)\b/i);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/**
 * The subscriber's stable identity in the subscriber_link ledger. Synced rows use the website's
 * D1 id; rows posted straight to the public form fall back to their own uuid — durable until a
 * re-import, which is the best available for a row that has no external system of record.
 */
function ledgerKey(r: RequestRow): { source: string; external_id: string } {
  return { source: r.source, external_id: r.external_id ?? r.id };
}

export async function runMatcher(db: Db, log: FastifyBaseLogger, config: Config): Promise<MatchStats> {
  const stats: MatchStats = { examined: 0, auto_accepted: 0, suggested: 0, ledger_applied: 0 };

  const requests = await q<RequestRow>(
    db,
    `SELECT id, source, external_id, name, email, phone, address, household_id
       FROM public_request
      WHERE matched_at IS NULL
      ORDER BY created_at
      LIMIT $1`,
    [BATCH],
  );

  for (const req of requests) {
    stats.examined += 1;
    try {
      await matchOne(db, log, config, req, stats);
    } catch (err) {
      // One bad row (odd characters, a dead connection mid-pass) must not wedge the whole queue.
      // matched_at stays NULL, so the next pass retries it.
      log.error({ err, request: req.id }, 'subscriber match failed for one request');
      continue;
    }
    await q(db, `UPDATE public_request SET matched_at = now() WHERE id = $1`, [req.id]);
  }

  return stats;
}

async function matchOne(
  db: Db,
  log: FastifyBaseLogger,
  config: Config,
  req: RequestRow,
  stats: MatchStats,
): Promise<void> {
  // A fresh look: clear undecided suggestions (identity fields may have changed), keep decisions.
  await q(db, `DELETE FROM match_candidate WHERE public_request_id = $1 AND status = 'suggested'`, [req.id]);

  const key = ledgerKey(req);
  const decided = new Set<string>();

  // ---- ledger: re-apply what somebody (or the exact-hit rule) already decided.
  const ledger = await q<{ natural_key: string; status: 'accepted' | 'rejected'; decided_by: string | null; decided_at: Date; voter_id: string | null; household_id: string | null; full_name: string | null; address: string | null }>(
    db,
    `SELECT sl.natural_key, sl.status, sl.decided_by, sl.decided_at,
            v.id AS voter_id, v.household_id, v.full_name, h.address
       FROM subscriber_link sl
       LEFT JOIN voter v ON v.natural_key = sl.natural_key
       LEFT JOIN household h ON h.id = v.household_id
      WHERE sl.source = $1 AND sl.external_id = $2`,
    [key.source, key.external_id],
  );
  for (const row of ledger) {
    decided.add(row.natural_key);
    await upsertCandidate(db, req.id, {
      voter_id: row.voter_id,
      natural_key: row.natural_key,
      household_id: row.household_id,
      voter_name: row.full_name ?? '(no longer on the list)',
      household_address: row.address,
      score: 1,
      method: 'ledger',
      status: row.status,
      decided_by: row.decided_by,
      decided_at: row.decided_at,
    });
    if (row.status === 'accepted' && row.household_id && !req.household_id) {
      await q(db, `UPDATE public_request SET household_id = $2 WHERE id = $1`, [req.id, row.household_id]);
      req.household_id = row.household_id;
      stats.ledger_applied += 1;
    }
  }

  // ---- tier 0: exact contact-info joins. Withdrawn consent still identifies — an unsubscribe
  // takes the person off a send list, not off the planet — so withdrawn rows still count here.
  const email = (req.email ?? '').trim().toLowerCase();
  const phone = (req.phone ?? '').trim();
  const exact = await q<CandidateRow>(
    db,
    `SELECT DISTINCT v.id AS voter_id, v.natural_key, v.household_id, v.full_name,
            h.address, 1.0::real AS score,
            CASE WHEN vc.channel = 'email' THEN 'email' ELSE 'phone' END AS method
       FROM voter_contact vc
       JOIN voter v ON v.id = vc.voter_id
       JOIN household h ON h.id = v.household_id
      WHERE vc.voter_id IS NOT NULL
        AND ((vc.channel = 'email' AND $1 <> '' AND lower(vc.value) = $1)
          OR (vc.channel = 'phone' AND $2 <> '' AND vc.value = $2))`,
    [email, phone],
  );

  const freshExact = exact.filter((c) => !decided.has(c.natural_key));
  const autoAccept =
    config.MATCH_AUTO_ACCEPT === 'exact' &&
    !req.household_id &&
    new Set(freshExact.map((c) => c.natural_key)).size === 1;

  for (const c of freshExact) {
    decided.add(c.natural_key);
    if (autoAccept) {
      await upsertCandidate(db, req.id, {
        voter_id: c.voter_id,
        natural_key: c.natural_key,
        household_id: c.household_id,
        voter_name: c.full_name,
        household_address: c.address,
        score: c.score,
        method: c.method,
        status: 'accepted',
        decided_by: null,
        decided_at: new Date(),
      });
      await q(db, `UPDATE public_request SET household_id = $2 WHERE id = $1`, [req.id, c.household_id]);
      req.household_id = c.household_id;
      await q(
        db,
        `INSERT INTO subscriber_link (source, external_id, natural_key, status, decided_by)
         VALUES ($1, $2, $3, 'accepted', NULL)
         ON CONFLICT (source, external_id, natural_key) DO NOTHING`,
        [key.source, key.external_id, c.natural_key],
      );
      // Machine-made link to a voter record: on the record like every other touch of the list.
      await audit(db, log, {
        userId: null,
        action: 'auto_accept_match',
        target: req.id,
        detail: { method: c.method, household_id: c.household_id },
        ip: null,
      });
      stats.auto_accepted += 1;
    } else {
      await upsertCandidate(db, req.id, {
        voter_id: c.voter_id,
        natural_key: c.natural_key,
        household_id: c.household_id,
        voter_name: c.full_name,
        household_address: c.address,
        score: c.score,
        method: c.method,
        status: 'suggested',
        decided_by: null,
        decided_at: null,
      });
      stats.suggested += 1;
    }
  }

  // ---- tier 1: fuzzy. Skip when an accepted link already exists — the queue needs alternatives
  // for an open question, not competition for a settled one.
  if (req.household_id) return;

  const variants = nameVariants(req.name);
  if (!variants.length) return;
  const addr = normName(req.address ?? '');
  const civic = req.address ? civicNum(req.address) : null;

  const fuzzy = await q<CandidateRow & { name_sim: number; addr_sim: number; civic_num: string | null }>(
    db,
    `SELECT v.id AS voter_id, v.natural_key, v.household_id, v.full_name, h.address,
            h.civic_num,
            max(similarity(lower(v.full_name), s.variant)) AS name_sim,
            CASE WHEN $2 <> '' THEN similarity(lower(h.address), $2) ELSE 0 END AS addr_sim,
            0::real AS score, 'name' AS method
       FROM voter v
       JOIN household h ON h.id = v.household_id
       CROSS JOIN unnest($1::text[]) AS s(variant)
      WHERE lower(v.full_name) % s.variant
         OR ($2 <> '' AND lower(h.address) % $2)
      GROUP BY v.id, v.natural_key, v.household_id, v.full_name, h.address, h.civic_num
      ORDER BY max(similarity(lower(v.full_name), s.variant)) DESC
      LIMIT 25`,
    [variants, addr],
  );

  const scored = fuzzy
    .filter((c) => !decided.has(c.natural_key))
    .map((c) => {
      const hasAddr = addr !== '';
      // Same street + same civic number is nearly an exact address even when the trigram score
      // is middling ("RR 2" vs "1234 Ilderton Rd"), so agreement earns a fixed boost.
      const civicBoost = hasAddr && civic && c.civic_num && civic === c.civic_num.toLowerCase() ? 0.15 : 0;
      const score = hasAddr
        ? Math.min(1, 0.55 * c.name_sim + 0.45 * c.addr_sim + civicBoost)
        : c.name_sim;
      return {
        ...c,
        score,
        method: (hasAddr && c.addr_sim > 0.3 ? 'name_address' : 'name') as CandidateRow['method'],
      };
    })
    .filter((c) => c.score >= (addr !== '' ? MIN_SCORE_WITH_ADDRESS : MIN_SCORE_NAME_ONLY))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  for (const c of scored) {
    await upsertCandidate(db, req.id, {
      voter_id: c.voter_id,
      natural_key: c.natural_key,
      household_id: c.household_id,
      voter_name: c.full_name,
      household_address: c.address,
      score: c.score,
      method: c.method,
      status: 'suggested',
      decided_by: null,
      decided_at: null,
    });
    stats.suggested += 1;
  }

  const top = scored[0];
  if (top) {
    // Producing suggestions reads voter names and addresses; a read of the list is a read of the
    // list whether a person or a matcher did the looking.
    await audit(db, log, {
      userId: null,
      action: 'suggest_match',
      target: req.id,
      detail: { n: scored.length, top_score: Math.round(top.score * 100) / 100 },
      ip: null,
    });
  }
}

async function upsertCandidate(
  db: Db,
  requestId: string,
  c: {
    voter_id: string | null;
    natural_key: string;
    household_id: string | null;
    voter_name: string;
    household_address: string | null;
    score: number;
    method: 'email' | 'phone' | 'name' | 'name_address' | 'ledger';
    status: 'suggested' | 'accepted' | 'rejected';
    decided_by: string | null;
    decided_at: Date | null;
  },
): Promise<void> {
  await one(
    db,
    `INSERT INTO match_candidate
       (public_request_id, voter_id, natural_key, household_id, voter_name, household_address,
        score, method, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (public_request_id, natural_key) DO UPDATE
       SET voter_id = excluded.voter_id,
           household_id = excluded.household_id,
           voter_name = excluded.voter_name,
           household_address = excluded.household_address,
           score = excluded.score,
           method = excluded.method,
           status = excluded.status,
           decided_by = excluded.decided_by,
           decided_at = excluded.decided_at
     RETURNING id`,
    [
      requestId,
      c.voter_id,
      c.natural_key,
      c.household_id,
      c.voter_name,
      c.household_address,
      c.score,
      c.method,
      c.status,
      c.decided_by,
      c.decided_at,
    ],
  );
}
