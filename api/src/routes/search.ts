import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { currentSession, requireRole } from '../auth/guard.js';
import { q } from '../db.js';
import { audit } from '../lib/audit.js';

const searchQuery = z.object({
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform((s) => s.replace(/\s+/g, ' ')),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

interface VoterHit {
  id: string;
  display_name: string;
  household_id: string;
  address: string;
  community: string | null;
  ward: string;
}
interface HouseholdHit {
  id: string;
  address: string;
  community: string | null;
  ward: string;
  n_voters: number;
}

/** Escape LIKE metacharacters so user input is matched literally inside '%...%'. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** "123 King", "93 stone field" → { num: 123, street: 'KING' }; otherwise null. */
function parseCivic(s: string): { num: number; street: string } | null {
  const m = /^(\d+)\s*[a-z]?\s+(.+)$/i.exec(s);
  if (!m) return null;
  return { num: Number(m[1]), street: (m[2] as string).toUpperCase() };
}

/** GET /api/search?q=&limit= — organizer/admin. Trigram + substring on voter.full_name and household.address. */
export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/search', { preHandler: requireRole('organizer') }, async (req) => {
    const { q: term, limit } = searchQuery.parse(req.query);
    const sess = currentSession(req);
    const like = `%${escapeLike(term)}%`;
    const civic = parseCivic(term);

    const [voters, households] = await Promise.all([
      q<VoterHit>(
        app.db,
        `SELECT v.id, v.display_name, v.household_id, h.address, h.community, h.ward
         FROM voter v JOIN household h ON h.id = v.household_id
         WHERE v.full_name ILIKE $1 OR v.full_name % $2
         -- substring hits first (surname-prefix hits before the rest), alphabetical within them;
         -- fuzzy-only hits after, best similarity first
         ORDER BY (v.full_name ILIKE $1) DESC,
                  (v.last_name ILIKE $3) DESC,
                  CASE WHEN v.full_name ILIKE $1 THEN 0 ELSE -similarity(v.full_name, $2) END,
                  v.last_name, v.first_name
         LIMIT $4`,
        [like, term, `${escapeLike(term)}%`, limit],
      ),
      q<HouseholdHit>(
        app.db,
        `SELECT h.id, h.address, h.community, h.ward, h.n_voters
         FROM household h
         WHERE h.address ILIKE $1
            OR h.address % $2
            OR ($3::int IS NOT NULL AND h.num_sort = $3 AND h.street ILIKE $4)
         ORDER BY (h.address ILIKE $5) DESC,
                  ($3::int IS NOT NULL AND h.num_sort = $3 AND h.street ILIKE $4) DESC,
                  (h.address ILIKE $1) DESC,
                  CASE WHEN h.address ILIKE $1 THEN 0 ELSE -similarity(h.address, $2) END,
                  h.street_sort, h.num_sort, h.address
         LIMIT $6`,
        [
          like,
          term,
          civic?.num ?? null,
          civic ? `${escapeLike(civic.street)}%` : null,
          `${escapeLike(term)}%`,
          limit,
        ],
      ),
    ]);

    await audit(app.db, req.log, {
      userId: sess.user.id,
      action: 'search',
      detail: { q: term, n_voters: voters.length, n_households: households.length },
      ip: req.ip,
    });
    return { voters, households };
  });
};
