import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { submitSubscription, type SubscribeOutcome } from '../subscribe/api';
import { buildConsentText, CAMPAIGN, ELECTION_DAY, OPT_INS, TERMS, type OptInKey } from '../subscribe/consent';
import { checkPhone } from '../subscribe/phone';
import '../subscribe/subscribe.css';

/*
 * The public opt-in page (`/subscribe`, outside the auth guard).
 *
 * The visitor is a member of the public, not a user: no account, no session, most likely a phone
 * held one-handed after scanning a QR code off a lawn sign. So there is one field, two unticked
 * boxes and one button, and everything else on the page is the disclosure that makes the tick mean
 * something.
 *
 * Two rules from docs/phase-5-messaging-plan.md §3.2 shape all of it:
 *
 *  1. **Consent is not real until the reply arrives.** This form creates a *pending* record and
 *     triggers a confirmation text. So the success state may not say "you're subscribed" — it says
 *     to go and reply, and that nothing happens until they do. Saying otherwise would be a lie the
 *     person could only discover by never getting a message.
 *  2. **The endpoint will not say whether a number is already known**, deliberately — that would
 *     let anyone use this page to test whether a neighbour is on the list. Every success therefore
 *     renders identically here, and the page never has a "you are already subscribed" state to
 *     leak.
 *
 * No elector data of any kind appears on this page. The only personal information in play is what
 * the visitor typed into the field, and it is posted straight back out again.
 */

const SUBMIT_LABEL = 'Send me the confirmation text';

type Status = 'idle' | 'sending' | 'sent';

export function SubscribePage() {
  const [phone, setPhone] = useState('');
  const [wants, setWants] = useState<Record<OptInKey, boolean>>({ wants_gotv: false, wants_updates: false });
  const [status, setStatus] = useState<Status>('idle');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SubscribeOutcome | null>(null);
  // Read back to them so a mistyped digit is visible at the one moment they can still fix it.
  const [sentTo, setSentTo] = useState('');

  const phoneRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const ids = useId();
  const phoneId = `${ids}-phone`;
  const phoneHintId = `${ids}-phone-hint`;
  const phoneErrId = `${ids}-phone-err`;
  const termsId = `${ids}-terms`;

  const picked = OPT_INS.filter((o) => wants[o.key]);

  // Move focus onto the "check your phone" panel: the instruction that follows is the only thing
  // that matters now, and on a screen reader an unannounced swap of the form for a panel is silent.
  useEffect(() => {
    if (status === 'sent') doneRef.current?.focus();
  }, [status]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (status === 'sending') return;

    // Validate both things before reporting, so someone with two problems is told about two
    // problems instead of discovering the second one after fixing the first.
    const check = checkPhone(phone);
    const badPhone = check.ok ? null : check.reason;
    const badPick = picked.length === 0 ? 'Tick at least one box, so we know what you are agreeing to.' : null;
    setPhoneError(badPhone);
    setPickError(badPick);
    if (!check.ok || badPick) {
      setOutcome(null);
      if (badPhone) phoneRef.current?.focus();
      return;
    }

    setOutcome(null);
    setStatus('sending');
    const result = await submitSubscription({
      phone: check.e164,
      wants_gotv: wants.wants_gotv,
      wants_updates: wants.wants_updates,
      // The verbatim wording that is on screen right now, next to the boxes they ticked.
      consent_text: buildConsentText(new Set(picked.map((o) => o.key))),
    });

    if (result.kind === 'accepted') {
      setSentTo(check.display);
      setStatus('sent');
      return;
    }
    setStatus('idle');
    if (result.kind === 'invalid_phone') {
      // The server disagreed with the local check. It is the authority, and its complaint belongs
      // against the field rather than in a banner, where it reads as a fixable typo.
      setPhoneError(result.message);
      phoneRef.current?.focus();
      return;
    }
    setOutcome(result);
  };

  if (status === 'sent') {
    return (
      <main className="sub-page">
        <div className="sub-card sub-card--done" role="status" tabIndex={-1} ref={doneRef}>
          <Masthead />
          <h1 className="sub-title">Check your phone</h1>
          <p className="sub-lede">
            We have just texted <strong className="sub-number">{sentTo}</strong>. Reply <strong>YES</strong> to that
            message.
          </p>
          <p className="sub-warn">You are not subscribed until you reply. Until then we will not text you again.</p>
          <p className="sub-note">
            Nothing after a minute or two? The number may have a digit wrong, or the text may still be on its way.
          </p>
          <button
            type="button"
            className="btn btn--block sub-btn"
            onClick={() => {
              // Back to the form with their choices intact — the likely reason for coming back is a
              // wrong digit, not a change of mind about what they wanted.
              setStatus('idle');
              setOutcome(null);
              setPhoneError(null);
            }}
          >
            Use a different number
          </button>
          <StopNote />
        </div>
      </main>
    );
  }

  const sending = status === 'sending';
  const retrying = outcome !== null && (outcome.kind === 'offline' || outcome.kind === 'failed');

  return (
    <main className="sub-page">
      <form className="sub-card" onSubmit={onSubmit} noValidate>
        <Masthead />
        <h1 className="sub-title">Get campaign texts</h1>
        <p className="sub-lede">
          Put in your mobile number and tick what you want. We will text you once to confirm, and you have to reply
          before anything else is sent.
        </p>

        <div className="sub-field">
          <label className="sub-label" htmlFor={phoneId}>
            Your mobile number
          </label>
          <input
            id={phoneId}
            ref={phoneRef}
            className="sub-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            name="phone"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="519-555-0134"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              // Clear the complaint the moment they start fixing it; leaving it up while they type
              // makes a correct number look wrong.
              if (phoneError) setPhoneError(null);
            }}
            aria-invalid={phoneError ? true : undefined}
            aria-describedby={phoneError ? `${phoneErrId} ${phoneHintId}` : phoneHintId}
          />
          <p className="sub-hint" id={phoneHintId}>
            Dashes, brackets and spaces are all fine.
          </p>
          {phoneError && (
            <p className="sub-error" id={phoneErrId} role="alert">
              {phoneError}
            </p>
          )}
        </div>

        <fieldset className="sub-fs">
          <legend className="sub-legend">What should we send you?</legend>
          {OPT_INS.map((o) => (
            <label key={o.key} className="sub-check">
              <input
                type="checkbox"
                name={o.key}
                checked={wants[o.key]}
                onChange={(e) => {
                  setWants((w) => ({ ...w, [o.key]: e.target.checked }));
                  if (pickError) setPickError(null);
                }}
              />
              <span className="sub-check__text">
                <span className="sub-check__label">{o.label}</span>
                <span className="sub-check__detail">{o.detail}</span>
              </span>
            </label>
          ))}
          {pickError && (
            <p className="sub-error" role="alert">
              {pickError}
            </p>
          )}
        </fieldset>

        <div className="sub-terms" id={termsId}>
          <p className="sub-terms__intro">
            By sending this you agree to receive text messages from {CAMPAIGN} at this number — only the boxes you
            ticked above.
          </p>
          <ul className="sub-terms__list">
            {TERMS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>

        {outcome && outcome.kind === 'rate_limited' && (
          <p className="sub-alert" role="alert">
            <strong>Too many sign-ups from this connection just now.</strong> This is a limit on our side, not anything
            you did. Wait a minute and send it again — your number was not saved, so nothing is half-done.
          </p>
        )}
        {outcome && outcome.kind === 'offline' && (
          <p className="sub-alert" role="alert">
            <strong>That did not reach us.</strong> Your phone may have lost signal. Your number was not sent anywhere,
            so it is safe to try again.
          </p>
        )}
        {outcome && outcome.kind === 'failed' && (
          <p className="sub-alert" role="alert">
            <strong>Something went wrong at our end.</strong> Your number was not saved and no text was sent. Please try
            again. <span className="sub-alert__detail">{outcome.message}</span>
          </p>
        )}

        <button type="submit" className="btn btn--primary btn--block sub-btn sub-btn--go" disabled={sending} aria-describedby={termsId}>
          {sending ? 'Sending…' : retrying ? 'Try again' : SUBMIT_LABEL}
        </button>

        <StopNote />
      </form>
    </main>
  );
}

/**
 * Who this page belongs to, said first. Deliberately not the app's `Wordmark` — "CanvassOS" is the
 * name of the campaign's internal tool and means nothing to a passer-by, who needs to know whose
 * texts they are agreeing to before they read anything else.
 */
function Masthead() {
  return (
    <div className="sub-masthead">
      <span className="sub-masthead__name">Sean Hunt</span>
      <span className="sub-masthead__role">for Mayor of Middlesex Centre</span>
      <span className="sub-masthead__day">Election day {ELECTION_DAY}</span>
    </div>
  );
}

/** The way out, on screen in every state — not only inside the messages they have yet to receive. */
function StopNote() {
  return (
    <p className="sub-stop">
      Already getting our texts? Reply <strong>STOP</strong> to any message and they stop.
    </p>
  );
}
