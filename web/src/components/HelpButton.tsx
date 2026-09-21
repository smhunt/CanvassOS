import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '../turfs/Dialog';
import { canSpeak, explain, isSpeaking, silence } from '../speech';

/**
 * One screen's explanation, in two forms. `sections` is what the dialog shows; `spoken` is a
 * separate script for the ear, one sentence per entry. Both are fixed strings declared next to the
 * screen they describe — never assembled from data, because whatever is in `spoken` may be sent to
 * a third-party voice service (see src/speech.ts).
 */
export interface HelpTopic {
  title: string;
  spoken: readonly string[];
  sections: readonly { heading: string; body: string }[];
}

interface Props {
  topic: HelpTopic;
  /** Whether opening the dialog also reads it aloud. The screen decides: drive mode passes its own
   *  Speech toggle, so somebody who has silenced the screen is not surprised by the help. */
  speak: boolean;
  /** Called after the dialog has closed and the voice has been stopped. For a screen that speaks on
   *  its own account and needs to know that whatever it was saying has just been cut off. */
  onClose?: () => void;
  /** Extra class on the button, for where it sits (the top bar recolours it). */
  className?: string;
}

/**
 * A question mark that opens a screen's help and, if asked to, reads it out. The reading starts
 * inside the click handler and nowhere else: iOS only allows speech that begins in a user gesture,
 * and an effect runs after the gesture has ended. Closing the dialog stops the voice — someone who
 * has dismissed the explanation has finished listening to it.
 */
export function HelpButton({ topic, speak, onClose, className }: Props) {
  const [open, setOpen] = useState(false);
  // Whether the script is being read, so the footer can offer Stop. Before this, the only way to
  // stop the voice was to close the explanation you were reading along with.
  const [reading, setReading] = useState(false);
  const titleId = useId();
  const read = () => {
    explain(topic.spoken);
    setReading(true);
  };
  const stop = () => {
    silence();
    setReading(false);
  };
  const close = () => {
    stop();
    setOpen(false);
    onClose?.();
  };

  // Polled, not event-driven — see isSpeaking(). The first check is a beat after starting because
  // `speaking` is still false in the instant after speak() on some engines, which would flip the
  // button straight back to "Read it aloud" before a word was said.
  useEffect(() => {
    if (!reading) return;
    let started = false;
    const id = window.setInterval(() => {
      const now = isSpeaking();
      if (now) started = true;
      else if (started) setReading(false);
    }, 300);
    // An engine that never reports speaking at all must not leave the button stuck on Stop.
    const giveUp = window.setTimeout(() => {
      if (!started) setReading(false);
    }, 3000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(giveUp);
    };
  }, [reading]);

  // A route change while the dialog is open unmounts this without ever calling close(), and the
  // utterance queue belongs to the document: the script would carry on for twenty seconds over
  // whatever screen came next. Gated on `open`, not unconditional — on the drive screen this button
  // unmounts whenever the bar does (a GPS failure, a refetch), and a cleanup that always ran would
  // cut off a door announcement that had nothing to do with help.
  useEffect(() => {
    if (!open) return;
    return () => silence();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`btn btn--icon help-btn${className ? ` ${className}` : ''}`}
        aria-label={topic.title}
        aria-haspopup="dialog"
        onClick={() => {
          if (speak) read();
          setOpen(true);
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {/* Portalled to <body>: the top bar is its own stacking context (z-index 30, below the install
          banner) and sets a white text colour, and a dialog rendered inside it would inherit both —
          painted under the banner, in white on a white card. Same escape as DrawPolygon's dialog. */}
      {open &&
        createPortal(
          <Dialog
            title={topic.title}
            titleId={titleId}
            onClose={close}
            footer={
              <>
                {canSpeak() &&
                  (reading ? (
                    <button type="button" className="btn" onClick={stop}>
                      Stop reading
                    </button>
                  ) : (
                    <button type="button" className="btn" onClick={read}>
                      Read it aloud
                    </button>
                  ))}
                <button type="button" className="btn btn--primary" onClick={close}>
                  Got it
                </button>
              </>
            }
          >
            <div className="modal__body help">
              {topic.sections.map((s) => (
                <section key={s.heading} className="help__section">
                  <h3 className="help__heading">{s.heading}</h3>
                  <p>{s.body}</p>
                </section>
              ))}
            </div>
          </Dialog>,
          document.body,
        )}
    </>
  );
}
