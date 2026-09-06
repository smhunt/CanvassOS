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
// The door screen is what volunteers open in the field; the turf builder is organiser-only.
const CanvassPage = lazy(() => import('./pages/CanvassPage').then((m) => ({ default: m.CanvassPage })));
const DoorScreen = lazy(() => import('./pages/DoorScreen').then((m) => ({ default: m.DoorScreen })));
const TurfsPage = lazy(() => import('./pages/TurfsPage').then((m) => ({ default: m.TurfsPage })));

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
            path="/canvass"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading your turfs…" />}>
                <CanvassPage />
              </Suspense>
            }
          />
          <Route
            path="/canvass/:turfId"
            element={
              <Suspense fallback={<FullPageSpinner label="Loading the doors…" />}>
                <DoorScreen />
              </Suspense>
            }
          />
          <Route
            path="/turfs"
            element={
              <RequireRole min="organizer">
                <Suspense fallback={<FullPageSpinner label="Loading turfs…" />}>
                  <TurfsPage />
                </Suspense>
              </RequireRole>
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
