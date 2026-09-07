/**
 * Every lawn sign and every outstanding sign request on one map.
 *
 * Two different things share this view on purpose, because in the field they are two halves of one
 * job: a *request* is a door that said yes and is waiting for a sign, a *placed* sign is one that is
 * already in the ground. Seeing them together is what turns "17 requests" into a driving route.
 *
 * Default-exported and only ever reached through `lazy()`: MapLibre is ~1 MB and the other three
 * signs tabs never need it.
 *
 * The requests half is voter data (addresses off the list) and is scoped and audited server-side by
 * GET /api/signs/requests — this component adds no scoping of its own and must not be given a
 * broader source.
 */
import type { FeatureCollection, Feature, Point } from 'geojson';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMeta, useSignRequests, useSigns } from '../api/hooks';
import type { Sign, SignRequest } from '../api/types';
import { ErrorBox, LoadingRows, fmtDate, n, titleCase, wardLabel } from '../components/ui';
import { MapView } from '../map/MapView';
import { SIGN_COLOURS } from '../map/palette';

/** The map's own grouping, which is coarser than `sign_status`: it is what you filter by. */
type Group = 'requested' | 'placed' | 'trouble' | 'removed';

const GROUPS: { id: Group; label: string; colour: string; hint: string }[] = [
  { id: 'requested', label: 'Requested', colour: SIGN_COLOURS.requested, hint: 'asked for one, not delivered' },
  { id: 'placed', label: 'Placed', colour: SIGN_COLOURS.placed, hint: 'in the ground now' },
  { id: 'trouble', label: 'Missing or damaged', colour: SIGN_COLOURS.missing, hint: 'needs a look' },
  { id: 'removed', label: 'Removed', colour: SIGN_COLOURS.removed, hint: 'already collected' },
];

function groupOf(status: Sign['status']): Group {
  if (status === 'placed') return 'placed';
  if (status === 'removed') return 'removed';
  if (status === 'requested') return 'requested';
  return 'trouble'; // missing | damaged
}

/** What the detail card shows, flattened so a sign and a request can share one renderer. */
interface Pin {
  id: string;
  group: Group;
  status: string;
  address: string | null;
  ward: string | null;
  lat: number;
  lon: number;
  when: string | null;
  who: string | null;
  note: string | null;
  accuracy_m: number | null;
  /** Set for a request, so the card can offer "place a sign here". */
  household_id: string | null;
  photo_count: number;
}

function pinFromSign(s: Sign): Pin {
  const g = groupOf(s.status);
  return {
    id: s.id,
    group: g,
    status: s.status,
    address: s.address ?? s.label,
    ward: s.ward,
    lat: s.lat,
    lon: s.lon,
    when: s.removed_at ?? s.placed_at ?? s.created_at,
    who: s.removed_by_name ?? s.placed_by_name,
    note: s.note,
    accuracy_m: s.accuracy_m,
    household_id: s.household_id,
    photo_count: s.photo_count,
  };
}

function pinFromRequest(r: SignRequest): Pin | null {
  // A door with no map point cannot be drawn. The counts below the map say how many were dropped
  // so the number here never silently disagrees with the requests tab.
  if (r.lat === null || r.lon === null) return null;
  return {
    id: `req:${r.household_id}`,
    group: 'requested',
    status: 'requested',
    address: r.address,
    ward: r.ward,
    lat: r.lat,
    lon: r.lon,
    when: r.last_contact_at,
    who: r.user_name,
    note: r.note,
    accuracy_m: null,
    household_id: r.household_id,
    photo_count: 0,
  };
}

export default function SignsMap() {
  const meta = useMeta();
  const signs = useSigns();
  const requests = useSignRequests();

  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<Group>>(new Set());
  const fittedRef = useRef(false);

  const { pins, unmapped } = useMemo(() => {
    const out: Pin[] = [];
    let dropped = 0;
    for (const s of signs.data ?? []) {
      // The column is nullable even though the create route requires both, so a row written by
      // hand or by a future importer cannot put a NaN on the map.
      if (typeof s.lat !== 'number' || typeof s.lon !== 'number') {
        dropped += 1;
        continue;
      }
      out.push(pinFromSign(s));
    }
    for (const r of requests.data ?? []) {
      const p = pinFromRequest(r);
      if (p) out.push(p);
      else dropped += 1;
    }
    return { pins: out, unmapped: dropped };
  }, [signs.data, requests.data]);

  const shown = useMemo(() => pins.filter((p) => !hidden.has(p.group)), [pins, hidden]);

  const collection = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: shown.map(
        (p): Feature<Point> => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          // `kind` drives the colour; the map never sees an address or a name.
          properties: { id: p.id, kind: p.group === 'trouble' ? 'missing' : p.group },
        }),
      ),
    }),
    [shown],
  );

  const counts = useMemo(() => {
    const c: Record<Group, number> = { requested: 0, placed: 0, trouble: 0, removed: 0 };
    for (const p of pins) c[p.group] += 1;
    return c;
  }, [pins]);

  const selected = useMemo(() => shown.find((p) => p.id === selectedId) ?? null, [shown, selectedId]);

  // Frame everything once, on the first load that has something to frame. Not on every change:
  // toggling "removed" off should not throw away the view the user panned to.
  useEffect(() => {
    if (!map || fittedRef.current || !pins.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pins) {
      if (p.lon < minX) minX = p.lon;
      if (p.lon > maxX) maxX = p.lon;
      if (p.lat < minY) minY = p.lat;
      if (p.lat > maxY) maxY = p.lat;
    }
    fittedRef.current = true;
    map.fitBounds([minX, minY, maxX, maxY], { padding: 48, maxZoom: 15, duration: 0 });
  }, [map, pins]);

  const toggle = (g: Group) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  if (signs.isPending || requests.isPending) {
    return (
      <div className="card">
        <LoadingRows rows={4} />
      </div>
    );
  }
  if (signs.isError) {
    return <ErrorBox title="Could not load the signs" error={signs.error} onRetry={() => void signs.refetch()} />;
  }
  if (requests.isError) {
    return (
      <ErrorBox
        title="Could not load the sign requests"
        error={requests.error}
        onRetry={() => void requests.refetch()}
      />
    );
  }

  return (
    <div className="sgmap">
      <div className="sgmap__legend" role="group" aria-label="Show or hide sign types">
        {GROUPS.map((g) => {
          const off = hidden.has(g.id);
          return (
            <button
              key={g.id}
              type="button"
              className={`sgmap__chip${off ? ' sgmap__chip--off' : ''}`}
              aria-pressed={!off}
              onClick={() => toggle(g.id)}
              title={g.hint}
            >
              <span className="sgmap__swatch" style={{ background: g.id === 'requested' ? '#fff' : g.colour, borderColor: g.colour }} />
              {g.label}
              <span className="badge">{n(counts[g.id])}</span>
            </button>
          );
        })}
      </div>

      <div className="sgmap__canvas">
        <MapView
          points={undefined}
          boundary={meta.data?.boundary}
          colourMode="ward"
          communities={[]}
          base="streets"
          selectedId={null}
          signs={collection}
          selectedSignId={selectedId}
          onSelectSign={(id) => setSelectedId(id)}
          // No households are loaded on this map, so there is nothing else to select.
          onSelect={() => undefined}
          onViewport={() => undefined}
          onMapReady={setMap}
        />
      </div>

      {selected ? (
        <div className="sgmap__detail card">
          <div className="sgmap__detail-head">
            <strong>{selected.address ?? 'Unaddressed location'}</strong>
            <button type="button" className="btn btn--small" onClick={() => setSelectedId(null)}>
              Close
            </button>
          </div>
          <p className="muted small">
            {titleCase(selected.status)}
            {selected.ward ? ` · ${wardLabel(selected.ward)}` : ''}
            {selected.when ? ` · ${fmtDate(selected.when)}` : ''}
            {selected.who ? ` · ${selected.who}` : ''}
            {selected.accuracy_m !== null ? ` · GPS ±${Math.round(selected.accuracy_m)} m` : ''}
            {selected.photo_count > 0 ? ` · ${n(selected.photo_count)} photo${selected.photo_count === 1 ? '' : 's'}` : ''}
          </p>
          {selected.note ? <p className="small">{selected.note}</p> : null}
          <div className="sgmap__detail-actions">
            {selected.group === 'requested' && selected.household_id ? (
              <Link
                className="btn btn--primary btn--small"
                to={`/signs?tab=place&household=${encodeURIComponent(selected.household_id)}${
                  selected.address ? `&address=${encodeURIComponent(selected.address)}` : ''
                }`}
              >
                Place a sign here
              </Link>
            ) : null}
            {selected.household_id ? (
              // Same target the requests tab uses: the main map, framed on that door.
              <Link className="btn btn--small" to={`/map?household=${encodeURIComponent(selected.household_id)}`}>
                Show the door on the map
              </Link>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="muted small sgmap__hint">
          {n(shown.length)} of {n(pins.length)} shown. Tap a marker for the details.
          {unmapped > 0
            ? ` ${n(unmapped)} more ${unmapped === 1 ? 'has' : 'have'} no map point and cannot be drawn.`
            : ''}
        </p>
      )}
    </div>
  );
}
