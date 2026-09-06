import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { RedirectIfSignedIn, RequireAuth, RequireRole } from './auth';
import { Shell } from './components/Shell';
import { FullPageSpinner } from './components/ui';
import { AccountPage } from './pages/AccountPage';
import { AuditPage } from './pages/AuditPage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { StatsPage } from './pages/StatsPage';
import { UsersPage } from './pages/UsersPage';

// MapLibre is ~1 MB; only fetch it when the map is actually opened.
const MapPage = lazy(() => import('./pages/MapPage').then((m) => ({ default: m.MapPage })));

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfSignedIn>
            <LoginPage />
          </RedirectIfSignedIn>
        }
      />
      <Route path="/invite/:token" element={<InvitePage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/map" replace />} />
          <Route
            path="/map"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading the map…" />}>
                <MapPage />
              </Suspense>
            }
          />
          <Route
            path="/stats"
            element={
              <RequireRole min="organizer">
                <StatsPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireRole min="admin">
                <UsersPage />
              </RequireRole>
            }
          />
          <Route
            path="/admin/audit"
            element={
              <RequireRole min="admin">
                <AuditPage />
              </RequireRole>
            }
          />
          <Route path="/account" element={<AccountPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
