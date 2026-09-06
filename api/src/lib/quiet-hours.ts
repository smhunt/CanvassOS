/**
 * When it is acceptable to make somebody's phone buzz.
 *
 * 09:00–21:30 on weekdays, 10:00–18:00 at weekends, America/Toronto — the CRTC telemarketing and
 * ADAD hours. Strictly those rules are about voice calls rather than SMS, so this is stricter than
 * the letter requires; a text at 07:00 costs goodwill regardless of what the rule technically
 * covers, and goodwill is the entire asset a GOTV list represents.
 *
 * Outside the window the send worker WAITS. It does not send late and it does not drop the row:
 * the message stays queued and goes out when the window reopens. That is why this module also
 * answers `nextOpen()` — the worker needs to know how long to sleep, and the campaign dashboard
 * needs to be able to say "resumes 09:00 tomorrow" rather than silently stalling.
 *
 * Everything here is a pure function of a `Date`, so the tests drive it with a fixed clock and
 * never wait on a real one.
 */

/** Minutes past local midnight, from "HH:MM". Used for the two configurable weekday bounds. */
export function parseHhMm(value: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) throw new Error(`invalid time "${value}" (expected HH:MM, 24-hour)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export const CAMPAIGN_TIMEZONE = 'America/Toronto';

/** Weekend hours are the narrow ones, and they are not configurable — see the module comment. */
const WEEKEND_START = 10 * 60; // 10:00
const WEEKEND_END = 18 * 60; // 18:00

export interface QuietHoursConfig {
  /** Weekday window start, "HH:MM" (MESSAGING_QUIET_START, default 09:00). */
  start: string;
  /** Weekday window end, "HH:MM" (MESSAGING_QUIET_END, default 21:30). */
  end: string;
}

export interface LocalTime {
  /** 0 = Sunday … 6 = Saturday, in America/Toronto. */
  weekday: number;
  /** Minutes past local midnight. */
  minutes: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAMPAIGN_TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * The wall-clock reading a recipient would get from their own phone. Goes through Intl rather than
 * a fixed UTC offset because Ontario changes offset twice a year and an election in late October
 * lands one week after the change — a hard-coded -05:00 or -04:00 is wrong for half the campaign.
 */
export function localTime(at: Date): LocalTime {
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of FORMATTER.formatToParts(at)) {
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

export interface Window {
  start: number;
  end: number;
}

/**
 * The window for one local day. The configured bounds are the outer limit; a weekend NARROWS them
 * rather than replacing them, so tightening MESSAGING_QUIET_START to 11:00 tightens Saturday too
 * and can never accidentally widen it back out to the weekday hours.
 */
export function windowFor(weekday: number, cfg: QuietHoursConfig): Window {
  const start = parseHhMm(cfg.start);
  const end = parseHhMm(cfg.end);
  if (weekday === 0 || weekday === 6) {
    return { start: Math.max(start, WEEKEND_START), end: Math.min(end, WEEKEND_END) };
  }
  return { start, end };
}

/** May a message go out at this instant? */
export function isSendable(at: Date, cfg: QuietHoursConfig): boolean {
  const { weekday, minutes } = localTime(at);
  const w = windowFor(weekday, cfg);
  return minutes >= w.start && minutes < w.end;
}

const MINUTE_MS = 60_000;
const addMinutes = (at: Date, minutes: number): Date => new Date(at.getTime() + minutes * MINUTE_MS);

/**
 * The next instant a message may go out — `at` itself when the window is already open. The worker
 * sleeps until this, so a campaign queued at 23:00 on a Friday resumes at 10:00 on the Saturday
 * without anyone touching it.
 */
export function nextOpen(at: Date, cfg: QuietHoursConfig): Date {
  let cursor = at;
  // Eight iterations covers any configuration: a window can be empty on some days (start >= end
  // after the weekend narrowing) but never on all seven.
  for (let i = 0; i < 8; i += 1) {
    const { weekday, minutes } = localTime(cursor);
    const w = windowFor(weekday, cfg);
    if (w.start < w.end) {
      if (minutes < w.start) return addMinutes(cursor, w.start - minutes);
      if (minutes < w.end) return cursor;
    }
    // Past today's window (or today has none): step to just after local midnight and re-ask. The
    // extra minute keeps a DST "spring forward" from landing us back on the same local day.
    cursor = addMinutes(cursor, 1440 - minutes + 1);
  }
  return cursor;
}
