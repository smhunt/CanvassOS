import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDoors } from '../api/hooks';
import type { ContactResult, Door } from '../api/types';
import '../canvass/canvass.css';
import { coordsOf, type Coords } from '../canvass/directions';
import { DoorRow } from '../canvass/DoorRow';
import { DoorSheet } from '../canvass/DoorSheet';
import { Progress } from '../canvass/Progress';
import { latestResult } from '../canvass/status';
import { EmptyState, ErrorBox, FullPageSpinner, Spinner, n, wardLabel } from '../components/ui';

// MapLibre is ~1 MB and volunteers are on rural data, so the overview is fetched only when the
// volunteer actually asks for a map — never as a side effect of opening the door list.
const TurfMap = lazy(() => import('../canvass/TurfMap'));

type Filter = 'all' | 'todo';
type View = 'list' | 'map';

/** The field screen: the doors of one turf in walking order, and the door card over them. */
export function DoorScreen() {
  const { turfId } = useParams<{ turfId: string }>();
  const doorsQ = useDoors(turfId);
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>('list');
  const [openId, setOpenId] = useState<string | null>(null);
  // Results recorded this session, applied on top of the server list so the row and the auto-advance
  // update the moment a door is saved rather than waiting for the refetch to land on a weak signal.
  const [recorded, setRecorded] = useState<Record<string, ContactResult>>({});
  // Where the volunteer was standing when the sheet last advanced, so the new door can say how far
  // away it is. Null whenever a door is opened by hand — then there is no walk to describe.
  const [from, setFrom] = useState<Coords | null>(null);
  const restoreFocus = useRef<string | null>(null);

  const doors = doorsQ.data?.doors ?? [];
  const resultFor = useCallback(
    (d: Door, map: Record<string, ContactResult> = recorded): ContactResult | null => latestResult(d, map),
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
    setFrom(null);
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
    setFrom(coordsOf(openDoor));
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
    // While the sheet is open the page behind it is inert backdrop: the modifier stops the sticky
    // header pinning itself into the strip the sheet does not cover, where it was being sliced.
    <div className={`page page--narrow cv-page${openDoor ? ' cv-page--sheet' : ''}`}>
      <header className="cv-head">
        <div className="cv-head__row">
          <Link to="/canvass" className="cv-back">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <polyline points="15 5 8 12 15 19" />
            </svg>
            Turfs
          </Link>
          <h1 className="cv-head__name">{turf.name}</h1>
          {turf.ward && <span className="cv-head__ward muted small nowrap">{wardLabel(turf.ward)}</span>}
        </div>
        <Progress done={done} total={doors.length} />
        <div className="cv-head__controls">
          {/* The filter is a list control, so it goes away with the list rather than sitting there
              doing nothing over the map, which shows the whole turf by design. */}
          {view === 'list' && (
            <div className="cv-seg" role="group" aria-label="Which doors to show">
              <button type="button" className="cv-seg__btn" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                All doors
              </button>
              <button type="button" className="cv-seg__btn" aria-pressed={filter === 'todo'} onClick={() => setFilter('todo')}>
                Not yet knocked ({n(todo)})
              </button>
            </div>
          )}
          <button
            type="button"
            className="cv-seg__btn cv-viewbtn"
            aria-pressed={view === 'map'}
            onClick={() => setView((v) => (v === 'map' ? 'list' : 'map'))}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="2 6 9 3 15 6 22 3 22 18 15 21 9 18 2 21" />
              <line x1="9" y1="3" x2="9" y2="18" />
              <line x1="15" y1="6" x2="15" y2="21" />
            </svg>
            Map
          </button>
        </div>
      </header>

      {doors.length === 0 && (
        <EmptyState title="This turf has no doors">
          An organiser can add streets to it on the Turfs page.
        </EmptyState>
      )}

      {doors.length > 0 && view === 'map' && (
        <Suspense
          fallback={
            <p className="cv-map__none muted">
              <Spinner size={18} /> Loading the map…
            </p>
          }
        >
          <TurfMap doors={doors} recorded={recorded} selectedId={openId} onSelect={open} />
        </Suspense>
      )}

      {view === 'list' && doors.length > 0 && visible.length === 0 && (
        <EmptyState title="Every door here is done">
          Nice work. Switch to “All doors” to look one up again.
        </EmptyState>
      )}

      {view === 'list' && visible.length > 0 && (
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
          from={from}
          onClose={close}
          onRecorded={handleRecorded}
          onPrev={openIndex > 0 ? () => open(doors[openIndex - 1]!.household_id) : null}
          onNext={openIndex < doors.length - 1 ? () => open(doors[openIndex + 1]!.household_id) : null}
        />
      )}
    </div>
  );
}
