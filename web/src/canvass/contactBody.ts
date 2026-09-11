/**
 * Turning what the volunteer ticked into the body `POST /api/contacts` wants.
 *
 * Extracted so the door screen and the map's door card build it the *same* way. The rules below
 * are not obvious and each one is a bug that was hit once already, so there must be exactly one
 * copy of them:
 *
 * - `supports` (per person) only once two people are named. With one person or nobody, the
 *   door-level `support` is the same answer with one fewer moving part.
 * - a `supports` key naming somebody no longer ticked is `400 support_voter_not_named`, so the map
 *   is pruned against the final list however the state got there.
 * - the API takes `voter_ids` / `support` / `note` as optional, not nullable, so anything left
 *   blank is omitted rather than sent as null.
 */
import type { ContactInput } from '../api/types';
import type { SpokeDetail } from './SpokeForm';

export function spokeBody(
  d: SpokeDetail,
  householdId: string,
  /** Null for a door recorded off the map that belongs to no turf — the column is nullable. */
  turfId: string | null,
): Omit<ContactInput, 'client_id'> {
  const note = d.note.trim();
  const perPerson = d.voter_ids.length > 1;
  const supports = Object.fromEntries(Object.entries(d.supports).filter(([id]) => d.voter_ids.includes(id)));
  return {
    household_id: householdId,
    turf_id: turfId,
    result: 'spoke',
    ...(d.voter_ids.length > 0 ? { voter_ids: d.voter_ids } : {}),
    ...(perPerson
      ? Object.keys(supports).length > 0
        ? { supports }
        : {}
      : d.support !== null
        ? { support: d.support }
        : {}),
    ...(note ? { note } : {}),
    wants_sign: d.wants_sign,
    // Only ever alongside wants_sign — the API refuses an address without the request, because an
    // address for a sign nobody asked for is a delivery somebody will actually drive to.
    ...(d.wants_sign && d.sign_address.trim() ? { sign_address: d.sign_address.trim() } : {}),
    wants_volunteer: d.wants_volunteer,
    needs_ride: d.needs_ride,
    follow_up: d.follow_up,
  };
}
