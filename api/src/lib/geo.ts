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
