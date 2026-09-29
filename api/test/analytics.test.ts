/** Unit tests for the analytics allow-lists (no database, no network). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { AUDIT_EVENTS } from '../src/lib/analytics.js';
import type { AuditAction } from '../src/lib/audit.js';
import { CLIENT_EVENTS, rebuild } from '../src/routes/analytics.js';

const ME = randomUUID();
const NOW = Date.parse('2026-10-01T15:00:00Z');

/**
 * Every detail shape the routes actually write, with the dangerous fields filled in — so each
 * mapper is shown the thing it must not pass on, not a sanitised stand-in.
 */
const PII = {
  household_id: 'H-KOMOKA-00123',
  voter_id: randomUUID(),
  email: 'someone@example.com',
  e164: '+15195550123',
  q: 'Smithers',
  name: '12 Main Street turf',
  lat: 42.9876,
  lon: -81.4567,
  label: 'corner of Glendon Dr',
  note: 'Mrs Smithers said hello',
  from: '+15195550199',
  candidate_id: randomUUID(),
  sign_id: randomUUID(),
  photo_id: randomUUID(),
  user_id: randomUUID(),
};
const FORBIDDEN = [
  /H-[A-Z]+-\d+/,
  /@/,
  /\+1519/,
  /Smithers/,
  /Main Street/,
  /Glendon/,
  /42\.98/,
  /81\.45/,
  new RegExp(PII.voter_id),
  new RegExp(PII.candidate_id),
  new RegExp(PII.sign_id),
  new RegExp(PII.photo_id),
  new RegExp(PII.user_id),
];

describe('AUDIT_EVENTS', () => {
  const actions = Object.keys(AUDIT_EVENTS) as AuditAction[];

  it('passes on none of the personal data an audit detail carries', () => {
    for (const action of actions) {
      const mapper = AUDIT_EVENTS[action];
      if (!mapper) continue;
      const ev = mapper({ ...PII, result: 'spoke', status: 'placed', wants: ['sign'], fields: ['name'] }, {
        userId: ME,
        action,
        target: PII.household_id,
      });
      const out = JSON.stringify(ev);
      for (const re of FORBIDDEN) assert.ok(!re.test(out), `${action} leaked ${re}: ${out}`);
    }
  });

  it('emits only flat string/number/boolean properties', () => {
    for (const action of actions) {
      const ev = AUDIT_EVENTS[action]?.({ n: 3, wants: ['sign', 'bogus'], bytes: 1_500_000 }, { userId: ME, action });
      for (const v of Object.values(ev?.props ?? {})) {
        assert.ok(['string', 'number', 'boolean'].includes(typeof v), `${action}: ${typeof v}`);
      }
    }
  });

  it('drops enum values it does not know rather than passing them through', () => {
    const ev = AUDIT_EVENTS.public_request!({ wants: ['sign', 'Mrs Smithers'], has_address: true }, { userId: null, action: 'public_request' });
    assert.equal(ev?.props?.wants, 'sign');
    const s = AUDIT_EVENTS.place_sign!({ status: 'at 12 Main St' }, { userId: ME, action: 'place_sign' });
    assert.equal(s?.props?.status, undefined);
  });

  it('records the search length, never the search', () => {
    const ev = AUDIT_EVENTS.search!({ q: 'Smithers', n_voters: 2, n_households: 1 }, { userId: ME, action: 'search' });
    assert.deepEqual(ev?.props, { query_length: 8, n_voters: 2, n_households: 1 });
  });

  it('buckets photo sizes (an exact byte count fingerprints one photo)', () => {
    const ev = AUDIT_EVENTS.upload_sign_photo!({ sign_id: PII.sign_id, bytes: 1_234_567 }, { userId: ME, action: 'upload_sign_photo' });
    assert.deepEqual(ev?.props, { size: '1-4MB' });
  });

  it('counts a campaign send from the keys the route actually writes', () => {
    // messaging.ts spreads { size, sms, email, estimated_days } into the detail; a rename there
    // should fail here rather than quietly send an event with no count.
    const ev = AUDIT_EVENTS.send_campaign!(
      { size: 120, sms: 80, email: 40, estimated_days: 1, override_max_audience: false, provider: 'log' },
      { userId: ME, action: 'send_campaign' },
    );
    assert.deepEqual(ev?.props, { audience_size: 120, sms: 80, email: 40, override_max_audience: false, provider: 'log' });
  });

  it('sends no per-voter contact event (the door-level one comes from the route)', () => {
    assert.equal(AUDIT_EVENTS.contact, null);
  });
});

describe('relay: rebuild()', () => {
  const ok = {
    event_type: 'screen_viewed',
    user_id: ME,
    device_id: 'abcdef-1234',
    session_id: NOW - 1000,
    time: NOW - 500,
    insert_id: 'ins-1',
    app_version: '1.5.0',
    platform: 'Web',
    os_name: 'Chrome',
    language: 'en-CA',
    ip: '$remote',
    library: 'amplitude-ts/2.47.0',
    event_properties: { route: '/canvass/:turfId', breakpoint: 'phone' },
  };

  it('keeps an allowed event and rebuilds it field by field', () => {
    const out = rebuild(ok, ME, NOW);
    assert.ok(typeof out === 'object');
    assert.equal(out.user_id, ME);
    assert.deepEqual(out.event_properties, { route: '/canvass/:turfId', breakpoint: 'phone' });
    // Fields the SDK sets that are not on the allow-list are gone — above all the IP marker.
    assert.ok(!('ip' in out));
    assert.ok(!('library' in out));
  });

  it('accepts a known tab id on a tabbed screen, including the coverage report', () => {
    const out = rebuild({ ...ok, event_properties: { route: '/reports', breakpoint: 'desktop', tab: 'coverage' } }, ME, NOW);
    assert.ok(typeof out === 'object');
    assert.deepEqual(out.event_properties, { route: '/reports', breakpoint: 'desktop', tab: 'coverage' });
    assert.equal(rebuild({ ...ok, event_properties: { route: '/reports', breakpoint: 'desktop', tab: 'ward-3' } }, ME, NOW), 'bad_props');
  });

  it("drops another user's event instead of re-stamping it (a phone passed between canvassers)", () => {
    assert.equal(rebuild({ ...ok, user_id: randomUUID() }, ME, NOW), 'other_user');
    assert.equal(rebuild({ ...ok, user_id: undefined }, ME, NOW), 'other_user');
  });

  it('drops an unknown event, an unknown property, and a resolved URL', () => {
    assert.equal(rebuild({ ...ok, event_type: 'door_viewed_with_name' }, ME, NOW), 'unknown_event');
    assert.equal(rebuild({ ...ok, event_properties: { ...ok.event_properties, name: 'Smithers' } }, ME, NOW), 'bad_props');
    assert.equal(rebuild({ ...ok, event_properties: { route: '/canvass/1f2e3d', breakpoint: 'phone' } }, ME, NOW), 'bad_props');
    assert.equal(
      rebuild({ ...ok, event_properties: { route: '/signs?tab=place&address=12+Main+St', breakpoint: 'phone' } }, ME, NOW),
      'bad_props',
    );
  });

  it('refuses free text in identifier-shaped properties', () => {
    const e = { ...ok, event_type: 'error_encountered', event_properties: { code: 'Mrs Smithers', status: 400, route: '/map' } };
    assert.equal(rebuild(e, ME, NOW), 'bad_props');
    const good = { ...e, event_properties: { code: 'not_your_turf', status: 403, route: '/map' } };
    assert.ok(typeof rebuild(good, ME, NOW) === 'object');
  });

  it('refuses text smuggled into device fields', () => {
    assert.equal(rebuild({ ...ok, device_model: 'Smithers, 12 Main St' }, ME, NOW), 'shape');
  });

  it('allows $identify with listed user properties only, and never a client-set role', () => {
    const idf = { ...ok, event_type: '$identify', event_properties: undefined, user_properties: { $set: { breakpoint: 'tablet', installed: true } } };
    const out = rebuild(idf, ME, NOW);
    assert.ok(typeof out === 'object');
    assert.deepEqual(out.user_properties, { breakpoint: 'tablet', installed: true });
    assert.equal(rebuild({ ...idf, user_properties: { $set: { role: 'admin' } } }, ME, NOW), 'bad_props');
  });

  it('drops events from the future or more than a week old', () => {
    assert.equal(rebuild({ ...ok, time: NOW + 3600_000 }, ME, NOW), 'time');
    assert.equal(rebuild({ ...ok, time: NOW - 8 * 24 * 3600_000 }, ME, NOW), 'time');
  });

  it('has a strict schema for every client event', () => {
    for (const [name, schema] of Object.entries(CLIENT_EVENTS)) {
      assert.equal(schema.safeParse({ __extra: 1 }).success, false, `${name} must reject unknown keys`);
    }
  });
});
