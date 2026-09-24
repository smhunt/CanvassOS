/** Unit tests for the "can this door ask for a sign" rules (no DOM, no network). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Sign, SignStatus } from '../api/types';
import { signRequestVerdict } from './signRequest';

const DOOR = { id: 'H-DENFIELD-00001', lat: 43.05, lon: -81.45 };

/** Only the three fields the verdict reads; the rest of `Sign` is noise here. */
const sign = (household_id: string | null, status: SignStatus): Sign =>
  ({ household_id, status }) as Sign;

describe('signRequestVerdict', () => {
  it('allows a request at a mapped door with no signs', () => {
    assert.deepEqual(signRequestVerdict(DOOR, []), { can: true });
  });

  it('refuses a door with no coordinates, because the API would', () => {
    const v = signRequestVerdict({ id: DOOR.id, lat: null, lon: null }, []);
    assert.equal(v.can, false);
    assert.match(v.can === false ? v.reason : '', /no map position/);
  });

  it('checks the coordinates before the sign list, so an unmapped door is never "already requested"', () => {
    const v = signRequestVerdict({ id: DOOR.id, lat: null, lon: null }, [sign(DOOR.id, 'requested')]);
    assert.equal(v.can, false);
    assert.match(v.can === false ? v.reason : '', /no map position/);
  });

  it('refuses a second request at a door that already asked', () => {
    const v = signRequestVerdict(DOOR, [sign(DOOR.id, 'requested')]);
    assert.equal(v.can, false);
    assert.match(v.can === false ? v.reason : '', /already been requested/);
  });

  for (const status of ['placed', 'missing', 'damaged'] as SignStatus[]) {
    it(`refuses a request at a door whose sign is ${status}`, () => {
      const v = signRequestVerdict(DOOR, [sign(DOOR.id, status)]);
      assert.equal(v.can, false);
      assert.match(v.can === false ? v.reason : '', /already recorded/);
    });
  }

  it('allows a fresh request once the old sign has been picked up', () => {
    assert.deepEqual(signRequestVerdict(DOOR, [sign(DOOR.id, 'removed')]), { can: true });
  });

  it('ignores signs at other doors and road-allowance signs with no door', () => {
    const signs = [sign('H-KOMOKA-00042', 'placed'), sign(null, 'placed')];
    assert.deepEqual(signRequestVerdict(DOOR, signs), { can: true });
  });

  // The rule that matters in a field: the guard must never be the reason a request is lost.
  it('fails OPEN when the sign list could not be loaded', () => {
    assert.deepEqual(signRequestVerdict(DOOR, undefined), { can: true });
  });
});
