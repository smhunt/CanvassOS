import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointsCollection, TurfPreview } from '../api/types';
import { MapView } from '../map/MapView';

interface Props {
  doors: TurfPreview['doors'];
}

/**
 * The doors of a turf-in-progress, drawn as dots so the organiser can see the *shape* they are
 * cutting — one contiguous walk, or three islands the counts cannot tell apart.
 *
 * Default-exported and only ever reached through `lazy()`: MapLibre is ~1 MB and most visits to the
 * Turfs page never open this dialog, so the list must not pay for it. Coloured by ward, matching the
 * ward stripe on the turf cards and the main map's ward mode.
 */
export default function TurfShapeMap({ doors }: Props) {
  const [map, setMap] = useState<MapLibreMap | null>(null);
  // The map instance outlives a re-fit, so the last-fitted box is kept out of render state.
  const fittedRef = useRef<string>('');

  const points = useMemo<PointsCollection>(
    () => ({
      type: 'FeatureCollection',
      features: doors.map((d) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
        properties: { id: d.household_id, ward: d.ward, community: null, n: 1, inst: false },
      })),
    }),
    [doors],
  );

  const bbox = useMemo<[number, number, number, number] | null>(() => {
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
    return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
  }, [doors]);

  // Re-fit on every change of extent, not once: the selection grows and shrinks under the
  // organiser's hands, and a map still framed on the first street answers the wrong question.
  useEffect(() => {
    if (!map || !bbox) return;
    const key = bbox.join(',');
    if (fittedRef.current === key) return;
    fittedRef.current = key;
    map.fitBounds(bbox, { padding: 32, maxZoom: 15, duration: 0 });
  }, [map, bbox]);

  return (
    <MapView
      points={points}
      boundary={undefined}
      colourMode="ward"
      communities={[]}
      base="streets"
      selectedId={null}
      // Nothing on this map is selectable: it is a sketch of a turf that does not exist yet, and
      // opening a household from the create dialog would be a different job on a different screen.
      onSelect={() => undefined}
      onViewport={() => undefined}
      onMapReady={setMap}
    />
  );
}
