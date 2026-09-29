/**
 * Where the canvass has been, and how it is going there.
 *
 * The numbers come from GET /api/stats/coverage — counts only, no name, address or door id — so
 * like the Unreachable tab this is a report *about* the list rather than a read of it.
 *
 * Two rules the layout has to keep visible, because both are easy to misread:
 *  - "Attempted" and "Spoke with" are doors, cumulative. A door knocked three times is one door.
 *  - "Stance" is the LATEST support recorded at each door, so it is doors too — one supporter
 *    visited twice is one supporter. The Stats page histogram counts visits, and the two will not
 *    agree. The day table is the exception: a day has no denominator, so its stance is visits.
 */
import { useMemo } from 'react';
import { useCoverage } from '../api/hooks';
import type { CoverageDay, CoverageRow } from '../api/types';
import { EmptyState, ErrorBox, LoadingCards, LoadingTiles, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import './coverage.css';

export const COVERAGE_BY = ['ward', 'community', 'turf', 'day'] as const;
export type CoverageBy = (typeof COVERAGE_BY)[number];
export const DEFAULT_BY: CoverageBy = 'ward';
export const isCoverageBy = (v: string | null): v is CoverageBy => (COVERAGE_BY as readonly string[]).includes(v ?? '');

const BY_LABEL: Record<CoverageBy, string> = { ward: 'Ward', community: 'Community', turf: 'Turf', day: 'Day' };

const pct = (num: number, den: number) => (den ? `${Math.round((num / den) * 100)}%` : '—');

/** Opposed (1–2) · undecided (3) · supportive (4–5), as one bar so a row reads at a glance. */
function StanceBar({ support, unit }: { support: CoverageRow['support']; unit: 'doors' | 'visits' }) {
  const [s1, s2, s3, s4, s5] = support;
  const opp = s1 + s2;
  const und = s3;
  const sup = s4 + s5;
  const total = opp + und + sup;
  if (total === 0) return <span className="muted small">no stance yet</span>;
  const w = (v: number) => `${(v / total) * 100}%`;
  return (
    <span className="cov-stance">
      <span
        className="cov-stack"
        role="img"
        aria-label={`${n(sup)} supportive, ${n(und)} undecided, ${n(opp)} opposed, of ${n(total)} ${unit}`}
      >
        <span className="cov-stack__seg cov-stack__seg--sup" style={{ width: w(sup) }} />
        <span className="cov-stack__seg cov-stack__seg--und" style={{ width: w(und) }} />
        <span className="cov-stack__seg cov-stack__seg--opp" style={{ width: w(opp) }} />
      </span>
      <span className="cov-stance__nums num small" aria-hidden="true">
        <span className="cov-stance__sup">{n(sup)}</span> · {n(und)} · <span className="cov-stance__opp">{n(opp)}</span>
      </span>
    </span>
  );
}

/** Attempted out of the doors there are — the one number an organiser is really asking for. */
function CoverageBar({ attempted, households }: { attempted: number; households: number }) {
  const share = households ? Math.min(1, attempted / households) : 0;
  return (
    <span className="cov-cover">
      <span className="cov-bar" aria-hidden="true">
        <span className="cov-bar__fill" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="num">
        {n(attempted)} <span className="muted small">({pct(attempted, households)})</span>
      </span>
    </span>
  );
}

export function CoveragePanel({ by, onBy }: { by: CoverageBy; onBy: (b: CoverageBy) => void }) {
  const cov = useCoverage();
  const data = cov.data;

  // Rows for the three door-denominated groupings share one table; the day table is its own shape.
  const rows = useMemo(() => {
    if (!data || by === 'day') return [];
    if (by === 'ward') return data.by_ward.map((r) => ({ key: r.ward, label: wardLabel(r.ward), note: null as string | null, row: r }));
    if (by === 'community') return data.by_community.map((r) => ({ key: r.community, label: titleCase(r.community), note: null, row: r }));
    return data.by_turf.map((r) => ({
      key: r.turf_id,
      label: r.name,
      note: [r.ward ? wardLabel(r.ward) : null, r.archived ? 'archived' : null].filter(Boolean).join(' · ') || null,
      row: r,
    }));
  }, [data, by]);

  const t = data?.totals;
  const stanceDoors = t ? t.support.reduce((a, v) => a + v, 0) : 0;
  const supporters = t ? t.support[3] + t.support[4] : 0;

  return (
    <>
      <div className="rep-toolbar">
        <div className="rep-days" role="group" aria-label="Group by">
          {COVERAGE_BY.map((b) => (
            <button
              key={b}
              type="button"
              className={`rep-days__btn${b === by ? ' rep-days__btn--active' : ''}`}
              aria-pressed={b === by}
              onClick={() => onBy(b)}
            >
              {BY_LABEL[b]}
            </button>
          ))}
        </div>
        {t?.first_day && (
          <span className="rep-toolbar__count muted small">
            Since {fmtDate(t.first_day)} · {n(t.canvassers)} {t.canvassers === 1 ? 'canvasser' : 'canvassers'}
          </span>
        )}
      </div>

      {cov.isPending && (
        <>
          <LoadingTiles count={4} label="Loading coverage…" />
          <LoadingCards count={1} label={null} />
        </>
      )}
      {cov.isError && <ErrorBox title="Could not load coverage" error={cov.error} onRetry={() => void cov.refetch()} />}

      {data && t && (
        <>
          <section className="tiles" aria-label="Coverage so far">
            <div className="tile">
              <span className="tile__value num">{pct(t.attempted, t.households)}</span>
              <span className="tile__label">Doors attempted</span>
              <span className="tile__note muted small">
                {n(t.attempted)} of {n(t.households)}
              </span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(t.spoke)}</span>
              <span className="tile__label">Spoke with someone</span>
              <span className="tile__note muted small">{pct(t.spoke, t.attempted)} of doors attempted</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(supporters)}</span>
              <span className="tile__label">Supportive doors</span>
              <span className="tile__note muted small">
                {stanceDoors ? `${pct(supporters, stanceDoors)} of ${n(stanceDoors)} with a stance` : 'no stance recorded yet'}
              </span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(t.follow_up)}</span>
              <span className="tile__label">Follow-ups waiting</span>
              <span className="tile__note muted small">doors promised a return visit</span>
            </div>
          </section>

          <section className="card" aria-labelledby="cov-h">
            <h2 id="cov-h">By {BY_LABEL[by].toLowerCase()}</h2>

            {by !== 'day' && rows.length === 0 && (
              <EmptyState title={by === 'turf' ? 'No turfs yet.' : 'Nothing to show.'}>
                {by === 'turf' && <p>Build a turf from Turfs and it will appear here with its own progress.</p>}
              </EmptyState>
            )}

            {by !== 'day' && rows.length > 0 && (
              <div className="table-wrap">
                <table className="table cov-table">
                  <caption className="visually-hidden">Canvass coverage by {BY_LABEL[by].toLowerCase()}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{BY_LABEL[by]}</th>
                      <th scope="col" className="num">
                        Doors
                      </th>
                      <th scope="col">Attempted</th>
                      <th scope="col" className="num">
                        Spoke
                      </th>
                      <th scope="col">Stance</th>
                      <th scope="col" className="num">
                        Follow-ups
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ key, label, note, row }) => (
                      <tr key={key} className={by === 'turf' && (row as { archived?: boolean }).archived ? 'cov-row--archived' : undefined}>
                        <th scope="row">
                          {label}
                          {note && <span className="muted small cov-note"> {note}</span>}
                        </th>
                        <td className="num">{n(row.households)}</td>
                        <td>
                          <CoverageBar attempted={row.attempted} households={row.households} />
                        </td>
                        <td className="num">{n(row.spoke)}</td>
                        <td>
                          <StanceBar support={row.support} unit="doors" />
                        </td>
                        <td className="num">{n(row.follow_up)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {by === 'day' && data.by_day.length === 0 && (
              <EmptyState title="No visits recorded yet.">
                <p>Days appear here as soon as the first door is recorded.</p>
              </EmptyState>
            )}

            {by === 'day' && data.by_day.length > 0 && (
              <div className="table-wrap">
                <table className="table cov-table">
                  <caption className="visually-hidden">Canvass activity by day, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col" className="num">
                        Visits
                      </th>
                      <th scope="col" className="num">
                        Doors
                      </th>
                      <th scope="col" className="num">
                        Spoke
                      </th>
                      <th scope="col" className="num">
                        Canvassers
                      </th>
                      <th scope="col">Stance recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.by_day].reverse().map((d: CoverageDay) => (
                      <tr key={d.day}>
                        <th scope="row">{fmtDate(d.day)}</th>
                        <td className="num">{n(d.contacts)}</td>
                        <td className="num">{n(d.doors)}</td>
                        <td className="num">{n(d.spoke)}</td>
                        <td className="num">{n(d.canvassers)}</td>
                        <td>
                          <StanceBar support={d.support} unit="visits" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="muted small">
              {by === 'day'
                ? 'Ontario calendar days, as on the Activity tab. Stance on this table is visits that day, not doors.'
                : 'Attempted and Spoke count doors, however many times each was visited. Stance is the latest support recorded at each door — supportive · undecided · opposed — so a supporter visited twice is one supporter, and these numbers will not match the Stats page, which counts visits.'}
              {by === 'turf' && ' A door in two turfs counts in both.'}
            </p>
          </section>
        </>
      )}
    </>
  );
}
