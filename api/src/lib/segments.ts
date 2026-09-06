/**
 * SMS segment arithmetic — GSM-7 vs UCS-2.
 *
 * This exists because of one content trap that costs real money (docs/phase-5-messaging-plan.md
 * §1.4): a single character outside the GSM-7 alphabet forces the WHOLE message into UCS-2, and the
 * per-segment limit collapses from 160 characters to 70. A body that was one segment becomes two or
 * three, on every recipient, produced by a keystroke nobody noticed.
 *
 * One correction to the plan, which matters when you are deciding what to warn about: `é`, `à` and
 * `Ç` are IN the GSM-7 alphabet and cost nothing. The characters that actually bite are the ones a
 * word processor inserts on your behalf — the curly apostrophe `’` it substitutes for `'`, the em
 * dash `—` it substitutes for `--`, smart quotes `“ ”` — plus a lower-case `ç` or `œ`. Those are
 * invisible in a proof-read and identical on screen to the characters they replaced.
 *
 * So the composer needs more than a count: it needs the *offending characters themselves*, named,
 * so the organiser can see that the problem is a smart quote and replace it. `offending` is the
 * whole point of this module; `segments` is just the number it justifies.
 *
 * The maths (3GPP TS 23.038):
 *   GSM-7  — 160 septets in a single message, 153 once it is multipart (the UDH concatenation
 *            header eats 7). Ten characters (`^ { } \ [ ~ ] | €` and form feed) are "extended":
 *            they are sent as ESC + char and therefore cost TWO septets each.
 *   UCS-2  — 70 UTF-16 code units single, 67 multipart. An emoji or any astral character is a
 *            surrogate pair and costs two units.
 *
 * Neither an escape pair nor a surrogate pair may be split across a segment boundary, which is why
 * the packing below is a loop rather than a division.
 */

/** The GSM 03.38 basic alphabet, in code order (0x1B ESC omitted — it is the escape, not a character). */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅå' +
  'Δ_ΦΓΛΩΠΨΣΘΞ' +
  'ÆæßÉ' +
  ' !"#¤%&\'()*+,-./' +
  '0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNO' +
  'PQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmno' +
  'pqrstuvwxyzäöñüà';

/** Sent as ESC + char: two septets each. `€` is the expensive one people forget. */
const GSM7_EXTENDED = '\f^{}\\[~]|€';

const BASIC = new Set(GSM7_BASIC.split(''));
const EXTENDED = new Set(GSM7_EXTENDED.split(''));

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SegmentInfo {
  /** Unicode code points, not UTF-16 units — an emoji is one character to the person typing it. */
  chars: number;
  segments: number;
  encoding: SmsEncoding;
  /**
   * The distinct characters that forced UCS-2, in order of first appearance. Empty for a GSM-7
   * body. This is the field the composer shows: "your message contains ’ and —".
   */
  offending: string[];
}

/** How many characters of `offending` are worth returning; a body that is entirely non-GSM needs no list. */
const MAX_OFFENDING = 20;

// Canada is NOT the GSM default of 160/153. Twilio's Canada SMS guidelines state, for both inbound
// and outbound long codes: "GSM 3.38=136, Unicode=70".
//   https://www.twilio.com/en-us/guidelines/ca/sms  (verified 2026-09-06)
// This matters in money: at 160 a 150-character body reads as one segment and is billed as two.
// Over-counting only makes an organiser write shorter copy; under-counting surprises them with a
// doubled bill and a message the carrier splits anyway, so we take the documented Canadian figure.
const GSM7_SINGLE = 136;
// Twilio documents only the single-message limit. 7 septets of the 136 go to the concatenation
// header, exactly as 160 becomes 153 in the GSM default — inferred, not documented, and deliberately
// the conservative direction.
const GSM7_MULTI = 129;
const UCS2_SINGLE = 70;
const UCS2_MULTI = 67;

/**
 * Pack per-character costs into segments without ever splitting a character's own units across a
 * boundary. Returns 1 while the whole body fits the single-message limit.
 */
function pack(costs: number[], single: number, multi: number): number {
  let total = 0;
  for (const c of costs) total += c;
  if (total === 0) return 0;
  if (total <= single) return 1;
  let segments = 1;
  let used = 0;
  for (const c of costs) {
    if (used + c > multi) {
      segments += 1;
      used = c;
    } else {
      used += c;
    }
  }
  return segments;
}

/** Characters, segments, encoding, and — the reason this function exists — what broke GSM-7. */
export function segmentInfo(text: string): SegmentInfo {
  const chars = [...text];
  const offending: string[] = [];
  const seen = new Set<string>();
  const septets: number[] = [];
  let gsm = true;

  for (const ch of chars) {
    if (BASIC.has(ch)) {
      septets.push(1);
    } else if (EXTENDED.has(ch)) {
      septets.push(2);
    } else {
      gsm = false;
      if (!seen.has(ch) && offending.length < MAX_OFFENDING) {
        seen.add(ch);
        offending.push(ch);
      }
    }
  }

  if (gsm) {
    return { chars: chars.length, segments: pack(septets, GSM7_SINGLE, GSM7_MULTI), encoding: 'GSM-7', offending: [] };
  }
  // One offending character re-encodes the ENTIRE body, so the cost is recomputed from scratch in
  // UTF-16 units — this is exactly the tripling the composer has to warn about.
  const units = chars.map((ch) => ch.length);
  return { chars: chars.length, segments: pack(units, UCS2_SINGLE, UCS2_MULTI), encoding: 'UCS-2', offending };
}
