import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMyAssignments, useOfflineSync } from '../api/hooks';
import { isOrganizer } from '../auth';
import '../canvass/canvass.css';
import { Progress, StatusChip } from '../canvass/Progress';
import { agoLabel, fmtDueDate } from '../canvass/status';
import { SyncStatus } from '../canvass/SyncStatus';
import { readLastTurf } from '../canvass/lastTurf';
import { cachedTurfSummaries } from '../offline/turfCache';
import { useUser } from '../components/Shell';
import { EmptyState, ErrorBox, LoadingCards, n, wardLabel } from '../components/ui';

/** The volunteer's landing page: the turfs assigned to them, each a doorway into the door screen. */
export function CanvassPage() {
  const user = useUser();
  const mine = useMyAssignments();
  useOfflineSync();
  const assignments = mine.data ?? [];
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // `?list=1` is how the drawer's "All my turfs" gets here without being bounced straight back out.
  const forceList = params.get('list') === '1';
  // Once per mount. Without this an auto-open would fire again on every refetch of the assignment
  // list, dragging a volunteer who deliberately came back to the list into a turf mid-scroll.
  const autoOpened = useRef(false);

  /**
   * Open the obvious turf instead of making the volunteer pick from a list of one.
   *
   * Two cases, in order: the turf this phone was last working in, and — failing that — the only
   * turf they have. The remembered id is checked against the assignments the server just returned,
   * so a turf that has been taken off someone cannot keep reopening, and `replace` keeps Back
   * pointing at wherever they came from rather than at a page that would redirect again.
   */
  useEffect(() => {
    if (forceList || autoOpened.current || !mine.data) return;
    const last = readLastTurf();
    const target =
      (last && assignments.some((a) => a.turf.id === last) ? last : null) ??
      (assignments.length === 1 ? (assignments[0]?.turf.id ?? null) : null);
    if (!target) return;
    autoOpened.current = true;
    navigate(`/canvass/${target}`, { replace: true });
  }, [forceList, mine.data, assignments, navigate]);
  // The assignment list itself is not cached — it is a small, fast call and caching it would put
  // more on the phone for no field benefit. But when it fails there has to be a way through to the
  // doors already saved here, or an offline volunteer is stranded one tap from their turf.
  const [saved, setSaved] = useState<{ turf_id: string; name: string; n_doors: number; cached_at: number }[]>([]);
  useEffect(() => {
    if (!mine.isError) return;
    void cachedTurfSummaries().then(setSaved);
  }, [mine.isError]);

  return (
    <div className="page page--narrow cv-turfs-page">
      <header className="page__head cv-page__head">
        <div>
          <h1>Canvass</h1>
          <p className="muted">Your turfs. Open one to walk the doors in order.</p>
        </div>
        <SyncStatus />
      </header>

      {mine.isPending && <LoadingCards count={3} label="Loading your turfs…" />}
      {mine.isError && <ErrorBox title="Could not load your turfs" error={mine.error} onRetry={() => void mine.refetch()} />}

      {mine.isError && saved.length > 0 && (
        <section aria-labelledby="cv-saved-h">
          <h2 id="cv-saved-h" className="sheet__h3">
            Saved on this phone
          </h2>
          <ul className="cv-turfs">
            {saved.map((t) => (
              <li key={t.turf_id}>
                <Link to={`/canvass/${t.turf_id}`} className="cv-turf">
                  <div className="cv-turf__top">
                    <span className="cv-turf__name">{t.name}</span>
                  </div>
                  <div className="cv-turf__meta">
                    <span>{n(t.n_doors)} doors</span>
                    <span>saved {agoLabel(t.cached_at)}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mine.data && assignments.length === 0 && (
        <div className="card">
          <EmptyState title="No turfs assigned yet">
            <p>An organiser assigns you a turf and it shows up here — no need to check back manually, just reload this page.</p>
            {isOrganizer(user) && (
              <p>
                <Link to="/turfs">Build a turf</Link> and assign it to yourself or a volunteer.
              </p>
            )}
          </EmptyState>
        </div>
      )}

      {assignments.length > 0 && (
        <ul className="cv-turfs">
          {assignments.map((a) => (
            <li key={a.id}>
              <Link to={`/canvass/${a.turf.id}`} className="cv-turf">
                <div className="cv-turf__top">
                  <span className="cv-turf__name">{a.turf.name}</span>
                  <StatusChip status={a.status} />
                </div>
                <div className="cv-turf__meta">
                  {a.turf.ward && <span>{wardLabel(a.turf.ward)}</span>}
                  <span>{n(a.n_households)} doors</span>
                  {a.due_date && <span className="cv-turf__due">Due {fmtDueDate(a.due_date)}</span>}
                </div>
                <Progress done={a.contacted} total={a.n_households} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
