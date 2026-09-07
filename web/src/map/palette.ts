import type { ContactResult, Quality } from '../api/types';

/** Ward colours (1–5) — shared by the map, legend and stats. */
export const WARD_COLOURS: Record<string, string> = {
  '01': '#2f6fdd',
  '02': '#e0871a',
  '03': '#2a9d6b',
  '04': '#c93c73',
  '05': '#8451c9',
};
export const wardColour = (ward: string): string => WARD_COLOURS[ward] ?? '#6b7280';

/** Categorical palette for communities, assigned in /api/meta order (largest first). */
export const CATEGORICAL = [
  '#2f6fdd',
  '#e0871a',
  '#2a9d6b',
  '#c93c73',
  '#8451c9',
  '#0e9aa7',
  '#b5651d',
  '#5c7c2a',
  '#d94f4f',
  '#6b7280',
  '#a3872a',
  '#3b82a0',
];
export const communityColour = (communities: string[], c: string | null): string => {
  if (!c) return '#9aa5b1';
  const i = communities.indexOf(c);
  return i < 0 ? '#9aa5b1' : (CATEGORICAL[i % CATEGORICAL.length] as string);
};

/** Voters per door — sequential. */
export const DOOR_STEPS: { label: string; min: number; colour: string }[] = [
  { label: '1 voter', min: 1, colour: '#9ecae1' },
  { label: '2', min: 2, colour: '#4292c6' },
  { label: '3–4', min: 3, colour: '#1d5fa3' },
  { label: '5+', min: 5, colour: '#0b2e5c' },
];

export const QUALITY_COLOURS: Record<Quality, string> = {
  good: '#2a9d6b',
  approx: '#e0871a',
  check: '#c93c73',
  legal: '#6b7280',
};
export const QUALITY_LABELS: Record<Quality, string> = {
  good: 'Good (exact address match)',
  approx: 'Approximate location',
  check: 'Needs a check',
  legal: 'Legal description (unmapped)',
};

/** Door status after canvassing. Green = a real conversation, grey = nothing recorded yet. */
export const RESULT_COLOURS: Record<ContactResult, string> = {
  spoke: '#2a9d6b',
  not_home: '#e0871a',
  left_literature: '#0e9aa7',
  refused: '#c93c73',
  moved: '#8451c9',
  inaccessible: '#a3872a',
  do_not_knock: '#7a1f3d',
  deceased: '#6b7280',
};
export const NOT_CONTACTED = '#a9b4c0';

export const NONRES_HIGHLIGHT = '#c93c73';
export const NONRES_MUTED = '#a9b4c0';
export const CLUSTER_COLOUR = '#1f4e79';
export const BOUNDARY_COLOUR = '#1f4e79';
export const SELECTED_COLOUR = '#ffcc33';

/**
 * The ring drawn round the doors of a turf opened with `/map?turf=<id>`. Deliberately NOT a hue:
 * every colour mode already owns the fill of a dot, so the turf marks itself with an outline (dark
 * on a light basemap, light on imagery — swapped in setBaseLayer) and by fading everything else.
 * A coloured ring here would read as another category and fight whatever mode is selected.
 */
export const TURF_OUTLINE = '#101820';
export const TURF_OUTLINE_ON_IMAGERY = '#ffffff';
/** Contrast ring underneath, so the outline survives both a white house dot and dark imagery. */
export const TURF_CONTRAST = '#ffffff';
export const TURF_CONTRAST_ON_IMAGERY = 'rgba(8, 14, 20, 0.75)';

/**
 * Lawn signs on the map. These are campaign property, not electors, so they get saturated hues that
 * deliberately do not appear in any household colour mode — a sign must never be mistaken for a door.
 *
 * `requested` is a door that asked for a sign and has not been given one: it is a job to do, so it
 * is the one that shouts. The three trouble states share a colour because the action is the same
 * (go and look at it); `removed` is muted because it is finished work.
 */
export const SIGN_COLOURS: Record<string, string> = {
  requested: '#e07b12',
  placed: '#12855a',
  missing: '#d12f2f',
  damaged: '#d12f2f',
  removed: '#8a94a0',
};
export const SIGN_FALLBACK = '#8a94a0';

export type ColourMode = 'ward' | 'community' | 'doors' | 'quality' | 'nonres' | 'status';

export const COLOUR_MODES: { id: ColourMode; label: string; organizerOnly?: boolean }[] = [
  { id: 'ward', label: 'Ward' },
  { id: 'community', label: 'Community' },
  { id: 'doors', label: 'Voters per door' },
  { id: 'quality', label: 'Record quality', organizerOnly: true },
  { id: 'nonres', label: 'Non-resident owners', organizerOnly: true },
  { id: 'status', label: 'Canvass status' },
];

export type BaseLayer = 'light' | 'streets' | 'satellite';
export const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  // CARTO watermarks anonymous tiles with "API KEY REQUIRED"; kept for anyone who adds a
  // key, but 'streets' is the default because OSM and Esri need none.
  { id: 'light', label: 'Light (needs a CARTO key)' },
  { id: 'streets', label: 'Streets' },
  { id: 'satellite', label: 'Satellite' },
];
