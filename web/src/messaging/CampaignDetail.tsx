import { useEffect, useState } from 'react';
import { useAudience, useCampaign, useCampaignAction, useSenderNumbers } from '../api/hooks';
import type { Campaign } from '../api/types';
import { ErrorBox, LoadingRows, fmtDate, n } from '../components/ui';
import { ApproveDialog } from './ApproveDialog';
import { AudienceReadout } from './AudienceReadout';
import { Composer } from './Composer';
import { ConfirmDialog } from './ConfirmDialog';
import { DeliveryGap, ProgressBar } from './ProgressBar';
import { TestSendPanel } from './TestSendPanel';
import {
  PURPOSE_CONSENT,
  PURPOSE_LABELS,
  STATUS_TONE,
  describeDays,
  finishEstimate,
  poolCapacity,
  statusLabel,
  totals,
} from './format';

type DialogKind = 'approve' | 'start' | 'cancel' | null;

interface Props {
  id: string;
  onBack: () => void;
}

/** Read-only rendering of what a campaign says, for every state after the draft. */
function MessagePreview({ campaign }: { campaign: Campaign }) {
  return (
    <section className="card stack">
      <h3 className="msg-h">The message</h3>
      {campaign.body_sms ? (
        <blockquote className="msg-preview">{campaign.body_sms}</blockquote>
      ) : (
        <p className="muted">No text message — email only.</p>
      )}
      {campaign.body_email && (
        <blockquote className="msg-preview msg-preview--email">
          <strong>{campaign.email_subject || '(no subject)'}</strong>
          <span>{campaign.body_email}</span>
        </blockquote>
      )}
    </section>
  );
}

/**
 * One campaign: edit it while it is a draft, approve it, start it, and then watch it drain.
 *
 * The live view exists because of the failure mode in plan §1.1 and §3.5 — a throttled long code
 * accepts messages it will never deliver — so while a send is running this polls and puts sent,
 * delivered and the remaining estimate on screen together.
 */
export function CampaignDetail({ id, onBack }: Props) {
  // Poll only while the drip is actually moving; the status the query itself returns is what turns
  // polling on and off, so there is no second source of truth about whether it is running.
  const [polling, setPolling] = useState(false);
  const q = useCampaign(id, polling);
  const campaign = q.data;
  useEffect(() => setPolling(campaign?.status === 'sending'), [campaign?.status]);

  const numbers = useSenderNumbers();
  const action = useCampaignAction();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [testedAt, setTestedAt] = useState<Date | null>(null);
  const [testedAnyway, setTestedAnyway] = useState(false);
  // Before the send starts there are no message_send rows to count, so the size of the job is the
  // audience, not the progress. Called unconditionally with a placeholder so hook order is stable.
  const aud = useAudience(campaign?.purpose ?? 'gotv', campaign?.audience ?? {});

  if (q.isPending && !campaign) return <LoadingRows rows={4} />;
  if (q.isError || !campaign) {
    return <ErrorBox title="Campaign could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;
  }

  const t = totals(campaign.progress);
  const cap = poolCapacity(numbers.data);
  const est = finishEstimate(t.remaining, cap);
  const isDraft = campaign.status === 'draft';
  const isApproved = campaign.status === 'scheduled';
  const running = campaign.status === 'sending' || campaign.status === 'paused';
  const finished = campaign.status === 'done' || campaign.status === 'cancelled';
  const canApprove = testedAt !== null || testedAnyway;
  const busy = action.isPending;
  // The job either has rows already (it has started) or is still just an audience.
  const plannedRecipients = t.total > 0 ? t.total : (aud.data?.sms ?? 0) + (aud.data?.email ?? 0);
  const plannedDays = t.total > 0 ? est.days : (aud.data?.estimated_days ?? finishEstimate(plannedRecipients, cap).days);

  const run = (a: 'send' | 'pause' | 'resume' | 'cancel') =>
    action.mutate({ id: campaign.id, action: a }, { onSuccess: () => setDialog(null) });

  return (
    <div className="stack">
      <div className="msg-detail__top">
        <button type="button" className="linkbtn" onClick={onBack}>
          ← All campaigns
        </button>
      </div>

      <header className="card msg-detail__head">
        <div className="msg-detail__title">
          <h2 className="msg-h">{campaign.name}</h2>
          <span className={`tag tag--${STATUS_TONE[campaign.status]}`}>{statusLabel(campaign)}</span>
        </div>
        <p className="muted small">
          {PURPOSE_LABELS[campaign.purpose]} — {PURPOSE_CONSENT[campaign.purpose]}
        </p>
        <p className="muted small">
          Created {fmtDate(campaign.created_at)}
          {campaign.created_by_name && ` by ${campaign.created_by_name}`}
          {campaign.approved_at && ` · approved ${fmtDate(campaign.approved_at)}`}
          {campaign.approved_by_name && ` by ${campaign.approved_by_name}`}
          {campaign.started_at && ` · started ${fmtDate(campaign.started_at)}`}
          {campaign.finished_at && ` · finished ${fmtDate(campaign.finished_at)}`}
        </p>
      </header>

      {action.isError && <ErrorBox title="That action did not go through" error={action.error} />}

      {isDraft && (
        <>
          <Composer key={campaign.id} campaign={campaign} onSaved={() => undefined} onCancel={onBack} />

          <section className="card stack msg-steps">
            <h3 className="msg-h">Before it goes anywhere</h3>

            <div className="msg-step">
              <h4 className="msg-step__h">
                <span className="msg-step__n" aria-hidden="true">
                  1
                </span>
                Send it to yourself
              </h4>
              <p className="muted small">
                Tests the saved draft, so save your changes first. Nobody should discover a broken link two thousand
                messages in.
              </p>
              <TestSendPanel
                campaignId={campaign.id}
                disabled={!campaign.body_sms}
                testedAt={testedAt}
                onTested={() => setTestedAt(new Date())}
              />
            </div>

            <div className="msg-step">
              <h4 className="msg-step__h">
                <span className="msg-step__n" aria-hidden="true">
                  2
                </span>
                Approve
              </h4>
              <p className="muted small">
                Approving restates the audience and how many days the send will take, and asks you to type a word. It
                still does not send anything.
              </p>
              {!canApprove && (
                <label className="check msg-steps__override">
                  <input type="checkbox" checked={testedAnyway} onChange={(e) => setTestedAnyway(e.target.checked)} />
                  <span className="check__label">I have already read this message on a real handset</span>
                </label>
              )}
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canApprove || busy}
                onClick={() => setDialog('approve')}
              >
                Approve this campaign
              </button>
              {!canApprove && (
                <p className="muted small">
                  Send yourself the test first — or tick the box above if you already have.
                </p>
              )}
            </div>
          </section>
        </>
      )}

      {!isDraft && <MessagePreview campaign={campaign} />}

      {isApproved && (
        <>
          <AudienceReadout purpose={campaign.purpose} audience={campaign.audience} headingId="msg-approved-audience-h" />
          <section className="card stack">
            <h3 className="msg-h">
              <span className="msg-step__n" aria-hidden="true">
                3
              </span>
              Start the drip
            </h3>
            <p>
              Approved{campaign.approved_by_name ? ` by ${campaign.approved_by_name}` : ''}. Starting it queues one row
              per person and hands them to the number pool at its daily cap — steadily, over hours or days, not at once.
            </p>
            <div className="msg-actions">
              <button type="button" className="btn btn--danger-outline" disabled={busy} onClick={() => setDialog('cancel')}>
                Cancel campaign
              </button>
              <button type="button" className="btn btn--primary" disabled={busy || cap.perDay <= 0} onClick={() => setDialog('start')}>
                Start sending
              </button>
            </div>
            {cap.perDay <= 0 && (
              <p className="msg-note msg-note--warn">
                <span aria-hidden="true">⚑ </span>
                <span className="visually-hidden">Warning: </span>
                No active sending numbers, so there is nothing to send with.
              </p>
            )}
          </section>
        </>
      )}

      {(running || finished) && (
        <section className="card stack" aria-labelledby="msg-live-h">
          <div className="msg-detail__title">
            <h3 className="msg-h" id="msg-live-h">
              {running ? 'Draining' : 'Final result'}
            </h3>
            {campaign.status === 'sending' && (
              <span className="muted small" aria-live="polite">
                Updating every few seconds{q.isFetching ? ' — checking now' : ''}
              </span>
            )}
          </div>

          <ProgressBar progress={campaign.progress} label={campaign.name} />

          <div className="msg-counts">
            <p className="num">
              <strong>{n(t.handled)}</strong> of <strong>{n(t.total)}</strong> recipients handled ·{' '}
              <strong>{n(t.remaining)}</strong> still waiting
            </p>
            {running && (
              <p aria-live="polite">
                {t.remaining > 0 ? (
                  <>
                    {describeDays(est.days)} left at {n(cap.perDay)} a day across {n(cap.numbers)}{' '}
                    {cap.numbers === 1 ? 'number' : 'numbers'}
                    {est.date && est.days > 0 && <> — finishing around {fmtDate(est.date.toISOString(), false)}</>}.{' '}
                    {n(cap.leftToday)} of today&rsquo;s capacity is left.
                  </>
                ) : (
                  <>Everything queued has been handled.</>
                )}
              </p>
            )}
          </div>

          <DeliveryGap progress={campaign.progress} />

          {running && (
            <div className="msg-actions">
              <button type="button" className="btn btn--danger-outline" disabled={busy} onClick={() => setDialog('cancel')}>
                Cancel the send
              </button>
              {campaign.status === 'sending' ? (
                <button type="button" className="btn" disabled={busy} onClick={() => run('pause')}>
                  {busy ? 'Pausing…' : 'Pause'}
                </button>
              ) : (
                <button type="button" className="btn btn--primary" disabled={busy} onClick={() => run('resume')}>
                  {busy ? 'Resuming…' : 'Resume'}
                </button>
              )}
            </div>
          )}

          {campaign.status === 'paused' && (
            <p className="msg-note">
              Paused. Nothing is leaving. Queued messages are re-checked against withdrawals when they resume, so a STOP
              received while paused is honoured.
            </p>
          )}
        </section>
      )}

      {dialog === 'approve' && (
        <ApproveDialog campaign={campaign} onClose={() => setDialog(null)} onApproved={() => setDialog(null)} />
      )}

      {dialog === 'start' && (
        <ConfirmDialog
          title="Start sending"
          titleId="msg-start-h"
          confirmLabel="Start sending"
          busyLabel="Starting…"
          busy={busy}
          error={action.error}
          errorTitle="Could not start the send"
          onConfirm={() => run('send')}
          onClose={() => setDialog(null)}
        >
          <p>
            This begins a real send to real phones. It cannot be un-sent — pausing stops what has not gone yet, and
            nothing more.
          </p>
          <p className="num">
            <strong>{n(plannedRecipients)}</strong> recipients · {describeDays(plannedDays)} at {n(cap.perDay)} a day
          </p>
          <p className="muted small">
            Sending pauses outside 09:00–21:30 on weekdays and 10:00–18:00 at weekends, so it may take longer than the
            estimate — never less.
          </p>
        </ConfirmDialog>
      )}

      {dialog === 'cancel' && (
        <ConfirmDialog
          title="Cancel this campaign"
          titleId="msg-cancel-h"
          confirmLabel="Cancel the campaign"
          busyLabel="Cancelling…"
          danger
          busy={busy}
          error={action.error}
          errorTitle="Could not cancel"
          onConfirm={() => run('cancel')}
          onClose={() => setDialog(null)}
        >
          <p>
            <span aria-hidden="true">⚑ </span>
            <span className="visually-hidden">Warning: </span>
            Cancelling is final — a cancelled campaign cannot be restarted, and the {n(t.remaining)} messages still
            waiting will never be sent. Anything already delivered stays delivered.
          </p>
          <p className="muted small">To stop it temporarily instead, use Pause.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
