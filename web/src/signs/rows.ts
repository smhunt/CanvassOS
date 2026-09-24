/**
 * Row shapes for the two list endpoints, plus the adapters that get there from what
 * `src/api/hooks.ts` hands back.
 *
 * Both of these are documented in API.md ("Lawn signs") and both differ from the types the shared
 * hooks currently declare — `usePickupList()` is typed `Sign[]` but `GET /api/signs/pickup` returns
 * the narrower worklist row (with `photo_ids`, without `client_id`/`photo_count`/`permission_by`),
 * and `SignRequest` declares `requested_at`/`user_name` where `GET /api/signs/requests` sends
 * `last_contact_at`, `last_result`, `voter_name` and friends. The shared types are not this
 * screen's to edit, so the mismatch is absorbed here — defensively, so the pickup list still
 * renders whichever way the contract settles.
 */
import type { CancelReason, PickupSign as ApiPickupSign, PublicRequest, SignRequest, SignStatus } from '../api/types';
import { SIGN_STATUSES } from '../api/types';

/** One line on the post-election retrieval worklist. Re-exported so the panels keep importing it
 *  from here, but there is now exactly one definition, in api/types.ts. */
export type PickupSign = ApiPickupSign;

const isSignStatus = (v: unknown): v is SignStatus => SIGN_STATUSES.includes(v as SignStatus);

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Coerces the wire rows defensively — the pickup list is what the retrieval crew works from
 *  in November, so a malformed row should degrade to a visible gap, never throw the page away. */
export function toPickupSigns(rows: PickupSign[] | undefined): PickupSign[] {
  if (!rows) return [];
  return rows.map((row) => {
    const r = row as unknown as Record<string, unknown>;
    const ids = r.photo_ids;
    return {
      id: String(r.id ?? ''),
      status: isSignStatus(r.status) ? r.status : 'placed',
      ward: str(r.ward),
      address: str(r.address),
      label: str(r.label),
      size: str(r.size),
      note: str(r.note),
      lat: num(r.lat),
      lon: num(r.lon),
      accuracy_m: num(r.accuracy_m),
      placed_at: str(r.placed_at),
      placed_by_name: str(r.placed_by_name),
      photo_ids: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
    };
  });
}

/** A door that asked for a sign at the door and has not had one delivered. */
export interface DeliveryRequest {
  household_id: string;
  address: string;
  ward: string;
  community: string | null;
  /** The door's own position — what a sign request is filed at, and what Directions opens. */
  lat: number | null;
  lon: number | null;
  contact_id: string;
  /** When the door asked — `last_contact_at` on the wire, `requested_at` in the shared type. */
  at: string | null;
  user_name: string | null;
  voter_name: string | null;
  note: string | null;
  /** `door` = a contact ticked "wants a sign"; `direct` = raised from a door card, no visit behind it. */
  origin: 'door' | 'direct';
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: CancelReason | null;
  cancel_note: string | null;
}

export function toDeliveryRequests(rows: SignRequest[] | undefined): DeliveryRequest[] {
  if (!rows) return [];
  return rows.map((row) => {
    const r = row as unknown as Record<string, unknown>;
    return {
      household_id: String(r.household_id ?? ''),
      address: str(r.address) ?? 'Address unknown',
      ward: str(r.ward) ?? '',
      community: str(r.community),
      lat: num(r.lat),
      lon: num(r.lon),
      contact_id: String(r.contact_id ?? ''),
      at: str(r.last_contact_at),
      user_name: str(r.user_name),
      voter_name: str(r.voter_name),
      note: str(r.note),
      origin: r.source === 'direct' ? 'direct' : 'door',
      cancelled_at: str(r.cancelled_at),
      cancelled_by_name: str(r.cancelled_by_name),
      cancel_reason: (str(r.cancel_reason) as CancelReason | null) ?? null,
      cancel_note: str(r.cancel_note),
    };
  });
}

/**
 * One list, four provenances.
 *
 * A volunteer holding a bundle of signs does not care how the request arrived, so the screen shows
 * them together; what they DO care about is whether a person said it at a door or it came off a web
 * form, which is why every row keeps its origin on a chip.
 *
 * The merge is in the browser, and that is a legal boundary rather than a convenience. `door` and
 * `direct` rows come from `GET /api/signs/requests`, which a scoped volunteer may call. `manual`
 * and `website` rows are `public_request` rows carrying a name, an email and a phone under CASL
 * consent, and come from `GET /api/public/requests`, which refuses a volunteer at the route. There
 * is no server response in which the two shapes are mixed, so there is no shape in which a
 * volunteer could be handed a CASL contact field — see API.md, GET /api/signs/requests.
 */
export type RequestOrigin = 'door' | 'direct' | 'manual' | 'website';

export const ORIGIN_LABELS: Record<RequestOrigin, string> = {
  door: 'asked at the door',
  direct: 'requested on a door card',
  manual: 'taken by hand',
  website: 'from the website',
};

export interface UnifiedRequest {
  /** Unique across all four origins: the door for a door/direct row, the request id otherwise. */
  key: string;
  origin: RequestOrigin;
  /** Null for a public sign-up nobody has matched to a door yet — its address is free text. */
  household_id: string | null;
  /** The heading: the door's address, or what the person typed, or their name as a last resort. */
  title: string;
  ward: string | null;
  community: string | null;
  lat: number | null;
  lon: number | null;
  /** When they asked. Null only if a row somehow carries no timestamp. */
  at: string | null;
  /** Who took it down — nobody is recorded on a `direct` row; see API.md. */
  user_name: string | null;
  voter_name: string | null;
  note: string | null;
  /**
   * Name, phone and email — CASL-governed, and present ONLY on `manual`/`website` rows, which only
   * an organizer ever receives. Never populated from a door row.
   */
  contact_line: string | null;
  /** The `public_request` id behind a manual/website row, for the edit/delete/handled routes. */
  public_request_id: string | null;
  /** Filled only on a row from the bin; a live row carries nulls. */
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  cancel_reason: CancelReason | null;
  cancel_note: string | null;
}

export function fromSignRequests(rows: DeliveryRequest[]): UnifiedRequest[] {
  return rows.map((r) => ({
    key: `h:${r.household_id}`,
    origin: r.origin,
    household_id: r.household_id,
    title: r.address,
    ward: r.ward || null,
    community: r.community,
    lat: r.lat,
    lon: r.lon,
    at: r.at,
    user_name: r.user_name,
    voter_name: r.voter_name,
    note: r.note,
    contact_line: null,
    public_request_id: null,
    cancelled_at: r.cancelled_at,
    cancelled_by_name: r.cancelled_by_name,
    cancel_reason: r.cancel_reason,
    cancel_note: r.cancel_note,
  }));
}

export function fromPublicRequests(rows: PublicRequest[] | undefined): UnifiedRequest[] {
  if (!rows) return [];
  return rows
    // Somebody who signed up to volunteer is a different job and belongs on the sign-ups screen,
    // not in the hands of the crew loading signs into a truck.
    .filter((r) => r.wants.includes('sign'))
    .map((r) => ({
      key: `p:${r.id}`,
      origin: r.source === 'manual' ? 'manual' : 'website',
      household_id: r.household_id,
      title: r.address ?? r.name,
      ward: null,
      community: null,
      lat: null,
      lon: null,
      at: r.created_at,
      user_name: null,
      voter_name: null,
      note: r.note,
      contact_line: [r.name, r.phone, r.email].filter(Boolean).join(' · ') || null,
      public_request_id: r.id,
      // A public request has no cancel stamp: its equivalent is `handled_at`, which the panel
      // reads from the request itself. Keeping these null stops the bin row inventing a reason.
      cancelled_at: null,
      cancelled_by_name: null,
      cancel_reason: null,
      cancel_note: null,
    }));
}

/** Newest first, across every origin — the one ordering that makes a mixed list readable. */
export function sortRequests(rows: UnifiedRequest[]): UnifiedRequest[] {
  return [...rows].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

/**
 * A link the phone will actually open in its map app.
 *
 * `geo:` is the obvious choice and the wrong one: iOS ignores it in Safari, which is most of the
 * phones on a pickup crew. Google's universal `maps/search` URL is the one link that works
 * everywhere — it opens the Google Maps app on Android and on any iPhone that has it, and falls
 * back to the web map otherwise, rather than dead-ending. Apple's `maps.apple.com` would be nicer
 * on an iPhone and useless on Android, and the crew is mixed.
 */
export function mapsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}
