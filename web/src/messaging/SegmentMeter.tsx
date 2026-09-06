import { useEffect, useMemo, useState } from 'react';
import { useSegments } from '../api/hooks';
import { n } from '../components/ui';
import { describeChar, hasSmartPunctuation, segmentsIfPlain, segmentsLocal, toPlainPunctuation } from './format';

interface Props {
  text: string;
  /** Offered only when the fix is punctuation; accents are never silently stripped. */
  onFix?: (next: string) => void;
  /** How many people would get this by SMS, so the segment count can be turned into a bill. */
  smsRecipients?: number;
}

/** Server round-trips lag a keystroke; the local count fills the gap so the meter is never stale. */
function useDebounced(value: string, ms: number): string {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setOut(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return out;
}

/**
 * Characters, segments and encoding, live.
 *
 * The trap this exists for (plan §1.4): a single curly apostrophe pasted from Word forces UCS-2,
 * the per-segment budget drops from 160 characters to 70, and every message in the send silently
 * costs three times as much. So the meter does not just report "UCS-2" — it names the character
 * that did it and prices the difference.
 */
export function SegmentMeter({ text, onFix, smsRecipients }: Props) {
  const debounced = useDebounced(text, 300);
  const server = useSegments(debounced);
  const local = useMemo(() => segmentsLocal(text), [text]);

  // The provider bills against the server's maths, so its answer wins once it matches what is in
  // the box. Between keystroke and response the local count keeps the meter honest and moving.
  const info = debounced === text && server.data ? server.data : local;
  const ucs2 = info.encoding === 'UCS-2';
  const perSegment = ucs2 ? (info.segments > 1 ? 67 : 70) : info.segments > 1 ? 153 : 160;
  const left = Math.max(0, perSegment * Math.max(info.segments, 1) - info.chars);
  const plainSegments = ucs2 ? segmentsIfPlain(text) : info.segments;
  const fixable = ucs2 && onFix !== undefined && hasSmartPunctuation(text) && plainSegments < info.segments;

  return (
    <div className={`msg-seg${ucs2 ? ' msg-seg--ucs2' : ''}`}>
      {/* Polite and debounced: it changes with every keystroke, so it must not shout each one. */}
      <p className="msg-seg__line" aria-live="polite">
        <span className="num">
          <strong>{n(info.chars)}</strong> characters
        </span>
        <span aria-hidden="true"> · </span>
        <span className="num">
          <strong>{n(info.segments)}</strong> {info.segments === 1 ? 'segment' : 'segments'}
        </span>
        <span aria-hidden="true"> · </span>
        <span className="msg-seg__enc">{info.encoding}</span>
        {info.chars > 0 && (
          <span className="muted small">
            {' '}
            ({n(left)} left in this segment, {perSegment} per segment)
          </span>
        )}
        {smsRecipients !== undefined && info.segments > 0 && (
          <span className="muted small">
            {' '}
            — {n(smsRecipients)} × {n(info.segments)} = <strong>{n(smsRecipients * info.segments)}</strong> segments billed
          </span>
        )}
      </p>

      {ucs2 && (
        <div className="msg-seg__warn" role="status">
          <p className="msg-seg__warn-head">
            <span aria-hidden="true">⚑ </span>
            <span className="visually-hidden">Warning: </span>
            This message is being sent as UCS-2 — 70 characters per segment instead of 160.
          </p>
          <ul className="msg-seg__chars">
            {info.offending.slice(0, 8).map((ch) => (
              <li key={ch}>
                <code className="mono">{ch === ' ' || ch.trim() === '' ? '␣' : ch}</code> {describeChar(ch)}
              </li>
            ))}
            {info.offending.length > 8 && <li className="muted">and {n(info.offending.length - 8)} more</li>}
          </ul>
          {plainSegments < info.segments && (
            <p className="msg-seg__cost">
              Straight punctuation would make this {n(plainSegments)} {plainSegments === 1 ? 'segment' : 'segments'} instead
              of {n(info.segments)} — the same message, {(info.segments / Math.max(plainSegments, 1)).toFixed(0)}× the bill,
              for every person in the send.
            </p>
          )}
          {fixable && (
            <button type="button" className="btn btn--small" onClick={() => onFix?.(toPlainPunctuation(text))}>
              Replace smart punctuation
            </button>
          )}
          {!fixable && (
            <p className="muted small">
              Accented letters are left alone — a name is not a typo. If the accents are deliberate, plan for the extra
              segments.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
