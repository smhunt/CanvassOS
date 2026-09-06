import { useMemo, useState, type FormEvent } from 'react';
import { useCreateTurf, useMeta, useStreets, useTurfs } from '../api/hooks';
import type { TurfSummary } from '../api/types';
import { ErrorBox, wardLabel } from '../components/ui';
import { Dialog } from './Dialog';
import { doorsInSelection, StreetPicker } from './StreetPicker';
import { TurfShapePanel } from './TurfShapePanel';

const FORM_ID = 'create-turf-form';
const FOOTNOTE_ID = 'create-turf-footnote';

/**
 * `street_sort` → names of the turfs already covering it. Archived turfs are skipped deliberately:
 * an archived turf is finished walking, so its roads are free to cut into a new one. GET /api/turfs
 * returns archived rows whatever the `archived` param says, so the skip has to happen here.
 */
function claimsByStreet(turfs: TurfSummary[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of turfs) {
    if (t.archived) continue;
    for (const s of t.streets) {
      const names = out.get(s);
      if (names) names.push(t.name);
      else out.set(s, [t.name]);
    }
  }
  return out;
}

interface Props {
  onClose: () => void;
  onCreated: (turf: TurfSummary) => void;
}

/**
 * Street-pick path only. Drawing a polygon happens on the map; the API takes exactly one of
 * `streets` or `polygon`, so this dialog always sends `streets`.
 */
export function CreateTurfDialog({ onClose, onCreated }: Props) {
  const meta = useMeta();
  const turfs = useTurfs();
  const create = useCreateTurf();
  const [name, setName] = useState('');
  const [ward, setWard] = useState('');
  const [streets, setStreets] = useState<string[]>([]);

  // Same query key the picker uses, so this is the cached list, not a second request.
  const streetRows = useStreets();
  const estimatedDoors = useMemo(
    () => doorsInSelection(streetRows.data ?? [], streets),
    [streetRows.data, streets],
  );

  const claimedBy = useMemo(() => claimsByStreet(turfs.data ?? []), [turfs.data]);
  const overlap = streets.filter((s) => claimedBy.has(s));
  const overlapTurfs = [...new Set(overlap.flatMap((s) => claimedBy.get(s) ?? []))];

  const ready = name.trim().length > 0 && streets.length > 0;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || create.isPending) return;
    create.mutate(
      { name: name.trim(), ward: ward || null, streets },
      { onSuccess: (r) => onCreated(r.turf) },
    );
  };

  return (
    <Dialog
      title="New turf"
      titleId="create-turf-h"
      onClose={onClose}
      wide
      footer={
        <>
          {overlap.length > 0 ? (
            <p className="small footnote footnote--warn" id={FOOTNOTE_ID}>
              <span aria-hidden="true">⚑ </span>
              <span className="visually-hidden">Warning: </span>
              {overlap.length} of {streets.length} selected streets {overlap.length === 1 ? 'is' : 'are'} already in{' '}
              {overlapTurfs.join(', ')} — those doors get knocked twice unless you are splitting a road on purpose.
            </p>
          ) : (
            <p className="muted small footnote" id={FOOTNOTE_ID}>
              {streets.length === 0 ? 'Pick at least one street.' : `${streets.length} street${streets.length === 1 ? '' : 's'} selected.`}
            </p>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={FORM_ID}
            className="btn btn--primary"
            aria-describedby={FOOTNOTE_ID}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create turf'}
          </button>
        </>
      }
    >
      <div className="modal__body">
        <form id={FORM_ID} onSubmit={onSubmit} noValidate>
          <div className="form-row">
            <label className="field">
              <span className="field__label">Turf name</span>
              <input
                type="text"
                required
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Komoka — north of Glendon"
              />
            </label>
            <div className="field field--short">
              <label className="field__label" htmlFor="turf-ward">
                Ward
              </label>
              <select
                id="turf-ward"
                aria-describedby="turf-ward-hint"
                value={ward}
                onChange={(e) => setWard(e.target.value)}
              >
                <option value="">All wards</option>
                {meta.data?.wards.map((w) => (
                  <option key={w.ward} value={w.ward}>
                    {wardLabel(w.ward)}
                  </option>
                ))}
              </select>
              <span className="field__hint" id="turf-ward-hint">
                Filters the streets below and is saved on the turf.
              </span>
            </div>
          </div>
        </form>

        {turfs.isError && (
          <p className="muted small">
            The existing turfs could not be loaded, so streets already used by another turf are not flagged below.
          </p>
        )}

        {/* Picker first in the DOM as well as on screen: it is the authoritative representation of
            the turf, and the map beside (or, on a phone, below) it is the supplement. */}
        <div className="create-turf__cols">
          <div className="create-turf__pick">
            <StreetPicker
              ward={ward}
              communities={meta.data?.communities.map((c) => c.community) ?? []}
              selected={streets}
              claimedBy={claimedBy}
              onChange={setStreets}
            />
          </div>
          <TurfShapePanel streets={streets} ward={ward} estimatedDoors={estimatedDoors} />
        </div>

        {create.isError && <ErrorBox title="Could not create the turf" error={create.error} compact />}
      </div>
    </Dialog>
  );
}
