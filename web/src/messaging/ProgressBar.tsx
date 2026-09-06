import { n } from '../components/ui';
import { pct, totals, type Progress } from './format';

const PARTS = [
  { key: 'delivered', label: 'Delivered' },
  { key: 'sent', label: 'Sent, not confirmed' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'queued', label: 'Waiting' },
] as const;

interface Props {
  progress: Progress;
  /** Names what the bar is about — it ends up in the bar's accessible label. */
  label: string;
  compact?: boolean;
}

/**
 * A campaign's send counts as one stacked bar plus a written legend.
 *
 * Delivered is drawn separately from sent because the gap between them is the whole point: a long
 * code that has hit its cap keeps accepting messages and quietly drops them, so "sent" climbing
 * while "delivered" does not is the only visible symptom of a throttle eating the send.
 *
 * Every slice carries a hatch or a tint as well as a colour, and every count is also written out —
 * "failed" must not be a red rectangle and nothing else.
 */
export function ProgressBar({ progress, label, compact }: Props) {
  const t = totals(progress);
  const summary = PARTS.map((p) => `${p.label} ${n(progress[p.key])}`).join(', ');

  return (
    <div className={`msg-progress${compact ? ' msg-progress--compact' : ''}`}>
      <div className="msg-bar" role="img" aria-label={`${label}: ${n(t.total)} recipients — ${summary}`}>
        {PARTS.map((p) => {
          const w = pct(progress[p.key], t.total);
          if (w <= 0) return null;
          return <span key={p.key} className={`msg-bar__seg msg-bar__seg--${p.key}`} style={{ width: `${w}%` }} />;
        })}
      </div>
      <ul className="msg-legend" aria-hidden="true">
        {PARTS.map((p) => (
          <li key={p.key} className={progress[p.key] === 0 ? 'msg-legend__item muted' : 'msg-legend__item'}>
            <i className={`msg-legend__swatch msg-legend__swatch--${p.key}`} />
            {p.label} <span className="num">{n(progress[p.key])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The delivered-versus-sent gap, in words. Shown next to the bar because a bar can only make the
 * gap visible — it cannot say why it matters.
 */
export function DeliveryGap({ progress }: { progress: Progress }) {
  const t = totals(progress);
  if (t.attempted === 0) return null;
  const unconfirmed = progress.sent;
  const rate = t.attempted > 0 ? Math.round((progress.delivered / t.attempted) * 100) : 0;
  // A handful of receipts always lag by a minute or two; a persistent tenth of the send is the
  // shape of a silent throttle, so that is where the wording changes.
  const worrying = t.attempted >= 50 && unconfirmed / t.attempted > 0.1;

  return (
    <p className={`msg-note${worrying ? ' msg-note--warn' : ''}`}>
      {worrying && (
        <>
          <span aria-hidden="true">⚑ </span>
          <span className="visually-hidden">Warning: </span>
        </>
      )}
      <strong>{n(progress.delivered)} delivered</strong> of {n(t.attempted)} attempted ({rate}%).{' '}
      {unconfirmed > 0 ? (
        <>
          {n(unconfirmed)} {unconfirmed === 1 ? 'message has' : 'messages have'} been handed to the carrier without a
          delivery receipt coming back. Delivered is the number that matters: a long code past its daily cap accepts
          messages and drops them, and this gap is the only place that shows.
        </>
      ) : (
        <>Every attempted message has a delivery receipt — nothing is being dropped silently.</>
      )}
      {progress.failed > 0 && <> {n(progress.failed)} failed outright.</>}
      {progress.skipped > 0 && (
        <> {n(progress.skipped)} skipped — withdrawn, out of quiet hours, or a duplicate number.</>
      )}
    </p>
  );
}
