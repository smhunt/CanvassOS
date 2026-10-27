import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HelpTopic } from '../components/HelpButton';
import { DRIVE_HELP } from '../canvass/driveHelp';
import { helpFor } from './route';
import * as topics from './topics';

const ALL: [string, HelpTopic][] = [
  ...Object.entries(topics).filter((e): e is [string, HelpTopic] => typeof e[1] === 'object'),
  ['DRIVE_HELP', DRIVE_HELP],
];

// ---------------------------------------------------------------- which screen gets which help

test('every screen in the nav opens its own help', () => {
  const cases: [string, HelpTopic][] = [
    ['/map', topics.MAP_HELP],
    ['/canvass', topics.CANVASS_HELP],
    ['/canvass/7b3c', topics.DOOR_HELP],
    ['/turfs', topics.TURFS_HELP],
    ['/signs', topics.SIGNS_HELP],
    ['/requests', topics.REQUESTS_HELP],
    ['/messaging', topics.MESSAGING_HELP],
    ['/reports', topics.REPORTS_HELP],
    ['/stats', topics.STATS_HELP],
    ['/turnout', topics.TURNOUT_HELP],
    ['/admin/users', topics.USERS_HELP],
    ['/admin/audit', topics.AUDIT_HELP],
    ['/account', topics.ACCOUNT_HELP],
  ];
  for (const [path, topic] of cases) assert.equal(helpFor(path), topic, path);
});

test('a trailing slash and a query-free deep path resolve the same way', () => {
  assert.equal(helpFor('/signs/'), topics.SIGNS_HELP);
  assert.equal(helpFor('/canvass/7b3c/'), topics.DOOR_HELP);
  assert.equal(helpFor('/map/anything'), topics.MAP_HELP);
});

test('drive mode and the print sheet get no top-bar help', () => {
  // Drive has its own speaking button on the drive bar; the sheet goes to a printer.
  assert.equal(helpFor('/canvass/7b3c/drive'), null);
  assert.equal(helpFor('/turfs/7b3c/sheet'), null);
});

test('unknown routes get no help rather than the wrong help', () => {
  for (const p of ['/', '/nope', '/canvass/a/b/c', '/admin', '/turfs/7b3c']) assert.equal(helpFor(p), null, p);
});

test('every exported topic is reachable from some route (nothing written and forgotten)', () => {
  const routes = [
    '/map', '/canvass', '/canvass/x', '/turfs', '/signs', '/requests', '/messaging',
    '/reports', '/stats', '/turnout', '/admin/users', '/admin/audit', '/account',
  ];
  const reached = new Set(routes.map(helpFor));
  for (const [name, t] of ALL) {
    if (name === 'DRIVE_HELP') continue;
    assert.ok(reached.has(t), `${name} is never shown`);
  }
});

// ---------------------------------------------------------------- the rules every script keeps

// src/speech.ts may hand `spoken` to a REMOTE voice, so it must be fixed text written in advance —
// never assembled from a door. These cannot prove nobody ever interpolates a name, but they fail the
// moment a script stops being a short list of plain sentences.
test('titles are unique and name the screen', () => {
  const titles = ALL.map(([, t]) => t.title);
  assert.equal(new Set(titles).size, titles.length);
  for (const t of titles) assert.match(t, /^How /, t);
});

for (const [name, t] of ALL) {
  test(`${name}: spoken script is short plain sentences, no figures, no markup`, () => {
    assert.ok(t.spoken.length >= 3 && t.spoken.length <= 7, `${t.spoken.length} sentences`);
    for (const s of t.spoken) {
      assert.equal(typeof s, 'string');
      assert.ok(s.length > 0 && s.length <= 160, `short enough to take in by ear: "${s}"`);
      assert.doesNotMatch(s, /\d/, `no figures for a synthesiser to stumble over: "${s}"`);
      assert.doesNotMatch(s, /[{}$<>]/, `no template or markup residue: "${s}"`);
      assert.match(s, /[.?!]$/, `a whole sentence, so the queue pauses between them: "${s}"`);
    }
  });

  test(`${name}: on-screen sections have unique headings and short bodies`, () => {
    assert.ok(t.sections.length >= 3 && t.sections.length <= 8, `${t.sections.length} sections`);
    const headings = t.sections.map((s) => s.heading);
    assert.equal(new Set(headings).size, headings.length, 'headings are used as React keys');
    for (const s of t.sections) {
      assert.ok(s.heading.trim().length > 0);
      assert.ok(s.body.trim().length > 0 && s.body.length <= 400, `"${s.heading}" is ${s.body.length} chars`);
      assert.doesNotMatch(s.body, /<[a-z/]/i, `no HTML in "${s.heading}"`);
    }
  });
}

test('the drive script tells the driver that names are never spoken', () => {
  assert.ok(DRIVE_HELP.spoken.some((s) => /never say a name/i.test(s)));
});
