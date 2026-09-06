import type { CSSProperties } from 'react';
import type { Meta } from '../api/types';
import { titleCase, wardLabel } from '../components/ui';
import {
  CLUSTER_COLOUR,
  DOOR_STEPS,
  NONRES_HIGHLIGHT,
  NONRES_MUTED,
  QUALITY_COLOURS,
  QUALITY_LABELS,
  communityColour,
  wardColour,
  type ColourMode,
} from './palette';

interface Props {
  mode: ColourMode;
  meta: Meta | undefined;
  zoom: number;
}

export function Legend({ mode, meta, zoom }: Props) {
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
    case 'nonres':
      items = [
        { colour: NONRES_HIGHLIGHT, label: 'Has non-resident owner(s)' },
        { colour: NONRES_MUTED, label: 'Residents only' },
      ];
      break;
  }
  const clustered = zoom < 13;
  return (
    <div className="legend" aria-label="Legend">
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
    </div>
  );
}
