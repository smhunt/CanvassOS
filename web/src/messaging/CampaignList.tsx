import { useCampaigns } from '../api/hooks';
import { EmptyState, ErrorBox, LoadingCards, fmtDate, n } from '../components/ui';
import { ProgressBar } from './ProgressBar';
import { PURPOSE_LABELS, awaitingStart, statusLabel, statusTone, totals } from './format';

interface Props {
  onOpen: (id: string) => void;
  onNew: () => void;
}

/**
 * Every campaign, newest first. Anything that has started carries its bar here rather than only on
 * the detail screen — a stalled send is something an organiser should be able to spot from the
 * list, without opening each one to find the campaign whose delivered count stopped moving.
 */
export function CampaignList({ onOpen, onNew }: Props) {
  const q = useCampaigns();

  if (q.isPending) return <LoadingCards count={3} label="Loading campaigns…" />;
  if (q.isError) return <ErrorBox title="Campaigns could not be loaded" error={q.error} onRetry={() => void q.refetch()} />;

  const campaigns = q.data ?? [];
  if (campaigns.length === 0) {
    return (
      <EmptyState title="No campaigns yet">
        <p>
          A campaign is one message to everyone who agreed to hear from you for that purpose. Write it, test it on your
          own phone, approve it, then start it.
        </p>
        <button type="button" className="btn btn--primary" onClick={onNew}>
          New campaign
        </button>
      </EmptyState>
    );
  }

  return (
    <ul className="msg-list">
      {campaigns.map((c) => {
        const t = totals(c.progress);
        const started = !awaitingStart(c) && c.status !== 'draft';
        return (
          <li key={c.id} className="card msg-camp">
            <div className="msg-camp__head">
              <h3 className="msg-camp__name">
                <button type="button" className="linkbtn" onClick={() => onOpen(c.id)}>
                  {c.name}
                </button>
              </h3>
              <span className={`tag tag--${statusTone(c)}`}>{statusLabel(c)}</span>
            </div>

            <p className="muted small msg-camp__meta">
              {PURPOSE_LABELS[c.purpose]} ·{' '}
              {c.finished_at
                ? `finished ${fmtDate(c.finished_at)}`
                : c.started_at
                  ? `started ${fmtDate(c.started_at)}`
                  : c.scheduled_for
                    ? `scheduled for ${fmtDate(c.scheduled_for)}`
                    : `created ${fmtDate(c.created_at)}`}
              {c.created_by_name && ` · ${c.created_by_name}`}
            </p>

            {started && t.total > 0 ? (
              <>
                <ProgressBar progress={c.progress} label={c.name} compact />
                <p className="small msg-camp__nums num">
                  <strong>{n(c.progress.delivered)} delivered</strong> of {n(t.attempted)} attempted
                  {c.progress.queued > 0 && <> · {n(c.progress.queued)} still waiting</>}
                </p>
              </>
            ) : (
              <p className="muted small">
                {awaitingStart(c) ? 'Approved and waiting to be started.' : 'Not tested, approved or sent.'}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
