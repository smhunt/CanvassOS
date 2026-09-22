/**
 * The one place this app talks. It lives outside `canvass/` because the help dialog uses it too, and
 * help is meant to reach screens that have nothing to do with canvassing.
 *
 * THE RULE FOR EVERY CALLER: nothing from the voters list is ever passed in here — no name, no
 * address. Chrome on Android may synthesise through a REMOTE voice, which sends the utterance text
 * to a third party; under the Municipal Elections Act s. 23(8) that is the list "provided to another
 * person". Help scripts are fixed strings written in advance; drive mode speaks a distance and a side
 * of the road. Keep it that way.
 *
 * speechSynthesis belongs to the document, not to whichever screen filled its queue, so whoever
 * starts speech is responsible for calling silence() when they go away.
 */

function synth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return window.speechSynthesis;
}

// Which voice speaks is a UI preference like the base layer or the door order: localStorage, in
// try/catch, per device — a voice is identified by a URI that only means something to the browser
// that listed it, so there is nothing here worth syncing to an account.
const VOICE_KEY = 'mc-canvass.voice';

/** The chosen voice's URI, or null for "whatever the browser would pick". */
export function readVoicePref(): string | null {
  try {
    return localStorage.getItem(VOICE_KEY);
  } catch {
    return null;
  }
}

export function writeVoicePref(uri: string | null): void {
  try {
    if (uri) localStorage.setItem(VOICE_KEY, uri);
    else localStorage.removeItem(VOICE_KEY);
  } catch {
    // Private mode refuses to store; the browser's default voice is a fine fallback.
  }
}

/** Every voice this browser offers. Empty until `voiceschanged` on Chrome — see useVoices. */
export function listVoices(): SpeechSynthesisVoice[] {
  const s = synth();
  if (!s) return [];
  try {
    return s.getVoices();
  } catch {
    return [];
  }
}

/**
 * Applied to every utterance, here, so no caller has to know the preference exists. A stored URI
 * that no longer matches anything — a voice uninstalled, a different browser profile — quietly falls
 * back to the default rather than failing: a driver who hears the wrong voice has lost nothing, one
 * who hears none has lost the feature. `lang` is set with it because some engines ignore a voice
 * whose language disagrees with the utterance's.
 */
function utter(text: string): SpeechSynthesisUtterance {
  const u = new SpeechSynthesisUtterance(text);
  const uri = readVoicePref();
  if (uri) {
    const v = listVoices().find((x) => x.voiceURI === uri);
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
  }
  return u;
}

/** Speak once. Cancels anything still queued so a stale door is never announced after a new one. */
export function announce(text: string): void {
  const s = synth();
  if (!s) return;
  try {
    s.cancel();
    s.speak(utter(text));
  } catch {
    // Some browsers throw without a prior user gesture; silence is an acceptable failure here.
  }
}

/**
 * Speak something longer than a phrase. One utterance per sentence, all queued inside the same call:
 * Chrome silently stops a single long utterance after about fifteen seconds and never fires its end
 * event, whereas a queue of short ones plays through. Must be called synchronously from a tap — iOS
 * refuses speech that does not start inside a user gesture, and queueing them all here is what keeps
 * the later sentences inside that permission.
 */
export function explain(sentences: readonly string[]): void {
  const s = synth();
  if (!s) return;
  try {
    s.cancel();
    for (const sentence of sentences) s.speak(utter(sentence));
  } catch {
    // Same failure mode as announce: the words are on screen as well, so silence loses nothing.
  }
}

/** Drop anything still queued or being spoken. Same guards as announce, for the same reasons. */
export function silence(): void {
  const s = synth();
  if (!s) return;
  try {
    s.cancel();
  } catch {
    // Nothing to recover: the point of the call was to leave nothing behind.
  }
}

/**
 * Whether anything is being said or is queued to be. Polled rather than tracked through utterance
 * events: Chrome does not always fire `end` after cancel(), and on some engines never fires it for
 * an utterance it silently dropped, so an event-driven flag could stick on "reading" for good.
 */
export function isSpeaking(): boolean {
  const s = synth();
  if (!s) return false;
  try {
    return s.speaking || s.pending;
  } catch {
    return false;
  }
}

/** False where the browser cannot speak at all, so a "read aloud" control is not offered in vain. */
export function canSpeak(): boolean {
  return synth() !== null;
}

// Chrome returns [] from the first getVoices() and only then starts loading the list. Asking once at
// import means that by the time anything is spoken the chosen voice can actually be found; without
// it the first announcement of a session would always come out in the default voice.
listVoices();
