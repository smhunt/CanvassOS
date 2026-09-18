/** Unit tests for the drive-mode maths (no DOM, no network). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { angleDiff, bearingDeg, compassOf, type Coords } from './directions';
import { selectAhead, type DriveFix } from './drive';
import type { Door } from '../api/types';

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

// ~111 m per 0.001 degree of latitude at this latitude; enough for readable fixtures.
const door = (id: string, lat: number, lon: number): Door => ({
  household_id: id,
  address: `${id} Road`,
  community: null,
  ward: '1',
  lat,
  lon,
  n_voters: 1,
  walk_order: 0,
  last_result: null,
  last_contact_at: null,
  voters: [],
});

const northbound = (lat: number, lon: number): DriveFix => ({ at: { lat, lon }, heading: 0, speed_mps: 22 });
/** A phone that reports no course: parked, or a desktop that has none at all. */
const stationary = (lat: number, lon: number): DriveFix => ({ at: { lat, lon }, heading: null, speed_mps: null });

describe('selectAhead', () => {
  it('ignores a nearer door that is behind, and picks the one ahead', () => {
    const behind = door('behind', 42.999, -81.5);
    const ahead = door('ahead', 43.002, -81.5);
    const sel = selectAhead([behind, ahead], northbound(43.0, -81.5), null);
    assert.equal(sel.current?.door.household_id, 'ahead');
    assert.ok(sel.current!.along_m > 0);
  });

  it('names the side of the road from the sign of cross-track', () => {
    const right = door('right', 43.002, -81.4985);
    const left = door('left', 43.002, -81.5015);
    assert.equal(selectAhead([right], northbound(43.0, -81.5), null).current?.side, 'right');
    assert.equal(selectAhead([left], northbound(43.0, -81.5), null).current?.side, 'left');
  });

  it('rejects a door on a parallel road beyond CROSS_LIMIT_M', () => {
    const parallel = door('parallel', 43.002, -81.49);
    const sel = selectAhead([parallel], northbound(43.0, -81.5), null);
    assert.equal(sel.current, null);
  });

  it('holds the selection while the held door is still ahead', () => {
    const a = door('a', 43.0020, -81.5);
    const b = door('b', 43.0021, -81.5);
    // b is nearly as close; without hysteresis the pick would flip between ticks.
    const sel = selectAhead([a, b], northbound(43.0, -81.5), 'b');
    assert.equal(sel.current?.door.household_id, 'b');
  });

  it('releases the held door once it has been passed', () => {
    const passed = door('passed', 42.999, -81.5);
    const next = door('next', 43.002, -81.5);
    const sel = selectAhead([passed, next], northbound(43.0, -81.5), 'passed');
    assert.equal(sel.current?.door.household_id, 'next');
  });

  it('falls back to nearest-first when the phone reports no heading', () => {
    const near = door('near', 42.9995, -81.5);
    const far = door('far', 43.010, -81.5);
    const sel = selectAhead([near, far], { at: { lat: 43.0, lon: -81.5 }, heading: null, speed_mps: null }, null);
    assert.equal(sel.fallback, true);
    assert.equal(sel.current?.door.household_id, 'near');
  });

  it('keeps the held door in the fallback even when another is nearer', () => {
    // A parked car with no heading: every tick re-sorts by distance, and a door metres away can
    // trade places with the held one on GPS noise alone.
    const near = door('near', 42.9995, -81.5);
    const far = door('far', 43.010, -81.5);
    const sel = selectAhead([near, far], stationary(43.0, -81.5), 'far');
    assert.equal(sel.fallback, true);
    assert.equal(sel.current?.door.household_id, 'far');
    assert.equal(sel.upcoming[0]?.door.household_id, 'near');
    assert.ok(!sel.upcoming.some((u) => u.door.household_id === 'far'));
  });

  it('falls through to nearest when the held door has left the list', () => {
    // Recorded, or filtered out by the caller: a held id that is no longer on offer must not
    // suppress the door that is.
    const near = door('near', 42.9995, -81.5);
    const far = door('far', 43.010, -81.5);
    const sel = selectAhead([near, far], stationary(43.0, -81.5), 'gone');
    assert.equal(sel.current?.door.household_id, 'near');
  });

  it('skips doors that were never geocoded', () => {
    const unmapped = { ...door('unmapped', 0, 0), lat: null, lon: null } as Door;
    const ahead = door('ahead', 43.002, -81.5);
    const sel = selectAhead([unmapped, ahead], northbound(43.0, -81.5), null);
    assert.equal(sel.current?.door.household_id, 'ahead');
  });

  it('keeps a held door through a bend', () => {
    // ~200 m off to the side: outside the 150 m acquire band, inside the 300 m release band.
    const held = door('held', 43.002, -81.49754);
    const deadAhead = door('dead-ahead', 43.003, -81.5);
    const withHeld = selectAhead([held, deadAhead], northbound(43.0, -81.5), 'held');
    assert.equal(withHeld.current?.door.household_id, 'held');
    // Without a hold, that same door is too far off-track to be picked fresh.
    const withoutHeld = selectAhead([held, deadAhead], northbound(43.0, -81.5), null);
    assert.equal(withoutHeld.current?.door.household_id, 'dead-ahead');
  });

  it('releases a held door once the driver has turned off its road', () => {
    // ~400 m off to the side: past even the 300 m release band.
    const strayed = door('strayed', 43.002, -81.49509);
    const deadAhead = door('dead-ahead', 43.003, -81.5);
    const sel = selectAhead([strayed, deadAhead], northbound(43.0, -81.5), 'strayed');
    assert.equal(sel.current?.door.household_id, 'dead-ahead');
  });

  it('AHEAD_MAX_M limits fresh candidates but not a held door', () => {
    const far = door('far', 43.0225, -81.5); // ~2500 m ahead, past AHEAD_MAX_M
    assert.equal(selectAhead([far], northbound(43.0, -81.5), null).current, null);
    assert.equal(selectAhead([far], northbound(43.0, -81.5), 'far').current?.door.household_id, 'far');
  });
});
