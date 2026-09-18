/**
 * The hands-free half of drive mode. Speaking the next door is the entire reason a solo driver can
 * use this without touching anything, so it is on by default; the toggle exists for when a passenger
 * is reading aloud instead. Preferences are UI state, so localStorage in try/catch, matching
 * readDoorOrder in nearMe.ts.
 */
const KEY = 'mc-canvass.drive-prefs';

export interface DrivePrefs {
  speak: boolean;
  names: boolean;
}

export function readDrivePrefs(): DrivePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { speak: true, names: true };
    const p = JSON.parse(raw) as Partial<DrivePrefs>;
    return { speak: p.speak !== false, names: p.names !== false };
  } catch {
    return { speak: true, names: true };
  }
}

export function writeDrivePrefs(p: DrivePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Private mode refuses to store; the toggles still work for this session.
  }
}

/** Speak once. Cancels anything still queued so a stale door is never announced after a new one. */
export function announce(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // Some browsers throw without a prior user gesture; silence is an acceptable failure here.
  }
}
