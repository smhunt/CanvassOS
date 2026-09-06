import { useState, type FormEvent } from 'react';
import { useUpdateTurf } from '../api/hooks';
import type { TurfSummary } from '../api/types';
import { ErrorBox } from '../components/ui';
import { Dialog } from './Dialog';

const FORM_ID = 'rename-turf-form';

interface Props {
  turf: TurfSummary;
  onClose: () => void;
}

export function RenameDialog({ turf, onClose }: Props) {
  const update = useUpdateTurf();
  const [name, setName] = useState(turf.name);
  const trimmed = name.trim();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || trimmed === turf.name || update.isPending) return;
    update.mutate({ id: turf.id, name: trimmed }, { onSuccess: onClose });
  };

  return (
    <Dialog
      title="Rename turf"
      titleId="rename-turf-h"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={FORM_ID}
            className="btn btn--primary"
            disabled={!trimmed || trimmed === turf.name || update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="modal__body">
        <form id={FORM_ID} onSubmit={onSubmit} noValidate>
          <label className="field">
            <span className="field__label">Turf name</span>
            <input type="text" required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </form>
        {update.isError && <ErrorBox title="Could not rename the turf" error={update.error} compact />}
      </div>
    </Dialog>
  );
}
