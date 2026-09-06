import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { errorMessage } from '../api/client';
import { useTurfPreview } from '../api/hooks';
import type { TurfPreview } from '../api/types';
import { Spinner, n, wardLabel } from '../components/ui';
import { wardColour } from '../map/palette';

// MapLibre is ~1 MB. Most visits to the Turfs page never open this dialog, and organisers on a
// tethered laptop should not download a map engine to read a list of turfs — so the canvas is a
// separate chunk fetched only once there is something to draw.
const TurfShapeMap = lazy(() => import('./TurfShapeMap'));

/**
 * Long enough that ticking down a list of streets is one request, not twenty; short enough that the
 * shape feels like it is following the selection.
 */
const DEBOUNCE_MS = 450;

/**
 * Above this the selection is not a turf — it is a chunk of the municipality picked with "Add all
 * shown". Drawing it would mean shipping thousands of coordinates to answer a question the
 * organiser is not asking yet, so the panel says so instead of fetching. (The size hint in the
 * picker calls 300 doors "very large"; this is five times that.)
 */
const MAX_PREVIEW_DOORS = 1500;

interface Props {
  /** `street_sort` keys, exactly as they will be POSTed to /api/turfs. */
  streets: string[];
  /** '' = all wards. Sent as null, matching the create call. */
  ward: string;
  /**
   * Doors the picker has already totalled for this selection. Used only to refuse an absurd
   * preview before the request goes out — the authoritative counts come back with the preview.
   */
  estimatedDoors: number;
}

/** Rough ground extent of the selection, in km, from its bounding box. */
function extent(doors: TurfPreview['doors']): { w: number; h: number } | null {
  if (doors.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of doors) {
    if (d.lon < minX) minX = d.lon;
    if (d.lon > maxX) maxX = d.lon;
    if (d.lat < minY) minY = d.lat;
    if (d.lat > maxY) maxY = d.lat;
  }
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  return { w: (maxX - minX) * 111.32 * Math.cos(midLat), h: (maxY - minY) * 110.57 };
}

const km = (v: number): string => (v < 1 ? `${Math.round(v * 1000)} m` : `${v.toFixed(1)} km`);

/**
 * The shape of the turf being cut, beside the street picker.
 *
 * The counts and the street list stay the authoritative record — this panel is supplementary, and
 * everything the map shows is also written out underneath it (doors, voters, the ward split, how
 * far the selection reaches). If the preview fails the picker is untouched and the turf can still
 * be created; only the sketch is missing.
 */
export function TurfShapePanel({ streets, ward, estimatedDoors }: Props) {
  const preview = useTurfPreview();
  const [shown, setShown] = useState<{ key: string; data: TurfPreview } | null>(null);
  const [failed, setFailed] = useState<{ key: string; msg: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The selection's identity. Content and order both matter, so this is what the effect watches —
  // the `streets` array itself gets a new identity on every keystroke in the picker's filters.
  const key = `${ward}|${streets.join(',')}`;
  const bodyRef = useRef({ streets, ward });
  bodyRef.current = { streets, ward };
  const keyRef = useRef(key);
  keyRef.current = key;
  // `mutate` is stable across renders, but the mutation object is not; keep it out of the deps so a
  // re-render never restarts the debounce timer.
  const mutateRef = useRef(preview.mutate);
  mutateRef.current = preview.mutate;

  const tooBig = estimatedDoors > MAX_PREVIEW_DOORS;
  const empty = streets.length === 0;

  useEffect(() => {
    if (empty || tooBig) return;
    const timer = setTimeout(() => {
      const { streets: s, ward: w } = bodyRef.current;
      mutateRef.current(
        { streets: s, ward: w || null },
        {
          // Responses can land out of order, so a reply only counts if the selection has not moved
          // on since it was asked for.
          onSuccess: (data) => {
            if (keyRef.current !== key) return;
            setFailed(null);
            setShown({ key, data });
          },
          onError: (err) => {
            if (keyRef.current !== key) return;
            setFailed({ key, msg: errorMessage(err) });
          },
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, empty, tooBig, attempt]);

  const data = shown?.data;
  const fresh = shown?.key === key;
  const errored = failed?.key === key;
  const located = data?.doors.length ?? 0;

  const wardRows = useMemo(() => {
    if (!data) return [];
    const tally = new Map<string, number>();
    for (const d of data.doors) tally.set(d.ward, (tally.get(d.ward) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([w, count]) => ({ ward: w, count }));
  }, [data]);

  const span = useMemo(() => (data ? extent(data.doors) : null), [data]);

  return (
    <section className="shape" aria-labelledby="shape-h">
      <h3 className="shape__h field__label" id="shape-h">
        Shape of this turf
      </h3>

      {empty && (
        <p className="muted small shape__note">
          Pick a street and the doors appear here, so you can see whether the turf is one walk or
          scattered across the municipality.
        </p>
      )}

      {!empty && tooBig && (
        <p className="muted small shape__note">
          {n(estimatedDoors)} doors selected — too many to sketch. The totals below are still exact;
          narrow the selection to about {n(MAX_PREVIEW_DOORS)} doors to see it drawn.
        </p>
      )}

      {!empty && !tooBig && errored && (
        <div className="shape__note">
          <div className="alert alert--danger alert--compact" role="alert">
            <div>
              <strong>The shape could not be drawn</strong>
              <div className="alert__detail">{failed.msg}</div>
              <div className="alert__detail">
                Nothing else is affected — the street list and its totals are correct, and the turf
                can still be created.
              </div>
            </div>
            <button type="button" className="btn btn--small" onClick={() => setAttempt((a) => a + 1)}>
              Retry
            </button>
          </div>
        </div>
      )}

      {!empty && !tooBig && !errored && !fresh && (
        <p className="muted small shape__note shape__note--busy" role="status">
          <Spinner size={16} /> Working out the shape…
        </p>
      )}

      {!empty && !tooBig && !errored && data && (
        // While a newer selection is in flight the old sketch stays up, dimmed: a map that blanks on
        // every checkbox is harder to read than one that lags by half a second.
        <div className={`shape__result${fresh ? '' : ' shape__result--stale'}`} aria-busy={!fresh}>
          {located > 0 ? (
            <div className="shape__canvas">
              <Suspense
                fallback={
                  <p className="shape__loading muted small">
                    <Spinner size={16} /> Loading the map…
                  </p>
                }
              >
                <TurfShapeMap doors={data.doors} />
              </Suspense>
            </div>
          ) : (
            <p className="muted small shape__note">
              None of these {n(data.n_households)} doors has a map point, so there is nothing to
              draw. They are all legal descriptions — the street list is the complete turf.
            </p>
          )}

          {/* The map's text alternative: everything the dots say, in words. */}
          <p className="shape__alt">
            <strong>
              {n(data.n_households)} doors · {n(data.n_voters)} voters
            </strong>
            {span && located > 1 && (
              <span className="muted"> · spans about {km(span.w)} by {km(span.h)}</span>
            )}
          </p>

          {data.unmapped > 0 && (
            <p className="muted small shape__note">
              {n(data.unmapped)} of these have no map point (legal descriptions), so {n(located)}{' '}
              {located === 1 ? 'dot is' : 'dots are'} drawn.
            </p>
          )}

          {/* The API caps how many coordinates a preview returns. Derived rather than read off a
              flag, so a cap that moves cannot leave the dot count silently disagreeing. */}
          {data.n_households - data.unmapped > located && (
            <p className="muted small shape__note">
              Only the first {n(located)} of {n(data.n_households - data.unmapped)} mapped doors are
              drawn — the counts above are the whole selection.
            </p>
          )}

          {wardRows.length > 0 && (
            <ul className="shape__legend">
              {wardRows.map((row) => (
                <li key={row.ward} className="shape__legend-item">
                  <span
                    className="shape__dot"
                    style={{ '--dot': wardColour(row.ward) } as CSSProperties}
                    aria-hidden="true"
                  />
                  {wardLabel(row.ward)} <span className="num">{n(row.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
