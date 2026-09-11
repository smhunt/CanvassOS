import { useSenderNumbers } from '../api/hooks';
import type { SenderNumber } from '../api/types';
import { EmptyState, ErrorBox, LoadingList, n } from '../components/ui';
import { pct, poolCapacity } from './format';

/** One number's day, as a bar. The cap is the point: past it, messages are accepted and dropped. */
function CapBar({ num }: { num: SenderNumber }) {
  const used = pct(num.sent_today, num.daily_cap);
  const full = num.sent_today >= num.daily_cap;
  return (
    <div
      className={`msg-cap${full ? ' msg-cap--full' : ''}`}
      role="img"
      aria-label={`${n(num.sent_today)} of ${n(num.daily_cap)} sent today${full ? ' — at its cap' : ''}`}
    >
      <span className="msg-cap__fill" style={{ width: `${used}%` }} />
    </div>
  );
}

/**
 * The throughput ceiling, at the top of the screen.
 *
 * Plan §1.1: a Canadian long code carries roughly 100–250 messages a day and the excess fails
 * silently. That makes the pool's daily capacity the single number that decides what a send can
 * be, so it is stated before anything is composed rather than discovered afterwards.
 */
export function CapacityStrip() {
  const q = useSenderNumbers();
  const cap = poolCapacity(q.data);

  if (q.isPending || q.isError) {
    // A failed capacity read must not look like "no capacity"; say nothing rather than something wrong.
    return null;
  }

  return (
    <div className={`msg-strip${cap.perDay <= 0 ? ' msg-strip--none' : ''}`}>
      <p className="msg-strip__line">
        <strong className="num">{n(cap.perDay)}</strong> messages a day, across{' '}
        <strong className="num">{n(cap.numbers)}</strong> {cap.numbers === 1 ? 'number' : 'numbers'} ·{' '}
        <span className="num">{n(cap.sentToday)}</span> sent today ·{' '}
        <strong className="num">{n(cap.leftToday)}</strong> left today
      </p>
      <p className="muted small">
        {cap.perDay <= 0
          ? 'No active sending numbers — nothing can be sent until one is added.'
          : 'That is the ceiling for every campaign on this screen. Anything above a number’s daily cap is dropped by the carrier without an error, so a big send is a drip measured in days.'}
      </p>
    </div>
  );
}

/** The pool itself: what each number has carried today against what it is allowed to carry. */
export function SenderPool() {
  const q = useSenderNumbers();
  const cap = poolCapacity(q.data);

  if (q.isPending) return <LoadingList rows={3} label="Loading the sending numbers…" />;
  if (q.isError) return <ErrorBox title="Sending numbers could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;

  const numbers = q.data ?? [];
  if (numbers.length === 0) {
    return (
      <EmptyState title="No sending numbers">
        <p>
          Numbers are provisioned with the provider and added server-side. Until there is at least one, campaigns can be
          written and approved but not sent.
        </p>
      </EmptyState>
    );
  }

  return (
    <section className="card stack">
      <h3 className="msg-h">Sending numbers</h3>
      <p className="muted small">
        Capacity is the sum of the active numbers&rsquo; daily caps: <strong className="num">{n(cap.perDay)}</strong> a
        day, <strong className="num">{n(cap.leftToday)}</strong> of it still available today. Caps are set
        conservatively on purpose — guessing high does not send more, it loses messages invisibly.
      </p>
      <div className="table-wrap">
        <table className="table table--compact">
          <thead>
            <tr>
              <th scope="col">Number</th>
              <th scope="col">Provider</th>
              <th scope="col">Today</th>
              <th scope="col">Capacity used</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((num) => (
              <tr key={num.id} className={num.active ? undefined : 'row--inactive'}>
                <td className="cell-name mono">
                  {num.e164}
                  {num.label && <span className="muted small"> {num.label}</span>}
                </td>
                <td>{num.provider}</td>
                <td className="num">
                  {n(num.sent_today)} / {n(num.daily_cap)}
                </td>
                <td className="msg-cap__cell">
                  <CapBar num={num} />
                </td>
                <td>
                  <span className={`tag tag--mini ${num.active ? 'tag--ok' : 'tag--neutral'}`}>
                    {num.active ? 'Active' : 'Paused'}
                  </span>
                  {num.sent_today >= num.daily_cap && num.active && (
                    <span className="tag tag--mini tag--warn msg-cap__tag">At cap</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
