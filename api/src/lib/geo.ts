/**
 * Point-in-polygon for turf building (Phase 2).
 *
 * The production image ships PostGIS, but the Phase 1 schema deliberately stores lat/lon columns
 * and no geometry column (db/schema.sql), so turf materialisation runs the ray-casting test here
 * in TypeScript over the ~7k household rows instead of `ST_Contains`. One turf save is a single
 * bbox-filtered SELECT plus a few thousand cheap comparisons — well under a millisecond.
 *
 * Geometry convention throughout: GeoJSON order, `[lon, lat]`.
 */
import { z } from 'zod';

export type Position = [number, number];
export type Ring = Position[];

export interface Polygon {
  type: 'Polygon';
  coordinates: Position[][];
}

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** GeoJSON Polygon as accepted by POST /api/turfs. Rings need >= 4 positions; holes are allowed. */
const positionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const ringSchema = z.array(positionSchema).min(4).max(5000);

export const polygonSchema: z.ZodType<Polygon> = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(ringSchema).min(1).max(20),
});

/**
 * Crossing-number (ray casting) test against one ring. The ring may be closed or open — the
 * `j = i++` wrap makes the last→first segment implicit either way.
 *
 * Points exactly on an edge are "inside or outside" depending on which side of the horizontal
 * ray the edge falls; that ambiguity is irrelevant here (household coordinates are never exactly
 * on a hand-drawn turf boundary) and the rule is consistent, so a point can never land in two
 * adjacent turfs' interiors by accident.
 */
export function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as Position;
    const b = ring[j] as Position;
    const [xi, yi] = a;
    const [xj, yj] = b;
    // Does the horizontal ray at `lat` cross this edge, to the right of the test point?
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(lon: number, lat: number, polygon: Polygon): boolean {
  const rings = polygon.coordinates;
  const outer = rings[0];
  if (!outer || outer.length < 3) return false;
  if (!pointInRing(lon, lat, outer)) return false;
  for (let i = 1; i < rings.length; i++) {
    const hole = rings[i] as Ring;
    if (hole.length >= 3 && pointInRing(lon, lat, hole)) return false;
  }
  return true;
}

/** Bounding box of the outer ring — used to pre-filter households in SQL before the exact test. */
export function polygonBBox(polygon: Polygon): BBox {
  const outer = polygon.coordinates[0];
  if (!outer || outer.length === 0) throw new Error('polygon has no outer ring');
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of outer) {
    const [lon, lat] = p;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

// ---------------------------------------------------------------- approximate turf outlines

/** Metres of padding around a street-picked turf's doors, so the shape covers the lots, not the
 *  pins. A rural lot is deep; 40 m is about a suburban frontage and reads as "this block". */
const PAD_M = 40;
const M_PER_DEG_LAT = 111_320;

/**
 * Convex hull by Andrew's monotone chain — O(n log n), no dependencies.
 *
 * Returns a closed ring in GeoJSON `[lon, lat]` order, or null when the input cannot make a
 * polygon. Collinear points are dropped (`<= 0` rather than `< 0`), which is what makes a
 * single-street turf come back as a degenerate two-point hull rather than a sliver — the caller
 * pads it into something visible.
 */
export function convexHull(points: Position[]): Position[] | null {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) =>
    a[0] === b[0] ? a[1] - b[1] : a[0] - b[0],
  );
  if (pts.length < 3) return pts.length ? pts : null;

  const cross = (o: Position, a: Position, b: Position) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (list: Position[]): Position[] => {
    const out: Position[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };

  const hull = [...build(pts), ...build([...pts].reverse())];
  return hull.length >= 3 ? hull : pts;
}

/**
 * An APPROXIMATE outline for a turf that was built by picking streets and therefore has no drawn
 * shape of its own.
 *
 * This is a convex hull of the turf's doors, padded outwards. It is deliberately not presented as
 * the turf: a hull spans the gaps between its streets, so it can cover doors that are not in the
 * turf at all. The API marks it `approx` and the map draws it dotted for exactly that reason — it
 * answers "roughly where is this turf", never "which doors are in it".
 *
 * Padding is applied by pushing each vertex away from the centroid, which also rescues the
 * degenerate cases: two doors on one street, or all doors collinear, would otherwise be a hull with
 * no area. Longitude is scaled by cos(latitude) so the padding is metres on the ground rather than
 * degrees, which at 43°N would be ~1.4x wider than it is tall.
 */
/** Twice the signed area of a ring, absolute — used only to spot a hull with no area at all. */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return Math.abs(a / 2);
}

export function approximateOutline(points: Position[]): Polygon | null {
  if (points.length === 0) return null;
  const hull = convexHull(points);
  if (!hull) return null;

  const cx = hull.reduce((a, p) => a + p[0], 0) / hull.length;
  const cy = hull.reduce((a, p) => a + p[1], 0) / hull.length;
  const padLat = PAD_M / M_PER_DEG_LAT;
  const padLon = padLat / Math.max(Math.cos((cy * Math.PI) / 180), 0.01);

  // Pushing a vertex away from the centroid only works when the hull has area to push out of. One
  // door, two doors, or a whole street of doors in a straight line all put the centroid ON the
  // shape, so every outward vector lies along it and the result stays a zero-area sliver that draws
  // nothing. Those cases become a padded bounding box instead — wider than ideal for a diagonal
  // street, but this is an approximation that is labelled as one, and a visible rough shape beats a
  // correct invisible one.
  const ring: Position[] =
    hull.length < 3 || ringArea(hull) < 1e-12
      ? (() => {
          const xs = points.map((p) => p[0]);
          const ys = points.map((p) => p[1]);
          const [x0, x1] = [Math.min(...xs) - padLon, Math.max(...xs) + padLon];
          const [y0, y1] = [Math.min(...ys) - padLat, Math.max(...ys) + padLat];
          return [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ] as Position[];
        })()
      : hull.map(([x, y]) => {
          const dx = x - cx;
          const dy = y - cy;
          const len = Math.hypot(dx / padLon, dy / padLat) || 1;
          return [x + (dx / padLon / len) * padLon, y + (dy / padLat / len) * padLat] as Position;
        });

  return { type: 'Polygon', coordinates: [[...ring, ring[0]!]] };
}
