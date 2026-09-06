import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDoors } from '../api/hooks';
import type { ContactResult, Door } from '../api/types';
import '../canvass/canvass.css';
import { DoorRow } from '../canvass/DoorRow';
import { DoorSheet } from '../canvass/DoorSheet';
import { Progress } from '../canvass/Progress';
import { EmptyState, ErrorBox, FullPageSpinner, n, wardLabel } from '../components/ui';

type Filter = 'all' | 'todo';

/** The field screen: the doors of one turf in walking order, and the door card over them. */
export function DoorScreen() {
  const { turfId } = useParams<{ turfId: string }>();
  const doorsQ = useDoors(turfId);
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  // Results recorded this session, applied on top of the server list so the row and the auto-advance
  // update the moment a door is saved rather than waiting for the refetch to land on a weak signal.
  const [recorded, setRecorded] = useState<Record<string, ContactResult>>({});
  const restoreFocus = useRef<string | null>(null);

  const doors = doorsQ.data?.doors ?? [];
  const resultFor = useCallback(
    (d: Door, map: Record<string, ContactResult> = recorded): ContactResult | null => map[d.household_id] ?? d.last_result,
    [recorded],
  );

  const done = doors.filter((d) => resultFor(d) !== null).length;
  const visible = filter === 'todo' ? doors.filter((d) => resultFor(d) === null) : doors;
  const openIndex = doors.findIndex((d) => d.household_id === openId);
  const openDoor = openIndex >= 0 ? doors[openIndex] : undefined;

  // Returning to the list should put the cursor back on the door that was open — or, when that row
  // has just been filtered out of the list, on the top of the list rather than nowhere.
  useEffect(() => {
    if (openId !== null) return;
    const id = restoreFocus.current;
    restoreFocus.current = null;
    if (!id) return;
    const row = document.querySelector<HTMLButtonElement>(`[data-door="${CSS.escape(id)}"]`);
    (row ?? document.querySelector<HTMLButtonElement>('.cv-door, .cv-seg__btn'))?.focus();
  }, [openId]);

  // Auto-advance can jump far down the list; keep the new door visible behind the sheet.
  useEffect(() => {
    if (!openId) return;
    document.querySelector(`[data-door="${CSS.escape(openId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [openId]);

  function open(id: string) {
    restoreFocus.current = id;
    setOpenId(id);
  }

  function close() {
    setOpenId(null);
  }

  /** After a save, go straight to the next door with nothing recorded — that is what makes a canvass fast. */
  function handleRecorded(result: ContactResult) {
    if (!openDoor) return;
    const next = { ...recorded, [openDoor.household_id]: result };
    setRecorded(next);
    const after = doors.slice(openIndex + 1).find((d) => resultFor(d, next) === null);
    const wrapped = after ?? doors.slice(0, openIndex).find((d) => resultFor(d, next) === null);
    restoreFocus.current = wrapped ? null : openDoor.household_id;
    setOpenId(wrapped?.household_id ?? null);
  }

  if (doorsQ.isPending) return <FullPageSpinner label="Loading the doors…" />;

  if (doorsQ.isError) {
    const forbidden = isApiError(doorsQ.error, 403) || isApiError(doorsQ.error, 404);
    return (
      <div className="page page--narrow">
        <ErrorBox
          title={forbidden ? 'This turf is not assigned to you' : 'Could not load this turf'}
          error={doorsQ.error}
          onRetry={forbidden ? undefined : () => void doorsQ.refetch()}
        />
        <p>
          <Link to="/canvass">Back to my turfs</Link>
        </p>
      </div>
    );
  }

  const turf = doorsQ.data.turf;
  const todo = doors.length - done;

  return (
    <div className="page page--narrow cv-page">
      <header className="cv-head">
        <div className="cv-head__row">
          <Link to="/canvass" className="cv-back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <polyline points="15 5 8 12 15 19" />
            </svg>
            Turfs
          </Link>
          <h1 className="cv-head__name">{turf.name}</h1>
          {turf.ward && <span className="muted small nowrap">{wardLabel(turf.ward)}</span>}
        </div>
        <Progress done={done} total={doors.length} />
        <div className="cv-seg" role="group" aria-label="Which doors to show">
          <button type="button" className="cv-seg__btn" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All doors
          </button>
          <button type="button" className="cv-seg__btn" aria-pressed={filter === 'todo'} onClick={() => setFilter('todo')}>
            Not yet knocked ({n(todo)})
          </button>
        </div>
      </header>

      {doors.length === 0 && (
        <EmptyState title="This turf has no doors">
          An organiser can add streets to it on the Turfs page.
        </EmptyState>
      )}
      {doors.length > 0 && visible.length === 0 && (
        <EmptyState title="Every door here is done">
          Nice work. Switch to “All doors” to look one up again.
        </EmptyState>
      )}

      {visible.length > 0 && (
        <ul className="cv-doors">
          {visible.map((d) => (
            <DoorRow key={d.household_id} door={d} result={resultFor(d)} onOpen={() => open(d.household_id)} />
          ))}
        </ul>
      )}

      {openDoor && turfId && (
        <DoorSheet
          key={openDoor.household_id}
          door={openDoor}
          turfId={turfId}
          index={openIndex + 1}
          total={doors.length}
          onClose={close}
          onRecorded={handleRecorded}
          onPrev={openIndex > 0 ? () => open(doors[openIndex - 1]!.household_id) : null}
          onNext={openIndex < doors.length - 1 ? () => open(doors[openIndex + 1]!.household_id) : null}
        />
      )}
    </div>
  );
}
