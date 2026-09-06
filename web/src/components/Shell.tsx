import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { useMeta } from '../api/hooks';
import type { User } from '../api/types';
import { isAdmin, isOrganizer } from '../auth';
import { RoleChip } from './ui';

export function useUser(): User {
  return useOutletContext<User>();
}

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="MC Canvass">
      <span className="wordmark__mc">MC</span>
      <span className="wordmark__rest">Canvass</span>
    </span>
  );
}

export function Shell() {
  const user = useUser();
  const loc = useLocation();
  const isMap = loc.pathname.startsWith('/map');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the phone menu on navigation and on outside click / Escape.
  useEffect(() => setMenuOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const links = [
    { to: '/map', label: 'Map', show: true },
    { to: '/canvass', label: 'Canvass', show: true },
    { to: '/turfs', label: 'Turfs', show: isOrganizer(user) },
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
        <div className="topbar__user">
          <span className="topbar__name" title={user.email}>
            {user.name}
          </span>
          <RoleChip role={user.role} />
        </div>
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
                <NavLink key={l.to} to={l.to} role="menuitem" className={({ isActive }) => `menu__item${isActive ? ' menu__item--active' : ''}`}>
                  {l.label}
                </NavLink>
              ))}
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
      <ImportLabel />
      <span className="footer__sep" aria-hidden="true">
        ·
      </span>
      <span>Municipal Elections Act — election use only, access is logged</span>
    </footer>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
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
