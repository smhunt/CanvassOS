import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useCreateTurf } from '../api/hooks';
import type { PointsCollection } from '../api/types';
import { ErrorBox, Spinner, n, wardLabel } from '../components/ui';
import './draw.css';
import { closeRing, countInside, type Position } from './drawGeometry';
import { addDrawLayers, removeDrawLayers, setDrawData } from './drawLayers';

interface Props {
  map: MapLibreMap;
  /** Every household point already in the browser — the live count is computed from these. */
  points: PointsCollection | undefined;
  wards: string[];
  /** Point filters narrow `points`, so the preview would under-count without saying so. */
  filtersActive: boolean;
  /** Lets the page suspend household selection while the organiser is drawing. */
  onActiveChange: (active: boolean) => void;
}

/** Finger-sized: closing the ring by tapping its first corner has to work on a tablet, not just a mouse. */
const CLOSE_HIT_PX = 20;

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

/**
 * Organizer-only polygon turf drawer. Click/tap drops corners, the ring and its door count update
 * live, and finishing POSTs the closed ring to `POST /api/turfs`, which re-runs the same
 * point-in-polygon test server-side to materialise the turf's doors.
 */
export function DrawPolygon({ map, points, wards, filtersActive, onActiveChange }: Props) {
  const [active, setActive] = useState(false);
  const [everActive, setEverActive] = useState(false);
  const [ring, setRing] = useState<Position[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [ward, setWard] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const createTurf = useCreateTurf();
  const nameRef = useRef<HTMLInputElement>(null);

  // The map's own click handler is registered once, so it reads the current ring through refs.
  // `createTurf` is a fresh object every render; going through a ref keeps reset/cancel/start
  // stable, which in turn stops the keyboard listener being torn down and re-added every render.
  const ringRef = useRef(ring);
  const namingRef = useRef(naming);
  const mutationRef = useRef(createTurf);
  ringRef.current = ring;
  namingRef.current = naming;
  mutationRef.current = createTurf;

  const inside = useMemo(() => countInside(points?.features ?? [], ring), [points, ring]);

  const undo = useCallback(() => setRing((r) => r.slice(0, -1)), []);

  const reset = useCallback(() => {
    setRing([]);
    setNaming(false);
    setName('');
    setWard('');
    mutationRef.current.reset();
  }, []);

  const cancel = useCallback(() => {
    setActive(false);
    reset();
  }, [reset]);

  const start = useCallback(() => {
    setActive(true);
    setEverActive(true);
    setDone(null);
    reset();
  }, [reset]);

  // ---- layers live for as long as the drawer is mounted, not just while drawing
  useEffect(() => {
    addDrawLayers(map);
    return () => removeDrawLayers(map);
  }, [map]);

  useEffect(() => {
    setDrawData(map, active ? ring : []);
  }, [map, active, ring]);

  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  // ---- dropping corners
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MapMouseEvent) => {
      if (namingRef.current) return;
      const pts = ringRef.current;
      const first = pts[0];
      if (first && pts.length >= 3) {
        const p = map.project(first);
        if ((p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2 <= CLOSE_HIT_PX ** 2) {
          setNaming(true);
          return;
        }
      }
      // wrap(): keeps longitudes inside ±180 after a pan across the antimeridian, which the API's
      // schema requires. MapLibre only fires 'click' for a real click, so a drag-pan never lands here.
      const { lng, lat } = e.lngLat.wrap();
      setRing((r) => [...r, [lng, lat]]);
    };
    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [map, active]);

  // ---- two quick corners must not zoom the map
  useEffect(() => {
    if (!active) return;
    const wasEnabled = map.doubleClickZoom.isEnabled();
    map.doubleClickZoom.disable();
    return () => {
      if (wasEnabled) map.doubleClickZoom.enable();
    };
  }, [map, active]);

  // ---- keyboard: the mode has to be exitable without a pointer
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape in the save dialog goes back to the drawing; only Escape on the map bins it.
        if (namingRef.current) setNaming(false);
        else cancel();
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !namingRef.current && !isTyping(e.target)) {
        e.preventDefault();
        undo();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, cancel, undo]);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  // ---- the confirmation clears itself; the organiser is looking at the map, not at a toast
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(null), 12_000);
    return () => window.clearTimeout(t);
  }, [done]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || ring.length < 3) return;
    createTurf.mutate(
      { name: trimmed, ward: ward || null, polygon: { type: 'Polygon', coordinates: [closeRing(ring)] } },
      {
        onSuccess: (res) => {
          // The server's count, not the preview's: filters or a stale points cache could differ.
          setDone(`Turf “${res.turf.name}” created — ${n(res.turf.n_households)} doors, ${n(res.turf.n_voters)} voters.`);
          setActive(false);
          reset();
        },
        // On failure the ring, the name and the ward are all left alone: the work is not thrown away.
      },
    );
  };

  const hint =
    ring.length === 0
      ? 'Tap the map to drop the first corner.'
      : ring.length < 3
        ? 'Keep tapping to add corners.'
        : 'Tap the first corner again, or press Finish, to close the shape.';

  const announcement = active
    ? `Draw mode on, ${ring.length} ${ring.length === 1 ? 'point' : 'points'}, ${inside.doors} doors inside`
    : (done ?? (everActive ? 'Draw mode off' : ''));

  return (
    <>
      <button
        type="button"
        className={`btn btn--map draw__toggle${active ? ' btn--map-active' : ''}`}
        aria-pressed={active}
        // On a phone .btn--map hides the label, so the button needs a name of its own.
        aria-label="Draw turf"
        onClick={() => (active ? cancel() : start())}
      >
        <PolygonIcon />
        <span>Draw turf</span>
      </button>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      {active && (
        <div className="card draw-panel" role="group" aria-label="Draw turf">
          <p className="draw-panel__hint">{hint}</p>
          <p className="draw-panel__counts">
            <strong>{n(inside.doors)}</strong> doors · <strong>{n(inside.voters)}</strong> voters inside ·{' '}
            <span className="muted">
              {ring.length} {ring.length === 1 ? 'point' : 'points'}
            </span>
          </p>
          {filtersActive && (
            <p className="draw-panel__warn">
              Filters are on, so this counts only the doors that match them. The saved turf takes every door inside the shape.
            </p>
          )}
          <div className="draw-panel__actions">
            <button type="button" className="btn btn--small" onClick={undo} disabled={ring.length === 0}>
              Undo point
            </button>
            <button type="button" className="btn btn--small btn--primary" onClick={() => setNaming(true)} disabled={ring.length < 3}>
              Finish
            </button>
            <button type="button" className="btn btn--small" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {done && !active && (
        <div className="pill draw-done">
          <CheckIcon />
          <span>{done}</span>
          <button type="button" className="linkbtn" onClick={() => setDone(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Portalled to <body> deliberately. DrawPolygon renders inside `.map-toolbar`, which is
          `position: absolute; z-index: 5` — a stacking context — so this dialog's own z-index only
          ranked it *within the toolbar*. It tied with `.map-bottomleft` (also 5) and lost on DOM
          order, which put the viewport pill and the legend on top of the open dialog. At body level
          there is no ancestor context to be trapped by. */}
      {naming &&
        createPortal(
          <div className="modal-wrap modal-wrap--fixed" role="presentation">
          <div className="scrim" onClick={() => setNaming(false)} aria-hidden="true" />
          <div className="card modal draw-modal" role="dialog" aria-modal="true" aria-labelledby="draw-turf-h">
            <form className="draw-modal__form" onSubmit={submit}>
              <header className="modal__head">
                <h2 id="draw-turf-h">Save turf</h2>
                <button type="button" className="btn btn--icon" onClick={() => setNaming(false)} aria-label="Back to drawing">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <line x1="5" y1="5" x2="19" y2="19" />
                    <line x1="19" y1="5" x2="5" y2="19" />
                  </svg>
                </button>
              </header>
              <div className="modal__body draw-modal__body">
                <p className="draw-modal__summary">
                  <strong>{n(inside.doors)}</strong> doors · <strong>{n(inside.voters)}</strong> voters inside the shape you drew.
                </p>
                <label className="field">
                  <span className="field__label">Turf name</span>
                  <input
                    ref={nameRef}
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={120}
                    required
                    placeholder="e.g. Ilderton — north of King"
                  />
                </label>
                <label className="field">
                  <span className="field__label">Ward</span>
                  <select value={ward} onChange={(e) => setWard(e.target.value)}>
                    <option value="">No ward</option>
                    {wards.map((w) => (
                      <option key={w} value={w}>
                        {wardLabel(w)}
                      </option>
                    ))}
                  </select>
                  {/* Matches the API: ward labels a turf, it never trims the selection. */}
                  <span className="field__hint">A label only — the shape decides which doors are in the turf.</span>
                </label>
                {createTurf.isError && <ErrorBox title="Could not save the turf" error={createTurf.error} compact />}
              </div>
              <footer className="draw-modal__actions">
                <button type="button" className="btn" onClick={() => setNaming(false)}>
                  Back to drawing
                </button>
                <button type="submit" className="btn btn--primary" disabled={!name.trim() || createTurf.isPending}>
                  {createTurf.isPending ? (
                    <>
                      <Spinner size={14} /> Saving…
                    </>
                  ) : (
                    'Create turf'
                  )}
                </button>
              </footer>
            </form>
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}

function PolygonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 3 21 10 17 20 7 20 3 10" />
      <circle cx="12" cy="3" r="2" fill="currentColor" />
      <circle cx="21" cy="10" r="2" fill="currentColor" />
      <circle cx="3" cy="10" r="2" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
