import { useId, useState } from 'react';
import { Dialog } from '../turfs/Dialog';
import { canSpeak, explain, silence } from '../speech';

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
}

/**
 * A question mark that opens a screen's help and, if asked to, reads it out. The reading starts
 * inside the click handler and nowhere else: iOS only allows speech that begins in a user gesture,
 * and an effect runs after the gesture has ended. Closing the dialog stops the voice — someone who
 * has dismissed the explanation has finished listening to it.
 */
export function HelpButton({ topic, speak }: Props) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const close = () => {
    silence();
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="btn btn--icon help-btn"
        aria-label={topic.title}
        aria-haspopup="dialog"
        onClick={() => {
          if (speak) explain(topic.spoken);
          setOpen(true);
        }}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open && (
        <Dialog
          title={topic.title}
          titleId={titleId}
          onClose={close}
          footer={
            <>
              {canSpeak() && (
                <button type="button" className="btn" onClick={() => explain(topic.spoken)}>
                  Read it aloud
                </button>
              )}
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
        </Dialog>
      )}
    </>
  );
}
