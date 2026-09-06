import { Link } from 'react-router-dom';
import { useMyAssignments } from '../api/hooks';
import { isOrganizer } from '../auth';
import '../canvass/canvass.css';
import { Progress, StatusChip } from '../canvass/Progress';
import { fmtDueDate } from '../canvass/status';
import { useUser } from '../components/Shell';
import { EmptyState, ErrorBox, LoadingRows, n, wardLabel } from '../components/ui';

/** The volunteer's landing page: the turfs assigned to them, each a doorway into the door screen. */
export function CanvassPage() {
  const user = useUser();
  const mine = useMyAssignments();
  const assignments = mine.data ?? [];

  return (
    <div className="page page--narrow">
      <header className="page__head">
        <h1>Canvass</h1>
        <p className="muted">Your turfs. Open one to walk the doors in order.</p>
      </header>

      {mine.isPending && (
        <div className="card">
          <LoadingRows rows={3} />
        </div>
      )}
      {mine.isError && <ErrorBox title="Could not load your turfs" error={mine.error} onRetry={() => void mine.refetch()} />}

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
