/**
 * Whether a lawn sign can be *requested* at a door, and what to say when it cannot.
 *
 * Pure, so it can be unit-tested under `tsx --test` with no DOM. Both rules it encodes are ones the
 * volunteer cannot see from the button: one the API would answer with a 400, the other with a
 * silent duplicate row.
 *
 * A request is a `sign` row with status `requested` at the household's OWN coordinates — the same
 * row `POST /api/contacts` writes when a canvasser ticks "wants a sign" (api/src/routes/contacts.ts).
 * It is deliberately not a `public_request`: that table records a *person* who phoned the campaign,
 * is organizer-only, and needs a name and a consent line nobody read at a door.
 */
import type { Sign } from '../api/types';

export type SignRequestVerdict = { can: true } | { can: false; reason: string };

export function signRequestVerdict(
  door: { id: string; lat: number | null; lon: number | null },
  signs: Sign[] | undefined,
): SignRequestVerdict {
  // `POST /api/signs` requires finite coordinates inside the Middlesex Centre sanity box, and a
  // requested sign is filed at the door's own position — an unmapped parcel (a concession/lot legal
  // description) has none to file, so the write would be refused with coordinate_out_of_range.
  if (door.lat === null || door.lon === null) {
    return { can: false, reason: 'This door has no map position, so a sign cannot be filed against it.' };
  }

  // Fails OPEN, on purpose. `signs` is undefined while the list is loading and STAYS undefined when
  // the fetch failed — which in this app most often means a volunteer standing in a field with no
  // signal. A duplicate pin is a five-second cleanup by an organizer; a volunteer on a porch who
  // cannot record what the resident just asked for is a sign nobody ever delivers.
  if (!signs) return { can: true };

  const here = signs.filter((s) => s.household_id === door.id);
  if (here.some((s) => s.status === 'requested')) {
    return { can: false, reason: 'A sign has already been requested for this door.' };
  }
  // `removed` means picked up after the election (or collected in error), so it does not block a
  // fresh request. Anything else — placed, missing, damaged — is a sign this door already has.
  if (here.some((s) => s.status !== 'removed')) {
    return { can: false, reason: 'A sign is already recorded at this door.' };
  }
  return { can: true };
}
