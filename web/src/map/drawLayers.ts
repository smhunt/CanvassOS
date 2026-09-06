/**
 * The MapLibre side of the turf drawer: two GeoJSON sources and four layers, added to the live
 * style when the drawer mounts and taken away again when it unmounts.
 *
 * They are added at runtime rather than baked into buildStyle() because only organizers ever draw,
 * and because switching base layers only toggles `visibility` (see style.ts) — the style is never
 * reloaded, so layers added here survive a base-layer change without being re-added.
 */
import type { Feature, FeatureCollection } from 'geojson';
import type { GeoJSONSource, LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { closeRing, type Position } from './drawGeometry';
import { EMPTY_FC } from './style';

const SHAPE_SOURCE = 'turf-draw';
const VERTEX_SOURCE = 'turf-draw-vertices';

/** Deliberately not a palette.ts colour: the drawing must never read as ward/status data. */
const DRAW_COLOUR = '#ff5c00';

/** Painted last-to-first, so the list order is the paint order. */
const DRAW_LAYERS: LayerSpecification[] = [
  {
    id: 'turf-draw-fill',
    type: 'fill',
    source: SHAPE_SOURCE,
    paint: { 'fill-color': DRAW_COLOUR, 'fill-opacity': 0.16 },
  },
  {
    id: 'turf-draw-line',
    type: 'line',
    source: SHAPE_SOURCE,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': DRAW_COLOUR, 'line-width': 3, 'line-opacity': 0.95 },
  },
  {
    // Halo on the first corner: it is the "tap here to close" target, and on a tablet the finger
    // needs something bigger than a 6px dot to aim at.
    id: 'turf-draw-vertex-first',
    type: 'circle',
    source: VERTEX_SOURCE,
    filter: ['==', ['get', 'first'], true],
    paint: {
      'circle-radius': 14,
      'circle-color': DRAW_COLOUR,
      'circle-opacity': 0.22,
      'circle-stroke-color': DRAW_COLOUR,
      'circle-stroke-width': 2,
    },
  },
  {
    // Inverted against the household dots (coloured fill, white stroke) so corners never read as doors.
    id: 'turf-draw-vertex',
    type: 'circle',
    source: VERTEX_SOURCE,
    paint: {
      'circle-radius': 6,
      'circle-color': '#ffffff',
      'circle-stroke-color': DRAW_COLOUR,
      'circle-stroke-width': 3,
    },
  },
];

export function addDrawLayers(map: MapLibreMap): void {
  if (!map.getSource(SHAPE_SOURCE)) map.addSource(SHAPE_SOURCE, { type: 'geojson', data: EMPTY_FC });
  if (!map.getSource(VERTEX_SOURCE)) map.addSource(VERTEX_SOURCE, { type: 'geojson', data: EMPTY_FC });
  for (const layer of DRAW_LAYERS) if (!map.getLayer(layer.id)) map.addLayer(layer);
}

export function removeDrawLayers(map: MapLibreMap): void {
  // When the whole map page unmounts, MapView's cleanup may already have called map.remove() and
  // torn the style down under us; there is nothing left to detach in that case.
  try {
    for (const layer of DRAW_LAYERS) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    for (const id of [SHAPE_SOURCE, VERTEX_SOURCE]) if (map.getSource(id)) map.removeSource(id);
  } catch {
    /* map already destroyed */
  }
}

/**
 * Render the ring as it stands. Three corners or more draws the *closed* polygon — the same ring
 * that would be POSTed — so the organiser is always looking at the shape they would get.
 */
export function setDrawData(map: MapLibreMap, ring: readonly Position[]): void {
  const shape = map.getSource(SHAPE_SOURCE) as GeoJSONSource | undefined;
  const vertices = map.getSource(VERTEX_SOURCE) as GeoJSONSource | undefined;
  if (!shape || !vertices) return;

  const shapeFeatures: Feature[] = [];
  if (ring.length >= 3) {
    shapeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [closeRing(ring)] } });
  } else if (ring.length === 2) {
    shapeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring.map((p) => [...p]) } });
  }
  shape.setData({ type: 'FeatureCollection', features: shapeFeatures } satisfies FeatureCollection);

  vertices.setData({
    type: 'FeatureCollection',
    features: ring.map((p, i) => ({
      type: 'Feature',
      // `first` drives the halo, and only once closing is actually possible.
      properties: { first: i === 0 && ring.length >= 3 },
      geometry: { type: 'Point', coordinates: [...p] },
    })),
  } satisfies FeatureCollection);
}
