import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useMe } from './api/hooks';
import type { Role, User } from './api/types';
import { ErrorBox, FullPageSpinner } from './components/ui';

const RANK: Record<Role, number> = { volunteer: 1, organizer: 2, admin: 3 };

export function roleAtLeast(role: Role | undefined, min: Role): boolean {
  return !!role && RANK[role] >= RANK[min];
}

export function isOrganizer(user: User | null | undefined): boolean {
  return roleAtLeast(user?.role, 'organizer');
}

export function isAdmin(user: User | null | undefined): boolean {
  return roleAtLeast(user?.role, 'admin');
}

/** Wraps every signed-in route: loading → spinner, signed out → /login (remembering where we were). */
export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  if (me.isPending) return <FullPageSpinner label="Checking your session…" />;
  if (me.isError) {
    return (
      <div className="page page--narrow">
        <ErrorBox title="Could not reach the server" error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Outlet context={me.data} />;
}

/** Route-level role gate. Lower roles are sent back to the map rather than shown a 403 page. */
export function RequireRole({ min, children }: { min: Role; children: ReactNode }) {
  const me = useMe();
  if (!roleAtLeast(me.data?.role, min)) return <Navigate to="/map" replace />;
  return <>{children}</>;
}

/** Signed-in users landing on /login or /invite go to the map. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <FullPageSpinner label="Loading…" />;
  if (me.data) return <Navigate to="/map" replace />;
  return <>{children}</>;
}
