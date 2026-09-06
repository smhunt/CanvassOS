const RTF = new Intl.RelativeTimeFormat('en-CA', { numeric: 'auto' });
const DAY_MS = 86_400_000;

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * "3 days ago" / "yesterday" — an organiser scanning for a stalled volunteer wants the gap, not the
 * timestamp. Compared as whole calendar days, so a 9pm knock checked at 8am next morning reads as
 * "yesterday" rather than "11 hours ago".
 */
export function relativeDay(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  return RTF.format(Math.round((startOfDay(then) - startOfDay(new Date())) / DAY_MS), 'day');
}

/** Whole days since `iso`, or null when it never happened — drives the "gone quiet" highlight. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.round((startOfDay(new Date()) - startOfDay(then)) / DAY_MS);
}

const pad = (v: number): string => String(v).padStart(2, '0');

export interface DayBucket {
  /** `YYYY-MM-DD`, matching `Activity.by_day[].day`. */
  key: string;
  label: string;
  contacts: number;
}

/**
 * A continuous run of the last `days` calendar days. `/api/activity` only returns days that had a
 * contact, and a gap in the bars is exactly what an organiser needs to see, so the zeroes are
 * filled back in here.
 */
export function fillDays(byDay: { day: string; contacts: number }[], days: number): DayBucket[] {
  const counts = new Map(byDay.map((d) => [d.day, d.contacts]));
  const today = new Date();
  const out: DayBucket[] = [];
  // Histogram keys its columns by label, so every label has to be distinct: a 30-day window can
  // hold the same day-of-month twice (31 Jan → 1 Mar). Month-qualify the repeat when it happens.
  const seen = new Set<string>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const bare = String(d.getDate());
    const label =
      i === days - 1 || d.getDate() === 1 || seen.has(bare)
        ? `${d.toLocaleDateString('en-CA', { month: 'short' })} ${d.getDate()}`
        : bare;
    seen.add(label);
    out.push({ key, label, contacts: counts.get(key) ?? 0 });
  }
  return out;
}
