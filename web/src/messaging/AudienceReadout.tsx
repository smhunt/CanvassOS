import { useAudience } from '../api/hooks';
import type { AudienceCount, CampaignPurpose } from '../api/types';
import { ErrorBox, fmtDate, n } from '../components/ui';
import { describeDays, landsAfterElection } from './format';

/** The one sentence the brief asks for, reused verbatim in the approve dialog. */
export function audienceSentence(a: AudienceCount): string {
  return (
    `Reaches ${n(a.sms)} by SMS, ${n(a.email)} by email · ${n(a.unreachable)} not reachable · ` +
    `${describeDays(a.estimated_days)} at ${n(a.daily_capacity)} a day`
  );
}

/** Days from today, as a calendar date — what "about 5 days" actually means on a wall calendar. */
export function finishDate(days: number): Date | null {
  if (!Number.isFinite(days)) return null;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.max(0, days));
}

interface Props {
  purpose: CampaignPurpose;
  audience: { ward?: string[]; community?: string[] };
  /** Heading level so this reads correctly inside the composer and inside a dialog. */
  headingId?: string;
}

/**
 * Who a campaign can reach and how long the transport will take to reach them.
 *
 * This sits ABOVE the compose box on purpose. Throughput is the ceiling (plan §1.1): Canadian long
 * codes carry roughly 100–250 messages a day per number and the excess is dropped without an
 * error. An organiser who learns after writing the message that the send takes nine days has
 * learned it too late — by then the audience is already chosen.
 */
export function AudienceReadout({ purpose, audience, headingId = 'msg-audience-h' }: Props) {
  const q = useAudience(purpose, audience);
  const a = q.data;
  const finish = a ? finishDate(a.estimated_days) : null;
  const late = a ? landsAfterElection(finish) : false;
  const noCapacity = a !== undefined && a.daily_capacity <= 0;

  return (
    <section className="card msg-audience" aria-labelledby={headingId}>
      <h3 id={headingId} className="msg-audience__h">
        Who this reaches, and how long it takes
      </h3>

      {q.isError && <ErrorBox title="Audience could not be counted" error={q.error} onRetry={() => void q.refetch()} compact />}

      {/* The live region is the sentence; the tiles below repeat it visually. */}
      <p className="msg-audience__sentence" aria-live="polite">
        {q.isPending && !a ? 'Counting…' : a ? audienceSentence(a) : 'Audience unknown.'}
      </p>

      {a && (
        <>
          <div className="msg-audience__tiles" aria-hidden="true">
            <div className="tile">
              <span className="tile__value num">{n(a.sms)}</span>
              <span className="tile__label">by SMS</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(a.email)}</span>
              <span className="tile__label">by email</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(a.unreachable)}</span>
              <span className="tile__label">not reachable</span>
            </div>
            <div className="tile">
              <span className="tile__value num">{n(a.total)}</span>
              <span className="tile__label">in scope</span>
            </div>
          </div>

          <p className={`msg-throughput${a.estimated_days > 1 || noCapacity ? ' msg-throughput--slow' : ''}`}>
            <strong className="msg-throughput__days">{describeDays(a.estimated_days)}</strong>
            <span className="msg-throughput__rate">
              {' '}
              at {n(a.daily_capacity)} messages a day
              {finish && a.estimated_days > 0 && <> — the last one lands around {fmtDate(finish.toISOString(), false)}</>}
            </span>
          </p>

          {noCapacity && (
            <p className="msg-note msg-note--warn">
              <span aria-hidden="true">⚑ </span>
              <span className="visually-hidden">Warning: </span>
              There are no active sending numbers, so this campaign cannot go anywhere. Add a number to the pool first.
            </p>
          )}

          {late && !noCapacity && (
            <p className="msg-note msg-note--warn">
              <span aria-hidden="true">⚑ </span>
              <span className="visually-hidden">Warning: </span>
              At this rate the send finishes after election day. Narrow the audience, add sending numbers, or start it
              sooner — a get-out-the-vote message that arrives on the 27th is wasted.
            </p>
          )}

          <p className="muted small msg-audience__foot">
            This is a drip, not a blast: messages leave steadily across the number pool and pause outside 09:00–21:30 on
            weekdays and 10:00–18:00 at weekends, so the real finish is this estimate or later, never sooner.
            {' '}Nobody counted here is someone who has not said yes to this purpose.
          </p>
        </>
      )}
    </section>
  );
}
