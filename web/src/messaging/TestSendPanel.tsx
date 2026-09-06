import { useState, type FormEvent } from 'react';
import { useTestSend } from '../api/hooks';
import { errorMessage } from '../api/client';

interface Props {
  campaignId: string;
  /** Nothing to test until there is a body. */
  disabled?: boolean;
  onTested: (to: string) => void;
  testedAt: Date | null;
}

/** 10 digits, or 11 starting with 1. Loose on purpose — the API normalises, this only catches slips. */
function looksLikeNumber(v: string): boolean {
  const digits = v.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/**
 * Step one, always. A typo, a broken link or a smart apostrophe is free to fix here and expensive
 * to fix once a few thousand people have it on their phones — so the approve step below stays shut
 * until this has been done.
 */
export function TestSendPanel({ campaignId, disabled, onTested, testedAt }: Props) {
  const [to, setTo] = useState('');
  const test = useTestSend();
  const valid = looksLikeNumber(to);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || test.isPending || disabled) return;
    test.mutate({ id: campaignId, to }, { onSuccess: () => onTested(to) });
  };

  return (
    <form className="msg-test" onSubmit={onSubmit} noValidate>
      <div className="form-row">
        <label className="field field--short">
          <span className="field__label">Your mobile number</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="519 555 0134"
            aria-invalid={to.length > 0 && !valid}
            aria-describedby="msg-test-hint"
          />
        </label>
        <button type="submit" className="btn btn--primary" disabled={!valid || test.isPending || disabled}>
          {test.isPending ? 'Sending…' : 'Send me this first'}
        </button>
      </div>
      <p className="field__hint" id="msg-test-hint">
        Goes to this number only. It is not counted against the campaign and does not touch the audience.
      </p>

      <div aria-live="polite">
        {test.isError && (
          <p className="msg-note msg-note--warn">
            <span aria-hidden="true">⚑ </span>
            <span className="visually-hidden">Error: </span>
            The test did not send: {errorMessage(test.error)}
          </p>
        )}
        {test.isSuccess && testedAt && (
          <p className="msg-note msg-note--ok">
            <span aria-hidden="true">✓ </span>
            Test sent. Read it on the handset before you approve anything — check the link, the times, and that no
            apostrophe turned into a question mark.
          </p>
        )}
      </div>
    </form>
  );
}
