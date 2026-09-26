/**
 * "Plan a route": the delivery list, in driving order, as links into Google Maps and Waze.
 *
 * It routes whatever the list is showing — so the ward filter doubles as "one ward's run" — and
 * only the rows with a map position. A phoned-in or website request carries a typed address and no
 * coordinates, and an unmapped legal-description door has none either; those are named below the
 * route rather than dropped, because a stop silently missing from the run is a sign never
 * delivered. Typed addresses are deliberately NOT sent to Google to be geocoded: see route.ts.
 *
 * The phone's position is asked for once, on tap, and only to anchor the order. It is not stored.
 */
import { useMemo, useState } from 'react';
import { formatDistance, describeGeolocationFailure, preflightGeolocation } from '../canvass/nearMe';
import type { Coords } from '../canvass/directions';
import { distanceM } from '../canvass/directions';
import { googleLegs, orderStops, tourLengthM, wazeUrl, type RouteStop } from './route';
import type { UnifiedRequest } from './rows';

export function RoutePanel({ rows, onClose }: { rows: UnifiedRequest[]; onClose: () => void }) {
  const [start, setStart] = useState<Coords | null>(null);
  const [locating, setLocating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const { stops, unmapped } = useMemo(() => {
    const stops: RouteStop[] = [];
    const unmapped: UnifiedRequest[] = [];
    // The same door can arrive twice — once from a door row, once from a linked phoned-in request —
    // and it is one stop.
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.lat === null || r.lon === null) {
        unmapped.push(r);
        continue;
      }
      const at = `${r.lat},${r.lon}`;
      if (seen.has(at)) continue;
      seen.add(at);
      stops.push({ key: r.key, title: r.title, lat: r.lat, lon: r.lon });
    }
    return { stops, unmapped };
  }, [rows]);

  const ordered = useMemo(() => orderStops(stops, start), [stops, start]);
  const legs = useMemo(() => googleLegs(ordered, start), [ordered, start]);
  const length = useMemo(() => tourLengthM(ordered, start), [ordered, start]);

  const locate = () => {
    const blocked = preflightGeolocation();
    if (blocked) {
      setFailure(blocked.message);
      return;
    }
    setLocating(true);
    setFailure(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStart({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        setLocating(false);
      },
      (err) => {
        setFailure(describeGeolocationFailure(err).message);
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  return (
    <section className="card sg-route" aria-labelledby="sg-route-h">
      <div className="sg-asked__head">
        <h3 id="sg-route-h" className="sheet__h3">
          Delivery route
        </h3>
        <button type="button" className="btn btn--small" onClick={onClose}>
          Close
        </button>
      </div>

      {stops.length === 0 ? (
        <p className="muted small">None of the doors on this list has a map position, so there is nothing to route.</p>
      ) : (
        <>
          <p className="muted small">
            {stops.length} {stops.length === 1 ? 'stop' : 'stops'}, about {formatDistance(length)} in a straight line
            {start ? ' from where you are' : ''} — road distance will be longer. The order is worked out here; Google and
            Waze drive it as given.
          </p>

          <div className="sg-row__actions">
            <button type="button" className="btn btn--small" onClick={locate} disabled={locating}>
              {locating ? 'Finding you…' : start ? 'Start from here again' : 'Start from where I am'}
            </button>
          </div>
          {failure && <p className="small sg-route__warn">{failure}</p>}

          <div className="sg-row__actions">
            {legs.map((leg) => (
              <a key={leg.first} className="btn btn--small btn--primary" href={leg.url} target="_blank" rel="noreferrer">
                {legs.length === 1 ? 'Open in Google Maps' : `Google Maps: stops ${leg.first}–${leg.last}`}
              </a>
            ))}
          </div>
          {legs.length > 1 && (
            <p className="muted small">
              Google takes ten stops per link. Open the next link when you reach the last stop of the one before — each
              one starts where the last ended. In a phone browser without the Maps app, Google may keep only the first
              few stops.
            </p>
          )}

          <ol className="sg-route__stops">
            {ordered.map((s, i) => {
              const prev = i === 0 ? start : (ordered[i - 1] as RouteStop);
              return (
                <li key={s.key} className="sg-route__stop">
                  <span className="sg-route__title">{s.title}</span>
                  {prev && <span className="muted small">{formatDistance(distanceM(prev, s))}</span>}
                  <a
                    className="btn btn--small"
                    href={wazeUrl(s)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Waze to stop ${i + 1}, ${s.title}`}
                  >
                    Waze
                  </a>
                </li>
              );
            })}
          </ol>
        </>
      )}

      {unmapped.length > 0 && (
        <>
          <p className="small sg-route__warn">
            Not on the route — no map position, so these need finding by address:
          </p>
          <ul className="sg-route__unmapped small">
            {unmapped.map((r) => (
              <li key={r.key}>{r.title}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
