/**
 * One version number, everywhere it is shown: the footer and About (APP_VERSION), the two
 * package.json files the API and the web report from, and CHANGELOG.md. The in-app changelog
 * mirrors CHANGELOG.md release for release, so a release written in one and not the other fails here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { APP_VERSION, CHANGELOG } from './components/changelog-modal';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const pkgVersion = (rel: string) => (JSON.parse(read(rel)) as { version: string }).version;

describe('version', () => {
  it('is the same in the app, both package.json files and CHANGELOG.md', () => {
    const md = read('../../CHANGELOG.md');
    const latest = md.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
    assert.equal(pkgVersion('../package.json'), APP_VERSION, 'web/package.json');
    assert.equal(pkgVersion('../../api/package.json'), APP_VERSION, 'api/package.json');
    assert.equal(CHANGELOG[0]?.version, APP_VERSION, 'the newest in-app changelog entry');
    assert.equal(
      latest,
      APP_VERSION,
      'the newest CHANGELOG.md release (an [Unreleased] block must be given a version before shipping)',
    );
  });

  it('has every CHANGELOG.md release in the in-app changelog, and nothing invented', () => {
    const md = read('../../CHANGELOG.md');
    const inMd = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/gm)].map((m) => ({
      version: m[1],
      date: m[2],
    }));
    const inApp = CHANGELOG.map((r) => ({ version: r.version, date: r.date }));
    assert.deepEqual(inApp, inMd);
    for (const r of CHANGELOG) {
      assert.ok(r.changes.length > 0, `${r.version} has no notes`);
    }
  });
});
