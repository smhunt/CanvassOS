/**
 * Unit tests for the pure parts of Phase 5 messaging: segment arithmetic, quiet hours, inbound
 * keyword matching, and retry backoff.
 *
 * No database and no network, so these run anywhere — and unlike the integration suite they need
 * no safety rail, because there is nothing here to destroy.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { isSendable, localTime, nextOpen, parseHhMm, windowFor } from '../src/lib/quiet-hours.js';
import { segmentInfo } from '../src/lib/segments.js';
import { classifyInbound, normalizeKeyword, textToJoinConsent } from '../src/messaging/inbound.js';
import { ProviderError, TwilioProvider } from '../src/messaging/provider.js';
import { backoffMs, MAX_ATTEMPTS } from '../src/messaging/worker.js';

describe('sms segments', () => {
  it('counts a plain GSM-7 body at the Canadian 136 characters per segment', () => {
    assert.deepEqual(segmentInfo('Vote today!'), {
      chars: 11,
      segments: 1,
      encoding: 'GSM-7',
      offending: [],
    });
    // Canada is not the GSM default of 160/153. Twilio documents "GSM 3.38=136" for Canadian long
    // codes; at 160 a 150-character body would read as one segment and bill as two.
    assert.equal(segmentInfo('A'.repeat(136)).segments, 1);
    assert.equal(segmentInfo('A'.repeat(150)).segments, 2, '150 chars is two segments in Canada');
    // 137 no longer fits: the whole message becomes multipart and every segment loses seven
    // septets to the concatenation header, so the limit drops to 129.
    assert.equal(segmentInfo('A'.repeat(137)).segments, 2);
    assert.equal(segmentInfo('A'.repeat(258)).segments, 2);
    assert.equal(segmentInfo('A'.repeat(259)).segments, 3);
  });

  it('an empty body is zero segments, not one', () => {
    assert.deepEqual(segmentInfo(''), { chars: 0, segments: 0, encoding: 'GSM-7', offending: [] });
  });

  /**
   * The trap this whole module exists for. A word processor silently replaces `'` with `’`, the
   * body leaves GSM-7, and the limit collapses from 160 characters to 70 — tripling the bill for
   * every message in the send. The test asserts the offending character is NAMED, because a bare
   * "3 segments" tells an organiser nothing about what to fix.
   */
  it('a curly apostrophe forces UCS-2 and is reported as the offender', () => {
    const straight = "Don't forget to vote on Monday. Polls are open 10am to 8pm at the community centre.";
    const curly = straight.replace("'", '’');

    const a = segmentInfo(straight);
    assert.equal(a.encoding, 'GSM-7');
    assert.equal(a.segments, 1);

    const b = segmentInfo(curly);
    assert.equal(b.encoding, 'UCS-2');
    assert.deepEqual(b.offending, ['’']);
    assert.equal(b.chars, a.chars, 'the same number of characters');
    // Same text, same length — and now two segments instead of one, purely from the quote mark.
    assert.equal(b.segments, 2);
    assert.ok(b.segments > a.segments, 'one keystroke doubled the bill');
  });

  it('reports every distinct offender once, in the order they appear', () => {
    // Worth knowing precisely: `é` and `à` ARE in GSM-7 (as is `Ç`), so French accents are mostly
    // free. What is not free is the typography a word processor inserts — a lower-case `ç`, an em
    // dash, a curly quote — which is exactly the class of character nobody proof-reads for.
    const info = segmentInfo('Réponse: ça ouvre — oui’');
    assert.equal(info.encoding, 'UCS-2');
    assert.deepEqual(info.offending, ['ç', '—', '’']);
    assert.equal(segmentInfo('Réponse: à Ça').encoding, 'GSM-7');
  });

  it('splits a long UCS-2 body at 70/67 units and never inside a surrogate pair', () => {
    assert.equal(segmentInfo('’'.repeat(70)).segments, 1);
    assert.equal(segmentInfo('’'.repeat(71)).segments, 2);
    // An emoji is one character to the person typing it but two UTF-16 units on the wire, so 36
    // of them do not fit a 67-unit segment even though 36 < 67.
    const party = '\u{1F389}';
    assert.equal(segmentInfo(party.repeat(36)).chars, 36);
    assert.equal(segmentInfo(party.repeat(35)).segments, 1);
    assert.equal(segmentInfo(party.repeat(36)).segments, 2);
  });

  it('charges the GSM-7 extension table two septets and does not split an escape pair', () => {
    // `€`, `{`, `}`, `[`, `]`, `~`, `^`, `\` and `|` are ESC + char on the wire.
    assert.equal(segmentInfo('€'.repeat(68)).segments, 1); // 136 septets exactly
    assert.equal(segmentInfo('€'.repeat(69)).segments, 2); // 138 septets
    assert.equal(segmentInfo('€'.repeat(68)).encoding, 'GSM-7', 'the euro sign is GSM-7, unlike é');
    // 128 single-septet characters then five euros: the first euro cannot straddle the 129-septet
    // boundary, so segment one ends a septet short rather than splitting the escape pair.
    const mixed = 'A'.repeat(128) + '€'.repeat(5);
    assert.equal(segmentInfo(mixed).encoding, 'GSM-7');
    assert.equal(segmentInfo(mixed).segments, 2);
  });
});

describe('quiet hours (America/Toronto)', () => {
  const cfg = { start: '09:00', end: '21:30' };

  it('parses and rejects wall-clock bounds', () => {
    assert.equal(parseHhMm('09:00'), 540);
    assert.equal(parseHhMm('21:30'), 1290);
    assert.throws(() => parseHhMm('9:00'));
    assert.throws(() => parseHhMm('24:00'));
  });

  it('narrows the window at weekends rather than replacing it', () => {
    assert.deepEqual(windowFor(2, cfg), { start: 540, end: 1290 }); // Tuesday: as configured
    assert.deepEqual(windowFor(6, cfg), { start: 600, end: 1080 }); // Saturday: 10:00–18:00
    assert.deepEqual(windowFor(0, cfg), { start: 600, end: 1080 }); // Sunday
    // Tightening the configured window tightens the weekend too; it can never widen it back out.
    assert.deepEqual(windowFor(0, { start: '11:00', end: '17:00' }), { start: 660, end: 1020 });
  });

  it('reads the recipient’s own wall clock, through the DST change', () => {
    assert.deepEqual(localTime(new Date('2026-09-08T18:00:00Z')), { weekday: 2, minutes: 14 * 60 }); // EDT
    assert.deepEqual(localTime(new Date('2026-11-10T19:00:00Z')), { weekday: 2, minutes: 14 * 60 }); // EST
  });

  it('permits a weekday afternoon and refuses an early morning or a late night', () => {
    assert.equal(isSendable(new Date('2026-09-08T18:00:00Z'), cfg), true); // Tue 14:00
    assert.equal(isSendable(new Date('2026-09-08T11:00:00Z'), cfg), false); // Tue 07:00
    assert.equal(isSendable(new Date('2026-09-09T02:00:00Z'), cfg), false); // Tue 22:00
  });

  it('applies the narrower weekend window', () => {
    assert.equal(isSendable(new Date('2026-09-06T13:00:00Z'), cfg), false); // Sun 09:00 — too early
    assert.equal(isSendable(new Date('2026-09-06T16:00:00Z'), cfg), true); // Sun 12:00
    assert.equal(isSendable(new Date('2026-09-06T23:00:00Z'), cfg), false); // Sun 19:00 — too late
  });

  it('says exactly when sending may resume', () => {
    // Already open: now.
    const open = new Date('2026-09-08T18:00:00Z');
    assert.equal(nextOpen(open, cfg).getTime(), open.getTime());
    // Tuesday 07:00 → Tuesday 09:00.
    assert.equal(nextOpen(new Date('2026-09-08T11:00:00Z'), cfg).toISOString(), '2026-09-08T13:00:00.000Z');
    // Tuesday 22:00 → Wednesday 09:00.
    assert.equal(nextOpen(new Date('2026-09-09T02:00:00Z'), cfg).toISOString(), '2026-09-09T13:00:00.000Z');
    // Sunday 09:00 → Sunday 10:00 (the weekend opens later).
    assert.equal(nextOpen(new Date('2026-09-06T13:00:00Z'), cfg).toISOString(), '2026-09-06T14:00:00.000Z');
    // Sunday 19:00 → Monday 09:00: a campaign queued on Sunday night waits for the working week.
    assert.equal(nextOpen(new Date('2026-09-06T23:00:00Z'), cfg).toISOString(), '2026-09-07T13:00:00.000Z');
  });
});

describe('inbound keywords', () => {
  it('folds case, spacing, punctuation and accents to one key', () => {
    assert.equal(normalizeKeyword(' Arrêt. '), 'ARRET');
    assert.equal(normalizeKeyword('S T O P'), 'STOP');
    assert.equal(normalizeKeyword('Désabonnement!'), 'DESABONNEMENT');
  });

  it('honours every documented stop word, however it is typed', () => {
    for (const word of [
      'STOP',
      'stop',
      ' Stop ',
      'UNSUBSCRIBE',
      'ARRÊT',
      'ARRET',
      'arrêt',
      'DÉSABONNEMENT',
      'desabonnement',
      'CANCEL',
      'quit',
      'End',
    ]) {
      assert.equal(classifyInbound(word), 'stop', word);
    }
  });

  it('recognises join and help, and leaves everything else alone', () => {
    for (const word of ['JOIN', 'join', 'YES', 'oui', 'START']) assert.equal(classifyInbound(word), 'join', word);
    for (const word of ['HELP', 'help', 'AIDE', 'info']) assert.equal(classifyInbound(word), 'help', word);
    for (const word of ['when is the election?', 'STOP BY THE OFFICE', '', 'yes please']) {
      assert.equal(classifyInbound(word), 'other', JSON.stringify(word));
    }
  });

  it('quotes a text-to-join consent verbatim, because a summarised consent is not a consent', () => {
    assert.match(textToJoinConsent('  Join  '), /^Text-to-join: replied "Join" to the campaign number\.$/);
  });
});

describe('retry backoff', () => {
  it('grows and is capped, and gives up after MAX_ATTEMPTS', () => {
    assert.equal(backoffMs(1), 500);
    assert.equal(backoffMs(2), 1000);
    assert.equal(backoffMs(3), 2000);
    assert.equal(backoffMs(50), 30_000);
    assert.equal(MAX_ATTEMPTS, 5);
  });
});

/**
 * The live provider adapter, driven entirely through an injected `fetch`. Nothing here reaches the
 * network — that is the point of the injection, and it is why no test in this repository can make
 * a real, billed call even when the twilio adapter is the thing under test.
 */
describe('twilio provider adapter (stubbed transport)', () => {
  const CREDS = { accountSid: 'AC0123456789abcdef', authToken: 'test-auth-token' };
  const ok = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts a form-encoded message and reports the provider id and segment count', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new TwilioProvider(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return ok({ sid: 'SM123', num_segments: '2' });
    }, CREDS);

    const result = await provider.send('+15195550134', 'Vote Monday', { from: '+15195550100' });
    assert.deepEqual(result, { providerId: 'SM123', segments: 2 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://api.twilio.com/2010-04-01/Accounts/${CREDS.accountSid}/Messages.json`);
    const sent = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(sent.get('To'), '+15195550134');
    assert.equal(sent.get('From'), '+15195550100');
    assert.equal(sent.get('Body'), 'Vote Monday');
  });

  it('refuses to send without a number from the pool, rather than letting the provider choose one', async () => {
    const provider = new TwilioProvider(async () => ok({ sid: 'SM1' }), CREDS);
    await assert.rejects(provider.send('+15195550134', 'hi'), (err: ProviderError) => {
      assert.equal(err.permanent, true);
      return true;
    });
  });

  /**
   * The distinction the worker depends on. A hard rejection must not be retried: an invalid number
   * never becomes valid, and every retry burns daily cap that a deliverable message needed.
   */
  it('separates a hard rejection from a transient failure', async () => {
    const invalid = new TwilioProvider(async () => ok({ code: 21211, message: "Invalid 'To' number" }, 400), CREDS);
    await assert.rejects(invalid.send('+1', 'x', { from: '+15195550100' }), (err: ProviderError) => {
      assert.equal(err.permanent, true, 'an invalid number is final');
      assert.equal(err.providerCode, '21211');
      return true;
    });

    const throttled = new TwilioProvider(async () => ok({ code: 20429, message: 'Too Many Requests' }, 429), CREDS);
    await assert.rejects(throttled.send('+15195550134', 'x', { from: '+15195550100' }), (err: ProviderError) => {
      assert.equal(err.permanent, false, '429 is worth retrying');
      return true;
    });

    const broken = new TwilioProvider(async () => ok({ message: 'oh dear' }, 503), CREDS);
    await assert.rejects(broken.send('+15195550134', 'x', { from: '+15195550100' }), (err: ProviderError) => {
      assert.equal(err.permanent, false, '5xx is worth retrying');
      return true;
    });

    const offline = new TwilioProvider(async () => {
      throw new Error('ECONNREFUSED');
    }, CREDS);
    await assert.rejects(offline.send('+15195550134', 'x', { from: '+15195550100' }), (err: ProviderError) => {
      assert.equal(err.permanent, false, 'a network failure means the message was never billed or sent');
      return true;
    });
  });

  it('verifies a webhook signature and rejects a tampered or missing one', async () => {
    const provider = new TwilioProvider(async () => ok({}), CREDS);
    const url = 'https://canvass.example/api/messaging/inbound';
    const params = { From: '+15195550134', Body: 'STOP', MessageSid: 'SM9' };
    // Twilio's algorithm: the URL, then every field sorted by name, concatenated as name+value.
    const material = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('');
    const signature = createHmac('sha1', CREDS.authToken).update(material, 'utf8').digest('base64');

    assert.equal(provider.verifyWebhook({ signature, url, params }), true);
    assert.equal(provider.verifyWebhook({ signature: undefined, url, params }), false);
    // A forged JOIN would mint consent for a number of the caller's choosing, so this must fail.
    assert.equal(
      provider.verifyWebhook({ signature, url, params: { ...params, Body: 'JOIN' } }),
      false,
      'changing one field invalidates the signature',
    );
    assert.equal(provider.verifyWebhook({ signature: 'nope', url, params }), false);
  });
});
