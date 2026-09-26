/** Unit tests for the delivery-route ordering and link building (no DOM, no network). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STOPS_PER_LEG, googleLegs, orderStops, tourLengthM, wazeUrl, type RouteStop } from './route';

const stop = (i: number, lat: number, lon: number): RouteStop => ({ key: `k${i}`, title: `Stop ${i}`, lat, lon });

// Ten stops strung along one concession, handed over shuffled — the newest-first list is in
// exactly this kind of order.
const line = [0, 7, 3, 9, 1, 5, 8, 2, 6, 4].map((i) => stop(i, 43.0, -81.6 + i * 0.01));

describe('orderStops', () => {
  it('drives a straight road end to end, not back and forth', () => {
    const tour = orderStops(line, null).map((s) => s.key);
    const along = Array.from({ length: 10 }, (_, i) => `k${i}`);
    assert.ok(
      tour.join() === along.join() || tour.join() === [...along].reverse().join(),
      `expected one end to the other, got ${tour.join()}`,
    );
  });

  it('starts at the end nearest a given start', () => {
    const tour = orderStops(line, { lat: 43.0, lon: -81.3 });
    assert.equal(tour[0]?.key, 'k9');
    assert.equal(tour[tour.length - 1]?.key, 'k0');
  });

  it('keeps every stop exactly once', () => {
    const grid = Array.from({ length: 40 }, (_, i) => stop(i, 42.9 + (i % 7) * 0.013, -81.6 + Math.floor(i / 7) * 0.02));
    const tour = orderStops(grid, { lat: 43.0, lon: -81.5 });
    assert.equal(tour.length, grid.length);
    assert.equal(new Set(tour.map((s) => s.key)).size, grid.length);
  });

  it('beats the order it was given', () => {
    const grid = Array.from({ length: 40 }, (_, i) => stop(i, 42.9 + ((i * 17) % 7) * 0.013, -81.6 + ((i * 11) % 6) * 0.02));
    assert.ok(tourLengthM(orderStops(grid, null), null) < tourLengthM(grid, null));
  });

  it('handles nothing and one', () => {
    assert.deepEqual(orderStops([], null), []);
    assert.equal(orderStops([stop(1, 43, -81.5)], null).length, 1);
  });
});

describe('googleLegs', () => {
  const stops = Array.from({ length: 23 }, (_, i) => ({ lat: 43 + i * 0.001, lon: -81.5 }));

  it('splits into legs that chain end to start', () => {
    const legs = googleLegs(stops, null);
    assert.deepEqual(
      legs.map((l) => [l.first, l.last]),
      [
        [1, 10],
        [11, 20],
        [21, 23],
      ],
    );
    const params = legs.map((l) => new URL(l.url).searchParams);
    // First leg: no origin, so the app starts from the phone.
    assert.equal(params[0]?.get('origin'), null);
    // Each later leg starts where the previous one ended.
    assert.equal(params[1]?.get('origin'), params[0]?.get('destination'));
    assert.equal(params[2]?.get('origin'), params[1]?.get('destination'));
    assert.equal(params[0]?.get('waypoints')?.split('|').length, STOPS_PER_LEG - 1);
    assert.equal(params[0]?.get('travelmode'), 'driving');
  });

  it('uses the fix as the first origin when there is one', () => {
    const url = new URL(googleLegs(stops.slice(0, 1), { lat: 43.01, lon: -81.49 })[0]?.url ?? '');
    assert.equal(url.searchParams.get('origin'), '43.010000,-81.490000');
    assert.equal(url.searchParams.get('waypoints'), null);
  });

  it('carries coordinates and nothing else', () => {
    for (const leg of googleLegs(stops, null)) {
      for (const [k, v] of new URL(leg.url).searchParams) {
        if (k === 'api' || k === 'travelmode') continue;
        assert.match(v, /^(-?\d+\.\d{6},-?\d+\.\d{6}\|?)+$/, `${k}=${v}`);
      }
    }
  });
});

describe('wazeUrl', () => {
  it('navigates to one coordinate', () => {
    assert.equal(wazeUrl({ lat: 43.05, lon: -81.4 }), 'https://waze.com/ul?ll=43.050000,-81.400000&navigate=yes');
  });
});
