import type { Quality } from '../api/types';

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

export const NONRES_HIGHLIGHT = '#c93c73';
export const NONRES_MUTED = '#a9b4c0';
export const CLUSTER_COLOUR = '#1f4e79';
export const BOUNDARY_COLOUR = '#1f4e79';
export const SELECTED_COLOUR = '#ffcc33';

export type ColourMode = 'ward' | 'community' | 'doors' | 'quality' | 'nonres';

export const COLOUR_MODES: { id: ColourMode; label: string; organizerOnly?: boolean }[] = [
  { id: 'ward', label: 'Ward' },
  { id: 'community', label: 'Community' },
  { id: 'doors', label: 'Voters per door' },
  { id: 'quality', label: 'Record quality', organizerOnly: true },
  { id: 'nonres', label: 'Non-resident owners', organizerOnly: true },
];

export type BaseLayer = 'light' | 'streets' | 'satellite';
export const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'streets', label: 'Streets' },
  { id: 'satellite', label: 'Satellite' },
];
