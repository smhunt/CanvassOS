import { useState } from 'react';
import { errorMessage } from '../api/client';
import { useTurfs, useUpdateTurf } from '../api/hooks';
import type { TurfSummary } from '../api/types';
import { EmptyState, ErrorBox, LoadingRows, n } from '../components/ui';
import { AssignDialog } from '../turfs/AssignDialog';
import { CreateTurfDialog } from '../turfs/CreateTurfDialog';
import { RenameDialog } from '../turfs/RenameDialog';
import { TurfCard } from '../turfs/TurfCard';
import '../turfs/turfs.css';

type DialogState = { kind: 'create' } | { kind: 'assign'; turf: TurfSummary } | { kind: 'rename'; turf: TurfSummary } | null;

/**
 * Organiser turf builder: cut the municipality into turfs and hand them to volunteers.
 * Aggregates only (street, door and voter counts) — no voter names or mailing addresses belong on
 * this screen, and none of the endpoints it uses return them.
 */
export function TurfsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [rowError, setRowError] = useState<{ id: string; msg: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const turfs = useTurfs(showArchived);
  const update = useUpdateTurf();

  const all = turfs.data ?? [];
  const live = all.filter((t) => !t.archived);
  const archived = all.filter((t) => t.archived);

  const doors = live.reduce((sum, t) => sum + t.n_households, 0);
  const contacted = live.reduce((sum, t) => sum + t.contacted, 0);
  const unassigned = live.filter((t) => t.assignees.length === 0).length;

  const onToggleArchive = (t: TurfSummary) => {
    setRowError(null);
    setBusyId(t.id);
    update.mutate(
      { id: t.id, archived: !t.archived },
      {
        onError: (err) => setRowError({ id: t.id, msg: errorMessage(err) }),
        onSettled: () => setBusyId(null),
      },
    );
  };

  const card = (t: TurfSummary) => (
    <TurfCard
      key={t.id}
      turf={t}
      busy={busyId === t.id}
      error={rowError?.id === t.id ? rowError.msg : null}
      onAssign={() => setDialog({ kind: 'assign', turf: t })}
      onRename={() => setDialog({ kind: 'rename', turf: t })}
      onToggleArchive={() => onToggleArchive(t)}
    />
  );

  return (
    <div className="page">
      <header className="page__head">
        <h1>Turfs</h1>
        <p className="muted">
          A turf is a bundle of streets one person can walk. Cut them here, then assign each one to a volunteer — they
          see only the doors in the turfs assigned to them.
        </p>
      </header>

      <div className="turfs__toolbar">
        <button type="button" className="btn btn--primary" onClick={() => setDialog({ kind: 'create' })}>
          New turf
        </button>
        <label className="check turfs__archived-toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          <span className="check__label">Show archived</span>
        </label>
      </div>

      {live.length > 0 && (
        <div className="tiles">
          <div className="tile">
            <span className="tile__value">{n(live.length)}</span>
            <span className="tile__label">Active turfs</span>
          </div>
          <div className="tile">
            <span className="tile__value">{n(doors)}</span>
            <span className="tile__label">Doors in turfs</span>
          </div>
          <div className="tile">
            <span className="tile__value">{n(contacted)}</span>
            <span className="tile__label">Doors contacted</span>
          </div>
          <div className="tile">
            <span className="tile__value">{n(unassigned)}</span>
            <span className="tile__label">Waiting on a volunteer</span>
          </div>
        </div>
      )}

      {turfs.isPending && <LoadingRows rows={4} />}
      {turfs.isError && <ErrorBox error={turfs.error} onRetry={() => void turfs.refetch()} />}
      {turfs.data && live.length === 0 && (
        <EmptyState title="No turfs yet">
          Start with one street bundle of roughly 100 doors — “New turf” totals them up as you pick.
        </EmptyState>
      )}

      {live.length > 0 && <ul className="turfs">{live.map(card)}</ul>}

      {showArchived && (
        <section aria-labelledby="archived-h">
          <h2 id="archived-h">Archived</h2>
          {archived.length === 0 ? (
            <p className="muted small">Nothing archived.</p>
          ) : (
            <ul className="turfs">{archived.map(card)}</ul>
          )}
        </section>
      )}

      {/* A fresh turf is no use unassigned, so hand straight over to the assign step. */}
      {dialog?.kind === 'create' && (
        <CreateTurfDialog onClose={() => setDialog(null)} onCreated={(turf) => setDialog({ kind: 'assign', turf })} />
      )}
      {dialog?.kind === 'assign' && <AssignDialog turf={dialog.turf} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename' && <RenameDialog turf={dialog.turf} onClose={() => setDialog(null)} />}
    </div>
  );
}
