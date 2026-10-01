/** The tour's steps point at real, published screenshots, each described for screen readers. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TOUR } from './tourSteps';

const publicDir = new URL('../../public/tour/', import.meta.url);

describe('TOUR', () => {
  it('uses each screenshot once', () => {
    const names = TOUR.map((s) => s.image);
    assert.equal(new Set(names).size, names.length);
  });

  it('has a .png and a .webp in public/tour/ for every step', () => {
    for (const s of TOUR) {
      for (const ext of ['png', 'webp']) {
        assert.ok(existsSync(new URL(`${s.image}.${ext}`, publicDir)), `missing public/tour/${s.image}.${ext}`);
      }
    }
  });

  it('describes every screenshot and says nothing with an em dash', () => {
    for (const s of TOUR) {
      assert.ok(s.alt.length > 30, `${s.image} needs real alt text`);
      for (const text of [s.title, s.body, s.alt]) assert.ok(!text.includes('—'), `${s.image}: ${text}`);
    }
  });
});
