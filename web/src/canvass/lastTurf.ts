/**
 * The turf this phone was last working in.
 *
 * A UI preference, not data: it is one id in `localStorage` alongside the base-layer and door-order
 * choices, never IndexedDB, and losing it costs a volunteer exactly one tap. Every access is
 * wrapped because Safari throws on `localStorage` in private browsing rather than returning null,
 * and a volunteer's shift must not end on a storage exception.
 *
 * It is deliberately not authoritative: CanvassPage only acts on it after checking the id is still
 * in the assignments the server just returned, so a turf taken off someone cannot keep reopening.
 */
const KEY = 'canvass_last_turf';

export function readLastTurf(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function writeLastTurf(turfId: string): void {
  try {
    localStorage.setItem(KEY, turfId);
  } catch {
    // Private browsing, or storage full. The app works without it.
  }
}

export function clearLastTurf(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // as above
  }
}
