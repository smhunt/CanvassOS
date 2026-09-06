/*
 * Phone parsing for the public opt-in page.
 *
 * This deliberately duplicates the rule in api/src/routes/voter-contacts.ts (`normalizePhone` and
 * the NANP regex). The server stays the authority — it re-validates and it is the thing that must
 * never store a number nobody can dial — but a person standing at a lawn sign in the rain should
 * find out about a typo in the same second they make it, not after a round trip. If the two ever
 * disagree the server wins: a 400 from it is rendered against the same field as a local error.
 */

/** North American numbering plan: area code and exchange both start 2–9. Same rule as the API. */
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;

export type PhoneCheck =
  | { ok: true; e164: string; display: string }
  | { ok: false; reason: string };

/**
 * Accepts what a real person types — `519-555-0134`, `(519) 555 0134`, `519.555.0134`,
 * `+1 519 555 0134`, `15195550134` — and returns one canonical `+1XXXXXXXXXX`.
 *
 * Anything outside the North American plan is refused rather than guessed at: this is a municipal
 * campaign in Middlesex Centre, and a bare seven- or nine-digit string is a typo, not a country
 * code. Every failure carries wording that says what to do next, because a refusal a person cannot
 * act on is the same as no form at all.
 */
export function checkPhone(raw: string): PhoneCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: 'Enter your mobile number so we know where to text.' };

  const digits = trimmed.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;

  if (national.length !== 10) {
    // A number written with a country code that is not +1 is not a typo — it is a number this
    // campaign cannot text at all, and counting its digits would send the person hunting for a
    // mistake they did not make.
    if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) {
      return { ok: false, reason: 'We can only text Canadian and US numbers.' };
    }
    // Otherwise count the digits back to them: "that is 9 digits" is checkable, "invalid" is not.
    return {
      ok: false,
      reason: `That is ${digits.length} digit${digits.length === 1 ? '' : 's'} — a mobile number needs 10, like 519-555-0134.`,
    };
  }
  if (!NANP.test(national)) {
    return { ok: false, reason: 'That is not a number we can text. Check the area code and the first three digits.' };
  }
  return { ok: true, e164: `+1${national}`, display: formatNational(national) };
}

/** `5195550134` → `519-555-0134`, for reading a number back to the person who typed it. */
function formatNational(national: string): string {
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}
