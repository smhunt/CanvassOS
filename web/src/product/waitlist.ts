/*
 * The product waitlist call, made from the public page behind the sign-in dialog.
 *
 * Like `subscribe/api.ts`, this uses `fetch` directly rather than `src/api/client.ts`: the visitor
 * has no session, and the shared client's 401 handling would bounce them around for nothing. No
 * cookie is sent, so a volunteer who is signed in on this browser and fills the form in for
 * somebody else does not tie that person's interest to their own account.
 *
 * Failure is returned, not thrown, as a small closed set of outcomes the form has to handle.
 * The server answers the same way whether an email is new or already on the list, so the page
 * shows one success state and never anything that would tell the two apart.
 */

export const ROLES = [
  { value: 'candidate', label: 'Candidate' },
  { value: 'campaign_manager', label: 'Campaign manager' },
  { value: 'volunteer_coordinator', label: 'Volunteer coordinator' },
  { value: 'other', label: 'Something else' },
] as const;

export const ELECTIONS = [
  { value: '2026', label: '2026' },
  { value: '2027', label: '2027' },
  { value: '2028', label: '2028' },
  { value: '2029', label: '2029' },
  { value: '2030', label: '2030' },
  { value: 'unsure', label: 'Not sure yet' },
] as const;

export const PROVINCES = ['ON', 'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'PE', 'QC', 'SK', 'YT'] as const;

/**
 * The words beside the tick box. The form renders this string and posts the same string as
 * `consent_text`, so the stored record says exactly what the person agreed to.
 */
/**
 * Who is asking for consent, as CASL requires a consent request to say: a name, and a way to reach
 * them, and a mailing address. Ecoworks is the business name of Web Architecture Inc.
 */
export const SENDER = { name: 'Ecoworks', legal: 'Web Architecture Inc.', email: 'getstarted@ecoworks.ca' } as const;
export const MAILING_ADDRESS = '2 Mayapple Crescent, Ilderton, ON';

export const CONSENT_TEXT =
  `Email me from ${SENDER.name} (${SENDER.email}) when CanvassOS opens to new campaigns, and occasionally ` +
  'before then about how it is coming along. I can unsubscribe at any time.';

export type WaitlistRequest = {
  email: string;
  name: string;
  role: (typeof ROLES)[number]['value'];
  municipality: string;
  province: (typeof PROVINCES)[number];
  next_election: (typeof ELECTIONS)[number]['value'];
  notes?: string;
  consent_text: string;
  /** Honeypot. Hidden from people; a bot that fills every field gets a quiet success and no row. */
  website?: string;
};

export type WaitlistOutcome =
  | { kind: 'joined'; message: string }
  /** The server rejected a field; `message` is its wording. */
  | { kind: 'invalid'; message: string }
  | { kind: 'rate_limited' }
  /** The request never reached the server. Safe to retry. */
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

export const JOINED_FALLBACK = "You're on the list. We'll email you when CanvassOS opens to new campaigns.";

export async function joinWaitlist(body: WaitlistRequest, fetchImpl: typeof fetch = fetch): Promise<WaitlistOutcome> {
  let res: Response;
  try {
    res = await fetchImpl('/api/waitlist', {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'offline' };
  }

  const data = (await res.json().catch(() => null)) as {
    message?: string;
    error?: { code?: string; message?: string };
  } | null;
  if (res.ok) return { kind: 'joined', message: data?.message || JOINED_FALLBACK };
  if (res.status === 429) return { kind: 'rate_limited' };
  if (res.status === 400) {
    return {
      kind: 'invalid',
      message: data?.error?.message || 'Check the form: one of the answers was not accepted.',
    };
  }
  return {
    kind: 'failed',
    message: data?.error?.message || `The server answered ${res.status}.`,
  };
}

/** What the form shows for each outcome other than success. */
export function outcomeText(o: Exclude<WaitlistOutcome, { kind: 'joined' }>): string {
  switch (o.kind) {
    case 'invalid':
      return o.message;
    case 'rate_limited':
      return 'Too many sign-ups from this connection. Wait an hour and try again.';
    case 'offline':
      return 'Could not reach CanvassOS. Check your connection and try again; nothing was saved.';
    case 'failed':
      return `Your details were not saved. ${o.message} Try again in a minute.`;
  }
}
