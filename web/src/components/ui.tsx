import type { ReactNode } from 'react';
import { errorMessage } from '../api/client';
import type { Role } from '../api/types';

export function Spinner({ size = 20 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div className="fullpage-center" role="status" aria-live="polite">
      <Spinner size={28} />
      {label && <p className="muted">{label}</p>}
    </div>
  );
}

export function ErrorBox({
  title = 'Something went wrong',
  error,
  onRetry,
  compact,
}: {
  title?: string;
  error?: unknown;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`alert alert--danger${compact ? ' alert--compact' : ''}`} role="alert">
      <div>
        <strong>{title}</strong>
        {error !== undefined && <div className="alert__detail">{errorMessage(error)}</div>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function RoleChip({ role }: { role: Role }) {
  return <span className={`chip chip--${role}`}>{role}</span>;
}

/**
 * Every loading shape below takes a `label`.
 *
 * Pass one when the shape *is* the screen's loading state — it is the only thing a screen reader
 * gets, since the bars themselves are decoration. Pass `null` when another shape on the same
 * screen has already announced it: two live regions both saying "loading" is worse than one.
 */
function LoadingRegion({ label, className, children }: { label: string | null; className?: string; children: ReactNode }) {
  // Every shape marks its own bars aria-hidden, so an unannounced one needs no wrapper at all —
  // that keeps the markup of a plain `LoadingRows` exactly what it was before labels existed.
  if (label === null) return className ? <div className={className}>{children}</div> : <>{children}</>;
  return (
    <div className={className} role="status" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}

export function LoadingRows({ rows = 3, label = null }: { rows?: number; label?: string | null }) {
  return (
    <LoadingRegion label={label}>
      <div className="skeleton-list" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    </LoadingRegion>
  );
}

/** Stat tiles (`.tiles`): a row of counts is coming, so reserve tile-sized boxes, not text lines. */
export function LoadingTiles({ count = 4, label = 'Loading…' }: { count?: number; label?: string | null }) {
  return (
    <LoadingRegion label={label}>
      <div className="skeleton-tiles" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="skeleton skeleton--tile" />
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A list of cards (turfs, queue rows, campaigns) — card-height blocks so the page does not jump. */
export function LoadingCards({ count = 3, label = 'Loading…' }: { count?: number; label?: string | null }) {
  return (
    <LoadingRegion label={label}>
      <div className="skeleton-cards" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="skeleton skeleton--card" />
        ))}
      </div>
    </LoadingRegion>
  );
}

/** A table: a header band plus `rows` × `cols` cells, so the columns are where they will land. */
export function LoadingTable({ rows = 5, cols = 4, label = 'Loading…' }: { rows?: number; cols?: number; label?: string | null }) {
  const row = (key: string, head: boolean) => (
    <div key={key} className={`skeleton-table__row${head ? ' skeleton-table__row--head' : ''}`}>
      {Array.from({ length: cols }, (_, c) => (
        <div key={c} className="skeleton skeleton--cell" />
      ))}
    </div>
  );
  return (
    <LoadingRegion label={label}>
      <div className="skeleton-table" aria-hidden="true">
        {row('head', true)}
        {Array.from({ length: rows }, (_, r) => row(`r${r}`, false))}
      </div>
    </LoadingRegion>
  );
}

/** A chart card: a title band over bars of uneven length, which is what a bar chart looks like. */
export function LoadingChart({ bars = 5, label = 'Loading…' }: { bars?: number; label?: string | null }) {
  return (
    <LoadingRegion label={label} className="card skeleton-chart">
      <div className="skeleton skeleton--head" aria-hidden="true" />
      <LoadingRows rows={bars} />
    </LoadingRegion>
  );
}

export const fmt = new Intl.NumberFormat('en-CA');
export const n = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : fmt.format(v));

/** Bare `YYYY-MM-DD` with no zone — how Postgres `date` columns come back (assignment.due_date). */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function fmtDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  // `new Date('2026-10-26')` is parsed as UTC midnight, which is the 25th in Ontario. Split the
  // parts and build a local date so a due date never renders as the day before it is due.
  const d = DATE_ONLY.test(iso)
    ? new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (DATE_ONLY.test(iso)) return d.toLocaleDateString('en-CA', { dateStyle: 'medium' });
  return withTime
    ? d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString('en-CA', { dateStyle: 'medium' });
}

export function wardLabel(w: string): string {
  return `Ward ${String(parseInt(w, 10) || w)}`;
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m) => m.toUpperCase());
}

/**
 * A page-shaped skeleton for a screen whose content is a list.
 *
 * A centred spinner says "something is happening"; a skeleton says "a list of things is coming, and
 * here is roughly how many". On a rural connection that difference is the difference between
 * waiting and reloading — and reloading a turf of 1,330 doors costs the volunteer the whole fetch
 * again. `aria-busy` on the region is what a screen reader gets; the bars themselves are decorative.
 */
export function LoadingList({ rows = 6, label = 'Loading…' }: { rows?: number; label?: string | null }) {
  return (
    <LoadingRegion label={label} className="skeleton-page">
      <div className="skeleton skeleton--head" aria-hidden="true" />
      <LoadingRows rows={rows} />
    </LoadingRegion>
  );
}
