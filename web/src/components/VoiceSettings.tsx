import { useEffect, useId, useMemo, useState } from 'react';
import { canSpeak, explain, listVoices, readVoicePref, silence, writeVoicePref } from '../speech';

// Fixed, like every script in this app: the sample is the one thing a volunteer will play over and
// over while choosing, and it must never be tempted to read out something "real" to be convincing.
const SAMPLE = ['Next door, two hundred metres, on your left.', 'This is how I will sound.'];

/**
 * The browser's voice list arrives late and can change: Chrome fills it asynchronously after the
 * first getVoices(), and installing a voice in the OS updates it live. `voiceschanged` covers both.
 * Safari never fires the event but has the list ready synchronously, which the initial state covers.
 */
function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState(listVoices);
  useEffect(() => {
    if (!canSpeak()) return;
    const update = () => setVoices(listVoices());
    update();
    window.speechSynthesis.addEventListener?.('voiceschanged', update);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', update);
  }, []);
  return voices;
}

/**
 * Account settings: which voice the app speaks in — drive mode's announcements and every help
 * script, since both go through src/speech.ts. Stored on this device only.
 */
export function VoiceSettings() {
  const voices = useVoices();
  const [uri, setUri] = useState(readVoicePref);
  const [allLanguages, setAllLanguages] = useState(false);
  const selectId = useId();

  // Stop the sample if they leave mid-sentence; the queue belongs to the document, not this card.
  useEffect(() => () => silence(), []);

  const shown = useMemo(() => {
    const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
    // A device with no English voice at all still gets a working picker rather than an empty one.
    const list = allLanguages || english.length === 0 ? voices : english;
    // The saved voice stays selectable even when the language filter would hide it.
    const saved = voices.find((v) => v.voiceURI === uri);
    const withSaved = saved && !list.includes(saved) ? [saved, ...list] : list;
    return [...withSaved].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  }, [voices, allLanguages, uri]);

  if (!canSpeak()) {
    return <p className="muted">This browser cannot speak, so there is no voice to choose.</p>;
  }

  const chosen = voices.find((v) => v.voiceURI === uri);
  // A saved URI this browser does not list (another profile, an uninstalled voice) is shown as the
  // default, which is also what speech.ts will actually use.
  const value = chosen ? chosen.voiceURI : '';

  return (
    <div className="stack">
      <p className="muted small">
        Used wherever the app talks: drive mode&rsquo;s next-door announcements and the spoken help. Saved
        on this device only.
      </p>
      <label className="field" htmlFor={selectId}>
        <span className="field__label">Voice</span>
        <select
          id={selectId}
          value={value}
          onChange={(e) => {
            const next = e.target.value || null;
            writeVoicePref(next);
            setUri(next);
            // Played from inside the change event so choosing IS hearing — and so iOS, which only
            // speaks from a user gesture, allows it. explain() reads the preference just written.
            explain(SAMPLE);
          }}
        >
          <option value="">Browser default</option>
          {shown.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} — {v.lang}
              {v.localService ? '' : ' (online)'}
            </option>
          ))}
        </select>
      </label>
      {voices.length === 0 && <p className="muted small">Still loading this device&rsquo;s voices…</p>}
      {chosen && !chosen.localService && (
        <p className="muted small">
          This is an online voice: the words are sent to the voice&rsquo;s provider to be spoken. That is
          acceptable here only because the app never speaks a name or an address — a distance, a side of
          the road, and the help text are all it ever says.
        </p>
      )}
      <div className="row">
        <button type="button" className="btn" onClick={() => explain(SAMPLE)}>
          Test voice
        </button>
        <label className="check">
          <input type="checkbox" checked={allLanguages} onChange={(e) => setAllLanguages(e.target.checked)} />
          <span className="check__label">Show every language</span>
        </label>
      </div>
    </div>
  );
}
