import { useState, type ReactNode } from 'react';
import type { Voter } from '../api/types';
import { Spinner } from '../components/ui';

export interface SpokeDetail {
  voter_id: string | null;
  support: number | null;
  wants_sign: boolean;
  wants_volunteer: boolean;
  needs_ride: boolean;
  follow_up: boolean;
  note: string;
}

const NOTE_MAX = 2000;
const SUPPORT_ENDS = ['Against', 'Strong'];

const FLAGS: { key: keyof Pick<SpokeDetail, 'wants_sign' | 'wants_volunteer' | 'needs_ride' | 'follow_up'>; label: string }[] = [
  { key: 'wants_sign', label: 'Wants a lawn sign' },
  { key: 'wants_volunteer', label: 'Wants to volunteer' },
  { key: 'needs_ride', label: 'Needs a ride to vote' },
  { key: 'follow_up', label: 'Needs a follow-up' },
];

interface Props {
  voters: Voter[];
  pending: boolean;
  onSubmit: (detail: SpokeDetail) => void;
  onCancel: () => void;
}

/**
 * Detail for a conversation. Contacts are append-only with no edit endpoint, so support, flags and
 * note have to ride along with the same POST — hence a Save rather than recording on the first tap.
 */
export function SpokeForm({ voters, pending, onSubmit, onCancel }: Props) {
  const [d, setD] = useState<SpokeDetail>({
    voter_id: null,
    support: null,
    wants_sign: false,
    wants_volunteer: false,
    needs_ride: false,
    follow_up: false,
    note: '',
  });
  const set = <K extends keyof SpokeDetail>(k: K, v: SpokeDetail[K]) => setD((p) => ({ ...p, [k]: v }));
  const who = d.voter_id ? (voters.find((v) => v.id === d.voter_id)?.display_name ?? 'this voter') : 'the whole door';

  return (
    <form
      className="cv-spoke"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(d);
      }}
    >
      <p className="muted small cv-spoke__intro">All optional — save straight away if you have nothing to add.</p>

      {voters.length > 1 && (
        <fieldset className="cv-fs">
          <legend>Who did you speak to?</legend>
          <div className="cv-pills">
            <Pill active={d.voter_id === null} onClick={() => set('voter_id', null)}>
              Whole door
            </Pill>
            {voters.map((v) => (
              <Pill key={v.id} active={d.voter_id === v.id} onClick={() => set('voter_id', v.id)}>
                {v.display_name}
              </Pill>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="cv-fs">
        <legend>Support for {who}</legend>
        <div className="cv-support">
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              type="button"
              className={`cv-support__btn${d.support === s ? ' cv-support__btn--on' : ''}`}
              aria-pressed={d.support === s}
              aria-label={`Support ${s} of 5${s === 1 ? ' — against' : s === 5 ? ' — strong' : ''}`}
              onClick={() => set('support', d.support === s ? null : s)}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="cv-support__ends muted small" aria-hidden="true">
          <span>{SUPPORT_ENDS[0]}</span>
          <span>{SUPPORT_ENDS[1]}</span>
        </div>
      </fieldset>

      <fieldset className="cv-fs">
        <legend>Asks</legend>
        {FLAGS.map((f) => (
          <label key={f.key} className="check">
            <input type="checkbox" checked={d[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
            <span className="check__label">{f.label}</span>
          </label>
        ))}
      </fieldset>

      <label className="field">
        <span className="field__label">Note</span>
        <textarea
          className="cv-note"
          rows={3}
          maxLength={NOTE_MAX}
          value={d.note}
          onChange={(e) => set('note', e.target.value)}
          placeholder="Anything worth remembering at this door"
        />
        <span className="field__hint">
          {d.note.length}/{NOTE_MAX}
        </span>
      </label>

      <div className="cv-spoke__actions">
        <button type="button" className="btn cv-btn" onClick={onCancel} disabled={pending}>
          Back
        </button>
        <button type="submit" className="btn btn--primary cv-btn cv-btn--save" disabled={pending}>
          {pending ? <Spinner size={18} /> : null}
          {pending ? 'Saving…' : 'Save — spoke'}
        </button>
      </div>
    </form>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`cv-pill${active ? ' cv-pill--on' : ''}`} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}
