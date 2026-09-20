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

/** Speak once. Cancels anything still queued so a stale door is never announced after a new one. */
export function announce(text: string): void {
  const s = synth();
  if (!s) return;
  try {
    s.cancel();
    s.speak(new SpeechSynthesisUtterance(text));
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
    for (const sentence of sentences) s.speak(new SpeechSynthesisUtterance(sentence));
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

/** False where the browser cannot speak at all, so a "read aloud" control is not offered in vain. */
export function canSpeak(): boolean {
  return synth() !== null;
}
