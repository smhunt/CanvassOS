import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { announce, canSpeak, explain, listVoices, readVoicePref, silence, writeVoicePref } from './speech';
import { DRIVE_HELP } from './canvass/driveHelp';

// speech.ts reads `window` and `localStorage` at call time, never at import, so a fake of each can
// be swapped in per test. No DOM library: the module touches four members of speechSynthesis.

interface Spoken {
  text: string;
  voice: { voiceURI: string } | null;
  lang: string;
}

const VOICES = [
  { name: 'Samantha', lang: 'en-US', voiceURI: 'local.samantha', localService: true },
  { name: 'Online UK', lang: 'en-GB', voiceURI: 'remote.uk', localService: false },
];

let log: string[];
let spoken: Spoken[];
let store: Map<string, string>;

function install(opts: { synth?: boolean; storageThrows?: boolean } = {}) {
  log = [];
  spoken = [];
  store = new Map();
  const g = globalThis as Record<string, unknown>;
  g.SpeechSynthesisUtterance = function (this: Spoken, text: string) {
    this.text = text;
    this.voice = null;
    this.lang = '';
  };
  g.window =
    opts.synth === false
      ? {}
      : {
          speechSynthesis: {
            cancel: () => log.push('cancel'),
            speak: (u: Spoken) => {
              log.push('speak');
              spoken.push(u);
            },
            getVoices: () => VOICES,
          },
        };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => {
        if (opts.storageThrows) throw new Error('blocked');
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.storageThrows) throw new Error('blocked');
        store.set(k, v);
      },
      removeItem: (k: string) => {
        if (opts.storageThrows) throw new Error('blocked');
        store.delete(k);
      },
    },
  });
}

beforeEach(() => install());

test('announce cancels whatever was queued, then speaks exactly one utterance', () => {
  announce('Next door, 200 metres, on your left');
  assert.deepEqual(log, ['cancel', 'speak']);
  assert.equal(spoken[0].text, 'Next door, 200 metres, on your left');
});

test('explain queues one utterance per sentence, in order, after a single cancel', () => {
  // One long utterance is what Chrome silently cuts off after about fifteen seconds; the queue of
  // short ones is the fix, and they must all be queued in the same call to stay inside the tap.
  explain(['One.', 'Two.', 'Three.']);
  assert.deepEqual(log, ['cancel', 'speak', 'speak', 'speak']);
  assert.deepEqual(
    spoken.map((u) => u.text),
    ['One.', 'Two.', 'Three.'],
  );
});

test('silence cancels and speaks nothing', () => {
  silence();
  assert.deepEqual(log, ['cancel']);
});

test('with no voice chosen the utterance is left to the browser default', () => {
  announce('hello');
  assert.equal(spoken[0].voice, null);
  assert.equal(spoken[0].lang, '');
});

test('the chosen voice, and its language, are applied to every utterance', () => {
  writeVoicePref('remote.uk');
  assert.equal(readVoicePref(), 'remote.uk');
  announce('a');
  explain(['b', 'c']);
  for (const u of spoken) {
    assert.equal(u.voice?.voiceURI, 'remote.uk');
    assert.equal(u.lang, 'en-GB');
  }
  assert.equal(spoken.length, 3);
});

test('a saved voice this browser no longer lists falls back to the default, not to silence', () => {
  writeVoicePref('uninstalled.voice');
  announce('still spoken');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].voice, null);
});

test('choosing the default again removes the stored preference', () => {
  writeVoicePref('local.samantha');
  writeVoicePref(null);
  assert.equal(readVoicePref(), null);
  assert.equal(store.size, 0);
});

test('a browser that cannot speak is reported as such and nothing throws', () => {
  install({ synth: false });
  assert.equal(canSpeak(), false);
  assert.deepEqual(listVoices(), []);
  assert.doesNotThrow(() => {
    announce('x');
    explain(['y']);
    silence();
  });
});

test('blocked storage (private mode) never breaks speech: no preference, default voice', () => {
  install({ storageThrows: true });
  assert.equal(readVoicePref(), null);
  assert.doesNotThrow(() => writeVoicePref('local.samantha'));
  announce('still works');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].voice, null);
});

test('a speech engine that throws (no user gesture yet) is swallowed, not surfaced', () => {
  (globalThis as unknown as { window: { speechSynthesis: { speak: () => void } } }).window.speechSynthesis.speak = () => {
    throw new Error('not allowed');
  };
  assert.doesNotThrow(() => {
    announce('x');
    explain(['y', 'z']);
  });
});

// The rule that lets online voices be offered at all: a help script is fixed text, written in
// advance. These cannot prove nobody ever interpolates a name, but they do fail the moment the
// script stops being a list of plain, short, ear-friendly sentences.
test('the drive help script is a fixed list of short plain sentences', () => {
  assert.ok(DRIVE_HELP.spoken.length >= 3);
  for (const s of DRIVE_HELP.spoken) {
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0 && s.length <= 160, `short enough to take in by ear: "${s}"`);
    assert.doesNotMatch(s, /\d/, 'no figures for a synthesiser to stumble over');
    assert.doesNotMatch(s, /[{}$<>]/, 'no template or markup residue');
    assert.match(s, /[.?!]$/, 'a whole sentence, so the queue pauses between them');
  }
  assert.ok(
    DRIVE_HELP.spoken.some((s) => /never say a name/i.test(s)),
    'the script tells the driver that names are never spoken',
  );
});

test('every on-screen help section has a heading and a body', () => {
  assert.ok(DRIVE_HELP.sections.length > 0);
  for (const sec of DRIVE_HELP.sections) {
    assert.ok(sec.heading.trim().length > 0);
    assert.ok(sec.body.trim().length > 0);
  }
  const headings = DRIVE_HELP.sections.map((s) => s.heading);
  assert.equal(new Set(headings).size, headings.length, 'headings are used as React keys');
});
