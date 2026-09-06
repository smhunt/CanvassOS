import { useEffect, useRef, type CSSProperties } from 'react';
import type { PointFilters } from '../api/hooks';
import type { Meta, Quality } from '../api/types';
import { n, titleCase, wardLabel } from '../components/ui';
import { QUALITY_COLOURS, QUALITY_LABELS, communityColour, wardColour } from './palette';

interface Props {
  open: boolean;
  onClose: () => void;
  meta: Meta | undefined;
  filters: PointFilters;
  onChange: (f: PointFilters) => void;
  organizer: boolean;
}

const QUALITIES: Quality[] = ['good', 'approx', 'check'];

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export function countActive(f: PointFilters): number {
  return f.ward.length + f.community.length + f.quality.length;
}

export function FiltersDrawer({ open, onClose, meta, filters, onChange, organizer }: Props) {
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const communities = meta?.communities.map((c) => c.community) ?? [];
  const active = countActive(filters);

  return (
    <>
      <div className="scrim scrim--drawer" onClick={onClose} aria-hidden="true" />
      <aside className="card drawer" role="dialog" aria-modal="true" aria-labelledby="filters-h">
        <header className="drawer__head">
          <h2 id="filters-h">Filters</h2>
          <div className="row">
            {active > 0 && (
              <button type="button" className="btn btn--small" onClick={() => onChange({ ward: [], community: [], quality: [] })}>
                Clear {active}
              </button>
            )}
            <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close filters">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <line x1="5" y1="5" x2="19" y2="19" />
                <line x1="19" y1="5" x2="5" y2="19" />
              </svg>
            </button>
          </div>
        </header>
        <div className="drawer__body">
          <fieldset className="fs">
            <legend>Ward</legend>
            {meta ? (
              meta.wards.map((w, i) => (
                <label key={w.ward} className="check">
                  <input
                    ref={i === 0 ? firstRef : undefined}
                    type="checkbox"
                    checked={filters.ward.includes(w.ward)}
                    onChange={() => onChange({ ...filters, ward: toggle(filters.ward, w.ward) })}
                  />
                  <span className="swatch" style={{ '--sw': wardColour(w.ward) } as CSSProperties} aria-hidden="true" />
                  <span className="check__label">{wardLabel(w.ward)}</span>
                  <span className="check__count muted">
                    {n(w.n_households)} · {n(w.n_voters)}
                  </span>
                </label>
              ))
            ) : (
              <p className="muted small">Loading…</p>
            )}
          </fieldset>

          <fieldset className="fs">
            <legend>Community</legend>
            {meta ? (
              meta.communities.map((c) => (
                <label key={c.community} className="check">
                  <input
                    type="checkbox"
                    checked={filters.community.includes(c.community)}
                    onChange={() => onChange({ ...filters, community: toggle(filters.community, c.community) })}
                  />
                  <span className="swatch" style={{ '--sw': communityColour(communities, c.community) } as CSSProperties} aria-hidden="true" />
                  <span className="check__label">{titleCase(c.community)}</span>
                  <span className="check__count muted">
                    {n(c.n_households)} · {n(c.n_voters)}
                  </span>
                </label>
              ))
            ) : (
              <p className="muted small">Loading…</p>
            )}
          </fieldset>

          {organizer && (
            <fieldset className="fs">
              <legend>Record quality</legend>
              {QUALITIES.map((q) => (
                <label key={q} className="check">
                  <input
                    type="checkbox"
                    checked={filters.quality.includes(q)}
                    onChange={() => onChange({ ...filters, quality: toggle(filters.quality, q) })}
                  />
                  <span className="swatch" style={{ '--sw': QUALITY_COLOURS[q] } as CSSProperties} aria-hidden="true" />
                  <span className="check__label">{QUALITY_LABELS[q]}</span>
                </label>
              ))}
              <p className="muted small fs__note">Legal-description parcels have no map point; see “unmapped parcels” in the legend.</p>
            </fieldset>
          )}
          <p className="muted small">Counts are doors · voters for the whole municipality.</p>
        </div>
      </aside>
    </>
  );
}
