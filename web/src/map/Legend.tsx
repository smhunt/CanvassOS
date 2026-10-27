import type { CSSProperties } from 'react';
import { RESULT_LABELS, type ContactResult, type Meta } from '../api/types';
import { titleCase, wardLabel } from '../components/ui';
import {
  CLUSTER_COLOUR,
  DOOR_STEPS,
  HEAT_MODES,
  HEAT_RAMP,
  NONRES_HIGHLIGHT,
  NONRES_MUTED,
  NOT_CONTACTED,
  QUALITY_COLOURS,
  QUALITY_LABELS,
  RESULT_COLOURS,
  communityColour,
  wardColour,
  type ColourMode,
  type HeatMode,
} from './palette';

interface Props {
  mode: ColourMode;
  meta: Meta | undefined;
  zoom: number;
  heat?: HeatMode;
}

/** The ramp as one CSS gradient, so the legend shows exactly the colours the layer paints. */
const HEAT_GRADIENT = `linear-gradient(to right, ${HEAT_RAMP.map(([p, c]) => `${c} ${Math.round(p * 100)}%`).join(', ')})`;

export function Legend({ mode, meta, zoom, heat = 'off' }: Props) {
  const communities = meta?.communities.map((c) => c.community) ?? [];
  let items: { colour: string; label: string }[] = [];
  switch (mode) {
    case 'ward':
      items = (meta?.wards ?? []).map((w) => ({ colour: wardColour(w.ward), label: wardLabel(w.ward) }));
      break;
    case 'community':
      items = communities.slice(0, 8).map((c) => ({ colour: communityColour(communities, c), label: titleCase(c) }));
      if (communities.length > 8) items.push({ colour: '#9aa5b1', label: `+${communities.length - 8} smaller` });
      break;
    case 'doors':
      items = DOOR_STEPS.map((s) => ({ colour: s.colour, label: s.label }));
      break;
    case 'quality':
      items = (['good', 'approx', 'check'] as const).map((q) => ({ colour: QUALITY_COLOURS[q], label: QUALITY_LABELS[q] }));
      break;
    case 'status': {
      // Only the results a canvasser actually records often; the rarer ones would crowd the legend
      // out of a phone screen without telling anyone anything they cannot get from the door card.
      const shown: ContactResult[] = ['spoke', 'not_home', 'left_literature', 'refused'];
      items = shown.map((r) => ({ colour: RESULT_COLOURS[r], label: RESULT_LABELS[r] }));
      items.push({ colour: NOT_CONTACTED, label: 'Not yet knocked' });
      break;
    }
    case 'nonres':
      items = [
        { colour: NONRES_HIGHLIGHT, label: 'Has non-resident owner(s)' },
        { colour: NONRES_MUTED, label: 'Residents only' },
      ];
      break;
  }
  const clustered = zoom < 13;
  const heatMode = heat === 'off' ? null : HEAT_MODES.find((h) => h.id === heat);
  return (
    <div className="legend" aria-label="Legend">
      {heatMode && (
        <div className="legend__heat">
          <div className="legend__heat-bar" style={{ background: HEAT_GRADIENT }} aria-hidden="true" />
          <div className="legend__heat-ends muted small" aria-hidden="true">
            <span>fewer</span>
            <span>more</span>
          </div>
          <p className="muted small legend__note">
            Heat: {heatMode.legend}, per area. The dots on top are still coloured by {mode === 'status' ? 'canvass status' : 'the mode above'}.
          </p>
        </div>
      )}
      {clustered && (
        <div className="legend__item">
          <span className="legend__cluster" style={{ background: CLUSTER_COLOUR }} aria-hidden="true">
            n
          </span>
          <span>Cluster of doors — zoom in or tap to expand</span>
        </div>
      )}
      <ul className="legend__list">
        {items.map((it) => (
          <li key={it.label} className="legend__item">
            <span className="swatch" style={{ '--sw': it.colour } as CSSProperties} aria-hidden="true" />
            <span>{it.label}</span>
          </li>
        ))}
        <li className="legend__item">
          <span className="swatch swatch--ring" aria-hidden="true" />
          <span>Institution / multi-unit</span>
        </li>
        <li className="legend__item">
          <span className="swatch swatch--dash" aria-hidden="true" />
          <span>Municipal boundary</span>
        </li>
      </ul>
      {mode === 'doors' && <p className="muted small legend__note">Dot size also grows with voters per door.</p>}
      {mode === 'status' && (
        <p className="muted small legend__note">Clusters stay ward-coloured; zoom in to see each door&rsquo;s status.</p>
      )}
    </div>
  );
}
