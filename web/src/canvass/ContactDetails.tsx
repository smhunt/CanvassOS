import { useState } from 'react';
import { errorMessage, isApiError } from '../api/client';
import { useAddVoterContact, useUpdateVoterContact, useVoterContacts } from '../api/hooks';
import type { ContactChannel, Voter, VoterContact } from '../api/types';
import { ErrorBox, LoadingRows, Spinner, fmtDate } from '../components/ui';

const CHANNELS: { key: ContactChannel; label: string }[] = [
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
];
const CHANNEL_LABELS: Record<ContactChannel, string> = { phone: 'Phone', email: 'Email' };
const CONSENT_NOTE_MAX = 500;

interface Props {
  householdId: string;
  voters: Voter[];
}

/**
 * A phone number or email given at the door. This is not voters-list data — nobody gave it to the
 * clerk — so it carries its own per-purpose consent, and the API refuses a value with none
 * (`400 consent_required`). Withdrawal is a stamp on the row, never a delete: a deleted number is
 * simply re-collected at the next canvass, and the point is to remember that somebody said stop.
 */
export function ContactDetails({ householdId, voters }: Props) {
  const list = useVoterContacts(householdId);
  const add = useAddVoterContact();
  const update = useUpdateVoterContact(householdId);

  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<ContactChannel>('phone');
  const [value, setValue] = useState('');
  const [voterId, setVoterId] = useState('');
  const [gotv, setGotv] = useState(false);
  const [updates, setUpdates] = useState(false);
  const [consentNote, setConsentNote] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);

  const rows = list.data ?? [];
  // API.md says the GET row carries `voter_name`, but the scaffolded `VoterContact` type does not
  // declare it; the door already knows every name here, so read it from there rather than the wire.
  const nameOf = new Map(voters.map((v) => [v.id, v.display_name]));
  const consented = gotv || updates;
  const canSave = consented && value.trim().length > 0 && !add.isPending;
  // The API's own words are more useful than ours here: it says exactly which format it wanted.
  const valueError = isApiError(add.error) && (add.error.code === 'invalid_phone' || add.error.code === 'invalid_email');
  const otherError = add.isError && !valueError;

  function reset() {
    setValue('');
    setVoterId('');
    setGotv(false);
    setUpdates(false);
    setConsentNote('');
    add.reset();
  }

  function save() {
    add.mutate(
      {
        household_id: householdId,
        channel,
        value: value.trim(),
        consent_gotv: gotv,
        consent_updates: updates,
        ...(voterId ? { voter_id: voterId } : {}),
        ...(consentNote.trim() ? { consent_note: consentNote.trim() } : {}),
        // No `contact_id`: the doorstep contact has not been saved yet — this panel lives inside the
        // unsent spoke form — and a number is worth keeping whether or not the door result lands.
      },
      {
        onSuccess: (r) => {
          setSaved(r.voter_contact.value);
          reset();
          setOpen(false);
        },
      },
    );
  }

  return (
    <section className="cv-details" aria-labelledby="cv-details-h">
      <h4 id="cv-details-h" className="cv-details__h">
        Phone or email
      </h4>

      {list.isPending && <LoadingRows rows={1} />}
      {list.isError && (
        <ErrorBox title="Could not load this door's details" error={list.error} onRetry={() => void list.refetch()} compact />
      )}

      {rows.length > 0 && (
        <ul className="cv-detail-list">
          {rows.map((c) => (
            <DetailRow
              key={c.id}
              row={c}
              voterName={c.voter_id ? (nameOf.get(c.voter_id) ?? 'A named resident') : null}
              confirming={confirmStop === c.id}
              busy={update.isPending}
              onAskStop={() => setConfirmStop(c.id)}
              onCancelStop={() => setConfirmStop(null)}
              onStop={() => update.mutate({ id: c.id, withdrawn: true }, { onSuccess: () => setConfirmStop(null) })}
              onResume={() => update.mutate({ id: c.id, withdrawn: false })}
            />
          ))}
        </ul>
      )}
      {update.isError && <ErrorBox title="That change did not save" error={update.error} compact />}

      {saved && (
        <p className="cv-details__saved small" role="status">
          Saved {saved}.
        </p>
      )}

      {!open ? (
        <button
          type="button"
          className="btn cv-details__add"
          onClick={() => {
            setSaved(null);
            setOpen(true);
          }}
        >
          + Add a phone or email
        </button>
      ) : (
        <div
          className="cv-add"
          // These inputs sit inside the spoke form, so a tap on the keyboard's "go" would otherwise
          // implicitly submit the door result — recording the visit and closing the sheet mid-typing.
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.target instanceof HTMLTextAreaElement) return;
            e.preventDefault();
            if (canSave) save();
          }}
        >
          <div className="cv-seg" role="group" aria-label="Phone or email">
            {CHANNELS.map((c) => (
              <button
                key={c.key}
                type="button"
                className="cv-seg__btn"
                aria-pressed={channel === c.key}
                onClick={() => setChannel(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>

          <label className="field">
            <span className="field__label">{channel === 'phone' ? 'Phone number' : 'Email address'}</span>
            <input
              className="cv-input"
              type={channel === 'phone' ? 'tel' : 'email'}
              inputMode={channel === 'phone' ? 'tel' : 'email'}
              // Never offer the volunteer's own saved numbers on somebody else's doorstep record.
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={valueError || undefined}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={channel === 'phone' ? '519 555 0123' : 'name@example.com'}
            />
            {valueError && <span className="field__hint field__hint--error">{errorMessage(add.error)}</span>}
          </label>

          {voters.length > 0 && (
            <label className="field">
              <span className="field__label">Whose is it?</span>
              <select value={voterId} onChange={(e) => setVoterId(e.target.value)}>
                <option value="">The whole door</option>
                {voters.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.display_name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <fieldset className="cv-fs">
            <legend>What did they agree to?</legend>
            <label className="check">
              <input type="checkbox" checked={gotv} onChange={(e) => setGotv(e.target.checked)} />
              <span className="check__label">Reminder to vote around election day</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={updates} onChange={(e) => setUpdates(e.target.checked)} />
              <span className="check__label">Campaign updates</span>
            </label>
            <p className="cv-consent small">
              You are recording that this person said yes, out loud, to what you tick — stored with your name and the
              time as the campaign's legal record of their consent. Tick only what they actually agreed to.
            </p>
            <label className="field">
              <span className="field__label">Anything they added (optional)</span>
              <input
                className="cv-input"
                type="text"
                maxLength={CONSENT_NOTE_MAX}
                autoComplete="off"
                value={consentNote}
                onChange={(e) => setConsentNote(e.target.value)}
                placeholder="Texts only, not before 10am"
              />
            </label>
          </fieldset>

          {otherError && <ErrorBox title="Not saved" error={add.error} compact />}

          <div className="cv-add__actions">
            <button
              type="button"
              className="btn cv-btn"
              disabled={add.isPending}
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn btn--primary cv-btn cv-btn--save" disabled={!canSave} onClick={save}>
              {add.isPending ? <Spinner size={18} /> : null}
              {add.isPending ? 'Saving…' : 'Save this detail'}
            </button>
          </div>
          {!consented && (
            <p className="field__hint cv-add__gate">Tick at least one box — we do not keep a detail nobody agreed to.</p>
          )}
        </div>
      )}
    </section>
  );
}

function DetailRow({
  row,
  voterName,
  confirming,
  busy,
  onAskStop,
  onCancelStop,
  onStop,
  onResume,
}: {
  row: VoterContact;
  voterName: string | null;
  confirming: boolean;
  busy: boolean;
  onAskStop: () => void;
  onCancelStop: () => void;
  onStop: () => void;
  onResume: () => void;
}) {
  const stopped = row.withdrawn_at !== null;
  const meta = [voterName ?? 'The whole door', row.collected_by_name && `by ${row.collected_by_name}`, fmtDate(row.consented_at, false)]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className={`cv-detail${stopped ? ' cv-detail--stopped' : ''}`}>
      <div className="cv-detail__top">
        <span className="cv-detail__value">{row.value}</span>
        <span className="tag tag--mini tag--neutral">{CHANNEL_LABELS[row.channel]}</span>
      </div>
      <div className="muted small">{meta}</div>
      {/* Consent travels with the value everywhere it is shown, so nobody holds a number without
          also seeing what it may be used for. */}
      <div className="cv-detail__tags">
        {row.consent_gotv && <span className="tag tag--mini tag--ok">Vote reminder</span>}
        {row.consent_updates && <span className="tag tag--mini tag--ok">Campaign updates</span>}
        {!row.consent_gotv && !row.consent_updates && <span className="tag tag--mini tag--warn">Nothing agreed</span>}
      </div>
      {row.consent_note && <p className="cv-detail__note">“{row.consent_note}”</p>}

      {stopped ? (
        <div className="cv-detail__stopped">
          <p>
            They asked us to stop on {fmtDate(row.withdrawn_at, false)}. Kept on file — not deleted — so it is not
            collected again by mistake.
          </p>
          <button type="button" className="btn btn--small" disabled={busy} onClick={onResume}>
            They changed their mind
          </button>
        </div>
      ) : confirming ? (
        <div className="cv-detail__confirm">
          <span className="small">Record that they asked us to stop?</span>
          <button type="button" className="btn btn--small btn--danger-outline" disabled={busy} onClick={onStop}>
            {busy ? <Spinner size={16} /> : null} Yes, record it
          </button>
          <button type="button" className="btn btn--small" disabled={busy} onClick={onCancelStop}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--small cv-detail__stop" onClick={onAskStop}>
          They asked us to stop
        </button>
      )}
    </li>
  );
}
