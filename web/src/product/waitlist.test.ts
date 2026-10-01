/** Unit tests for the waitlist call: what is sent, and the outcome for each answer (no DOM, no network). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONSENT_TEXT,
  JOINED_FALLBACK,
  MAILING_ADDRESS,
  joinWaitlist,
  outcomeText,
  type WaitlistRequest,
} from './waitlist';

const body: WaitlistRequest = {
  email: 'pat@example.com',
  name: 'Pat',
  role: 'campaign_manager',
  municipality: 'Lucan Biddulph',
  province: 'ON',
  next_election: '2030',
  consent_text: CONSENT_TEXT,
};

function fakeFetch(answer: () => Promise<Response> | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('joinWaitlist', () => {
  it('posts the form as JSON, without the session cookie', async () => {
    const f = fakeFetch(() => json(200, { ok: true, message: 'On the list.' }));
    const out = await joinWaitlist(body, f.impl);
    assert.deepEqual(out, { kind: 'joined', message: 'On the list.' });
    assert.equal(f.calls[0]?.url, '/api/waitlist');
    assert.equal(f.calls[0]?.init.method, 'POST');
    assert.equal(f.calls[0]?.init.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(f.calls[0]?.init.body)), body);
  });

  it('falls back to its own success words when the server sends none', async () => {
    const out = await joinWaitlist(body, fakeFetch(() => new Response('', { status: 201 })).impl);
    assert.deepEqual(out, { kind: 'joined', message: JOINED_FALLBACK });
  });

  it('passes a validation message through', async () => {
    const out = await joinWaitlist(body, fakeFetch(() => json(400, { error: { message: 'email is not valid' } })).impl);
    assert.deepEqual(out, { kind: 'invalid', message: 'email is not valid' });
    const bare = await joinWaitlist(body, fakeFetch(() => new Response('nope', { status: 400 })).impl);
    assert.equal(bare.kind, 'invalid');
  });

  it('names a rate limit, a dropped connection and a server failure separately', async () => {
    assert.deepEqual(await joinWaitlist(body, fakeFetch(() => json(429, {})).impl), { kind: 'rate_limited' });
    assert.deepEqual(
      await joinWaitlist(
        body,
        fakeFetch(() => {
          throw new TypeError('Failed to fetch');
        }).impl,
      ),
      { kind: 'offline' },
    );
    assert.deepEqual(await joinWaitlist(body, fakeFetch(() => json(500, {})).impl), {
      kind: 'failed',
      message: 'The server answered 500.',
    });
  });
});

describe('CONSENT_TEXT', () => {
  it('names who is asking and how to reach them, as CASL requires', () => {
    assert.match(CONSENT_TEXT, /Ecoworks \(getstarted@ecoworks\.ca\)/);
    assert.ok(MAILING_ADDRESS.length > 0, 'CASL needs a mailing address on the request');
    assert.ok(CONSENT_TEXT.length >= 20 && CONSENT_TEXT.length <= 1000, 'the API accepts 20 to 1000 characters');
  });
});

describe('outcomeText', () => {
  it('gives every failure a sentence a person can act on', () => {
    assert.equal(outcomeText({ kind: 'invalid', message: 'email is not valid' }), 'email is not valid');
    assert.match(outcomeText({ kind: 'rate_limited' }), /Wait an hour/);
    assert.match(outcomeText({ kind: 'offline' }), /nothing was saved/);
    assert.match(
      outcomeText({ kind: 'failed', message: 'The server answered 500.' }),
      /not saved\. The server answered 500\./,
    );
  });
});
