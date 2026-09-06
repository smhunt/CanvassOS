/**
 * Client-side mirror of `api/src/lib/geo.ts`.
 *
 * The turf drawer shows a live "doors inside" count while the organiser is still dropping corners.
 * That number has to be the number the server will actually materialise into `turf_household`
 * when the shape is saved, so the crossing-number test below is a deliberate copy of the server's
 * — same ray direction, same strict/non-strict comparisons, same treatment of an open ring.
 * If one side changes, change the other: a preview that quietly disagrees with the saved turf is
 * worse than no preview at all.
 *
 * Geometry convention throughout: GeoJSON order, `[lon, lat]`.
 */
import type { PointsCollection } from '../api/types';

export type Position = [number, number];

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/**
 * Crossing-number (ray casting) test against one ring. The ring may be closed or open — the
 * `j = i++` wrap makes the last→first segment implicit either way, which is why the in-progress
 * (open) ring previews exactly the same doors as the closed ring we POST.
 */
export function pointInRing(lon: number, lat: number, ring: readonly Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as Position;
    const [xj, yj] = ring[j] as Position;
    // Does the horizontal ray at `lat` cross this edge, to the right of the test point?
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function ringBBox(ring: readonly Position[]): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** GeoJSON rings must be closed; the drawing keeps an open list of corners. */
export function closeRing(ring: readonly Position[]): Position[] {
  const out = ring.map(([lon, lat]): Position => [lon, lat]);
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push([first[0], first[1]]);
  return out;
}

export interface InsideCount {
  doors: number;
  voters: number;
}

/**
 * Doors and voters inside the ring. Mirrors the server's shape too: a bbox rejection first (it is
 * a SQL pre-filter there, a comparison here) and the exact test only for survivors, so panning
 * around with a few thousand points on screen stays free.
 */
export function countInside(features: PointsCollection['features'], ring: readonly Position[]): InsideCount {
  if (ring.length < 3) return { doors: 0, voters: 0 };
  const { minLon, minLat, maxLon, maxLat } = ringBBox(ring);
  let doors = 0;
  let voters = 0;
  for (const f of features) {
    const lon = f.geometry.coordinates[0];
    const lat = f.geometry.coordinates[1];
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
    if (!pointInRing(lon, lat, ring)) continue;
    doors++;
    voters += f.properties.n;
  }
  return { doors, voters };
}
