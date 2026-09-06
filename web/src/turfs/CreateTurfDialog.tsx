import { useState, type FormEvent } from 'react';
import { useCreateTurf, useMeta } from '../api/hooks';
import type { TurfSummary } from '../api/types';
import { ErrorBox, wardLabel } from '../components/ui';
import { Dialog } from './Dialog';
import { StreetPicker } from './StreetPicker';

const FORM_ID = 'create-turf-form';

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
  const create = useCreateTurf();
  const [name, setName] = useState('');
  const [ward, setWard] = useState('');
  const [streets, setStreets] = useState<string[]>([]);

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
          <p className="muted small footnote">
            {streets.length === 0 ? 'Pick at least one street.' : `${streets.length} street${streets.length === 1 ? '' : 's'} selected.`}
          </p>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn btn--primary" disabled={!ready || create.isPending}>
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

        <p className="muted small">
          Streets already used by another turf are not flagged yet — check the turf list before cutting a turf that
          overlaps one.
        </p>

        <StreetPicker
          ward={ward}
          communities={meta.data?.communities.map((c) => c.community) ?? []}
          selected={streets}
          onChange={setStreets}
        />

        {create.isError && <ErrorBox title="Could not create the turf" error={create.error} compact />}
      </div>
    </Dialog>
  );
}
