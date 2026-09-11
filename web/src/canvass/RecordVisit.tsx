/**
 * Record a visit to a door that was opened from the map, rather than from a turf.
 *
 * The door screen's `DoorSheet` cannot be reused here: it is built around walking a turf — it wants
 * a `turfId`, a position ("Door 4 of 26"), previous/next, and where the volunteer was standing. A
 * door tapped on the map has none of those and inventing them would be lying to the UI. What the
 * two genuinely share is the part that matters — `SpokeForm` and `spokeBody()` — so those are
 * shared and this is the small shell around them.
 *
 * `turf_id` is nullable on `contact`, which is what makes this possible at all: a visit to a door
 * in no turf is a real visit and has always been storable. Nothing could record one.
 */
import { useState } from 'react';
import { useRecordContact, type RecordContactVars } from '../api/hooks';
import { CONTACT_RESULTS, RESULT_LABELS, type ContactInput, type ContactResult, type Voter } from '../api/types';
import { ErrorBox, Spinner } from '../components/ui';
import { spokeBody } from './contactBody';
import { SpokeForm, type SpokeDetail } from './SpokeForm';
import { resultColour } from './status';

interface Props {
  householdId: string;
  address: string;
  voters: Voter[];
  /** The turf this door is in, when it is in one. Null is normal and is stored as null. */
  turfId: string | null;
  onRecorded: (result: ContactResult) => void;
  onCancel: () => void;
}

export function RecordVisit({ householdId, address, voters, turfId, onRecorded, onCancel }: Props) {
  const [spoke, setSpoke] = useState(false);
  const record = useRecordContact();

  function send(input: Omit<ContactInput, 'client_id'>) {
    // One client_id, minted once here. Regenerating it on a retry is what turns one door into two,
    // so the mutation gets the same body back if it has to go through the offline queue.
    const body: RecordContactVars = { ...input, client_id: crypto.randomUUID(), door_label: address };
    record.mutate(body, { onSuccess: () => onRecorded(body.result) });
  }

  if (spoke) {
    return (
      <div className="rv">
        <SpokeForm
          householdId={householdId}
          defaultSignAddress={address}
          voters={voters}
          pending={record.isPending}
          onSubmit={(d: SpokeDetail) => send(spokeBody(d, householdId, turfId))}
          onCancel={() => setSpoke(false)}
        />
        {record.isError && <ErrorBox title="Could not record this visit" error={record.error} compact />}
      </div>
    );
  }

  return (
    <div className="rv">
      <div className="rv__results" role="group" aria-label="What happened at this door">
        {CONTACT_RESULTS.map((r) => (
          <button
            key={r}
            type="button"
            className="btn rv__result"
            style={{ '--result': resultColour(r) } as React.CSSProperties}
            disabled={record.isPending}
            // "Spoke" opens the detail form because support, flags and a note have to ride along
            // with the same POST — contacts are append-only and there is no edit endpoint.
            onClick={() => (r === 'spoke' ? setSpoke(true) : send({ household_id: householdId, turf_id: turfId, result: r }))}
          >
            {RESULT_LABELS[r]}
          </button>
        ))}
      </div>
      <div className="rv__foot">
        {record.isPending && <Spinner size={14} />}
        <button type="button" className="btn btn--small" onClick={onCancel} disabled={record.isPending}>
          Cancel
        </button>
      </div>
      {record.isError && <ErrorBox title="Could not record this visit" error={record.error} compact />}
    </div>
  );
}
