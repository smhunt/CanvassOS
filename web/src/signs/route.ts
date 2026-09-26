/**
 * The delivery run as a drive: put the waiting doors in a sensible order and hand that order to the
 * phone's navigation app.
 *
 * The order is solved here, not by Google. Maps URLs have no "optimise waypoints" switch — the
 * stops are driven in exactly the order the link lists them — so a link built straight from the
 * newest-first list would zig-zag across the township. Nearest-neighbour gives a reasonable first
 * tour and 2-opt then removes every crossing it can find. Distances are straight-line (haversine),
 * not road distances: on Middlesex Centre's concession grid that is close enough to pick the order,
 * and the only way to do better would be to send every door to a routing API, which is exactly
 * what this module is built not to do.
 *
 * What leaves the browser, and only when somebody taps a link: coordinates. Never a name, an
 * address string or a household id — the same rule as the Street View proxy (CLAUDE.md), because
 * a list of supporters' doors in a URL is the list, and a coordinate pair is the least of it a
 * navigation app can work with.
 */
import { distanceM, type Coords } from '../canvass/directions';

export interface RouteStop {
  key: string;
  title: string;
  lat: number;
  lon: number;
}

/**
 * Google documents up to nine waypoints on every platform except a *mobile browser*, which gets
 * three. The link opens the Maps app on a phone that has it, so a leg is nine waypoints plus the
 * destination; a phone without the app gets the web map, which may drop waypoints past the third,
 * and the leg list says so.
 */
export const STOPS_PER_LEG = 10;

const key = (c: Coords): string => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;

/**
 * Nearest-neighbour then 2-opt, on an open path (the run ends at the last sign, it does not drive
 * home). With a `start` the tour is anchored there; without one, it begins at whichever end of the
 * spread makes the shorter drive, and the first leg's link leaves the origin blank so the app
 * starts from wherever the phone is.
 */
export function orderStops<T extends RouteStop>(stops: T[], start: Coords | null): T[] {
  if (stops.length <= 1) return [...stops];

  // Nearest-neighbour from the start, or — with none — from the stop farthest from the centroid,
  // which is an end of the spread rather than the middle of it.
  let from: Coords;
  if (start) {
    from = start;
  } else {
    const c = {
      lat: stops.reduce((s, p) => s + p.lat, 0) / stops.length,
      lon: stops.reduce((s, p) => s + p.lon, 0) / stops.length,
    };
    from = stops.reduce((far, p) => (distanceM(c, p) > distanceM(c, far) ? p : far), stops[0] as T);
  }
  const left = [...stops];
  const tour: T[] = [];
  while (left.length > 0) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (distanceM(from, left[i] as T) < distanceM(from, left[best] as T)) best = i;
    }
    const next = left.splice(best, 1)[0] as T;
    tour.push(next);
    from = next;
  }

  // 2-opt on the open path. Node -1 is the fixed start when there is one; with none, the first
  // stop is free too, so a reversal may take in the head of the tour.
  const at = (i: number): Coords | null => (i < 0 ? start : i >= tour.length ? null : (tour[i] as T));
  const d = (a: Coords | null, b: Coords | null): number => (a && b ? distanceM(a, b) : 0);
  const n = tour.length;
  let improved = true;
  // Bounded so a pathological input can never hang the screen; real runs settle in a few passes.
  for (let pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const before = d(at(i - 1), at(i)) + d(at(j), at(j + 1));
        const after = d(at(i - 1), at(j)) + d(at(i), at(j + 1));
        if (after < before - 0.5) {
          tour.splice(i, j - i + 1, ...tour.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return tour;
}

/** Straight-line length of the whole run, start included — shown so nobody mistakes it for road km. */
export function tourLengthM(stops: Coords[], start: Coords | null): number {
  let total = 0;
  let prev = start;
  for (const s of stops) {
    if (prev) total += distanceM(prev, s);
    prev = s;
  }
  return total;
}

export interface RouteLeg {
  /** 1-based positions in the ordered run, inclusive, for "stops 11–20". */
  first: number;
  last: number;
  url: string;
}

/**
 * Splits the ordered run into Google Maps directions links of `STOPS_PER_LEG` stops each. Every leg
 * after the first starts at the previous leg's last stop, so the legs chain into one drive. The
 * first leg's origin is the phone's fix when there is one and blank otherwise — Google then starts
 * from the device's own location, which is what a driver wants anyway.
 */
export function googleLegs(stops: Coords[], start: Coords | null): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (let i = 0; i < stops.length; i += STOPS_PER_LEG) {
    const chunk = stops.slice(i, i + STOPS_PER_LEG);
    const origin = i === 0 ? start : (stops[i - 1] as Coords);
    const destination = chunk[chunk.length - 1] as Coords;
    const waypoints = chunk.slice(0, -1);
    const params = [
      'api=1',
      ...(origin ? [`origin=${key(origin)}`] : []),
      `destination=${key(destination)}`,
      ...(waypoints.length > 0 ? [`waypoints=${waypoints.map(key).join('%7C')}`] : []),
      'travelmode=driving',
    ];
    legs.push({ first: i + 1, last: i + chunk.length, url: `https://www.google.com/maps/dir/?${params.join('&')}` });
  }
  return legs;
}

/**
 * Waze's deep link takes one destination and nothing else — there is no multi-stop form — so Waze
 * is offered per stop, in route order, and the driver taps the next one on arrival.
 */
export function wazeUrl(c: Coords): string {
  return `https://waze.com/ul?ll=${key(c)}&navigate=yes`;
}
