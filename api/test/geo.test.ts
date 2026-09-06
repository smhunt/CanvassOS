/** Unit tests for the turf point-in-polygon helper (no database). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pointInPolygon, pointInRing, polygonBBox, type Polygon, type Ring } from '../src/lib/geo.js';

const square: Ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

describe('geo.pointInRing', () => {
  it('accepts interior points and rejects exterior ones', () => {
    assert.equal(pointInRing(5, 5, square), true);
    assert.equal(pointInRing(0.001, 0.001, square), true);
    assert.equal(pointInRing(15, 5, square), false);
    assert.equal(pointInRing(-1, 5, square), false);
    assert.equal(pointInRing(5, 11, square), false);
    assert.equal(pointInRing(5, -0.5, square), false);
  });

  it('does not need the ring to be closed', () => {
    const open = square.slice(0, 4) as Ring;
    assert.equal(pointInRing(5, 5, open), true);
    assert.equal(pointInRing(11, 5, open), false);
  });

  it('handles a concave ring (the notch is outside)', () => {
    // A "C" opening to the right: x in [0,10], with a bite taken out of the middle-right.
    const c: Ring = [
      [0, 0],
      [10, 0],
      [10, 3],
      [4, 3],
      [4, 7],
      [10, 7],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    assert.equal(pointInRing(2, 5, c), true, 'spine of the C');
    assert.equal(pointInRing(7, 5, c), false, 'inside the notch');
    assert.equal(pointInRing(7, 1, c), true, 'lower arm');
    assert.equal(pointInRing(7, 9, c), true, 'upper arm');
  });
});

describe('geo.pointInPolygon', () => {
  const withHole: Polygon = {
    type: 'Polygon',
    coordinates: [
      square,
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ],
  };

  it('excludes points inside a hole', () => {
    assert.equal(pointInPolygon(5, 5, withHole), false);
    assert.equal(pointInPolygon(2, 2, withHole), true);
    assert.equal(pointInPolygon(20, 20, withHole), false);
  });

  it('works with realistic Middlesex coordinates', () => {
    const box: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-81.4, 43.05],
          [-81.35, 43.05],
          [-81.35, 43.1],
          [-81.4, 43.1],
          [-81.4, 43.05],
        ],
      ],
    };
    assert.equal(pointInPolygon(-81.37, 43.07, box), true);
    assert.equal(pointInPolygon(-81.41, 43.07, box), false);
    assert.equal(pointInPolygon(-81.37, 43.11, box), false);
    assert.deepEqual(polygonBBox(box), { minLon: -81.4, minLat: 43.05, maxLon: -81.35, maxLat: 43.1 });
  });

  it('returns false for a degenerate ring', () => {
    assert.equal(pointInPolygon(1, 1, { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }), false);
  });
});
