import { forwardRef, useState, type FormEvent } from 'react';
import {
  CONSENT_TEXT,
  ELECTIONS,
  MAILING_ADDRESS,
  SENDER,
  PROVINCES,
  ROLES,
  joinWaitlist,
  outcomeText,
  type WaitlistRequest,
} from './waitlist';

type Fields = Omit<WaitlistRequest, 'consent_text'>;

const EMPTY: Fields = {
  name: '',
  email: '',
  role: 'candidate',
  municipality: '',
  province: 'ON',
  next_election: '2026',
  notes: '',
  website: '',
};

/** The waitlist form. The ref is the first field, so "Join the waitlist" anywhere can focus it. */
export const WaitlistForm = forwardRef<HTMLInputElement>(function WaitlistForm(_props, firstField) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => setF((prev) => ({ ...prev, [k]: v }));

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!e.currentTarget.reportValidity()) return;
    setBusy(true);
    const outcome = await joinWaitlist({
      ...f,
      name: f.name.trim(),
      email: f.email.trim(),
      municipality: f.municipality.trim(),
      notes: f.notes?.trim() || undefined,
      consent_text: CONSENT_TEXT,
    });
    setBusy(false);
    if (outcome.kind === 'joined') setJoined(outcome.message);
    else setError(outcomeText(outcome));
  };

  if (joined) {
    return (
      <div className="waitlist__done" role="status">
        <h3>Thanks for signing up</h3>
        <p>{joined}</p>
      </div>
    );
  }

  return (
    <form className="waitlist__form" onSubmit={onSubmit} noValidate>
      <div className="waitlist__row">
        <label className="p-field">
          <span>Your name</span>
          <input
            ref={firstField}
            name="name"
            autoComplete="name"
            required
            maxLength={120}
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="p-field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            maxLength={200}
            value={f.email}
            onChange={(e) => set('email', e.target.value)}
          />
        </label>
      </div>
      <div className="waitlist__row">
        <label className="p-field">
          <span>Your role</span>
          <select name="role" value={f.role} onChange={(e) => set('role', e.target.value as Fields['role'])}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="p-field">
          <span>Next election</span>
          <select
            name="next_election"
            value={f.next_election}
            onChange={(e) => set('next_election', e.target.value as Fields['next_election'])}
          >
            {ELECTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="waitlist__row">
        <label className="p-field p-field--grow">
          <span>Municipality</span>
          <input
            name="municipality"
            autoComplete="address-level2"
            required
            maxLength={120}
            value={f.municipality}
            onChange={(e) => set('municipality', e.target.value)}
          />
        </label>
        <label className="p-field p-field--narrow">
          <span>Province</span>
          <select
            name="province"
            value={f.province}
            onChange={(e) => set('province', e.target.value as Fields['province'])}
          >
            {PROVINCES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="p-field">
        <span>
          Anything we should know? <em>(optional)</em>
        </span>
        <textarea
          name="notes"
          rows={3}
          maxLength={500}
          value={f.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </label>
      {/* Honeypot: off-screen and out of the tab order; people never see it. */}
      <label className="waitlist__trap" aria-hidden="true">
        Website
        <input
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={f.website}
          onChange={(e) => set('website', e.target.value)}
        />
      </label>
      <label className="p-check">
        <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{CONSENT_TEXT}</span>
      </label>
      <p className="waitlist__sender">
        CanvassOS is made by {SENDER.name}. Questions: <a href={`mailto:${SENDER.email}`}>{SENDER.email}</a>
        {MAILING_ADDRESS && <>&nbsp;· {MAILING_ADDRESS}</>}
      </p>
      {error && (
        <p className="waitlist__error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="p-btn p-btn--sign" disabled={busy}>
        {busy ? 'Joining…' : 'Join the waitlist'}
      </button>
    </form>
  );
});
