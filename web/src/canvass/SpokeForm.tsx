import { useState, type ReactNode } from 'react';
import type { Voter } from '../api/types';
import { Spinner } from '../components/ui';
import { ContactDetails } from './ContactDetails';

export interface SpokeDetail {
  /** Everyone tagged at this door. Empty means the door itself — still the common case. */
  voter_ids: string[];
  /** Door-level support: what "the whole door" or the single named person said. */
  support: number | null;
  /** Per-person support, keyed by voter id. Only meaningful with two or more people tagged. */
  supports: Record<string, number>;
  wants_sign: boolean;
  wants_volunteer: boolean;
  needs_ride: boolean;
  follow_up: boolean;
  note: string;
}

const NOTE_MAX = 2000;
const SUPPORT_ENDS = ['Against', 'Strong'];
const SUPPORT_LEVELS = [1, 2, 3, 4, 5];
/** The API refuses more than 12 named voters (`400 too_many_voters`), so the chips stop there too. */
const MAX_NAMED = 12;

const FLAGS: { key: keyof Pick<SpokeDetail, 'wants_sign' | 'wants_volunteer' | 'needs_ride' | 'follow_up'>; label: string }[] = [
  { key: 'wants_sign', label: 'Wants a lawn sign' },
  { key: 'wants_volunteer', label: 'Wants to volunteer' },
  { key: 'needs_ride', label: 'Needs a ride to vote' },
  { key: 'follow_up', label: 'Needs a follow-up' },
];

interface Props {
  householdId: string;
  voters: Voter[];
  pending: boolean;
  onSubmit: (detail: SpokeDetail) => void;
  onCancel: () => void;
}

/**
 * Detail for a conversation. Contacts are append-only with no edit endpoint, so support, flags and
 * note have to ride along with the same POST — hence a Save rather than recording on the first tap.
 */
export function SpokeForm({ householdId, voters, pending, onSubmit, onCancel }: Props) {
  const [d, setD] = useState<SpokeDetail>({
    voter_ids: [],
    support: null,
    supports: {},
    wants_sign: false,
    wants_volunteer: false,
    needs_ride: false,
    follow_up: false,
    note: '',
  });
  const set = <K extends keyof SpokeDetail>(k: K, v: SpokeDetail[K]) => setD((p) => ({ ...p, [k]: v }));

  const named = voters.filter((v) => d.voter_ids.includes(v.id));
  // One support level cannot describe two people who disagreed, and the API writes a row each
  // precisely so it does not have to. Below two, the single row stays — most doors are one tap.
  const perPerson = named.length > 1;
  const who = named.length > 0 ? joinNames(named.map((v) => v.display_name)) : 'the whole door';
  const atMax = d.voter_ids.length >= MAX_NAMED;

  function toggleVoter(id: string) {
    setD((p) => {
      const picked = new Set(p.voter_ids);
      if (!picked.delete(id)) picked.add(id);
      // Keep list order rather than tap order, so the heading reads the way the names are shown.
      const voter_ids = voters.filter((v) => picked.has(v.id)).map((v) => v.id);
      // A support level for somebody no longer named is `400 support_voter_not_named`, so it is
      // dropped with them instead of lingering in state until submit.
      const supports = Object.fromEntries(Object.entries(p.supports).filter(([k]) => picked.has(k)));
      return { ...p, voter_ids, supports };
    });
  }

  function setPersonSupport(id: string, s: number) {
    setD((p) => {
      const supports = { ...p.supports };
      // Tapping the level already showing clears it: nobody gets an invented default.
      if (supports[id] === s) delete supports[id];
      else supports[id] = s;
      return { ...p, supports };
    });
  }

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
            <Pill active={d.voter_ids.length === 0} onClick={() => setD((p) => ({ ...p, voter_ids: [], supports: {} }))}>
              Whole door
            </Pill>
            {voters.map((v) => {
              const on = d.voter_ids.includes(v.id);
              return (
                <Pill key={v.id} active={on} disabled={!on && atMax} onClick={() => toggleVoter(v.id)}>
                  {v.display_name}
                </Pill>
              );
            })}
          </div>
          <p className="muted small cv-pills__hint">
            {atMax ? 'That is as many people as one door can record.' : 'Tick everyone you spoke to — more than one is fine.'}
          </p>
        </fieldset>
      )}

      <fieldset className="cv-fs">
        <legend>Support for {who}</legend>
        {perPerson ? (
          <div className="cv-psupport">
            {named.map((v) => (
              <div key={v.id} className="cv-psupport__row">
                <span className="cv-psupport__name">{v.display_name}</span>
                {SUPPORT_LEVELS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`cv-support__btn cv-support__btn--sm${d.supports[v.id] === s ? ' cv-support__btn--on' : ''}`}
                    aria-pressed={d.supports[v.id] === s}
                    aria-label={`${v.display_name}: support ${s} of 5${s === 1 ? ' — against' : s === 5 ? ' — strong' : ''}`}
                    onClick={() => setPersonSupport(v.id, s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            ))}
            <p className="muted small cv-psupport__hint">1 is against, 5 is strong. Leave anyone blank if they did not say.</p>
          </div>
        ) : (
          <>
            <div className="cv-support">
              {SUPPORT_LEVELS.map((s) => (
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
          </>
        )}
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

      <ContactDetails householdId={householdId} voters={voters} />

      <label className="field">
        <span className="field__label">Note</span>
        <textarea
          className="cv-spoke__note"
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

/** "Bridget", "Bridget and Daniel", "Bridget, Daniel and Sam" — how the volunteer would say it. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function Pill({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`cv-pill${active ? ' cv-pill--on' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {/* A tick box, not just a fill: several of these can be on at once, and that has to read in
          sunlight and to anyone who cannot rely on the colour change alone. */}
      <span className="cv-pill__mark" aria-hidden="true">
        {active ? '✓' : ''}
      </span>
      {children}
    </button>
  );
}
