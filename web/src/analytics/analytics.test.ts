import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _bufferSize, _resetForTests, configure, flush, identify, optedOut, reset, screenFor, setOptedOut, setUser, track } from './index';

// The tracker reads window/navigator/localStorage/fetch at call time, never at import, so each is
// a hand-made fake here — no DOM library, matching speech.test.ts. What these tests hold the module
// to is the relay's contract: the envelope's regexes, and that no path, query or id ever leaves.

const ME = '2f1c0d7e-8a4b-4c3d-9e2f-0a1b2c3d4e5f';
const OTHER = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TURF = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

let sent: { url: string; init: RequestInit; body: unknown }[];
let beacons: { url: string; blob: Blob }[];
let store: Map<string, string>;
let listeners: Record<string, (() => void)[]>;
let fetchImpl: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
let onLine: boolean;

function install() {
  sent = [];
  beacons = [];
  store = new Map();
  listeners = {};
  onLine = true;
  fetchImpl = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body as string) });
    return { ok: true, status: 200 };
  };
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  g.window = {
    addEventListener: (name: string, fn: () => void) => (listeners[name] ??= []).push(fn),
    document: { addEventListener: () => {}, visibilityState: 'visible' },
  };
  Object.defineProperty(g, 'navigator', {
    configurable: true,
    value: {
      get onLine() {
        return onLine;
      },
      language: 'en-CA',
      sendBeacon: (url: string, blob: Blob) => {
        beacons.push({ url, blob });
        return true;
      },
    },
  });
  g.fetch = (url: string, init: RequestInit) => fetchImpl(url, init);
  _resetForTests();
}

const fire = (name: string) => (listeners[name] ?? []).forEach((fn) => fn());
const events = (i = 0) => (sent[i]!.body as { events: Record<string, unknown>[] }).events;

beforeEach(install);

// ---------------------------------------------------------------- screenFor: pattern in, pattern out

test('screenFor returns the route pattern, never the path', () => {
  assert.deepEqual(screenFor(`/canvass/${TURF}/drive`), { route: '/canvass/:turfId/drive' });
  assert.deepEqual(screenFor(`/canvass/${TURF}`), { route: '/canvass/:turfId' });
  assert.deepEqual(screenFor(`/turfs/${TURF}/sheet`), { route: '/turfs/:turfId/sheet' });
  assert.deepEqual(screenFor('/map'), { route: '/map' });
  assert.deepEqual(screenFor('/admin/users'), { route: '/admin/users' });
  assert.deepEqual(screenFor('/nowhere'), { route: 'not_found' });
  assert.deepEqual(screenFor('/canvass/'), { route: '/canvass' });
  assert.ok(!JSON.stringify(screenFor(`/canvass/${TURF}/drive`)).includes(TURF));
});

test('screenFor passes a known tab id on the tabbed screens and nothing else from the query', () => {
  assert.deepEqual(screenFor('/reports', '?tab=coverage'), { route: '/reports', tab: 'coverage' });
  assert.deepEqual(screenFor('/signs', '?tab=place&address=12+Main+St'), { route: '/signs', tab: 'place' });
  assert.deepEqual(screenFor('/reports', '?tab=bogus'), { route: '/reports' });
  assert.deepEqual(screenFor('/reports', '?days=30'), { route: '/reports' });
  // A tab on a screen that has none is not forwarded either.
  assert.deepEqual(screenFor('/map', '?tab=place'), { route: '/map' });
});

// ---------------------------------------------------------------- the envelope, against the relay's regexes

test('a tracked event goes up in the relay envelope, stamped with the signed-in user', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('screen_viewed', { ...screenFor(`/canvass/${TURF}`), breakpoint: 'phone' });
  await flush();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, '/api/analytics/events');
  assert.equal(sent[0]!.init.credentials, 'same-origin');
  const e = events()[0]!;
  assert.equal(e.event_type, 'screen_viewed');
  assert.equal(e.user_id, ME);
  assert.match(e.device_id as string, /^[A-Za-z0-9._-]{5,100}$/);
  assert.match(e.insert_id as string, /^[A-Za-z0-9._-]{1,100}$/);
  assert.match(e.app_version as string, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  assert.equal(e.language, 'en-CA');
  assert.equal(typeof e.time, 'number');
  assert.equal(typeof e.session_id, 'number');
  assert.deepEqual(e.event_properties, { route: '/canvass/:turfId', breakpoint: 'phone' });
  // The turf id went into screenFor and must not have come out anywhere in the upload.
  assert.ok(!(sent[0]!.init.body as string).includes(TURF));
  assert.equal(_bufferSize(), 0);
});

test('identify sends only $set, which is all the relay accepts', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  identify({ breakpoint: 'tablet', installed: true, voice_kind: undefined });
  await flush();
  const e = events()[0]!;
  assert.equal(e.event_type, '$identify');
  assert.deepEqual(e.user_properties, { $set: { breakpoint: 'tablet', installed: true } });
  assert.ok(!('event_properties' in e));
});

test('non-scalar property values are dropped rather than sent', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'contact', note: { text: 'saw Mrs Smithers' } } as unknown as { kind: 'contact' });
  await flush();
  assert.deepEqual(events()[0]!.event_properties, { kind: 'contact' });
  assert.ok(!(sent[0]!.init.body as string).includes('Smithers'));
});

// ---------------------------------------------------------------- attribution rules

test('nothing is sent before setUser, and everything buffered goes once it is called', async () => {
  configure({ appVersion: '1.7.0' });
  track('storage_not_durable', {});
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(_bufferSize(), 1);
  setUser(ME);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(events()[0]!.user_id, ME);
});

test('a different user signing in drops what the previous one buffered (a passed phone)', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'sign' });
  setUser(OTHER);
  track('write_queued', { kind: 'contact' });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(events().length, 1);
  assert.equal(events()[0]!.user_id, OTHER);
  assert.deepEqual(events()[0]!.event_properties, { kind: 'contact' });
});

test('reset empties the buffer, stops attribution and rotates the device id', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'sign' });
  await flush();
  const before = events()[0]!.device_id;
  track('write_queued', { kind: 'sign' });
  reset();
  assert.equal(_bufferSize(), 0);
  track('write_queued', { kind: 'sign' });
  await flush();
  assert.equal(sent.length, 1, 'nothing sends with no user');
  setUser(OTHER);
  track('write_queued', { kind: 'sign' });
  await flush();
  assert.notEqual(events(1)[0]!.device_id, before);
});

test('opting out sends nothing and clears what was waiting', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'sign' });
  setOptedOut(true);
  assert.equal(optedOut(), true);
  assert.equal(_bufferSize(), 0);
  track('screen_viewed', { route: '/map', breakpoint: 'phone' });
  identify({ installed: true });
  await flush();
  assert.equal(sent.length, 0);
  setOptedOut(false);
  assert.equal(optedOut(), false);
});

// ---------------------------------------------------------------- transport

test('a dead network keeps the batch for the next flush; a 4xx is a verdict', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'sign' });
  fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await flush();
  assert.equal(_bufferSize(), 1);
  fetchImpl = async () => ({ ok: false, status: 401 });
  await flush();
  assert.equal(_bufferSize(), 0, 'a 401 is not retried into');
});

test('nothing is attempted while the browser says it is offline', async () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'sign' });
  onLine = false;
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(_bufferSize(), 1);
  onLine = true;
  fire('online');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
});

test('leaving the page hands the batch to sendBeacon as JSON', () => {
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  track('write_queued', { kind: 'sign' });
  fire('pagehide');
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0]!.url, '/api/analytics/events');
  assert.equal(beacons[0]!.blob.type, 'application/json');
  assert.equal(_bufferSize(), 0);
});

test('a storage that throws costs a persisted device id and nothing else', async () => {
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  configure({ appVersion: '1.7.0' });
  setUser(ME);
  assert.equal(optedOut(), false);
  track('write_queued', { kind: 'sign' });
  await flush();
  assert.equal(sent.length, 1);
  assert.match(events()[0]!.device_id as string, /^[A-Za-z0-9._-]{5,100}$/);
});
