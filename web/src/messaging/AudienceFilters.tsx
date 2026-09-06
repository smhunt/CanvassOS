import { useMeta } from '../api/hooks';
import { n, titleCase, wardLabel } from '../components/ui';

interface Props {
  wards: string[];
  communities: string[];
  onWards: (next: string[]) => void;
  onCommunities: (next: string[]) => void;
  disabled?: boolean;
}

const toggle = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

/**
 * Optional narrowing of the audience. Nothing ticked means everyone who consented to this purpose.
 *
 * Narrowing is the only lever an organiser has that makes a send finish sooner without buying more
 * numbers, which is why it sits next to the audience readout rather than in a filter drawer: the
 * counts and the days above have to move as these move.
 */
export function AudienceFilters({ wards, communities, onWards, onCommunities, disabled }: Props) {
  const meta = useMeta();
  const allWards = meta.data?.wards ?? [];
  const allCommunities = meta.data?.communities ?? [];
  const narrowed = wards.length > 0 || communities.length > 0;

  return (
    <div className="msg-filters">
      <fieldset className="fs" disabled={disabled}>
        <legend>Wards</legend>
        <div className="msg-filters__grid">
          {allWards.map((w) => (
            <label key={w.ward} className="check">
              <input type="checkbox" checked={wards.includes(w.ward)} onChange={() => onWards(toggle(wards, w.ward))} />
              <span className="check__label">{wardLabel(w.ward)}</span>
              <span className="check__count muted num">{n(w.n_voters)}</span>
            </label>
          ))}
          {allWards.length === 0 && <p className="muted small">No wards loaded.</p>}
        </div>
      </fieldset>

      <fieldset className="fs" disabled={disabled}>
        <legend>Communities</legend>
        <div className="msg-filters__grid msg-filters__grid--scroll">
          {allCommunities.map((c) => (
            <label key={c.community} className="check">
              <input
                type="checkbox"
                checked={communities.includes(c.community)}
                onChange={() => onCommunities(toggle(communities, c.community))}
              />
              <span className="check__label">{titleCase(c.community)}</span>
              <span className="check__count muted num">{n(c.n_voters)}</span>
            </label>
          ))}
          {allCommunities.length === 0 && <p className="muted small">No communities loaded.</p>}
        </div>
      </fieldset>

      <div className="msg-filters__foot">
        <p className="muted small">
          {narrowed
            ? 'Only consenting people in the ticked wards and communities are counted above.'
            : 'Nothing ticked — everyone who consented to this purpose is counted above.'}
        </p>
        {narrowed && (
          <button
            type="button"
            className="btn btn--small"
            disabled={disabled}
            onClick={() => {
              onWards([]);
              onCommunities([]);
            }}
          >
            Clear narrowing
          </button>
        )}
      </div>
    </div>
  );
}
