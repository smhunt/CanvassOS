import type { AssignmentStatus, ContactResult, Door } from '../api/types';
import { NOT_CONTACTED, RESULT_COLOURS } from '../map/palette';

export const ASSIGNMENT_LABELS: Record<AssignmentStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  done: 'Done',
};

/** One colour source for the door screen and the map, so a green dot means the same thing on both. */
export const resultColour = (r: ContactResult | null): string => (r ? RESULT_COLOURS[r] : NOT_CONTACTED);

/**
 * The result to show for a door: one recorded on this phone this session wins over the one the
 * server last sent, so the list, the map and the auto-advance agree the instant a door is saved.
 */
export const latestResult = (door: Door, recorded: Record<string, ContactResult>): ContactResult | null =>
  recorded[door.household_id] ?? door.last_result;

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

/**
 * "4 min ago" for the sync panel and the offline banner — the two places a volunteer has to judge
 * how stale what they are looking at is. Short units on purpose: a phone held at arm's length in a
 * driveway is not the place for a full timestamp until the number stops being useful.
 */
export function agoLabel(at: number | null): string {
  if (at === null) return 'not yet this session';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
}
