import type { FeatureCollection } from 'geojson';
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import {
  BOUNDARY_COLOUR,
  NOT_CONTACTED,
  RESULT_COLOURS,
  CLUSTER_COLOUR,
  DOOR_STEPS,
  NONRES_HIGHLIGHT,
  NONRES_MUTED,
  QUALITY_COLOURS,
  SELECTED_COLOUR,
  SIGN_COLOURS,
  SIGN_FALLBACK,
  TURF_CONTRAST,
  TURF_CONTRAST_ON_IMAGERY,
  TURF_OUTLINE,
  TURF_OUTLINE_ON_IMAGERY,
  WARD_COLOURS,
  communityColour,
  type BaseLayer,
  type ColourMode,
} from './palette';

// ------------------------------------------------------------------ base layers (raster, inline)

const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';
const CARTO_ATTR = `${OSM_ATTR} © <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>`;
const ESRI_ATTR =
  'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noreferrer">Esri</a> — Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const esri = (service: string) => `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`;

/** Which raster layers make up each base layer. */
export const BASE_LAYER_IDS: Record<BaseLayer, string[]> = {
  light: ['base-carto-light'],
  streets: ['base-osm'],
  satellite: ['base-esri-imagery', 'base-esri-transport', 'base-esri-places'],
};
const ALL_BASE_LAYER_IDS = Object.values(BASE_LAYER_IDS).flat();

export const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Full style object: every base layer is present and toggled with `visibility`, so switching never
 *  drops our data sources. Glyphs are served from our own origin (public/fonts, generated at build). */
export function buildStyle(initial: BaseLayer): StyleSpecification {
  const vis = (id: string) => (BASE_LAYER_IDS[initial].includes(id) ? 'visible' : 'none');
  const raster = (id: string, source: string): LayerSpecification => ({
    id,
    type: 'raster',
    source,
    layout: { visibility: vis(id) },
    paint: { 'raster-fade-duration': 150 },
  });
  return {
    version: 8,
    glyphs: `${window.location.origin}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      'carto-light': {
        type: 'raster',
        tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`),
        tileSize: 256,
        maxzoom: 20,
        attribution: CARTO_ATTR,
      },
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: OSM_ATTR,
      },
      'esri-imagery': { type: 'raster', tiles: [esri('World_Imagery')], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTR },
      'esri-transport': { type: 'raster', tiles: [esri('Reference/World_Transportation')], tileSize: 256, maxzoom: 19 },
      'esri-places': { type: 'raster', tiles: [esri('Reference/World_Boundaries_and_Places')], tileSize: 256, maxzoom: 19 },
      boundary: { type: 'geojson', data: EMPTY_FC },
      // The doors of one turf, when the map was opened as /map?turf=<id>. Its own source, never
      // clustered: the ring has to mark the same doors at every zoom, including the zooms where the
      // households source has collapsed them into cluster bubbles.
      turf: { type: 'geojson', data: EMPTY_FC },
      // The turf's own drawn boundary. One shape, so unlike the per-door ring it costs the same ink
      // whether the turf holds 18 doors or 1,330 — which is the whole reason it exists (see the
      // turf-ring comment). Empty for a street-picked turf that was never given a polygon.
      'turf-outline': { type: 'geojson', data: EMPTY_FC },
      // Lawn signs and outstanding sign requests. Never clustered: there are tens of these, not
      // thousands, and each one is an individual job somebody has to drive to.
      signs: { type: 'geojson', data: EMPTY_FC },
      households: {
        type: 'geojson',
        data: EMPTY_FC,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 44,
        clusterProperties: {
          voters: ['+', ['get', 'n']],
          // One accumulator per ward: how many doors in this cluster belong to each. Used by
          // clusterColourExpression() to paint the cluster in its dominant ward's colour.
          ...WARD_ACCUMULATORS,
        },
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e9edf2' } },
      raster('base-carto-light', 'carto-light'),
      raster('base-osm', 'osm'),
      raster('base-esri-imagery', 'esri-imagery'),
      raster('base-esri-transport', 'esri-transport'),
      raster('base-esri-places', 'esri-places'),
      {
        id: 'boundary-line',
        type: 'line',
        source: 'boundary',
        paint: { 'line-color': BOUNDARY_COLOUR, 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
      },
      // The turf boundary. Drawn before the door layers so doors keep their hit area and stay on
      // top; the fill is faint enough to read as a wash rather than as a colour mode.
      {
        id: 'turf-area',
        type: 'fill',
        source: 'turf-outline',
        paint: { 'fill-color': TURF_OUTLINE, 'fill-opacity': 0.07 },
      },
      {
        id: 'turf-area-line',
        type: 'line',
        source: 'turf-outline',
        layout: { 'line-join': 'round' },
        paint: {
          'line-color': TURF_OUTLINE,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 2.4, 17, 3],
          // Fades out as the per-door rings fade in: past z16 the doors say which are yours and the
          // boundary is just a line across the street you are standing on.
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 15.2, 0.9, 17, 0.35],
        },
      },
      {
        id: 'clusters',
        type: 'circle',
        source: 'households',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': clusterColourExpression('ward'),
          'circle-opacity': 0.88,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 23, 400, 29, 1200, 36],
        },
      },
      {
        id: 'cluster-count',
        type: 'symbol',
        source: 'households',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Sans Bold'],
          'text-size': ['step', ['get', 'point_count'], 12, 100, 13, 400, 14],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        // Ward 2's orange and ward 3's green are too light for unhaloed white text.
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.45)', 'text-halo-width': 1 },
      },
      {
        id: 'points',
        type: 'circle',
        source: 'households',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': zoomScaled(baseRadius()),
          'circle-color': colourExpression('ward', []),
          'circle-opacity': 0.9,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 0.6, 16, 1.5],
        },
      },
      {
        id: 'inst-ring',
        type: 'circle',
        source: 'households',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'inst'], true]],
        paint: {
          'circle-radius': zoomScaled(['+', baseRadius(), 5]),
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#1a2430',
          'circle-stroke-width': 2,
        },
      },
      // Two rings, not a fill: the dot underneath keeps whatever colour the current mode gave it,
      // so the turf reads as a turf in every mode instead of overriding one of them.
      //
      // Both layers are zoom-staged (see turfMarkRadius) because a turf is 1,300 doors, not 18. A
      // fixed-size ring is a per-door mark ~7x the area of the door it marks, so at village zoom
      // 1,000 of them merge into one black shape and the map is gone. The stroke therefore only
      // exists once doors are far enough apart to read as separate.
      {
        id: 'turf-ring-contrast',
        type: 'circle',
        source: 'turf',
        paint: {
          'circle-radius': turfMarkRadius(),
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': TURF_CONTRAST,
          'circle-stroke-width': turfStrokeWidth(CONTRAST_STROKE),
          'circle-stroke-opacity': 0.85,
        },
      },
      {
        id: 'turf-ring',
        type: 'circle',
        source: 'turf',
        paint: {
          'circle-radius': turfMarkRadius(),
          // Solid while the households source is still clustering (clusterMaxZoom 12), because
          // there are no individual door dots to leave undimmed down there and the turf would
          // otherwise vanish. Hollow by the time the ring appears, so the door keeps its mode
          // colour at the zooms where anyone reads colour.
          'circle-color': TURF_OUTLINE,
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.9, 12.8, 0],
          'circle-stroke-color': TURF_OUTLINE,
          'circle-stroke-width': turfStrokeWidth(RING_STROKE),
        },
      },
      // ---- lawn signs, drawn above the doors: this is an overlay on the map, not a door state.
      // A requested sign has no post in the ground yet, so it is drawn hollow — filled means placed.
      {
        id: 'sign-dots',
        type: 'circle',
        source: 'signs',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 7, 17, 10],
          'circle-color': [
            'case',
            ['==', ['get', 'kind'], 'requested'],
            'rgba(255,255,255,0.92)',
            signColour(),
          ],
          'circle-stroke-color': signColour(),
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 2.5, 17, 3.5],
        },
      },
      {
        id: 'sign-selected',
        type: 'circle',
        source: 'signs',
        filter: ['==', ['get', 'id'], ''],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 12, 17, 16],
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': SELECTED_COLOUR,
          'circle-stroke-width': 4,
        },
      },
      {
        id: 'selected',
        type: 'circle',
        source: 'households',
        filter: ['==', ['get', 'id'], ''],
        paint: {
          'circle-radius': zoomScaled(['+', baseRadius(), 7]),
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': SELECTED_COLOUR,
          'circle-stroke-width': 4,
        },
      },
    ],
  };
}

// ------------------------------------------------------------------ data-driven expressions

/** Radius grows gently with voters per door (n). */
function baseRadius(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['coalesce', ['get', 'n'], 1], 1, 4, 2, 4.6, 4, 6, 8, 8, 30, 11, 200, 16];
}

function zoomScaled(r: ExpressionSpecification): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 12, ['*', r, 0.7], 14, r, 17, ['*', r, 1.5]];
}

/** Ring stroke widths at full zoom. The contrast pass is the wider of the two and sits underneath,
 *  so the visible halo is the difference between them rather than its full width. */
const RING_STROKE = 2;
const CONTRAST_STROKE = 3.6;

/**
 * The turf mark: a compact dot while doors are clustered, growing into a ring around the door once
 * they are separate. Deliberately a single flat zoom ramp rather than zoomScaled() wrapping a
 * radius — a zoom interpolation cannot be nested inside another one.
 */
/** A sign's colour from its `kind` (status for a real sign, 'requested' for an unfilled request). */
function signColour(): ExpressionSpecification {
  const pairs: string[] = [];
  for (const [k, c] of Object.entries(SIGN_COLOURS)) pairs.push(k, c);
  return ['match', ['get', 'kind'], ...pairs, SIGN_FALLBACK] as unknown as ExpressionSpecification;
}

function turfMarkRadius(): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    10, 2,
    12.6, 2.6,
    // Between here and 15.2 the mark draws nothing at all (fill faded out, stroke not yet in), so
    // the jump in radius across that gap is free. The ring must clear the door dot, which is doing
    // its own zoom scaling underneath (zoomScaled: x1.0 at z14 rising to x1.5 at z17) — sizing it
    // off baseRadius alone put the ring 1px outside the dot and it read as a thick edge, not a ring.
    15.2, ['+', ['*', baseRadius(), 1.25], 3],
    16.2, ['+', ['*', baseRadius(), 1.4], 4],
    17.5, ['+', ['*', baseRadius(), 1.5], 5],
  ];
}

/**
 * Zero until doors are far enough apart to ring individually, then the given width.
 *
 * The threshold is measured, not guessed. The Ilderton turf is 1,330 doors over ~1540x1806 m, so
 * neighbours sit ~9.6 px apart at z14.5 — narrower than the plain door dot's own diameter. A ring
 * of any width there is a solid mass, so nothing is drawn until ~z15.5, where the same doors are
 * ~25 px apart. Below that the boundary outline is what says "this is the turf".
 */
function turfStrokeWidth(full: number): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], 15.2, 0, 16.2, full * 0.6, 17.5, full];
}

/** `{ w01: ['+', ['case', ['==', ['get','ward'], '01'], 1, 0]], ... }` — one count per ward. */
export const WARD_ACCUMULATORS: Record<string, unknown> = Object.fromEntries(
  Object.keys(WARD_COLOURS).map((w) => [
    `w${w}`,
    ['+', ['case', ['==', ['get', 'ward'], w], 1, 0]],
  ]),
);

/**
 * Colour a cluster by the ward holding the most doors in it. Clusters straddle ward lines, so
 * this is a majority colour, not an exact one — the count label and drilling in stay authoritative.
 * Ties fall to the lowest-numbered ward, which keeps the colour stable as the map is panned.
 */
export function clusterColourExpression(mode: ColourMode): ExpressionSpecification | string {
  if (mode !== 'ward') return CLUSTER_COLOUR;
  const wards = Object.keys(WARD_COLOURS);
  const cases: unknown[] = [];
  for (const w of wards) {
    cases.push(['==', ['get', `w${w}`], ['var', 'top']], WARD_COLOURS[w] as string);
  }
  return [
    'let',
    'top',
    ['max', ...wards.map((w) => ['get', `w${w}`])],
    ['case', ...cases, CLUSTER_COLOUR],
  ] as unknown as ExpressionSpecification;
}

export function colourExpression(mode: ColourMode, communities: string[]): ExpressionSpecification | string {
  switch (mode) {
    case 'ward': {
      const pairs: (string | ExpressionSpecification)[] = [];
      for (const [w, c] of Object.entries(WARD_COLOURS)) pairs.push(w, c);
      return ['match', ['get', 'ward'], ...pairs, '#6b7280'] as unknown as ExpressionSpecification;
    }
    case 'community': {
      if (!communities.length) return '#9aa5b1';
      const pairs: string[] = [];
      for (const c of communities) pairs.push(c, communityColour(communities, c));
      return ['match', ['coalesce', ['get', 'community'], ''], ...pairs, '#9aa5b1'] as unknown as ExpressionSpecification;
    }
    case 'doors': {
      const [s1, s2, s3, s4] = DOOR_STEPS;
      return [
        'step',
        ['coalesce', ['get', 'n'], 1],
        s1?.colour ?? '#9ecae1',
        2,
        s2?.colour ?? '#4292c6',
        3,
        s3?.colour ?? '#1d5fa3',
        5,
        s4?.colour ?? '#0b2e5c',
      ];
    }
    case 'status': {
      // `status` is the latest contact result, or null when the door has never been knocked.
      const pairs: string[] = [];
      for (const [r, c] of Object.entries(RESULT_COLOURS)) pairs.push(r, c);
      return ['match', ['coalesce', ['get', 'status'], ''], ...pairs, NOT_CONTACTED] as unknown as ExpressionSpecification;
    }
    case 'quality':
      return [
        'match',
        ['coalesce', ['get', 'q'], 'good'],
        'good',
        QUALITY_COLOURS.good,
        'approx',
        QUALITY_COLOURS.approx,
        'check',
        QUALITY_COLOURS.check,
        QUALITY_COLOURS.legal,
      ];
    case 'nonres':
      return ['case', ['>', ['coalesce', ['get', 'nonres'], 0], 0], NONRES_HIGHLIGHT, NONRES_MUTED];
  }
}

/** Stroke colour that stays readable on imagery. */
export function strokeForBase(base: BaseLayer): { points: string; ring: string } {
  return base === 'satellite' ? { points: '#ffffff', ring: '#ffffff' } : { points: '#ffffff', ring: '#1a2430' };
}

export function setBaseLayer(map: import('maplibre-gl').Map, base: BaseLayer): void {
  const want = new Set(BASE_LAYER_IDS[base]);
  for (const id of ALL_BASE_LAYER_IDS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', want.has(id) ? 'visible' : 'none');
  }
  const s = strokeForBase(base);
  if (map.getLayer('inst-ring')) map.setPaintProperty('inst-ring', 'circle-stroke-color', s.ring);
  if (map.getLayer('boundary-line')) map.setPaintProperty('boundary-line', 'line-color', base === 'satellite' ? '#ffd166' : BOUNDARY_COLOUR);
  // The turf ring is a dark outline on a light basemap and a light one on imagery, so it stays the
  // brightest thing on the map either way.
  const imagery = base === 'satellite';
  if (map.getLayer('turf-ring')) {
    map.setPaintProperty('turf-ring', 'circle-stroke-color', imagery ? TURF_OUTLINE_ON_IMAGERY : TURF_OUTLINE);
    // The low-zoom dot is a fill, so it needs the same imagery swap as the stroke or the turf
    // disappears into dark aerial photography at exactly the zoom where the dot is all there is.
    map.setPaintProperty('turf-ring', 'circle-color', imagery ? TURF_OUTLINE_ON_IMAGERY : TURF_OUTLINE);
  }
  if (map.getLayer('turf-ring-contrast')) {
    map.setPaintProperty('turf-ring-contrast', 'circle-stroke-color', imagery ? TURF_CONTRAST_ON_IMAGERY : TURF_CONTRAST);
  }
}

// ------------------------------------------------------------------ turf highlight

/** Opacity of a door that is not in the highlighted turf. Low enough to read as background, high
 *  enough that the organizer can still see where the turf sits in the municipality. */
const DIMMED = 0.12;

/**
 * Fade everything that is not in the turf, and leave the turf's own doors untouched.
 *
 * This only ever writes *opacity*, never colour: `circle-color` belongs to the colour mode, so a
 * mode change (which rewrites exactly that property) cannot clear the highlight, and dropping the
 * highlight cannot clear the mode. Pass `null` to put the map back to normal — the values restored
 * here are the ones buildStyle() ships with, which is why they are repeated rather than captured.
 */
export function applyTurfHighlight(map: import('maplibre-gl').Map, ids: string[] | null): void {
  const on = ids !== null;
  // Linear scan per feature, once per data/zoom change rather than per frame; a turf is at most a
  // few thousand ids against ~7k doors, which is well inside the budget for a one-off evaluation.
  const inTurf: ExpressionSpecification = ['in', ['get', 'id'], ['literal', ids ?? []]];

  if (map.getLayer('points')) {
    map.setPaintProperty('points', 'circle-opacity', on ? ['case', inTurf, 1, DIMMED] : 0.9);
    map.setPaintProperty('points', 'circle-stroke-opacity', on ? ['case', inTurf, 1, DIMMED] : 1);
  }
  // A cluster is a mixture of in-turf and out-of-turf doors, so it cannot be split — it is dimmed
  // as a whole. The turf's own doors stay marked because their rings come from the `turf` source,
  // which is never clustered.
  if (map.getLayer('clusters')) {
    map.setPaintProperty('clusters', 'circle-opacity', on ? 0.25 : 0.88);
    map.setPaintProperty('clusters', 'circle-stroke-opacity', on ? 0.25 : 1);
  }
  if (map.getLayer('cluster-count')) map.setPaintProperty('cluster-count', 'text-opacity', on ? 0.35 : 1);
  if (map.getLayer('inst-ring')) map.setPaintProperty('inst-ring', 'circle-stroke-opacity', on ? DIMMED : 1);
}
