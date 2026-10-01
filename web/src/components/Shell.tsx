import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { useMeta } from '../api/hooks';
import { configure, identify, screenFor, setUser, track } from '../analytics';
import { currentBreakpoint } from '../canvass/useBreakpoint';
import { isIosInstalled } from '../pwa';
import { listVoices, readVoicePref } from '../speech';
import { BuildLine } from './BuildLine';
import { APP_VERSION } from './changelog-modal';
import type { User } from '../api/types';
import { isAdmin, isOrganizer } from '../auth';
import { helpFor } from '../help/route';
import { HelpButton } from './HelpButton';
import { SignOutButton } from './SignOutButton';
import { RoleChip } from './ui';

export function useUser(): User {
  return useOutletContext<User>();
}

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="CanvassOS">
      <span className="wordmark__word">Canvass</span>
      <span className="wordmark__badge">OS</span>
    </span>
  );
}

export function Shell() {
  const user = useUser();
  const loc = useLocation();
  const isMap = loc.pathname.startsWith('/map');
  const help = helpFor(loc.pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Desktop only: the name in the top bar opens Account and Sign out. Below DESKTOP the name is
  // hidden and the same two live in the phone menu, so the two menus are never on screen together.
  const [userOpen, setUserOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);

  // Close either menu on navigation and on outside click / Escape.
  useEffect(() => {
    setMenuOpen(false);
    setUserOpen(false);
  }, [loc.pathname]);

  // Analytics runs only inside the signed-in shell: never on /login, /invite or /subscribe. The
  // user id is the opaque uuid. What is described here is the device and the app, never a door.
  useEffect(() => {
    configure({ appVersion: APP_VERSION });
    setUser(user.id);
    let installed = false;
    let pointer: 'coarse' | 'fine' = 'fine';
    try {
      installed = isIosInstalled() || window.matchMedia('(display-mode: standalone)').matches;
      pointer = window.matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine';
    } catch {
      /* no matchMedia — the defaults stand */
    }
    const uri = readVoicePref();
    const voice = uri ? listVoices().find((v) => v.voiceURI === uri) : undefined;
    identify({
      app_version: APP_VERSION,
      installed,
      breakpoint: currentBreakpoint(),
      pointer,
      voice_kind: !uri ? 'none' : voice && !voice.localService ? 'online' : 'local',
    });
  }, [user.id]);
  // Page views by hand, and only the pattern: `screenFor` never returns the path or the query.
  useEffect(() => {
    track('screen_viewed', { ...screenFor(loc.pathname, loc.search), breakpoint: currentBreakpoint() });
  }, [loc.pathname, loc.search]);
  useEffect(() => {
    if (!menuOpen && !userOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t)) setMenuOpen(false);
      if (userRef.current && !userRef.current.contains(t)) setUserOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setUserOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, userOpen]);

  const links = [
    { to: '/map', label: 'Map', show: true },
    { to: '/canvass', label: 'Canvass', show: true },
    { to: '/turfs', label: 'Turfs', show: isOrganizer(user) },
    { to: '/signs', label: 'Signs', show: true },
    { to: '/requests', label: 'Sign-ups', show: isOrganizer(user) },
    { to: '/messaging', label: 'Messaging', show: isOrganizer(user) },
    { to: '/reports', label: 'Reports', show: isOrganizer(user) },
    { to: '/stats', label: 'Stats', show: isOrganizer(user) },
    { to: '/admin/users', label: 'Users', show: isAdmin(user) },
    { to: '/admin/audit', label: 'Audit', show: isAdmin(user) },
    { to: '/account', label: 'Account', show: true },
  ].filter((l) => l.show);

  return (
    <div className={`shell${isMap ? ' shell--map' : ''}`}>
      <header className="topbar">
        <NavLink to="/map" className="topbar__brand">
          <Wordmark />
        </NavLink>
        <nav className="topbar__nav" aria-label="Main">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => `navlink${isActive ? ' navlink--active' : ''}`}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar__user" ref={userRef}>
          <button
            type="button"
            className="topbar__userbtn"
            aria-haspopup="menu"
            aria-expanded={userOpen}
            aria-controls="user-menu"
            onClick={() => setUserOpen((o) => !o)}
          >
            <span className="topbar__name" title={user.email}>
              {user.name}
            </span>
            <RoleChip role={user.role} />
          </button>
          {userOpen && (
            <div className="menu" id="user-menu" role="menu">
              <div className="menu__user">
                <div className="muted small">{user.email}</div>
              </div>
              <NavLink to="/account" role="menuitem" className="menu__item">
                Account
              </NavLink>
              <SignOutButton role="menuitem" className="menu__item" />
            </div>
          )}
        </div>
        {/* Silent on open (speak={false}), unlike drive mode's: this one is used at a doorstep, in a
            meeting, on a laptop in an office — places a phone should not start talking unasked. The
            dialog's "Read it aloud" is one tap away. Keyed by title so moving to another screen with
            the dialog open (the back button) remounts it: the old script stops, the new one is closed. */}
        {help && <HelpButton key={help.title} topic={help} speak={false} className="topbar__help" />}
        <div className="topbar__menu" ref={menuRef}>
          <button
            type="button"
            className="btn btn--icon topbar__menubtn"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MenuIcon open={menuOpen} />
          </button>
          {menuOpen && (
            <div className="menu" id="mobile-menu" role="menu">
              <div className="menu__user">
                <div>
                  <div className="menu__name">{user.name}</div>
                  <div className="muted small">{user.email}</div>
                </div>
                <RoleChip role={user.role} />
              </div>
              {links.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  role="menuitem"
                  className={({ isActive }) => `menu__item${isActive ? ' menu__item--active' : ''}`}
                >
                  {l.label}
                </NavLink>
              ))}
              <div className="menu__sep" role="separator" />
              <SignOutButton role="menuitem" className="menu__item" />
            </div>
          )}
        </div>
      </header>
      <main className={`shell__main${isMap ? ' shell__main--map' : ''}`}>
        <Outlet context={user} />
      </main>
      {!isMap && <Footer />}
    </div>
  );
}

export function ImportLabel({ prefix = 'Data: ' }: { prefix?: string }) {
  const meta = useMeta();
  if (!meta.data?.import) return null;
  const imp = meta.data.import;
  return (
    <span>
      {prefix}
      {imp.source_label}
    </span>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer__row">
        <ImportLabel />
        <span className="footer__sep" aria-hidden="true">
          ·
        </span>
        <span>Municipal Elections Act — election use only, access is logged</span>
      </div>
      <BuildLine />
    </footer>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {open ? (
        <>
          <line x1="5" y1="5" x2="19" y2="19" />
          <line x1="19" y1="5" x2="5" y2="19" />
        </>
      ) : (
        <>
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </>
      )}
    </svg>
  );
}
