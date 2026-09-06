import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CampaignDetail } from '../messaging/CampaignDetail';
import { CampaignList } from '../messaging/CampaignList';
import { Composer } from '../messaging/Composer';
import { CapacityStrip, SenderPool } from '../messaging/SenderPool';
import '../messaging/messaging.css';

const TABS = [
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'numbers', label: 'Sending numbers' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Organiser messaging: compose an SMS or email campaign, see who it can actually reach, approve
 * it, and watch it drain.
 *
 * Two facts from `docs/phase-5-messaging-plan.md` shape this screen, and both are stated before
 * anything can be typed:
 *
 *  - Throughput is the ceiling. Long codes carry ~100–250 messages a day each and drop the excess
 *    silently, so the pool's capacity sits at the top of the page and the audience readout gives
 *    the send's length in days before the message box appears.
 *  - Sending is three deliberate steps — test, approve, start — never one button.
 *
 * Nothing here shows an elector's name or address. It is a broadcast tool working off counts, and
 * the consent that makes it lawful lives per person in `voter_contact`, not here.
 *
 * The tab and the open campaign live in the query string (as on /reports and /signs) so a running
 * send is a link somebody can be sent, and Back steps between views rather than leaving the page.
 */
export function CampaignsPage() {
  const [params, setParams] = useSearchParams();

  const tab: TabId = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as TabId) : 'campaigns';
  const open = params.get('campaign');

  const setTab = (next: TabId) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    p.delete('campaign');
    setParams(p);
  };

  const openCampaign = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('campaign', id);
    setParams(p);
  };

  const closeCampaign = () => {
    const p = new URLSearchParams(params);
    p.delete('campaign');
    setParams(p);
  };

  // A saved draft replaces the "new" URL: Back from the draft should reach the list, not a second
  // empty composer that would create a duplicate campaign.
  const onCreated = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('campaign', id);
    setParams(p, { replace: true });
  };

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
    document.getElementById(`msg-tab-${pick.id}`)?.focus();
  };

  return (
    <div className="page msg-page">
      <header className="page__head">
        <h1>Messaging</h1>
        <p className="muted">
          Text and email to people who asked to hear from us — and only for the purpose they agreed to. Someone who says
          STOP is never messaged again, on any campaign.
        </p>
      </header>

      {/* The ceiling, before anything else on the screen. */}
      <CapacityStrip />

      <div className="tabs" role="tablist" aria-label="Messaging" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`msg-tab-${t.id}`}
            type="button"
            role="tab"
            className={`tab${t.id === tab ? ' tab--active' : ''}`}
            aria-selected={t.id === tab}
            aria-controls={`msg-panel-${t.id}`}
            tabIndex={t.id === tab ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="stack" id={`msg-panel-${tab}`} role="tabpanel" aria-labelledby={`msg-tab-${tab}`} tabIndex={0}>
        {tab === 'numbers' && <SenderPool />}

        {tab === 'campaigns' && open === 'new' && (
          <Composer key="new" onSaved={(c) => onCreated(c.id)} onCancel={closeCampaign} />
        )}

        {tab === 'campaigns' && open !== null && open !== 'new' && (
          <CampaignDetail key={open} id={open} onBack={closeCampaign} />
        )}

        {tab === 'campaigns' && open === null && (
          <>
            <div className="msg-toolbar">
              <p className="muted small">
                Every send is a drip: it leaves steadily across the number pool, over hours or days. Plan a
                get-out-the-vote message backwards from the day it has to land.
              </p>
              <button type="button" className="btn btn--primary" onClick={() => openCampaign('new')}>
                New campaign
              </button>
            </div>
            <CampaignList onOpen={openCampaign} onNew={() => openCampaign('new')} />
          </>
        )}
      </div>
    </div>
  );
}
