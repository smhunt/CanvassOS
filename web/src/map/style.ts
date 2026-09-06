import type { FeatureCollection } from 'geojson';
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import {
  BOUNDARY_COLOUR,
  CLUSTER_COLOUR,
  DOOR_STEPS,
  NONRES_HIGHLIGHT,
  NONRES_MUTED,
  QUALITY_COLOURS,
  SELECTED_COLOUR,
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
      households: {
        type: 'geojson',
        data: EMPTY_FC,
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 44,
        clusterProperties: { voters: ['+', ['get', 'n']] },
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
      {
        id: 'clusters',
        type: 'circle',
        source: 'households',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': CLUSTER_COLOUR,
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
        paint: { 'text-color': '#ffffff' },
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
}
