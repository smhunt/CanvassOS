import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../api/client';
import { useDoors, useMyAssignments, useOfflineSync } from '../api/hooks';
import type { ContactResult, Door } from '../api/types';
import '../canvass/canvass.css';
import { coordsOf, type Coords } from '../canvass/directions';
import { DoorRow } from '../canvass/DoorRow';
import { DoorSheet } from '../canvass/DoorSheet';
import { formatDistance, orderByDistance, readDoorOrder, useNearMe, writeDoorOrder, type DoorOrder } from '../canvass/nearMe';
import { Progress } from '../canvass/Progress';
import { agoLabel, latestResult } from '../canvass/status';
import { SyncStatus } from '../canvass/SyncStatus';
import { TurfDrawer } from '../canvass/TurfDrawer';
import { writeLastTurf } from '../canvass/lastTurf';
import { useIsTablet } from '../canvass/useBreakpoint';
import { useOutbox, useQueuedResults } from '../offline/useOutbox';
import { EmptyState, ErrorBox, FullPageSpinner, Spinner, n, wardLabel } from '../components/ui';

// MapLibre is ~1 MB and volunteers are on rural data, so the overview is fetched only when the
// volunteer actually asks for a map — never as a side effect of opening the door list.
const TurfMap = lazy(() => import('../canvass/TurfMap'));

type Filter = 'all' | 'todo';
type View = 'list' | 'map';

const NO_DISTANCES = new Map<string, number>();

/** The field screen: the doors of one turf in walking order, and the door card over them. */
export function DoorScreen() {
  const { turfId } = useParams<{ turfId: string }>();
  const doorsQ = useDoors(turfId);
  const outbox = useOutbox();
  // Results that are recorded but still only on this phone. Merged in below so a volunteer who
  // reloads the app in a dead spot still sees which doors they have already knocked.
  const queued = useQueuedResults(outbox);
  useOfflineSync();
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<View>('list');
  // Walking order is the default and the choice is remembered, because a volunteer who prefers one
  // prefers it at every door, not once per app launch.
  const [order, setOrderState] = useState<DoorOrder>(readDoorOrder);
  const near = useNearMe(order === 'near');
  const [openId, setOpenId] = useState<string | null>(null);
  // Width, not device. An iPad in Split View is 320-678px wide and is a phone as far as this screen
  // is concerned; the same iPad full-screen is 744-1366 and has room for both halves at once.
  const tablet = useIsTablet();
  // Results recorded this session, applied on top of the server list so the row and the auto-advance
  // update the moment a door is saved rather than waiting for the refetch to land on a weak signal.
  const [recorded, setRecorded] = useState<Record<string, ContactResult>>({});
  // Where the volunteer was standing when the sheet last advanced, so the new door can say how far
  // away it is. Null whenever a door is opened by hand — then there is no walk to describe.
  const [from, setFrom] = useState<Coords | null>(null);
  const restoreFocus = useRef<string | null>(null);
  const [turfsOpen, setTurfsOpen] = useState(false);
  // Already in the query cache from the turf list, so opening the drawer costs no round trip.
  const mine = useMyAssignments();

  // Remember where this phone was working, so /canvass reopens it next time. Written as soon as the
  // doors are in hand rather than on leaving — a volunteer's app is far more likely to be killed by
  // the OS mid-shift than closed deliberately — but never before, or a turf that 403s or times out
  // would be remembered and /canvass would reopen the failure every time.
  useEffect(() => {
    if (turfId && doorsQ.data) writeLastTurf(turfId);
  }, [turfId, doorsQ.data]);

  const serverDoors = useMemo(() => doorsQ.data?.doors ?? [], [doorsQ.data]);
  // Ordering the array itself, not just the rendering, so prev/next and the auto-advance send the
  // volunteer to the nearest unknocked door rather than back along the street.
  const { doors, distances } = useMemo(
    () => (order === 'near' ? orderByDistance(serverDoors, near.at) : { doors: serverDoors, distances: NO_DISTANCES }),
    [order, serverDoors, near.at],
  );

  // The session's own results win over the queue's, which win over the server's.
  const known = useMemo(() => ({ ...queued, ...recorded }), [queued, recorded]);
  const resultFor = useCallback(
    (d: Door, map: Record<string, ContactResult> = known): ContactResult | null => latestResult(d, map),
    [known],
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

  function setOrder(next: DoorOrder) {
    setOrderState(next);
    writeDoorOrder(next);
  }

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
    setRecorded((r) => ({ ...r, [openDoor.household_id]: result }));
    const next = { ...known, [openDoor.household_id]: result };
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
          {/* `list=1`: without it /canvass would auto-open the turf that just failed, and the only
              way out of a broken turf would loop back into it. */}
          <Link to="/canvass?list=1">Back to my turfs</Link>
        </p>
      </div>
    );
  }

  const turf = doorsQ.data.turf;
  const todo = doors.length - done;
  const cached = doorsQ.data.from_cache === true;

  const door =
    openDoor && turfId ? (
      <DoorSheet
        key={openDoor.household_id}
        door={openDoor}
        turfId={turfId}
        index={openIndex + 1}
        total={doors.length}
        from={from}
        variant={tablet ? 'pane' : 'sheet'}
        onClose={close}
        onRecorded={handleRecorded}
        onPrev={openIndex > 0 ? () => open(doors[openIndex - 1]!.household_id) : null}
        onNext={openIndex < doors.length - 1 ? () => open(doors[openIndex + 1]!.household_id) : null}
      />
    ) : null;
  // Two panes side by side from the tablet stop up; one column with the door over it below it.
  const pageClass = [
    'page',
    // The 640px column is the right measure for a single list. Split, the grid sets its own widths.
    tablet ? 'cv-page--split' : 'page--narrow',
    'cv-page',
    // Only the sheet covers the header. Beside a pane the header is the one thing telling the
    // volunteer which turf they are in, so it stays.
    !tablet && openDoor ? 'cv-page--sheet' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={pageClass}>
      <header className="cv-head">
        <div className="cv-head__row">
          {/* Opens the turf drawer rather than going back to the list. Going "back" would land on
              /canvass, which now reopens this very turf — so the list is reached from inside the
              drawer instead, where it cannot be a loop. */}
          <button
            type="button"
            className="cv-turfbtn"
            onClick={() => setTurfsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={turfsOpen}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="14" y2="17" />
            </svg>
            Turfs
          </button>
          <h1 className="cv-head__name">{turf.name}</h1>
          {turf.ward && <span className="cv-head__ward muted small nowrap">{wardLabel(turf.ward)}</span>}
          <SyncStatus />
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
          {view === 'list' && (
            <button
              type="button"
              className="cv-seg__btn cv-viewbtn"
              aria-pressed={order === 'near'}
              onClick={() => setOrder(order === 'near' ? 'walk' : 'near')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="6" />
                <line x1="12" y1="1" x2="12" y2="4" />
                <line x1="12" y1="20" x2="12" y2="23" />
                <line x1="1" y1="12" x2="4" y2="12" />
                <line x1="20" y1="12" x2="23" y2="12" />
              </svg>
              Near me
            </button>
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

      {/* "Where am I in the turf": notes, the map and the list. Its own element so that at tablet
          width it can become the master column and scroll independently of the open door. */}
      <div className="cv-master">
        {cached && (
          // The volunteer has to know they are looking at a copy, and that recording into it is
          // still safe — otherwise a stale list reads as a broken app and the shift stops.
          <p className="cv-note cv-note--offline" role="status">
            <strong>Saved copy</strong> — this turf was stored on your phone {agoLabel(doorsQ.data.cached_at ?? null)}. Doors
            you record now are queued and go up as soon as there is signal.
          </p>
        )}

        {view === 'list' && order === 'near' && near.failure && (
          <p className="cv-note cv-note--warn" role="status">
            {near.failure.message}
          </p>
        )}
        {view === 'list' && order === 'near' && !near.failure && !near.at && (
          <p className="cv-note muted" role="status">
            <Spinner size={16} /> Finding you — the doors stay in walking order until the phone has a position.
          </p>
        )}

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
            <TurfMap doors={doors} recorded={known} selectedId={openId} onSelect={open} />
          </Suspense>
        )}

        {view === 'list' && doors.length > 0 && visible.length === 0 && (
          <EmptyState title="Every door here is done">
            Nice work. Switch to “All doors” to look one up again.
          </EmptyState>
        )}

        {view === 'list' && visible.length > 0 && (
          <ul className="cv-doors">
            {visible.map((d) => {
              const m = distances.get(d.household_id);
              return (
                <DoorRow
                  key={d.household_id}
                  door={d}
                  result={resultFor(d)}
                  distance={m === undefined ? null : formatDistance(m)}
                  onOpen={() => open(d.household_id)}
                />
              );
            })}
          </ul>
        )}
      </div>

      {/* Split, the detail half is always there — an empty pane rather than a pane that appears and
          shoves the list sideways the first time a door is tapped. */}
      {tablet ? (
        <div className="cv-detail">
          {door}
          {!door && (
            <div className="card cv-detail__empty">
              <EmptyState title="No door open">
                Pick a door {view === 'map' ? 'on the map' : 'from the list'} to see who is on the list there and record
                what happened.
              </EmptyState>
            </div>
          )}
        </div>
      ) : (
        door
      )}

      <TurfDrawer
        open={turfsOpen}
        onClose={() => setTurfsOpen(false)}
        assignments={mine.data ?? []}
        currentTurfId={turfId}
        loading={mine.isPending}
      />
    </div>
  );
}
