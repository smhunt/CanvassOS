/**
 * The arithmetic behind the messaging screen — the part the API does not hand us.
 *
 * Two of the three things here exist because of `docs/phase-5-messaging-plan.md` §1:
 *
 *  - Canadian long codes carry ~100–250 messages a day per number and the excess is dropped
 *    *silently*. So "how long will this take?" is a first-class number, not a footnote, and it is
 *    computed from the live sender pool rather than assumed.
 *  - One curly apostrophe forces UCS-2 and triples the bill. The server owns the authoritative
 *    count (it is what the provider bills against), but a counter that only updates on a round
 *    trip is not a live counter — so the same maths runs locally between responses.
 */
import type { Campaign, CampaignStatus, SegmentInfo, SenderNumber } from '../api/types';

// ------------------------------------------------------------------ campaign status

export const STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: 'Draft',
  // 'scheduled' is what approval produces: a human has signed it off but nothing has left yet.
  scheduled: 'Approved',
  sending: 'Sending',
  paused: 'Paused',
  done: 'Finished',
  cancelled: 'Cancelled',
};

/** Tag tone. Never the only signal — the word itself is always rendered next to it. */
export const STATUS_TONE: Record<CampaignStatus, 'neutral' | 'ok' | 'warn'> = {
  draft: 'neutral',
  scheduled: 'ok',
  sending: 'ok',
  paused: 'warn',
  done: 'neutral',
  cancelled: 'warn',
};

/**
 * Approval does not move the campaign out of `draft` — it stamps `approved_by`/`approved_at`, and
 * the send endpoint checks that stamp. So "Draft" and "Approved" are the same status wearing two
 * different faces, and the label has to read the stamp rather than the enum.
 */
export type CampaignState = Pick<Campaign, 'status' | 'scheduled_for' | 'approved_at'>;

export function statusLabel(c: CampaignState): string {
  if (c.status === 'draft') return c.approved_at ? 'Approved' : 'Draft';
  if (c.status === 'scheduled') return c.scheduled_for ? 'Scheduled' : 'Approved';
  return STATUS_LABELS[c.status];
}

export function statusTone(c: CampaignState): 'neutral' | 'ok' | 'warn' {
  if (c.status === 'draft') return c.approved_at ? 'ok' : 'neutral';
  return STATUS_TONE[c.status];
}

/** Approved and not yet started: the only state in which "start the drip" is offered. */
export function awaitingStart(c: CampaignState): boolean {
  return (c.status === 'draft' && c.approved_at !== null) || c.status === 'scheduled';
}

export const PURPOSE_LABELS = { gotv: 'Get out the vote', updates: 'Campaign updates' } as const;

/** Why the purpose is not cosmetic: it selects which consent column a recipient must hold. */
export const PURPOSE_CONSENT = {
  gotv: 'Goes only to people who ticked “ok to remind me to vote”.',
  updates: 'Goes only to people who ticked “ok to send me campaign updates”.',
} as const;

// ------------------------------------------------------------------ progress

export type Progress = Campaign['progress'];

export interface Totals {
  /** Everyone the campaign has a row for — the denominator for every bar on this screen. */
  total: number;
  /** Handed to the provider: sent + delivered + failed. Skipped rows were never attempted. */
  attempted: number;
  /** Everything that is no longer waiting. */
  handled: number;
  remaining: number;
}

export function totals(p: Progress): Totals {
  const total = p.queued + p.sent + p.delivered + p.failed + p.skipped;
  return { total, attempted: p.sent + p.delivered + p.failed, handled: total - p.queued, remaining: p.queued };
}

export function pct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

// ------------------------------------------------------------------ throughput

export interface Capacity {
  /** Active numbers only — an inactive number carries nothing. */
  numbers: number;
  perDay: number;
  sentToday: number;
  leftToday: number;
}

export function poolCapacity(numbers: SenderNumber[] | undefined): Capacity {
  const active = (numbers ?? []).filter((x) => x.active);
  const perDay = active.reduce((a, x) => a + x.daily_cap, 0);
  const sentToday = active.reduce((a, x) => a + x.sent_today, 0);
  return { numbers: active.length, perDay, sentToday, leftToday: Math.max(0, perDay - sentToday) };
}

export interface Estimate {
  /** Further calendar days needed; 0 means it finishes today, Infinity means it never does. */
  days: number;
  date: Date | null;
}

/**
 * When a send of `remaining` messages finishes, given what the pool has left today and its daily
 * ceiling. Deliberately ignores quiet hours: those only ever make it later, so this is the
 * optimistic bound and the UI says so rather than quoting a false precision.
 */
export function finishEstimate(remaining: number, cap: Capacity, now = new Date()): Estimate {
  if (remaining <= 0) return { days: 0, date: now };
  if (cap.perDay <= 0) return { days: Number.POSITIVE_INFINITY, date: null };
  if (remaining <= cap.leftToday) return { days: 0, date: now };
  const extra = Math.ceil((remaining - cap.leftToday) / cap.perDay);
  return { days: extra, date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + extra) };
}

export function describeDays(days: number | null): string {
  // The API sends null for estimated_days when there is no capacity to divide by; Infinity is what
  // the local estimate produces for the same situation. Both mean "this never finishes".
  if (days === null || !Number.isFinite(days)) return 'never — there is no sending capacity';
  if (days <= 0) return 'under a day';
  if (days === 1) return 'about a day';
  return `about ${days} days`;
}

/** Election day. A GOTV drip that lands after the polls close is worthless, and the arithmetic
 *  that says so is not obvious while you are picking an audience — so the composer checks it. */
export const ELECTION_DAY = new Date(2026, 9, 26);

export function landsAfterElection(finish: Date | null): boolean {
  if (!finish) return true; // no capacity at all: it never lands, which is worse
  return finish.getTime() > ELECTION_DAY.getTime();
}

// ------------------------------------------------------------------ segments and encoding

// GSM-7 default alphabet. Everything outside this (and the extension table below) forces UCS-2,
// which drops the per-segment budget from 136 characters to 70.
// Canada is not the GSM default of 160/153: Twilio documents 136 for Canadian long codes
// (https://www.twilio.com/en-us/guidelines/ca/sms). Must stay in step with api/src/lib/segments.ts.
//
// Note that é and à ARE in this alphabet, so the local count treats them as free. The plan (§1.4)
// describes them as forcing UCS-2, which is true of some providers' encoders and not others — if
// the API counts them strictly, its stricter answer is the one the meter settles on, in the safe
// direction (a warning that relaxes, never one that appears after the send).
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞÆæßÉ' +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà';
// These are GSM-7 too but cost two septets each.
const GSM_EXT = '^{}\\[~]|€';

/**
 * The same segment maths the API does, run locally so the counter moves with the keystroke rather
 * than with the network. `useSegments()` overwrites this the moment it answers — the provider
 * bills against the server's number, so the server's number is the one that must be shown at rest.
 */
export function segmentsLocal(text: string): SegmentInfo {
  const chars = [...text];
  let septets = 0;
  const offending: string[] = [];
  for (const ch of chars) {
    if (GSM_BASIC.includes(ch)) septets += 1;
    else if (GSM_EXT.includes(ch)) septets += 2;
    else if (!offending.includes(ch)) offending.push(ch);
  }
  if (offending.length > 0) {
    // UCS-2 is counted in UTF-16 code units, so an emoji costs two.
    const units = text.length;
    return {
      chars: chars.length,
      segments: units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67),
      encoding: 'UCS-2',
      offending,
    };
  }
  return {
    chars: chars.length,
    segments: septets === 0 ? 0 : septets <= 136 ? 1 : Math.ceil(septets / 129),
    encoding: 'GSM-7',
    offending: [],
  };
}

/** What the same text would cost if the offending characters were replaced — the size of the bill. */
export function segmentsIfPlain(text: string): number {
  return segmentsLocal(toPlainPunctuation(text)).segments;
}

const CHAR_NAMES: Record<string, string> = {
  '’': "curly apostrophe ’ — what Word, Pages and iOS type instead of '",
  '‘': 'curly quote ‘',
  '“': 'curly double quote “',
  '”': 'curly double quote ”',
  '–': 'en dash –',
  '—': 'em dash —',
  '…': 'ellipsis … — three dots in one character',
  ' ': 'non-breaking space — invisible, usually pasted from a web page',
  '​': 'zero-width space — invisible',
  '‑': 'non-breaking hyphen',
};

/** Name a character an organiser cannot see, so "why is this suddenly 3 segments?" has an answer. */
export function describeChar(ch: string): string {
  const known = CHAR_NAMES[ch];
  if (known) return known;
  const cp = ch.codePointAt(0) ?? 0;
  return `${ch} (U+${cp.toString(16).toUpperCase().padStart(4, '0')})`;
}

const SMART: [RegExp, string][] = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—‑]/g, '-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
  [/[​‌‍﻿]/g, ''],
];

/**
 * Straighten punctuation only. Accents are deliberately left alone: stripping the é out of a
 * candidate's or a street's name to save a segment is not a fix, it is a different message.
 */
export function toPlainPunctuation(text: string): string {
  return SMART.reduce((s, [re, to]) => s.replace(re, to), text);
}

export function hasSmartPunctuation(text: string): boolean {
  return SMART.some(([re]) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
