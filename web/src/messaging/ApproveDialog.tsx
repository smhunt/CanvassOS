import { useMemo, useState } from 'react';
import { useAudience, useCampaignAction, useSegments } from '../api/hooks';
import type { Campaign } from '../api/types';
import { ErrorBox, fmtDate, n } from '../components/ui';
import { Dialog } from '../turfs/Dialog';
import { audienceSentence, finishDate } from './AudienceReadout';
import { describeDays, landsAfterElection, PURPOSE_CONSENT, PURPOSE_LABELS, segmentsLocal } from './format';

const CONFIRM_WORD = 'APPROVE';

interface Props {
  campaign: Campaign;
  onClose: () => void;
  onApproved: () => void;
}

/**
 * The last thing between a typo and a few thousand people.
 *
 * It restates the two numbers that decide whether this send is a good idea — how many people, and
 * how many days — because they were chosen minutes ago at the top of a long form, and asks for a
 * typed word rather than a click. Approving still does not send: the drip is started separately,
 * on purpose (`useCampaignAction` — approve, then send).
 */
export function ApproveDialog({ campaign, onClose, onApproved }: Props) {
  const [typed, setTyped] = useState('');
  const action = useCampaignAction();
  const audience = useAudience(campaign.purpose, campaign.audience);
  const body = campaign.body_sms ?? '';
  const server = useSegments(body);
  const local = useMemo(() => segmentsLocal(body), [body]);
  const seg = server.data ?? local;

  const a = audience.data;
  const finish = a ? finishDate(a.estimated_days) : null;
  const late = a ? landsAfterElection(finish) : false;
  const ok = typed.trim().toUpperCase() === CONFIRM_WORD && !action.isPending;

  return (
    <Dialog
      title="Approve this campaign"
      titleId="msg-approve-h"
      onClose={onClose}
      wide
      footer={
        <>
          <p className="muted small footnote" id="msg-approve-foot">
            Approving does not send. It records who signed this off; starting the drip is a separate button.
          </p>
          <button type="button" className="btn" onClick={onClose} disabled={action.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!ok}
            aria-describedby="msg-approve-foot"
            onClick={() => action.mutate({ id: campaign.id, action: 'approve' }, { onSuccess: onApproved })}
          >
            {action.isPending ? 'Approving…' : 'Approve'}
          </button>
        </>
      }
    >
      <div className="modal__body stack">
        <dl className="dl">
          <dt>Campaign</dt>
          <dd>{campaign.name}</dd>
          <dt>Purpose</dt>
          <dd>
            {PURPOSE_LABELS[campaign.purpose]} — {PURPOSE_CONSENT[campaign.purpose]}
          </dd>
          <dt>Reaches</dt>
          <dd>{a ? audienceSentence(a) : 'counting…'}</dd>
          <dt>Takes</dt>
          <dd>
            {a ? describeDays(a.estimated_days) : '—'}
            {finish && a && (a.estimated_days ?? 0) > 0 && <> — the last message lands around {fmtDate(finish.toISOString(), false)}</>}
          </dd>
          {a && a.sms > 0 && (
            <>
              <dt>Billed</dt>
              <dd className="num">
                {n(a.sms)} × {n(seg.segments)} {seg.segments === 1 ? 'segment' : 'segments'} ={' '}
                {n(a.sms * seg.segments)} segments, {seg.encoding}
              </dd>
            </>
          )}
        </dl>

        <div>
          <h3 className="msg-h">What they will read</h3>
          <blockquote className="msg-preview">{body || <em className="muted">No text message — email only.</em>}</blockquote>
          {campaign.body_email && (
            <blockquote className="msg-preview msg-preview--email">
              <strong>{campaign.email_subject || '(no subject)'}</strong>
              <span>{campaign.body_email}</span>
            </blockquote>
          )}
        </div>

        {late && (
          <p className="msg-note msg-note--warn">
            <span aria-hidden="true">⚑ </span>
            <span className="visually-hidden">Warning: </span>
            At the current sending capacity this does not finish before election day.
          </p>
        )}

        <p className="msg-note msg-note--warn">
          <span aria-hidden="true">⚑ </span>
          <span className="visually-hidden">Important: </span>
          A sent message cannot be recalled, corrected or apologised away one handset at a time. If you have not read
          the test on your own phone, close this and do that first.
        </p>

        {action.isError && <ErrorBox title="Could not approve" error={action.error} compact />}

        <label className="field field--short">
          <span className="field__label">Type {CONFIRM_WORD} to confirm</span>
          <input
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-describedby="msg-approve-foot"
          />
        </label>
      </div>
    </Dialog>
  );
}
