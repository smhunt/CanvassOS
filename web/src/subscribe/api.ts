/*
 * The one call this page makes.
 *
 * Written against `fetch` rather than `src/api/client.ts` on purpose: this is the only
 * unauthenticated endpoint in the app, so the shared client's 401 handling (which clears the
 * session and bounces to /login) is not merely unnecessary here, it would be wrong — a passer-by
 * has no session to clear.
 *
 * Failure is returned, not thrown, as a small closed set of outcomes. Every one of them has to be
 * something a person can read and act on, so the caller is made to handle each: an opt-in page that
 * says "Error: 500" has taken someone's number and told them nothing.
 */

export type SubscribeRequest = {
  phone: string;
  wants_gotv: boolean;
  wants_updates: boolean;
  consent_text: string;
};

export type SubscribeOutcome =
  /** 202: a pending record exists and a confirmation text is on its way. Nothing is consented yet. */
  | { kind: 'accepted' }
  /** The server rejected the number itself; `message` is its wording, shown against the field. */
  | { kind: 'invalid_phone'; message: string }
  /** 429 by IP. Not the visitor's fault and not permanent — say so. */
  | { kind: 'rate_limited' }
  /** The request never reached the server (no signal, captive wifi). Safe to retry. */
  | { kind: 'offline' }
  /** Anything else. The number was not saved; the only honest thing to offer is another try. */
  | { kind: 'failed'; message: string };

export async function submitSubscription(body: SubscribeRequest): Promise<SubscribeOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/subscribe', {
      method: 'POST',
      // A volunteer may well have the canvassing app signed in on this phone while holding it out
      // to a stranger at a door. Sending no cookie keeps the opt-in anonymous and self-collected,
      // which is what the record has to say it is.
      credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // fetch only rejects when the request never completed — that is a connection problem, not a
    // rejection of the number, so it must not read like one.
    return { kind: 'offline' };
  }

  // 202 is the documented success. Treat every 2xx alike: the endpoint deliberately answers the
  // same way whether or not the number is already known, and this page must not leak the
  // difference by rendering anything else.
  if (res.ok) return { kind: 'accepted' };
  if (res.status === 429) return { kind: 'rate_limited' };

  const err = await readError(res);
  if (res.status === 400 && (err.code === 'invalid_phone' || err.code === 'validation_error')) {
    return { kind: 'invalid_phone', message: err.message ?? 'That is not a number we can text.' };
  }
  return { kind: 'failed', message: err.message ?? 'The sign-up did not go through.' };
}

/** The API's error envelope is `{ error: { code, message } }`; a proxy or gateway may send neither. */
async function readError(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const data: unknown = await res.json();
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    return { code: e?.code, message: e?.message };
  } catch {
    return {};
  }
}
