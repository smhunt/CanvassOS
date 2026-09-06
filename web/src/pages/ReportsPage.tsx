import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ActivityPanel, DEFAULT_DAYS, isActivityDays, type ActivityDays } from '../reports/ActivityPanel';
import { FollowUpQueue } from '../reports/FollowUpQueue';
import '../reports/reports.css';

const TABS = [
  { id: 'follow-ups', label: 'Follow-ups' },
  { id: 'activity', label: 'Activity' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Organiser reports. The tab lives in the query string so a link to the activity view is shareable
 * and Back steps between tabs rather than leaving the page.
 *
 * The follow-up queue carries addresses and canvassers' notes about residents — personal
 * information under the Municipal Elections Act — so there is deliberately no export here. Bulk
 * extraction has to be audited server-side (Phase 4).
 */
export function ReportsPage() {
  const [params, setParams] = useSearchParams();

  const tab: TabId = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'follow-ups';
  const daysParam = Number(params.get('days'));
  const days: ActivityDays = isActivityDays(daysParam) ? daysParam : DEFAULT_DAYS;

  // A tab switch pushes, so Back returns to the tab you came from.
  const setTab = (next: TabId) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p);
  };
  // The window is a setting on the activity view, not a place — it replaces so Back still leaves.
  const setDays = (next: ActivityDays) => {
    const p = new URLSearchParams(params);
    p.set('days', String(next));
    setParams(p, { replace: true });
  };

  // Roving tabindex: arrows move between tabs, Tab leaves the tablist.
  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    const pick = TABS[next];
    if (!pick) return;
    e.preventDefault();
    setTab(pick.id);
    document.getElementById(`reports-tab-${pick.id}`)?.focus();
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>Reports</h1>
        <p className="muted">
          Doors waiting on a promised follow-up, and who has been out knocking. Notes here are what canvassers were
          told at the door — treat them the way you treat the voters list.
        </p>
      </header>

      <div className="tabs" role="tablist" aria-label="Reports" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`reports-tab-${t.id}`}
            type="button"
            role="tab"
            className={`tab${t.id === tab ? ' tab--active' : ''}`}
            aria-selected={t.id === tab}
            aria-controls={`reports-panel-${t.id}`}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="stack" id={`reports-panel-${tab}`} role="tabpanel" aria-labelledby={`reports-tab-${tab}`} tabIndex={0}>
        {tab === 'follow-ups' ? <FollowUpQueue /> : <ActivityPanel days={days} onDays={setDays} />}
      </div>
    </div>
  );
}
