/**
 * Who has voted: importing the clerk's list, and the turnout it adds up to.
 *
 *   POST /api/voted/import    admin      stamp (or clear) voter.voted_at from an uploaded JSON file
 *   GET  /api/voted/imports   admin      the files applied so far
 *   GET  /api/voted/summary   organizer  turnout by ward / community / day — counts only
 *
 * The matching is in lib/voted.ts and is pure; this file fetches the list, applies the plan in one
 * transaction, records the file in `voted_import`, and audits. A dry run goes through every step
 * but the transaction, so the operator sees exactly what a real run would do.
 *
 * Volunteers never reach any of this. They see the result of it — `has_voted` on the voters of
 * their own turf's doors, and a count per door — through the same scoped routes as everything else.
 */
import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireRole } from '../auth/guard.js';
import { one, q, withTx } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { parseEntries, planVotedImport, type EntryResult, type MatchableVoter, type VotedEntry } from '../lib/voted.js';

/**
 * The app-wide body limit is 64 KB, sized for a door result. A voted list is thousands of names
 * with addresses — a few hundred KB on the last weekend — so this one route takes up to 16 MB.
 */
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

const importBody = z.object({
  label: z.string().trim().min(1).max(200),
  /**
   * `merge` (default): stamp everyone the file names, leave everyone else as they were — the right
   * mode for a daily file that lists only that day's voters. `replace`: the file is the complete
   * list of everyone who has voted so far, so anybody stamped earlier and absent from it is
   * un-stamped. Both clear a voter the file explicitly flags `hasVoted: false`.
   */
  mode: z.enum(['merge', 'replace']).default('merge'),
  dry_run: z.boolean().default(false),
  /** The stamp for entries that carry no date of their own. Defaults to now. */
  voted_at: z.string().datetime({ offset: true }).optional(),
  /** The uploaded file, as parsed JSON — any shape lib/voted.ts `parseEntries` accepts. */
  entries: z.unknown(),
});

/** How many unplaced rows go back to the operator. The counts are always complete. */
const UNMATCHED_LIMIT = 500;

interface VotedImportRow {
  id: number;
  at: Date;
  user_id: string | null;
  user_name: string | null;
  label: string;
  mode: string;
  sha256: string;
  n_entries: number;
  n_matched: number;
  n_unmatched: number;
  n_ambiguous: number;
  n_marked: number;
  n_cleared: number;
}

const IMPORT_COLS = `
  i.id, i.at, i.user_id, u.name AS user_name, i.label, i.mode, i.sha256,
  i.n_entries, i.n_matched, i.n_unmatched, i.n_ambiguous, i.n_marked, i.n_cleared`;

/** Explicit allow-list, like every other row that leaves this API. */
const serializeImport = (r: VotedImportRow) => ({
  id: r.id,
  at: r.at,
  user_id: r.user_id,
  user_name: r.user_name,
  label: r.label,
  mode: r.mode,
  sha256: r.sha256,
  n_entries: r.n_entries,
  n_matched: r.n_matched,
  n_unmatched: r.n_unmatched,
  n_ambiguous: r.n_ambiguous,
  n_marked: r.n_marked,
  n_cleared: r.n_cleared,
});

/** The rows the operator has to look at: what the file said, and why it was not placed. */
const unplaced = (results: EntryResult[]) =>
  results
    .filter((r) => r.outcome.kind !== 'matched')
    .slice(0, UNMATCHED_LIMIT)
    .map((r) => {
      const o = r.outcome;
      return {
        index: r.index,
        name: r.name,
        address: r.address,
        reason: o.kind === 'ambiguous' ? 'ambiguous' : o.kind === 'unmatched' ? o.reason : 'matched',
        why: o.kind === 'unmatched' ? o.why : undefined,
        candidates: o.kind === 'ambiguous' ? o.candidates : undefined,
      };
    });

export const votedRoutes: FastifyPluginAsync = async (app) => {
  const adminOnly = requireRole('admin');

  app.post('/import', { preHandler: adminOnly, bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const body = importBody.parse(req.body);
    const me = currentSession(req).user;
    const parsed = parseEntries(body.entries);
    if (parsed.error) throw badRequest(parsed.error, 'bad_file');
    if (parsed.entries.length === 0) throw badRequest('the file holds no voters', 'empty_file');
    // The body's stamp, else the file's own export time, else now.
    const stamp = new Date(body.voted_at ?? parsed.exported_at ?? Date.now());

    // The whole list, once, in memory: ~17k narrow rows is a couple of megabytes and a few tens of
    // milliseconds, and it is the only way to tell "one John Smith" from "three" without a query
    // per line. This is a read of every name on the list, and is audited as one below.
    const voters = await q<MatchableVoter>(
      app.db,
      `SELECT v.id, v.natural_key, v.first_name, v.last_name, v.full_name, v.name_raw, v.household_id,
              h.address, h.property_address_raw, h.civic_num, h.street, (v.voted_at IS NOT NULL) AS voted
       FROM voter v JOIN household h ON h.id = v.household_id`,
    );
    const plan = planVotedImport(parsed.entries, voters);
    // The hash is of the entries as they arrived, so the same file uploaded twice is recognisable
    // in the import history whatever label it was given.
    const sha256 = createHash('sha256').update(JSON.stringify(body.entries)).digest('hex');

    const markIds = [...plan.mark.keys()];
    const clearIds = [...plan.clear.keys()];
    // What would actually change, against what is stamped now: a complete export carries a
    // `voted: false` for every elector who has not voted, and ten thousand of those are not ten
    // thousand un-markings. `replace` also un-marks everyone stamped whom the file does not name.
    const stamped = new Set(voters.filter((v) => v.voted).map((v) => v.id));
    const markSet = new Set(markIds);
    const wouldMark = markIds.filter((id) => !stamped.has(id)).length;
    let wouldClear = clearIds.filter((id) => stamped.has(id)).length;
    if (body.mode === 'replace') {
      const clearSet = new Set(clearIds);
      for (const id of stamped) if (!markSet.has(id) && !clearSet.has(id)) wouldClear++;
    }
    const counts = { ...plan.counts, would_mark: wouldMark, would_clear: wouldClear };

    if (body.dry_run) {
      await audit(app.db, req.log, {
        userId: me.id,
        action: 'import_voted',
        detail: { dry_run: true, mode: body.mode, ...flatCounts(plan.counts) },
        ip: req.ip,
      });
      return { dry_run: true, import: null, counts, unmatched: unplaced(plan.results) };
    }

    const row = await withTx(app.db, async (tx) => {
      const ins = await one<{ id: number }>(
        tx,
        `INSERT INTO voted_import (user_id, label, mode, sha256, n_entries, n_matched, n_unmatched, n_ambiguous, n_marked, n_cleared)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0) RETURNING id`,
        [me.id, body.label, body.mode, sha256, plan.counts.entries, plan.counts.matched, plan.counts.unmatched, plan.counts.ambiguous],
      );
      const importId = (ins as { id: number }).id;

      // A voter already stamped keeps the earlier stamp: the first file that said they had voted is
      // when we learned it, and a later file repeating the fact is not news.
      const withDate = markIds.filter((id) => (plan.mark.get(id) as VotedEntry).voted_at);
      const withoutDate = markIds.filter((id) => !(plan.mark.get(id) as VotedEntry).voted_at);
      let marked = 0;
      if (withoutDate.length) {
        const r = await tx.query(
          `UPDATE voter SET voted_at = $2, voted_import_id = $3 WHERE id = ANY($1::uuid[]) AND voted_at IS NULL`,
          [withoutDate, stamp, importId],
        );
        marked += r.rowCount ?? 0;
      }
      if (withDate.length) {
        const r = await tx.query(
          `UPDATE voter v SET voted_at = m.at, voted_import_id = $3
           FROM unnest($1::uuid[], $2::timestamptz[]) AS m(id, at)
           WHERE v.id = m.id AND v.voted_at IS NULL`,
          [withDate, withDate.map((id) => (plan.mark.get(id) as VotedEntry).voted_at), importId],
        );
        marked += r.rowCount ?? 0;
      }

      let cleared = 0;
      if (clearIds.length) {
        const r = await tx.query(
          `UPDATE voter SET voted_at = NULL, voted_import_id = NULL WHERE id = ANY($1::uuid[]) AND voted_at IS NOT NULL`,
          [clearIds],
        );
        cleared += r.rowCount ?? 0;
      }
      if (body.mode === 'replace') {
        const r = await tx.query(
          `UPDATE voter SET voted_at = NULL, voted_import_id = NULL WHERE voted_at IS NOT NULL AND NOT (id = ANY($1::uuid[]))`,
          [markIds],
        );
        cleared += r.rowCount ?? 0;
      }

      await tx.query(`UPDATE voted_import SET n_marked = $2, n_cleared = $3 WHERE id = $1`, [importId, marked, cleared]);
      return one<VotedImportRow>(
        tx,
        `SELECT ${IMPORT_COLS} FROM voted_import i LEFT JOIN app_user u ON u.id = i.user_id WHERE i.id = $1`,
        [importId],
      );
    });

    await audit(app.db, req.log, {
      userId: me.id,
      action: 'import_voted',
      target: String((row as VotedImportRow).id),
      detail: {
        dry_run: false,
        mode: body.mode,
        ...flatCounts(plan.counts),
        marked: (row as VotedImportRow).n_marked,
        cleared: (row as VotedImportRow).n_cleared,
      },
      ip: req.ip,
    });

    return reply.status(201).send({
      dry_run: false,
      import: serializeImport(row as VotedImportRow),
      counts,
      unmatched: unplaced(plan.results),
    });
  });

  app.get('/imports', { preHandler: adminOnly }, async () => {
    const rows = await q<VotedImportRow>(
      app.db,
      `SELECT ${IMPORT_COLS} FROM voted_import i LEFT JOIN app_user u ON u.id = i.user_id ORDER BY i.id DESC LIMIT 200`,
    );
    return { imports: rows.map(serializeImport) };
  });

  /**
   * Turnout so far. Aggregates only — the same class as /stats/coverage: no name, address or id,
   * so nothing here is a row of the list. `by_day` is in Ontario time because "how many voted on
   * Saturday" is a question about a calendar day at the polls, not about UTC.
   */
  app.get('/summary', { preHandler: requireRole('organizer') }, async (req) => {
    const me = currentSession(req).user;
    const [totals, byWard, byCommunity, byDay, last] = await Promise.all([
      one<{ voters: number; voted: number; households: number; households_any: number; households_all: number }>(
        app.db,
        `SELECT (SELECT count(*)::int FROM voter) AS voters,
                (SELECT count(*)::int FROM voter WHERE voted_at IS NOT NULL) AS voted,
                (SELECT count(*)::int FROM household WHERE n_voters > 0) AS households,
                (SELECT count(DISTINCT household_id)::int FROM voter WHERE voted_at IS NOT NULL) AS households_any,
                (SELECT count(*)::int FROM household h
                  WHERE h.n_voters > 0
                    AND NOT EXISTS (SELECT 1 FROM voter v WHERE v.household_id = h.id AND v.voted_at IS NULL)
                    AND EXISTS (SELECT 1 FROM voter v WHERE v.household_id = h.id)) AS households_all`,
      ),
      q<{ ward: string; voters: number; voted: number }>(
        app.db,
        `SELECT ward, count(*)::int AS voters, count(*) FILTER (WHERE voted_at IS NOT NULL)::int AS voted
         FROM voter GROUP BY ward ORDER BY ward`,
      ),
      q<{ community: string | null; voters: number; voted: number }>(
        app.db,
        `SELECT h.community, count(*)::int AS voters, count(*) FILTER (WHERE v.voted_at IS NOT NULL)::int AS voted
         FROM voter v JOIN household h ON h.id = v.household_id
         GROUP BY h.community ORDER BY voters DESC`,
      ),
      q<{ day: string; voted: number }>(
        app.db,
        `SELECT to_char((voted_at AT TIME ZONE 'America/Toronto')::date, 'YYYY-MM-DD') AS day, count(*)::int AS voted
         FROM voter WHERE voted_at IS NOT NULL GROUP BY 1 ORDER BY 1`,
      ),
      one<VotedImportRow>(
        app.db,
        `SELECT ${IMPORT_COLS} FROM voted_import i LEFT JOIN app_user u ON u.id = i.user_id ORDER BY i.id DESC LIMIT 1`,
      ),
    ]);
    await audit(app.db, req.log, {
      userId: me.id,
      action: 'view_turnout',
      detail: { voted: totals?.voted ?? 0 },
      ip: req.ip,
    });
    return {
      totals: totals ?? { voters: 0, voted: 0, households: 0, households_any: 0, households_all: 0 },
      by_ward: byWard,
      by_community: byCommunity,
      by_day: byDay,
      last_import: last ? serializeImport(last) : null,
    };
  });
};

/** The plan's counts as flat numbers for the audit detail (by_how spread as `how_<name>`). */
function flatCounts(c: ReturnType<typeof planVotedImport>['counts']): Record<string, number> {
  return {
    entries: c.entries,
    matched: c.matched,
    unmatched: c.unmatched,
    ambiguous: c.ambiguous,
    address_differs: c.address_differs,
    how_id: c.by_how.id,
    how_key: c.by_how.key,
    how_name_address: c.by_how['name+address'],
    how_name: c.by_how.name,
    how_name_only: c.by_how['name~address'],
    why_new_address: c.unmatched_by.new_address,
    why_new_at_door: c.unmatched_by.new_at_door,
    why_given_name_differs: c.unmatched_by.given_name_differs,
    why_surname_unknown: c.unmatched_by.surname_unknown,
    why_no_name: c.unmatched_by.no_name,
  };
}
