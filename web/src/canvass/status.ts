import type { AssignmentStatus, ContactResult } from '../api/types';
import { NOT_CONTACTED, RESULT_COLOURS } from '../map/palette';

export const ASSIGNMENT_LABELS: Record<AssignmentStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
};

/** One colour source for the door screen and the map, so a green dot means the same thing on both. */
export const resultColour = (r: ContactResult | null): string => (r ? RESULT_COLOURS[r] : NOT_CONTACTED);

export const pct = (done: number, total: number): number => (total > 0 ? Math.round((done / total) * 100) : 0);

/**
 * `due_date` arrives as a bare YYYY-MM-DD. `new Date()` would read that as UTC midnight and show the
 * previous day in Ontario, so build the date from its parts instead.
 */
export function fmtDueDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', { dateStyle: 'medium' });
}
