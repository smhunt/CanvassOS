/**
 * Street-level imagery of a door, so a canvasser can recognise the house before they walk up it:
 * is it the one behind the hedge, are there steps, is there a gate.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED LIKE THIS — the privacy design, which is the hard part
 * ---------------------------------------------------------------------------------------------
 * The doors on the map come from the voters list, and s. 23(8) of the *Municipal Elections Act,
 * 1996* says a recipient of that list "shall not provide it to any other person". A naive
 * implementation of this feature — putting a Google key in the SPA and asking the browser for
 * `streetview?location=<address>` — would hand a third party the campaign's working copy of the
 * clerk's list one door at a time. So:
 *
 * 1. **Coordinates only leave the building — never a name, an address string, or a household id.**
 *    The lat/lon of a door is public: it comes from Middlesex County's open address data, and
 *    anyone can look up where 123 Glendon Drive is. What is confidential is *who lives there*, and
 *    nothing in this file can see a voter row. `requestDoorImage()` takes two numbers.
 *
 * 2. **The provider key never reaches the browser.** Everything here runs server-side behind
 *    `GET /api/households/:id/streetview`. A key in client JavaScript is both a billing risk
 *    (anyone can spend the campaign's money) and a disclosure: the requests would carry the
 *    campaign's Referer, tying "which doors are being looked at, in what order, by whom" to the
 *    campaign. Proxied, Google sees one server making location requests with no referer and no
 *    per-volunteer identity.
 *
 * 3. **The imagery is never stored. Not on disk, not in memory.** Two independent reasons point
 *    the same way. The campaign should not accumulate a photo library of electors' houses — a
 *    directory of 7,000 house photos keyed to the voters list is exactly the artefact s. 23 exists
 *    to prevent. And Google's own terms forbid it outright: Maps Platform ToS §3.2.3(a) bars
 *    "pre-fetch, index, store, reshare, or rehost" and names "Street View images" explicitly,
 *    §3.2.3(b) is a flat "No Caching", and the only carve-out (Service Specific Terms §A.3) is for
 *    **`pano_ID` values**, which may be stored indefinitely. So the single cache in this file holds
 *    exactly that: the panorama id (or its absence) for a coordinate. Bytes pass straight through
 *    to the reply and are then unreferenced. There was an earlier draft of this file with a short
 *    byte cache to avoid double-billing; reading §3.2.3 is what removed it.
 *
 * 4. **The free metadata endpoint is checked first.** It answers "is there imagery here?" at no
 *    cost. On rural concession roads the honest answer is often no, and asking the *image*
 *    endpoint that question means paying for a grey "no imagery available" placeholder. Metadata
 *    first is both cheaper and how the route can return a truthful 404.
 *
 * 5. **The whole feature is off unless a key is configured** (`STREETVIEW_API_KEY`). This campaign
 *    may decide the third-party call is not worth it; absent the key nothing here ever runs.
 */

/** Injectable so tests can stub the provider — no test ever makes a real, billed call. */
export type FetchLike = typeof globalThis.fetch;

export type StreetViewProvider = 'google';

/** Google's unsigned Street View Static ceiling is 640×640; asking for more is silently clamped. */
export const STREETVIEW_MAX_DIM = 640;
export const STREETVIEW_MIN_DIM = 100;
export const STREETVIEW_DEFAULT_W = 640;
export const STREETVIEW_DEFAULT_H = 400;

/**
 * How far from the address point we will accept a panorama. Google's default is 50 m, which is
 * fine in Komoka or Ilderton but returns nothing for a farmhouse set well back from the road
 * allowance where the camera car actually drove — and rural doors are exactly the ones a canvasser
 * most needs to recognise. 100 m covers a deep rural setback while still being close enough that
 * the auto-computed heading points at the right property.
 */
const SEARCH_RADIUS_M = 100;

/** A door photo is ~100 KB; anything an order of magnitude larger is not an answer we asked for. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const METADATA_TIMEOUT_MS = 5_000;
const IMAGE_TIMEOUT_MS = 10_000;

/**
 * Panorama ids are the one thing the terms let us keep, and they are stable. Metadata requests are
 * free and unmetered, so this cache buys latency rather than money — one fewer round trip for a
 * volunteer stepping back and forth through a turf list. A TTL anyway, because a road that gets
 * re-driven should eventually be re-asked about.
 */
const PANO_TTL_MS = 6 * 60 * 60 * 1000;
const PANO_CACHE_MAX = 2_000; // ~100 bytes each; the whole 7.1k door set would still fit in memory

export interface DoorImage {
  bytes: Buffer;
  contentType: string;
}

/** What the provider said about a door. `unavailable` is an honest "no imagery here". */
export type DoorImageResult =
  | { kind: 'image'; image: DoorImage }
  | { kind: 'unavailable' }
  | { kind: 'error'; status: string };

// ---------------------------------------------------------------- bounded, expiring memory cache

interface Entry<T> {
  value: T;
  expires: number;
}

/** Insertion-ordered map used as a tiny TTL cache with a hard entry cap. */
class TtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Used by tests; drops everything held in memory. */
  clear(): void {
    this.map.clear();
  }
}

/**
 * coordinate → panorama id, or `null` meaning "asked, and there is nothing here". The ONLY thing
 * this process remembers about the provider's answers, and the only thing the terms permit it to.
 */
const panoCache = new TtlCache<string | null>(PANO_CACHE_MAX, PANO_TTL_MS);

/** Drop every remembered panorama id. */
export function clearStreetViewCache(): void {
  panoCache.clear();
}

// ---------------------------------------------------------------- provider

const GOOGLE_METADATA_URL = 'https://maps.googleapis.com/maps/api/streetview/metadata';
const GOOGLE_IMAGE_URL = 'https://maps.googleapis.com/maps/api/streetview';

/** 6 decimals ≈ 0.1 m — the same precision the map serves, and a stable cache key. */
const coordKey = (lat: number, lon: number): string => `${lat.toFixed(6)},${lon.toFixed(6)}`;

export interface DoorImageRequest {
  fetchImpl: FetchLike;
  apiKey: string;
  provider: StreetViewProvider;
  lat: number;
  lon: number;
  width: number;
  height: number;
}

/**
 * Metadata first (free): does the provider have imagery within `SEARCH_RADIUS_M` of this point?
 * Returns `null` when the provider answered with something that is neither yes nor no, so the
 * caller can distinguish "no photo of this door" (a normal 404) from "the provider is unhappy"
 * (a 502 the campaign's ops should see).
 */
async function googleHasImagery(
  req: DoorImageRequest,
): Promise<{ ok: true; panoId: string | null } | { ok: false; status: string }> {
  const url = new URL(GOOGLE_METADATA_URL);
  // `location` is two numbers. No address, no id, no session token, nothing that identifies a
  // person or ties this lookup to a campaign — see note 1 at the top of this file.
  url.searchParams.set('location', `${req.lat},${req.lon}`);
  url.searchParams.set('radius', String(SEARCH_RADIUS_M));
  // Outdoor panoramas only: an indoor business photosphere is not a door a canvasser can find.
  url.searchParams.set('source', 'outdoor');
  url.searchParams.set('key', req.apiKey);

  const res = await req.fetchImpl(url, {
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return { ok: false, status: `http_${res.status}` };

  const body = (await res.json()) as { status?: unknown; pano_id?: unknown };
  const status = typeof body.status === 'string' ? body.status : 'UNKNOWN';
  if (status === 'OK') {
    // `pano_id` is the one value the terms let us keep. An OK with no id is still a yes.
    return { ok: true, panoId: typeof body.pano_id === 'string' ? body.pano_id : '' };
  }
  // ZERO_RESULTS: nothing within the radius. NOT_FOUND: the point is not on any road network at
  // all. Both are the common, expected answer on a concession road, and neither is an error.
  if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') return { ok: true, panoId: null };
  return { ok: false, status };
}

/** The billed call. Only reached when metadata already said there is something here. */
async function googleImage(req: DoorImageRequest): Promise<{ bytes: Buffer; contentType: string } | { status: string }> {
  const url = new URL(GOOGLE_IMAGE_URL);
  url.searchParams.set('size', `${req.width}x${req.height}`);
  url.searchParams.set('location', `${req.lat},${req.lon}`);
  url.searchParams.set('radius', String(SEARCH_RADIUS_M));
  url.searchParams.set('source', 'outdoor');
  // Deliberately NO `heading`: given a `location` (rather than a `pano`), Google aims the camera
  // from the nearest photograph towards that point — which is precisely "look at this door".
  // `return_error_code` makes a missing panorama a 404 instead of a grey placeholder image, so a
  // race between the metadata check and the image call cannot bill us for a picture of nothing.
  url.searchParams.set('return_error_code', 'true');
  url.searchParams.set('key', req.apiKey);

  const res = await req.fetchImpl(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (res.status === 404) return { status: 'ZERO_RESULTS' };
  if (!res.ok) return { status: `http_${res.status}` };

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return { status: `bad_content_type:${contentType || 'none'}` };

  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) return { status: 'empty_body' };
  if (bytes.length > MAX_IMAGE_BYTES) return { status: 'oversized_body' };
  return { bytes, contentType };
}

/**
 * Fetch a door photo, checking the free availability endpoint before spending anything.
 *
 * Callers must have already decided the requester is allowed to see this door — nothing here
 * knows about roles or turfs. Both caches are keyed on the coordinates alone, which is why the
 * household id never has to be passed in.
 */
export async function requestDoorImage(req: DoorImageRequest): Promise<DoorImageResult> {
  const point = coordKey(req.lat, req.lon);

  // A remembered `null` — "we asked about this coordinate and there is no panorama" — is worth
  // having, because it is the answer for a lot of Middlesex Centre and it short-circuits the whole
  // request. A remembered id does NOT let us skip the image call: the bytes are never kept.
  const known = panoCache.get(point);
  if (known === null) return { kind: 'unavailable' };
  if (known === undefined) {
    const meta = await googleHasImagery(req);
    if (!meta.ok) return { kind: 'error', status: meta.status };
    panoCache.set(point, meta.panoId);
    if (meta.panoId === null) return { kind: 'unavailable' };
  }

  const img = await googleImage(req);
  if ('status' in img) {
    if (img.status === 'ZERO_RESULTS') {
      panoCache.set(point, null);
      return { kind: 'unavailable' };
    }
    return { kind: 'error', status: img.status };
  }

  return { kind: 'image', image: img };
}
