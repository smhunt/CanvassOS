/** Unit tests for the drive-mode maths (no DOM, no network). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleDiff, bearingDeg, compassOf, type Coords } from './directions';

const at = (lat: number, lon: number): Coords => ({ lat, lon });

describe('bearingDeg', () => {
  it('reads the cardinal directions', () => {
    const origin = at(43.0, -81.5);
    assert.ok(Math.abs(bearingDeg(origin, at(43.1, -81.5)) - 0) < 0.5);
    assert.ok(Math.abs(bearingDeg(origin, at(43.0, -81.4)) - 90) < 0.5);
    assert.ok(Math.abs(bearingDeg(origin, at(42.9, -81.5)) - 180) < 0.5);
    assert.ok(Math.abs(bearingDeg(origin, at(43.0, -81.6)) - 270) < 0.5);
  });

  it('always returns 0..360, never negative', () => {
    const b = bearingDeg(at(43.0, -81.5), at(43.0, -81.6));
    assert.ok(b >= 0 && b < 360);
  });
});

describe('compassOf still behaves after the extraction', () => {
  it('rounds to the same eight points as before', () => {
    const origin = at(43.0, -81.5);
    assert.equal(compassOf(origin, at(43.1, -81.5)), 'N');
    assert.equal(compassOf(origin, at(43.0, -81.4)), 'E');
    assert.equal(compassOf(origin, at(42.9, -81.5)), 'S');
    assert.equal(compassOf(origin, at(43.0, -81.6)), 'W');
  });
});

describe('angleDiff', () => {
  // The wraparound is where this class of bug always lives.
  it('is signed and takes the short way round 0/360', () => {
    assert.equal(angleDiff(10, 350), 20);
    assert.equal(angleDiff(350, 10), -20);
    assert.equal(angleDiff(0, 0), 0);
    assert.equal(angleDiff(0, 180), 180);
    assert.equal(angleDiff(180, 0), 180);
  });
});
