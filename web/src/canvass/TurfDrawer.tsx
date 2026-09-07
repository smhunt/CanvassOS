/**
 * Switch turfs without leaving the doors.
 *
 * A volunteer with more than one turf was going back to the list page and in again to move between
 * them, losing their place each time. This slides over the door screen instead: the same turfs, the
 * same progress, one tap to change.
 *
 * Portalled to <body> for the same reason the draw dialog is — the door screen sits inside stacking
 * contexts of its own, and a drawer the header paints over is worse than no drawer.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import type { Assignment } from '../api/types';
import { n, wardLabel } from '../components/ui';
import { Progress, StatusChip } from './Progress';

interface Props {
  open: boolean;
  onClose: () => void;
  assignments: Assignment[];
  /** The turf currently on screen: marked as open, and not navigable. */
  currentTurfId: string | undefined;
  /** True while the assignments are still loading, so the drawer says so rather than looking empty. */
  loading?: boolean;
}

export function TurfDrawer({ open, onClose, assignments, currentTurfId, loading = false }: Props) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Escape closes, and the panel takes focus when it opens so a keyboard user is inside it rather
  // than still on the door list behind the scrim.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The door sheet also closes on Escape and may be open behind this.
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const go = (turfId: string) => {
    onClose();
    navigate(`/canvass/${turfId}`);
  };

  const onRowKey = (e: ReactKeyboardEvent, turfId: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    go(turfId);
  };

  return createPortal(
    <div className="cv-drawer-wrap" role="presentation">
      <div className="cv-drawer__scrim" onClick={onClose} aria-hidden="true" />
      <div className="cv-drawer" role="dialog" aria-modal="true" aria-labelledby="cv-drawer-h" tabIndex={-1} ref={panelRef}>
        <header className="cv-drawer__head">
          <h2 id="cv-drawer-h">Your turfs</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close the turf list">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </header>

        <div className="cv-drawer__body">
          {loading && <p className="muted small">Loading your turfs…</p>}
          {!loading && assignments.length === 0 && <p className="muted small">No turfs are assigned to you.</p>}
          <ul className="cv-turfs cv-turfs--drawer">
            {assignments.map((a) => {
              const current = a.turf.id === currentTurfId;
              return (
                <li key={a.id}>
                  {/* The open turf is not a button: tapping it would be a navigation to where you
                      already are, which closes the drawer and reads as a failure. */}
                  <div
                    className={`cv-turf${current ? ' cv-turf--current' : ''}`}
                    {...(current
                      ? { 'aria-current': true as const }
                      : {
                          role: 'button',
                          tabIndex: 0,
                          onClick: () => go(a.turf.id),
                          onKeyDown: (e: ReactKeyboardEvent) => onRowKey(e, a.turf.id),
                        })}
                  >
                    <div className="cv-turf__top">
                      <span className="cv-turf__name">{a.turf.name}</span>
                      {current ? <span className="cv-turf__here">Open</span> : <StatusChip status={a.status} />}
                    </div>
                    <div className="cv-turf__meta">
                      {a.turf.ward && <span>{wardLabel(a.turf.ward)}</span>}
                      <span>{n(a.n_households)} doors</span>
                    </div>
                    <Progress done={a.contacted} total={a.n_households} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="cv-drawer__foot">
          {/* `list=1` suppresses the auto-open on /canvass, which would otherwise bounce straight
              back into this turf and make the full list unreachable. */}
          <Link className="btn btn--block" to="/canvass?list=1" onClick={onClose}>
            All my turfs
          </Link>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
