import { useId, useState, type ReactNode } from 'react';

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  /** Rendered under the input — the minimum-length rule, or why a password is being asked for. */
  hint?: ReactNode;
  /** Marks the hint as an error and sets aria-invalid; the caller owns the validation rule. */
  invalid?: boolean;
  required?: boolean;
  minLength?: number;
  autoFocus?: boolean;
  name?: string;
}

/**
 * A password input with a show/hide toggle.
 *
 * Volunteers type these on phones, one-handed, often in poor light — and a mistyped password that
 * cannot be read back is the most common reason someone gives up at the door. Hiding by default is
 * still right (a phone screen is visible to whoever is standing at the door), so this reveals only
 * on a deliberate tap.
 *
 * It is a `button`, not a checkbox: it performs an action rather than recording a value, so it must
 * not be submitted with the form, and `aria-pressed` is what conveys the on/off state.
 */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  invalid,
  required,
  minLength,
  autoFocus,
  name = 'password',
}: Props) {
  const [shown, setShown] = useState(false);
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <div className="pw">
        <input
          id={id}
          className="pw__input"
          // Switching type keeps one input, so the value and cursor survive the toggle.
          type={shown ? 'text' : 'password'}
          name={name}
          autoComplete={autoComplete}
          // A revealed password must not be offered to spellcheck or autocorrect services.
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          required={required}
          minLength={minLength}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={hintId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pw__toggle"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-controls={id}
          // The label says what tapping does; aria-pressed says what state it is in.
          aria-label={shown ? 'Hide password' : 'Show password'}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint && (
        <span className={`field__hint${invalid ? ' field__hint--error' : ''}`} id={hintId}>
          {hint}
        </span>
      )}
    </label>
  );
}
