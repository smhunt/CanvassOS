/** Unit tests for the turf point-in-polygon helper (no database). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approximateOutline, pointInPolygon, pointInRing, polygonBBox, type Polygon, type Position, type Ring } from '../src/lib/geo.js';

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

describe('approximateOutline', () => {
  const area = (p: NonNullable<ReturnType<typeof approximateOutline>>) => {
    const r = p.coordinates[0]!;
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
    return Math.abs(a / 2);
  };

  it('wraps a block of doors and contains them all', () => {
    const doors: Position[] = [
      [-81.38, 43.08],
      [-81.37, 43.08],
      [-81.37, 43.09],
      [-81.38, 43.09],
      [-81.375, 43.085],
    ];
    const out = approximateOutline(doors)!;
    assert.ok(out, 'a block of doors has an outline');
    // Padding pushes the ring outwards, so every door it was built from must fall inside it.
    for (const [lon, lat] of doors) {
      assert.ok(pointInPolygon(lon, lat, out), `door ${lon},${lat} must be inside its own outline`);
    }
  });

  it('gives a single street real width instead of a zero-area sliver', () => {
    // Collinear doors: the hull itself has no area, which is the case that would draw nothing.
    const street: Position[] = [
      [-81.38, 43.08],
      [-81.379, 43.08],
      [-81.378, 43.08],
      [-81.377, 43.08],
    ];
    const out = approximateOutline(street)!;
    assert.ok(out);
    assert.ok(area(out) > 0, 'a straight street must still enclose an area');
    for (const [lon, lat] of street) assert.ok(pointInPolygon(lon, lat, out));
  });

  it('still produces something for one door, and nothing for none', () => {
    const one = approximateOutline([[-81.38, 43.08]])!;
    assert.ok(one);
    assert.ok(pointInPolygon(-81.38, 43.08, one));
    assert.equal(approximateOutline([]), null);
  });

  it('pads in metres, not degrees, so the shape is not stretched east-west', () => {
    const out = approximateOutline([[-81.38, 43.08]])!;
    const r = out.coordinates[0]!;
    const wLon = Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0]));
    const hLat = Math.max(...r.map((p) => p[1])) - Math.min(...r.map((p) => p[1]));
    // At 43 degrees N a degree of longitude is ~cos(43) = 0.73 of a degree of latitude, so an
    // equal-metres box must be WIDER in degrees by roughly that factor.
    const ratio = wLon / hLat;
    assert.ok(ratio > 1.2 && ratio < 1.5, `expected ~1.37, got ${ratio}`);
  });
});
