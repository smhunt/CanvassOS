/**
 * Getting a volunteer from the door they just finished to the next one.
 *
 * The link has to open the phone's *own* map app, which rules out the obvious answers: `geo:` is
 * ignored by Safari on iOS, and `maps.apple.com` is useless on Android. Google's universal
 * `maps/search` URL is the only one that opens a native app on both and degrades to the web map
 * otherwise. The lawn-sign screen reached the same conclusion for the same reason; the two screens
 * are owned separately, so the choice is reimplemented here rather than shared.
 */
export function mapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

export interface Coords {
  lat: number;
  lon: number;
}

/** A door only has a usable position when the import geocoded it; plenty of rural doors have not. */
export function coordsOf(d: { lat: number | null; lon: number | null }): Coords | null {
  return d.lat !== null && d.lon !== null ? { lat: d.lat, lon: d.lon } : null;
}

const EARTH_M = 6371000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Haversine. Turf legs are a few hundred metres, so any spheroid refinement would be noise. */
export function distanceM(a: Coords, b: Coords): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Initial great-circle bearing, rounded to eight points — the most a phone in a pocket can be trusted with. */
export function compassOf(a: Coords, b: Coords): string {
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return COMPASS[Math.round(((deg + 360) % 360) / 45) % 8] as string;
}

/**
 * "120 m NE" — how far the next door is from the one just knocked. Null when either end is
 * unmapped, or when the two doors are close enough that a bearing would send someone the wrong way
 * down a driveway.
 */
export function walkHint(from: Coords | null, to: Coords | null): string | null {
  if (!from || !to) return null;
  const m = distanceM(from, to);
  if (m < 15) return 'next door';
  const dist = m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  return `${dist} ${compassOf(from, to)}`;
}
