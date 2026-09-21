import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  titleId: string;
  onClose: () => void;
  /** Wider panel for the street picker; the default matches the map's modals. */
  wide?: boolean;
  /**
   * Change this when the panel swaps to a different step (assign → confirm removal) to pull focus
   * back to the heading, which now describes the new step. Without it a keyboard or screen-reader
   * user is left on a button that no longer exists.
   */
  focusKey?: string;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The map's modal idiom (`src/map/LegalList.tsx`) plus the two things a form dialog needs that a
 * read-only list does not: focus stays inside while it is open, and it goes back to the button that
 * opened it on close — organisers drive this screen from the keyboard.
 * Rendered only while open, so the mount effect is the open effect.
 */
export function Dialog({ title, titleId, onClose, wide, focusKey, children, footer }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  // Mount-only: parents pass an inline `onClose`, so the listener effect below re-runs on every
  // render — reading `activeElement` there would capture a button inside the panel as the opener.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    headRef.current?.focus();
  }, [focusKey]);

  // Capture phase, and only the topmost modal acts. The page underneath has its own Escape listeners
  // on `document` (a door sheet, the household card, the turf draw tool), registered earlier, so in
  // the bubble phase they ran FIRST and stopPropagation() came too late: Escape in the help dialog
  // also closed the open door or threw away a half-drawn turf. A capture listener on `document` runs
  // before every bubble listener, and stopPropagation() then keeps it from reaching them. The
  // topmost check is what makes capture safe if two dialogs are ever open: without it the outer one,
  // registered first, would take the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (modals[modals.length - 1] !== panelRef.current) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;
      const here = document.activeElement;
      if (e.shiftKey && (here === first || here === headRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && here === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal-wrap modal-wrap--fixed" role="presentation">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className={`card modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__head">
          <h2 id={titleId} ref={headRef} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </header>
        {children}
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}
