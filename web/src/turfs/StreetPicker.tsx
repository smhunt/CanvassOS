import { useMemo, useState } from 'react';
import { useStreets } from '../api/hooks';
import type { Street } from '../api/types';
import { ErrorBox, LoadingRows, n, titleCase, wardLabel } from '../components/ui';

/** One selectable street. `key` is `street_sort` — the value POST /api/turfs matches households on. */
interface StreetGroup {
  key: string;
  label: string;
  wards: string[];
  communities: string[];
  n_households: number;
  n_voters: number;
}

interface Totals {
  streets: number;
  households: number;
  voters: number;
}

interface Props {
  /** '' = every ward. Doubles as the turf's ward in the create form. */
  ward: string;
  communities: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/**
 * /api/streets returns one row per street × ward × community, but a turf is created from bare
 * `street_sort` keys — so a street that runs across a ward line comes in whole however the list is
 * filtered. Group by `street_sort` and total over every row of the group, or the running total would
 * promise a smaller turf than the one that gets saved.
 */
function group(rows: Street[]): StreetGroup[] {
  const byKey = new Map<string, StreetGroup>();
  for (const r of rows) {
    let g = byKey.get(r.street_sort);
    if (!g) {
      g = { key: r.street_sort, label: r.label, wards: [], communities: [], n_households: 0, n_voters: 0 };
      byKey.set(r.street_sort, g);
    }
    if (!g.wards.includes(r.ward)) g.wards.push(r.ward);
    if (r.community && !g.communities.includes(r.community)) g.communities.push(r.community);
    g.n_households += r.n_households;
    g.n_voters += r.n_voters;
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function totalsFor(groups: StreetGroup[], selected: string[]): Totals {
  const picked = new Set(selected);
  let households = 0;
  let voters = 0;
  for (const g of groups) {
    if (!picked.has(g.key)) continue;
    households += g.n_households;
    voters += g.n_voters;
  }
  return { streets: selected.length, households, voters };
}

/** Rough door counts a canvasser can finish in an evening or two. Advisory only — nothing blocks. */
function sizeHint(doors: number): { tone: 'ok' | 'warn' | 'over'; text: string } | null {
  if (doors === 0) return null;
  if (doors <= 150) return { tone: 'ok', text: 'a walkable turf' };
  if (doors <= 300) return { tone: 'warn', text: 'large — a few evenings' };
  return { tone: 'over', text: 'very large — consider splitting' };
}

export function StreetPicker({ ward, communities, selected, onChange }: Props) {
  const [community, setCommunity] = useState('');
  const [term, setTerm] = useState('');
  // Fetched unfiltered so the running total counts every stretch of a picked street; ward and
  // community narrow the view only.
  const streets = useStreets();

  const groups = useMemo(() => group(streets.data ?? []), [streets.data]);
  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    return groups.filter(
      (g) =>
        (!ward || g.wards.includes(ward)) &&
        (!community || g.communities.includes(community)) &&
        (!q || g.label.toLowerCase().includes(q)),
    );
  }, [groups, ward, community, term]);

  const picked = new Set(selected);
  const totals = totalsFor(groups, selected);
  const hint = sizeHint(totals.households);
  const chips = groups.filter((g) => picked.has(g.key));

  const toggle = (key: string) => onChange(picked.has(key) ? selected.filter((k) => k !== key) : [...selected, key]);
  const addShown = () => onChange([...new Set([...selected, ...shown.map((g) => g.key)])]);

  return (
    <div className="picker">
      <div className="picker__filters">
        <label className="field">
          <span className="field__label">Find a street</span>
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="e.g. Glendon"
            autoComplete="off"
          />
        </label>
        <label className="field field--short">
          <span className="field__label">Community</span>
          <select value={community} onChange={(e) => setCommunity(e.target.value)}>
            <option value="">All communities</option>
            {communities.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selected.length > 0 && (
        <div className="picker__picked">
          <span className="field__label" id="picked-h">
            Selected
          </span>
          <ul className="chips" aria-labelledby="picked-h">
            {chips.map((g) => (
              <li key={g.key}>
                <button type="button" className="chipbtn" onClick={() => toggle(g.key)}>
                  {g.label}
                  <span aria-hidden="true">×</span>
                  <span className="visually-hidden">— remove from this turf</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="picker__actions">
        <span className="muted small">
          {streets.data ? `${n(shown.length)} of ${n(groups.length)} streets shown` : 'Loading streets…'}
        </span>
        <span className="row">
          <button type="button" className="btn btn--small" onClick={addShown} disabled={shown.length === 0}>
            Add all shown
          </button>
          <button type="button" className="btn btn--small" onClick={() => onChange([])} disabled={selected.length === 0}>
            Clear selection
          </button>
        </span>
      </div>

      {streets.isPending && <LoadingRows rows={6} />}
      {streets.isError && <ErrorBox error={streets.error} onRetry={() => void streets.refetch()} compact />}
      {streets.data && shown.length === 0 && <p className="muted small">No streets match those filters.</p>}

      {shown.length > 0 && (
        <fieldset className="fs picker__list">
          <legend className="visually-hidden">Streets in this turf</legend>
          {shown.map((g) => (
            <label key={g.key} className="check street">
              <input type="checkbox" checked={picked.has(g.key)} onChange={() => toggle(g.key)} />
              <span className="check__label">
                <span className="street__name">{g.label}</span>
                <span className="muted small street__where">
                  {g.wards.map(wardLabel).join(', ')}
                  {g.communities.length > 0 && ` · ${g.communities.map(titleCase).join(', ')}`}
                </span>
              </span>
              {g.wards.length > 1 && (
                <span className="tag tag--mini tag--warn" title="Picking this street takes in every ward it runs through.">
                  crosses wards
                </span>
              )}
              <span className="check__count muted nowrap">
                {n(g.n_households)} doors · {n(g.n_voters)} voters
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div className="picker__total" role="status" aria-live="polite">
        {totals.streets === 0 ? (
          <span className="muted">No streets picked yet.</span>
        ) : (
          <>
            <strong>
              {n(totals.streets)} street{totals.streets === 1 ? '' : 's'} · {n(totals.households)} doors · {n(totals.voters)} voters
            </strong>
            {hint && <span className={`tag tag--mini picker__hint picker__hint--${hint.tone}`}>{hint.text}</span>}
          </>
        )}
      </div>
    </div>
  );
}
