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

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
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
