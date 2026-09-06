import type { CSSProperties } from 'react';
import { n } from './ui';

export interface BarDatum {
  label: string;
  value: number;
  colour?: string;
  /** Secondary value drawn as a thinner bar underneath (e.g. voters next to households). */
  value2?: number;
  note?: string;
}

interface Props {
  data: BarDatum[];
  /** Legend labels for value / value2. */
  series: [string] | [string, string];
  colour?: string;
  colour2?: string;
  title: string;
  /** Format for the value column. */
  format?: (v: number) => string;
}

/**
 * Horizontal bar list rendered as inline SVG rows — no chart library. Each row is one <svg> so the
 * layout stays fluid; the numbers are real text (readable, selectable, screen-reader friendly), and
 * a hidden table mirrors the data for assistive tech.
 */
export function HBars({ data, series, colour = 'var(--brand)', colour2 = 'var(--bar-2)', title, format = n }: Props) {
  // Each series is scaled to its own maximum: households and voters are different units, and
  // voters ≈ 2.4 × households everywhere, so a shared scale would flatten the households bars.
  const max = Math.max(1, ...data.map((d) => d.value));
  const max2 = Math.max(1, ...data.map((d) => d.value2 ?? 0));
  const two = series.length === 2;
  return (
    <div className="hbars">
      {two && (
        <div className="hbars__legend" aria-hidden="true">
          <span>
            <i className="swatch swatch--sq" style={{ '--sw': colour } as CSSProperties} /> {series[0]}
          </span>
          <span>
            <i className="swatch swatch--sq" style={{ '--sw': colour2 } as CSSProperties} /> {series[1]}
          </span>
        </div>
      )}
      <div aria-hidden="true">
        {data.map((d) => {
          const w1 = (d.value / max) * 100;
          const w2 = ((d.value2 ?? 0) / max2) * 100;
          const c = d.colour ?? colour;
          return (
            <div key={d.label} className={`hbars__row${two ? ' hbars__row--two' : ''}`}>
              <span className="hbars__label">
                {d.label}
                {d.note && <span className="muted small hbars__note"> {d.note}</span>}
              </span>
              <svg className="hbars__svg" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                <rect x="0" y="0" width="100" height="10" className="hbars__track" />
                <rect x="0" y={two ? 0 : 1} width={w1} height={two ? 5.5 : 8} rx="0.4" fill={c} />
                {two && <rect x="0" y="6" width={w2} height="4" rx="0.4" fill={d.colour ? c : colour2} opacity={d.colour ? 0.45 : 1} />}
              </svg>
              <span className="hbars__value num">
                {format(d.value)}
                {two && d.value2 !== undefined && <span className="muted hbars__value2">{format(d.value2)}</span>}
              </span>
            </div>
          );
        })}
      </div>
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{series[0]}</th>
            {two && <th scope="col">{series[1]}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{format(d.value)}</td>
              {two && <td>{d.value2 === undefined ? '' : format(d.value2)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Vertical histogram (few buckets), also inline SVG with real-text labels. */
export function Histogram({
  data,
  title,
  colour = 'var(--brand)',
  compact,
}: {
  data: { label: string; value: number }[];
  title: string;
  colour?: string;
  compact?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={`hist${compact ? ' hist--compact' : ''}`} role="img" aria-label={`${title}: ${data.map((d) => `${d.label}: ${n(d.value)}`).join(', ')}`}>
      {data.map((d) => (
        <div key={d.label} className="hist__col">
          <span className="hist__value num">{n(d.value)}</span>
          <svg className="hist__svg" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">
            <rect x="0" y="99" width="10" height="1" className="hist__base" />
            <rect x="0" y={100 - (d.value / max) * 100} width="10" height={(d.value / max) * 100} rx="0.6" fill={colour} />
          </svg>
          <span className="hist__label">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
