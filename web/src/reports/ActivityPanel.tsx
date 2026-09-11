import { useMemo, type CSSProperties } from 'react';
import { useActivity } from '../api/hooks';
import { Histogram } from '../components/Bars';
import { EmptyState, ErrorBox, LoadingChart, LoadingTiles, fmtDate, n } from '../components/ui';
import { daysSince, fillDays, relativeDay } from './relative';

const WINDOWS = [7, 14, 30] as const;
export type ActivityDays = (typeof WINDOWS)[number];

export const DEFAULT_DAYS: ActivityDays = 14;
export const isActivityDays = (v: number): v is ActivityDays => (WINDOWS as readonly number[]).includes(v);

/** A canvasser silent for longer than this is flagged; roughly "missed a weekend". */
const QUIET_DAYS = 7;

/** Who has been knocking. Aggregates only — no addresses, no voter names, no notes. */
export function ActivityPanel({ days, onDays }: { days: ActivityDays; onDays: (d: ActivityDays) => void }) {
  const activity = useActivity(days);

  const byDay = useMemo(() => fillDays(activity.data?.by_day ?? [], days), [activity.data, days]);
  const byUser = activity.data?.by_user ?? [];

  const contacts = byUser.reduce((sum, u) => sum + u.contacts, 0);
  const busiest = byDay.reduce((best, d) => (d.contacts > best.contacts ? d : best), { label: '—', contacts: 0 });

  return (
    <>
      <div className="rep-toolbar">
        <div className="rep-days" role="group" aria-label="Time window">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              className={`rep-days__btn${d === days ? ' rep-days__btn--active' : ''}`}
              aria-pressed={d === days}
              onClick={() => onDays(d)}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {/* Four tiles over a per-day chart, which is the shape of the answer. */}
      {activity.isPending && (
        <>
          <LoadingTiles count={4} label="Loading activity…" />
          <LoadingChart bars={5} label={null} />
        </>
      )}
      {activity.isError && <ErrorBox title="Could not load activity" error={activity.error} onRetry={() => void activity.refetch()} />}

      {activity.data && (
        <>
          <section className="tiles" aria-label={`Totals for the last ${days} days`}>
            <div className="tile">
              <span className="tile__value num">{n(contacts)}</span>
              <span className="tile__label">Contacts</span>
              <span className="tile__note muted small">last {days} days</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(byUser.length)}</span>
              <span className="tile__label">Canvassers</span>
              <span className="tile__note muted small">recorded at least one door</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{(contacts / days).toFixed(1)}</span>
              <span className="tile__label">Contacts per day</span>
              <span className="tile__note muted small">across the window</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(busiest.contacts)}</span>
              <span className="tile__label">Busiest day</span>
              <span className="tile__note muted small">{busiest.contacts > 0 ? busiest.label : 'nothing recorded yet'}</span>
            </div>
          </section>

          <section className="card" aria-labelledby="rep-day-h">
            <h2 id="rep-day-h">Contacts per day</h2>
            {/* --rep-cols keeps 30 bars wide enough to read; the wrapper scrolls on a phone. */}
            <div className="rep-chart" style={{ '--rep-cols': days } as CSSProperties}>
              <Histogram
                title={`Contacts per day, last ${days} days`}
                data={byDay.map((d) => ({ label: d.label, value: d.contacts }))}
              />
            </div>
            <p className="muted small">
              Days are Ontario calendar days, so an evening knock counts on the evening it happened.
            </p>
          </section>

          <section className="card" aria-labelledby="rep-user-h">
            <h2 id="rep-user-h">By canvasser</h2>
            {byUser.length === 0 ? (
              <EmptyState title="No contacts were recorded in this window.">
                <p>Try a longer window, or check that turfs have been assigned.</p>
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">Canvassers ranked by contacts recorded in the last {days} days</caption>
                  <thead>
                    <tr>
                      <th scope="col">Canvasser</th>
                      <th scope="col" className="num">
                        Contacts
                      </th>
                      <th scope="col" className="num">
                        Doors
                      </th>
                      <th scope="col">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byUser.map((u) => {
                      const since = daysSince(u.last_at);
                      const quiet = since === null || since >= QUIET_DAYS;
                      return (
                        <tr key={u.user_id}>
                          <th scope="row" className="rep-act__name">
                            {u.name}
                          </th>
                          <td className="num">{n(u.contacts)}</td>
                          <td className="num">{n(u.doors)}</td>
                          <td className={quiet ? 'rep-stale' : undefined}>
                            <span title={u.last_at ? fmtDate(u.last_at) : undefined}>{relativeDay(u.last_at)}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">
              “Doors” counts distinct households, so it is lower than contacts when a door was revisited. Totals per
              canvasser overlap where two people worked the same address.
            </p>
          </section>
        </>
      )}
    </>
  );
}
