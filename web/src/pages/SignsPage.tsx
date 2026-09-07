import { Suspense, lazy, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/ui';
import { PickupPanel } from '../signs/PickupPanel';
import { PlaceSignPanel } from '../signs/PlaceSignPanel';
import { SignRequestsPanel } from '../signs/SignRequestsPanel';
import '../signs/signs.css';

// MapLibre is ~1 MB and three of the four tabs never touch it, so the map is split out and only
// fetched when this tab is actually opened.
const SignsMap = lazy(() => import('../signs/SignsMap'));

const TABS = [
  { id: 'place', label: 'Place a sign' },
  { id: 'requests', label: 'Sign requests' },
  { id: 'map', label: 'Map' },
  { id: 'pickup', label: 'Pickup list' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Lawn signs: put one in the ground, deliver the ones that were asked for, and get them all back.
 *
 * Placement is campaign logistics rather than voter data, so every signed-in role can use this
 * screen — with one exception: the sign-requests tab lists doors off the voters list and is scoped
 * and audited server-side like any other read of personal information.
 *
 * The tab lives in `?tab=` (as on /reports) so the pickup list is a link somebody can be sent, and
 * Back steps between tabs rather than leaving the page. `?household=` carries a door from the
 * requests tab into the placing form.
 */
export function SignsPage() {
  const [params, setParams] = useSearchParams();

  const tab: TabId = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'place';

  const householdId = params.get('household');
  const household = householdId ? { id: householdId, address: params.get('address') } : null;

  // A tab switch pushes, so Back returns to the tab you came from.
  const setTab = (next: TabId) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p);
  };

  // Unlinking the door is a correction, not a place — it replaces so Back still leaves the page.
  const clearHousehold = () => {
    const p = new URLSearchParams(params);
    p.delete('household');
    p.delete('address');
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
    document.getElementById(`signs-tab-${pick.id}`)?.focus();
  };

  return (
    <div className="page page--signs">
      <header className="page__head">
        <h1>Lawn signs</h1>
        <p className="muted">
          Record where every sign went, with a GPS fix and a photo. Signs have to come down within the window set by the
          municipal sign by-law, and a sign nobody can find is a fine — the fix and the photo are how the pickup crew
          finds it in November.
        </p>
      </header>

      <div className="tabs" role="tablist" aria-label="Lawn signs" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`signs-tab-${t.id}`}
            type="button"
            role="tab"
            className={`tab${t.id === tab ? ' tab--active' : ''}`}
            aria-selected={t.id === tab}
            aria-controls={`signs-panel-${t.id}`}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="stack" id={`signs-panel-${tab}`} role="tabpanel" aria-labelledby={`signs-tab-${tab}`} tabIndex={0}>
        {tab === 'place' && <PlaceSignPanel household={household} onClearHousehold={clearHousehold} />}
        {tab === 'requests' && <SignRequestsPanel />}
        {tab === 'map' && (
          <Suspense
            fallback={
              <p className="muted small">
                <Spinner size={16} /> Loading the map…
              </p>
            }
          >
            <SignsMap />
          </Suspense>
        )}
        {tab === 'pickup' && <PickupPanel />}
      </div>
    </div>
  );
}
