import { useEffect, useRef, useState } from 'react';
import { useLegalHouseholds } from '../api/hooks';
import type { Meta } from '../api/types';
import { EmptyState, ErrorBox, LoadingRows, n, wardLabel } from '../components/ui';

interface Props {
  open: boolean;
  onClose: () => void;
  meta: Meta | undefined;
  onPick: (id: string) => void;
}

/** The concession/lot households that have no map point, listed so they are still reachable. */
export function LegalList({ open, onClose, meta, onPick }: Props) {
  const [ward, setWard] = useState('');
  const legal = useLegalHouseholds(open, ward || undefined);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    headRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const rows = legal.data?.households ?? [];
  return (
    <div className="modal-wrap" role="presentation">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="card modal" role="dialog" aria-modal="true" aria-labelledby="legal-h">
        <header className="modal__head">
          <h2 id="legal-h" ref={headRef} tabIndex={-1}>
            Unmapped parcels
          </h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </header>
        <p className="muted small modal__intro">
          These households are listed by legal description (concession / lot) with no civic address, so they have no point on the
          map. Open one to see its voters.
        </p>
        <label className="field field--inline">
          <span className="field__label">Ward</span>
          <select aria-label="Ward" value={ward} onChange={(e) => setWard(e.target.value)}>
            <option value="">All wards</option>
            {meta?.wards.map((w) => (
              <option key={w.ward} value={w.ward}>
                {wardLabel(w.ward)}
              </option>
            ))}
          </select>
        </label>
        <div className="modal__body">
          {legal.isPending && <LoadingRows rows={6} />}
          {legal.isError && <ErrorBox error={legal.error} onRetry={() => void legal.refetch()} compact />}
          {legal.data && rows.length === 0 && <EmptyState title="No unmapped parcels in this ward" />}
          {rows.length > 0 && (
            <table className="table table--compact">
              <thead>
                <tr>
                  <th scope="col">Legal description</th>
                  <th scope="col">Ward</th>
                  <th scope="col" className="num">
                    Voters
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <button type="button" className="linkbtn" onClick={() => onPick(h.id)}>
                        {h.address}
                      </button>
                      {h.voter_names && <div className="muted small">{h.voter_names}</div>}
                    </td>
                    <td>{wardLabel(h.ward)}</td>
                    <td className="num">{n(h.n_voters)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
