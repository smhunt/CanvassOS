import { useEffect, useRef, useState } from 'react';
import { TOUR } from './tourSteps';

type Props = {
  open: boolean;
  onClose: () => void;
  /** The last step's button: close the tour and go to the waitlist form. */
  onJoin: () => void;
  onSignIn: () => void;
};

/*
 * The screenshot tour, in a native modal <dialog>: the page behind is inert, Escape closes it,
 * and focus comes back to whatever opened it. Left and right arrow keys move between steps.
 */
export function Tour({ open, onClose, onJoin, onSignIn }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [i, setI] = useState(0);
  const step = TOUR[i];
  const last = i === TOUR.length - 1;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setI(0);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Each step announces itself: focus goes to its title, which a screen reader reads.
  useEffect(() => {
    if (open) titleRef.current?.focus();
  }, [i, open]);

  const go = (n: number) => setI(Math.max(0, Math.min(TOUR.length - 1, n)));

  return (
    <dialog
      ref={ref}
      className="tour"
      aria-labelledby="tour-title"
      aria-describedby="tour-body"
      onClose={onClose}
      onCancel={onClose}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(i + 1);
        if (e.key === 'ArrowLeft') go(i - 1);
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="tour__inner">
        <figure className={`tour__shot tour__shot--${step.frame}`}>
          <picture key={step.image}>
            <source srcSet={`/tour/${step.image}.webp`} type="image/webp" />
            <img src={`/tour/${step.image}.png`} alt={step.alt} />
          </picture>
        </figure>
        <div className="tour__text">
          <p className="tour__count" aria-live="polite">
            {i + 1} of {TOUR.length}
          </p>
          <h2 id="tour-title" ref={titleRef} tabIndex={-1}>
            {step.title}
          </h2>
          <p id="tour-body">{step.body}</p>
          <p className="tour__note">Screenshots use invented residents, with names and contact details blurred.</p>
          <div className="tour__nav">
            <button type="button" className="p-btn p-btn--quiet" onClick={() => go(i - 1)} disabled={i === 0}>
              Back
            </button>
            {last ? (
              <button type="button" className="p-btn p-btn--sign" onClick={onJoin}>
                Join the waitlist
              </button>
            ) : (
              <button type="button" className="p-btn p-btn--ink" onClick={() => go(i + 1)}>
                Next
              </button>
            )}
          </div>
          <ol className="tour__dots" aria-label="Tour steps">
            {TOUR.map((s, n) => (
              <li key={s.image}>
                <button
                  type="button"
                  aria-label={`Step ${n + 1}: ${s.title}`}
                  aria-current={n === i ? 'step' : undefined}
                  onClick={() => go(n)}
                />
              </li>
            ))}
          </ol>
          <p className="tour__foot">
            Already on a campaign?{' '}
            <button type="button" className="p-link" onClick={onSignIn}>
              Sign in
            </button>
          </p>
        </div>
        <button type="button" className="tour__close" aria-label="Close the tour" onClick={onClose}>
          ×
        </button>
      </div>
    </dialog>
  );
}
