/**
 * The assigned turf, kept on the phone so /canvass/:turfId still works with no connection: the
 * door list, the names, the walking order, and somewhere to record results into the queue.
 *
 * This is voters-list data — personal information under the Municipal Elections Act — sitting on a
 * volunteer's phone, so the scope is deliberately narrow:
 *
 *   - nothing is cached until a turf is actually opened (`useDoors` writes it, nothing else does),
 *   - only turfs the API agreed to serve this user, which for a volunteer is only their own,
 *   - and there is a visible "Clear saved turf data" button in the sync panel.
 *
 * `make purge` shreds the server after election day but it cannot reach a phone, which is exactly
 * why this cache is small, opt-in-by-use and clearable from the screen the volunteer already has
 * open. The service worker still never caches `/api/*` (vite.config.ts); this store is the single
 * deliberate exception, and it holds one response shape.
 */
import type { DoorsResponse } from '../api/types';
import { TURF_CACHE, idbClear, idbGet, idbGetAll, idbPut } from './db';
import { clearPendingPhotos } from './photoQueue';

export interface CachedTurf {
  turf_id: string;
  cached_at: number;
  response: DoorsResponse;
}

export async function cacheTurf(turfId: string, response: DoorsResponse): Promise<void> {
  await idbPut<CachedTurf>(TURF_CACHE, { turf_id: turfId, cached_at: Date.now(), response });
}

export const readCachedTurf = (turfId: string): Promise<CachedTurf | undefined> =>
  idbGet<CachedTurf>(TURF_CACHE, turfId);

/** What is on this phone, for the "clear it" panel — names and counts, not the doors themselves. */
export async function cachedTurfSummaries(): Promise<{ turf_id: string; name: string; n_doors: number; cached_at: number }[]> {
  const all = await idbGetAll<CachedTurf>(TURF_CACHE);
  return all
    .map((t) => ({ turf_id: t.turf_id, name: t.response.turf.name, n_doors: t.response.doors.length, cached_at: t.cached_at }))
    .sort((a, b) => b.cached_at - a.cached_at);
}

/**
 * "Clear saved data" — one button, everything personal it can reach.
 *
 * The turf cache is not the only personal information this app leaves on a phone: a sign photo is a
 * photograph of somebody's house, and one taken offline is held here until its sign exists (see
 * photoQueue.ts). A volunteer who says "clear this phone" means that too, and must not have to know
 * there is a second store to find. So this clears both, and the placing screen says plainly at
 * capture time that a held photo is cleared by this button — nothing here is discovered afterwards.
 */
export async function clearTurfCache(): Promise<void> {
  await idbClear(TURF_CACHE);
  await clearPendingPhotos();
}
