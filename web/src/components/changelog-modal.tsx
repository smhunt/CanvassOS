import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export const APP_VERSION = '0.5.0';
export const REPO_URL = 'https://github.com/smhunt/mc-canvass';

export interface Release {
  version: string;
  date: string;
  changes: string[];
}

/** Mirrors CHANGELOG.md at the repo root — keep the two in step. */
export const CHANGELOG: Release[] = [
  {
    version: '0.5.0',
    date: '2026-09-11',
    changes: [
      'Record a visit straight from a door on the map \u2014 including doors that are in no turf.',
      'Asking for a lawn sign now creates a real request, with an address field prefilled with the door.',
      'Fixed: a door dropped off the delivery list the moment its sign request was recorded.',
    ],
  },
  {
    version: '0.4.6',
    date: '2026-09-10',
    changes: [
      'Tap a door on the map and you can now act on it: open it in the door screen, place a lawn sign, or get directions.',
      'Works for doors outside every turf too \u2014 those are the ones most likely to need a sign.',
    ],
  },
  {
    version: '0.4.5',
    date: '2026-09-10',
    changes: [
      'Fixed: the print button did nothing in the installed app \u2014 iPhone cannot print from one, so it now opens the sheet in Safari.',
      'Print the paper sheet straight from the turf drawer.',
      'Tap a turf boundary on the map to open that turf.',
      'Loading skeletons instead of a spinner on the door list and the sheet.',
    ],
  },
  {
    version: '0.4.4',
    date: '2026-09-08',
    changes: [
      'More map on a phone: search collapses to an icon and the toolbar no longer wraps onto a second row.',
      'The door card leads with the voters; the counts and \u201cCentre on map\u201d moved below them.',
      'Fixed: \u201cCentre on map\u201d used to put the door underneath the panel that asked for it.',
    ],
  },
  {
    version: '0.4.3',
    date: '2026-09-08',
    changes: [
      'Turf boundaries on the map: yours if you are a volunteer, everyone\u2019s (with yours highlighted) if you run the campaign.',
    ],
  },
  {
    version: '0.4.2',
    date: '2026-09-08',
    changes: [
      'New Unreachable report: why part of the list cannot be reached, and what to do about each reason.',
      'It separates what blocks a door-knock from what only blocks the post \u2014 a PO box is not an unreachable door.',
    ],
  },
  {
    version: '0.4.1',
    date: '2026-09-06',
    changes: [
      'A map of every lawn sign and every outstanding sign request, on the Signs page.',
      'Fixed the turf map: a big turf drew as a solid black blob and hid the map underneath it.',
    ],
  },
  {
    version: '0.4.0',
    date: '2026-09-06',
    changes: [
      'Works with no signal: results and sign photos queue on the phone and sync themselves later.',
      'Doors can be ordered nearest-first from your GPS, as well as in walking order.',
      'Printable paper turf sheet, for a dead battery or no signal at all.',
      'Proper iPad layout \u2014 the door list and the open door side by side.',
      'Add MC Canvass to your home screen so it opens like an app.',
      'Move a turf from one volunteer to another, or take it off them.',
      'Optional street-level photo of a door, off unless a key is configured.',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-09-05',
    changes: [
      'Lawn signs: place one with the phone\u2019s GPS and a photo, and see how accurate the fix is.',
      'Pickup list of every sign still standing, with a link that opens your phone\u2019s map app.',
      'Delivery list of doors that asked for a sign at the door.',
      'Draw a turf as a polygon on the map, with the door count updating as you draw.',
      'Follow-up queue and volunteer activity under Reports.',
      'The turf builder now names the turf a street already belongs to, so walks cannot overlap unnoticed.',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-09-05',
    changes: [
      'Turfs: cut from a list of streets or a drawn polygon, with doors ordered along the street.',
      'Assign a turf to a volunteer and track it as open, in progress or done.',
      'Door screen for phones: one-thumb result buttons, support 1-5, issue flags and a note.',
      'Volunteers see voter names at doors in their own turf — never mailing or resident details.',
      'Every result carries an idempotency key, so a retry on a bad signal cannot double-count a door.',
      '"Canvass status" colour mode on the map, and clusters coloured by their dominant ward.',
      'Default basemap switched to OpenStreetMap — CARTO now watermarks anonymous tiles.',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-05',
    changes: [
      'Phase 1: self-hosted canvass stack — importer, API, MapLibre viewer.',
      'docker compose stack: PostgreSQL 16, Fastify + TypeScript API, React SPA, Caddy for TLS and the /api proxy.',
      'Makefile lifecycle: up, down, restart, logs, ps, import, import-force, backup, restore, purge, psql, test.',
      'Database schema applied on first boot, with trigram indexes on voter names and household addresses.',
      'Python one-shot importer for voters_final.csv and households.csv, idempotent on the source-file hash and traceable through import_run.',
      'Session-cookie sign-in with argon2id password hashing, rate-limited login and a first-boot admin account.',
      'Roles admin, organizer and volunteer, enforced on every API route and reflected in the UI.',
      'Single-use invite links valid 7 days; re-invite doubles as a password reset; the last active admin cannot be demoted or deactivated.',
      'Change password (minimum 10 characters), which signs out every other device.',
      'Volunteers see anonymous household points only — no names, mailing addresses, resident status or municipality-wide search.',
      'MapLibre map of the whole municipality: clustered household points, the Middlesex Centre boundary, and light, streets and satellite base layers.',
      'Colour modes for ward, community and voters per door, plus record quality and non-resident owners for organizers, each with a legend.',
      'Filters drawer for ward, community and record quality, showing door and voter counts per filter.',
      'Household card with voters, resident status, mailing addresses that differ from the property, and centre-on-map.',
      'Unmapped parcels list so the 70 legal-description households without a civic address stay reachable.',
      'Search across voter names and household addresses, including "123 King" number-and-street matching.',
      'Streets endpoint rolling households up by street, ward and community — the base for the Phase 2 turf builder.',
      'Stats dashboard: totals, ward and community breakdowns, voters per door and record quality.',
      'Audit log of sign-ins, failed sign-ins, household views, searches, invites, user changes and password changes, browsable and filterable by admins.',
      'Municipal Elections Act notices in the footer, on the account page and on the audit log.',
      'Encrypted backups (pg_dump | gzip | gpg AES256) and a purge target that deletes every volume and shreds the source CSVs.',
      'Installable on phones: web manifest, icons and a build-generated app-shell service worker.',
    ],
  },
];

export interface HowItWorksStep {
  title: string;
  description: string;
  icon: string;
}

export const HOW_IT_WORKS: HowItWorksStep[] = [
  {
    title: 'Sign in with your invite link',
    description:
      'Sean or an organizer sends you a private link. Open it once, pick a password of at least 10 characters, and you are in. The link expires after 7 days and works only once — ask for a fresh one if it has gone stale. After that, sign in at the campaign address with your email and password.',
    icon: '🔑',
  },
  {
    title: 'Read the map',
    description:
      'Every dot is a household on the voters list. Use the colour menu to shade them by ward, by community, or by how many voters live behind the door. Organizers also get record quality and non-resident owners. The legend at the bottom always tells you what the colours mean right now.',
    icon: '🗺️',
  },
  {
    title: 'Zoom in to split the clusters',
    description:
      'Zoomed out, nearby doors collapse into a numbered circle so the map stays readable across 7,000 households. Pinch or tap a cluster to break it apart into individual doors.',
    icon: '🔵',
  },
  {
    title: 'Narrow it down with filters',
    description:
      'The filters drawer limits the map to the wards, communities and record qualities you care about, and shows the door and voter count for each choice. The count beside the filters button tells you how many are active — clear them when the map looks emptier than it should.',
    icon: '🎚️',
  },
  {
    title: 'Open a door for the details',
    description:
      'Tap a dot to open the household card. Organizers and admins see the address, everyone on the list at that door, whether an owner lives elsewhere, and any mailing address that differs from the property. Volunteers see the number of voters at the door only until turfs arrive in Phase 2.',
    icon: '🏠',
  },
  {
    title: 'Search by name or address',
    description:
      'Organizers and admins can search the list from the map — a surname, part of an address, or "123 King" style. Picking a result flies the map to that door and opens its card. Households recorded by legal description have no map point; find those under "unmapped parcels".',
    icon: '🔎',
  },
  {
    title: 'Check the numbers on Stats',
    description:
      'Stats holds the shape of the municipality: totals, doors and voters by ward and by community, voters per door, and record quality. The canvass figures stay at zero until door-knocking starts in Phase 2.',
    icon: '📊',
  },
  {
    title: 'Install it on your phone',
    description:
      'Open the site in your phone browser and choose "Add to Home Screen". It then launches like an app. The screens load without a signal, but the voter data still needs one — offline turfs come in Phase 3.',
    icon: '📲',
  },
  {
    title: 'The rules you are agreeing to',
    description:
      'The voters list is personal information supplied under the Ontario Municipal Elections Act. Use it for this campaign and nothing else. Never copy, photograph, export or forward the list, and never merge it into another contact list. Every sign-in, search and household view is written to an audit log. The whole database is destroyed after election day.',
    icon: '⚖️',
  },
];

export type Priority = 'high' | 'medium' | 'low';

export interface RoadmapItem {
  label: string;
  priority: Priority;
  done?: boolean;
}

export interface RoadmapGroup {
  category: string;
  icon: string;
  items: RoadmapItem[];
}

export const ROADMAP: RoadmapGroup[] = [
  {
    category: 'Shipped — Phase 1: foundation and read-only viewer',
    icon: '✅',
    items: [
      { label: 'Compose stack, schema and the CSV importer', priority: 'high', done: true },
      { label: 'Sign-in, roles and invite links', priority: 'high', done: true },
      { label: 'Municipality-wide map with filters, search and the household card', priority: 'high', done: true },
      { label: 'Stats dashboard and audit log', priority: 'medium', done: true },
      { label: 'Encrypted backups and the post-election purge', priority: 'high', done: true },
    ],
  },
  {
    category: 'Shipped — Phase 2: canvassing core',
    icon: '✅',
    items: [
      { label: 'Turfs cut from a list of streets, with doors in walking order', priority: 'high', done: true },
      { label: 'Assignments — turf to volunteer, with open / in progress / done', priority: 'high', done: true },
      { label: 'Door screen: one-thumb result buttons, support, flags and notes', priority: 'high', done: true },
      { label: 'Volunteers scoped to their assigned turfs, with voter names at the door', priority: 'high', done: true },
      { label: 'Latest-status colouring on the map', priority: 'medium', done: true },
    ],
  },
  {
    category: 'Shipped — lawn signs',
    icon: '✅',
    items: [
      { label: 'Place a sign with GPS and a photo, accuracy shown and re-takeable', priority: 'high', done: true },
      { label: 'Pickup list for after election day, with map-app links', priority: 'high', done: true },
      { label: 'Delivery list of doors that asked for a sign', priority: 'medium', done: true },
    ],
  },
  {
    category: 'Shipped — Phase 3: field hardening',
    icon: '✅',
    items: [
      { label: 'Works offline: results queue on the phone and sync when you get signal back', priority: 'high', done: true },
      { label: 'Your assigned turf is cached, so the door list works with no connection', priority: 'high', done: true },
      { label: 'Walking order along the street, and nearest-first ordering from your GPS', priority: 'high', done: true },
      { label: 'Printable paper turf sheet, for a dead battery or no signal at all', priority: 'medium', done: true },
      { label: 'Add to home screen, so it opens like an app', priority: 'medium', done: true },
      { label: 'Street-level image of a door — optional, off unless a key is configured', priority: 'low', done: true },
    ],
  },
  {
    category: 'Shipped — at the door, beyond the result buttons',
    icon: '✅',
    items: [
      { label: 'Tag more than one person at a door in a single visit', priority: 'high', done: true },
      { label: 'Collect a phone number or email at the door, with consent recorded per purpose', priority: 'high', done: true },
      { label: 'A withdrawal is stamped and kept, never deleted — that record is the proof', priority: 'high', done: true },
    ],
  },
  {
    category: 'Shipped — Phase 5: messaging',
    icon: '✅',
    items: [
      { label: 'SMS and email to electors who opted in — SMS first, email as the fallback', priority: 'high', done: true },
      { label: 'Nobody is messaged without an explicit yes; STOP is honoured before the next send', priority: 'high', done: true },
      { label: 'Sending window and weekend hours enforced in code (CRTC), not left to whoever clicks', priority: 'high', done: true },
      { label: 'Send it to yourself first, then approve by typing a word — two gates before anything goes out', priority: 'high', done: true },
      { label: 'A drip across the day, because a Canadian long code is throttled and the excess fails silently', priority: 'high', done: true },
    ],
  },
  {
    category: 'Shipped — maps everywhere they help',
    icon: '✅',
    items: [
      { label: 'Every lawn sign and every outstanding request on one map', priority: 'high', done: true },
      { label: 'Turf boundaries on the main map — yours, or everyone\u2019s with yours highlighted', priority: 'high', done: true },
      { label: 'Open the turf you were last in, and switch turfs from a drawer', priority: 'medium', done: true },
      { label: 'A turf built from streets gets an approximate outline drawn round its doors', priority: 'low', done: true },
      { label: 'Tap a boundary on the map to open that turf', priority: 'medium', done: true },
      { label: 'Print the paper sheet straight from the turf drawer', priority: 'medium', done: true },
    ],
  },
  {
    category: 'Shipped — why part of the list cannot be reached',
    icon: '✅',
    items: [
      { label: 'A report separating what blocks a door-knock from what only blocks the post', priority: 'high', done: true },
      { label: 'Written guidance for each reason, and which ward to look at first', priority: 'high', done: true },
      { label: 'Optional AI advice written from the counts alone — no name or address ever leaves', priority: 'medium', done: true },
    ],
  },
  {
    category: 'Next — reaching people who are not at the door',
    icon: '📣',
    items: [
      { label: 'Geographically targeted ads for the rural communities — Meta, Instagram and whichever others accept political advertising in Canada', priority: 'high' },
      { label: 'Census data by neighbourhood (not by person) to decide which streets to walk first', priority: 'medium' },
    ],
  },
  {
    category: 'Next — telling people things',
    icon: '🔔',
    items: [
      { label: 'Notify a volunteer when a turf is assigned to them, or taken off them', priority: 'high' },
      { label: 'Messages between organisers and volunteers, in the app', priority: 'high' },
      { label: 'Push notifications to an installed phone — no SMS provider, no per-message cost', priority: 'medium' },
      { label: 'Nudge an organiser when a door is flagged for follow-up, or a sign is requested', priority: 'medium' },
    ],
  },
  {
    category: 'Planned — Phase 4: reporting and admin',
    icon: '📈',
    items: [
      {
        label:
          'Diff-based re-import of a newer list — new, removed and moved voters, keeping contacts. The biggest remaining gap: today a re-import deletes every contact, sign and consent record.',
        priority: 'high',
      },
      { label: 'Coverage and support reports by ward, community, turf and day', priority: 'high' },
      { label: 'CSV export with an audit entry for every download', priority: 'medium' },
      { label: 'Aerial imagery layer from the county GIS — current, free, and covers the rural roads', priority: 'low' },
    ],
  },
];

export type AboutTab = 'changelog' | 'how' | 'roadmap';

const TABS: { id: AboutTab; label: string }[] = [
  { id: 'changelog', label: 'Changelog' },
  { id: 'how', label: 'How it works' },
  { id: 'roadmap', label: 'Roadmap' },
];

interface Props {
  open: boolean;
  tab: AboutTab;
  onTab: (tab: AboutTab) => void;
  onClose: () => void;
}

export function ChangelogModal({ open, tab, onTab, onClose }: Props) {
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    headRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

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
    onTab(pick.id);
    document.getElementById(`about-tab-${pick.id}`)?.focus();
  };

  return (
    <div className="modal-wrap modal-wrap--fixed" role="presentation">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="card modal" role="dialog" aria-modal="true" aria-labelledby="about-h">
        <header className="modal__head">
          <h2 id="about-h" ref={headRef} tabIndex={-1}>
            About MC Canvass <span className="muted">v{APP_VERSION}</span>
          </h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close about this app">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </header>

        <div className="tabs" role="tablist" aria-label="About this app" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`about-tab-${t.id}`}
              type="button"
              role="tab"
              className={`tab${t.id === tab ? ' tab--active' : ''}`}
              aria-selected={t.id === tab}
              aria-controls={`about-panel-${t.id}`}
              tabIndex={t.id === tab ? 0 : -1}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal__body" id={`about-panel-${tab}`} role="tabpanel" aria-labelledby={`about-tab-${tab}`} tabIndex={0}>
          {tab === 'changelog' && <ChangelogPanel />}
          {tab === 'how' && <HowItWorksPanel />}
          {tab === 'roadmap' && <RoadmapPanel />}
        </div>
      </div>
    </div>
  );
}

function ChangelogPanel() {
  return (
    <div className="about">
      {CHANGELOG.map((r) => (
        <section key={r.version} className="about__block">
          <h3 className="about__title">
            <span className="tag tag--mini tag--neutral mono">v{r.version}</span> <span className="muted small">{r.date}</span>
          </h3>
          <ul className="about__list">
            {r.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted small">
        Source and issues:{' '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          github.com/smhunt/mc-canvass
        </a>
      </p>
    </div>
  );
}

function HowItWorksPanel() {
  return (
    <div className="about">
      {HOW_IT_WORKS.map((s) => (
        <section key={s.title} className="about__step">
          <span className="about__icon" aria-hidden="true">
            {s.icon}
          </span>
          <div>
            <h3 className="about__title">{s.title}</h3>
            <p className="muted">{s.description}</p>
          </div>
        </section>
      ))}
    </div>
  );
}

function RoadmapPanel() {
  return (
    <div className="about">
      {ROADMAP.map((g) => (
        <section key={g.category} className="about__block">
          <h3 className="about__title">
            <span className="about__icon" aria-hidden="true">
              {g.icon}
            </span>{' '}
            {g.category}
          </h3>
          <ul className="about__list about__list--plain">
            {g.items.map((it) => (
              <li key={it.label} className="about__item">
                <span>{it.label}</span>
                {it.done ? (
                  <span className="tag tag--mini tag--ok">done</span>
                ) : (
                  <span className={`tag tag--mini tag--prio-${it.priority}`}>{it.priority}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted small">Phases follow the build plan in prompt_plan.md. Dates depend on how fast the doors get knocked.</p>
    </div>
  );
}
