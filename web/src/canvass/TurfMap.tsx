import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { ContactResult, Door, PointsCollection } from '../api/types';
import { CONTACT_RESULTS, RESULT_LABELS } from '../api/types';
import { MapView, type MapViewHandle } from '../map/MapView';
import { n } from '../components/ui';
import { latestResult, resultColour } from './status';

interface Props {
  doors: Door[];
  /** Results recorded on this phone this session; they colour the dots before the refetch lands. */
  recorded: Record<string, ContactResult>;
  selectedId: string | null;
  onSelect: (householdId: string) => void;
}

/**
 * The whole turf on one map, as an opt-in alternative to the door list.
 *
 * Default-exported and only ever reached through `lazy()`, because MapLibre is ~1 MB and volunteers
 * are on rural data — nobody should pay for it by opening the door list. The dots are painted by
 * MapView's own `status` colour mode from a `status` property per door, so a green dot means exactly
 * what a green dot means on the list and on the organiser map.
 */
export default function TurfMap({ doors, recorded, selectedId, onSelect }: Props) {
  const mapRef = useRef<MapViewHandle>(null);
  const fitted = useRef(false);

  const located = useMemo(() => doors.filter((d) => d.lat !== null && d.lon !== null), [doors]);

  const points = useMemo<PointsCollection>(
    () => ({
      type: 'FeatureCollection',
      features: located.map((d) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon as number, d.lat as number] },
        properties: {
          id: d.household_id,
          ward: d.ward,
          community: d.community,
          n: d.n_voters,
          inst: false,
          status: latestResult(d, recorded),
        },
      })),
    }),
    [located, recorded],
  );

  const bbox = useMemo<[number, number, number, number] | null>(() => {
    if (located.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of located) {
      const x = d.lon as number;
      const y = d.lat as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  }, [located]);

  /** Legend doubles as the text alternative: the same counts the colours are showing. */
  const legend = useMemo(() => {
    const tally = new Map<ContactResult | 'none', number>();
    for (const d of doors) {
      const key = latestResult(d, recorded) ?? 'none';
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const rows: { key: string; label: string; colour: string; count: number }[] = [];
    const todo = tally.get('none') ?? 0;
    if (todo > 0) rows.push({ key: 'none', label: 'Not yet knocked', colour: resultColour(null), count: todo });
    for (const r of CONTACT_RESULTS) {
      const count = tally.get(r) ?? 0;
      if (count > 0) rows.push({ key: r, label: RESULT_LABELS[r], colour: resultColour(r), count });
    }
    return rows;
  }, [doors, recorded]);

  // Follow the selection — including the auto-advance after a result — so the door the volunteer is
  // being sent to is the one under the sheet, not wherever the map happened to be left.
  useEffect(() => {
    if (!selectedId) return;
    const d = located.find((x) => x.household_id === selectedId);
    const map = mapRef.current;
    if (!d || !map) return;
    map.flyTo(d.lon as number, d.lat as number, Math.max(map.getZoom(), 15));
  }, [selectedId, located]);

  if (!bbox) {
    return (
      <p className="cv-map__none muted">
        None of these {n(doors.length)} doors has a map location yet, so there is nothing to draw. The list is the
        complete turf.
      </p>
    );
  }

  return (
    <section className="cv-map" aria-label="Turf map">
      <div className="cv-map__canvas">
        <MapView
          ref={mapRef}
          points={points}
          boundary={undefined}
          colourMode="status"
          communities={[]}
          base="streets"
          selectedId={selectedId}
          onSelect={(props) => onSelect(props.id)}
          onViewport={() => undefined}
          // MapView only fits bounds for a boundary polygon, and the turf's outline is not in the
          // doors response — so open on the doors themselves, once, via the live map it hands back.
          onMapReady={(map) => {
            if (!map || fitted.current) return;
            fitted.current = true;
            map.fitBounds(bbox, { padding: 40, maxZoom: 16, duration: 0 });
          }}
        />
      </div>
      <p className="cv-map__hint muted small">
        Tap a door on the map to record it.
        {located.length < doors.length && ` ${n(doors.length - located.length)} of ${n(doors.length)} doors have no map location and are on the list only.`}
      </p>
      <ul className="cv-legend">
        {legend.map((row) => (
          <li key={row.key} className="cv-legend__item">
            <span className="cv-legend__dot" style={{ '--dot': row.colour } as CSSProperties} aria-hidden="true" />
            {row.label} <span className="num">{n(row.count)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
