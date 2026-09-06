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
import type { PickupSign as ApiPickupSign, SignRequest, SignStatus } from '../api/types';
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
  contact_id: string;
  /** When the door asked — `last_contact_at` on the wire, `requested_at` in the shared type. */
  at: string | null;
  user_name: string | null;
  voter_name: string | null;
  note: string | null;
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
      contact_id: String(r.contact_id ?? ''),
      at: str(r.last_contact_at),
      user_name: str(r.user_name),
      voter_name: str(r.voter_name),
      note: str(r.note),
    };
  });
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
