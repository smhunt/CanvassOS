import { useState, type FormEvent } from 'react';
import { useAudience, useCreateCampaign, useUpdateCampaign } from '../api/hooks';
import type { Campaign, CampaignPurpose } from '../api/types';
import { ErrorBox, n } from '../components/ui';
import { AudienceFilters } from './AudienceFilters';
import { AudienceReadout } from './AudienceReadout';
import { SegmentMeter } from './SegmentMeter';
import { PURPOSE_CONSENT, PURPOSE_LABELS } from './format';

const FORM_ID = 'msg-composer-form';
const OPT_OUT = 'Reply STOP to stop.';

interface Props {
  /** Absent for a new draft. The parent keys this component by id, so state starts fresh. */
  campaign?: Campaign;
  onSaved: (c: Campaign) => void;
  onCancel: () => void;
}

/**
 * Compose or edit a draft.
 *
 * Order on the page is deliberate and is the whole argument of plan §1.1: name, then purpose, then
 * who it reaches and how many days that takes — and only then the message box. The cost of a
 * nine-day send is a fact about the audience, so it belongs where the audience is chosen.
 */
export function Composer({ campaign, onSaved, onCancel }: Props) {
  const [name, setName] = useState(campaign?.name ?? '');
  const [purpose, setPurpose] = useState<CampaignPurpose>(campaign?.purpose ?? 'gotv');
  const [wards, setWards] = useState<string[]>(campaign?.audience.ward ?? []);
  const [communities, setCommunities] = useState<string[]>(campaign?.audience.community ?? []);
  const [bodySms, setBodySms] = useState(campaign?.body_sms ?? '');
  const [emailSubject, setEmailSubject] = useState(campaign?.email_subject ?? '');
  const [bodyEmail, setBodyEmail] = useState(campaign?.body_email ?? '');

  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const saving = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const audience = {
    ...(wards.length > 0 ? { ward: wards } : {}),
    ...(communities.length > 0 ? { community: communities } : {}),
  };
  const counts = useAudience(purpose, audience);

  const hasOptOut = /\bstop\b/i.test(bodySms);
  const ready = name.trim().length > 0 && (bodySms.trim().length > 0 || bodyEmail.trim().length > 0);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || saving) return;
    const body = {
      name: name.trim(),
      purpose,
      body_sms: bodySms.trim() || null,
      email_subject: emailSubject.trim() || null,
      body_email: bodyEmail.trim() || null,
      audience,
    };
    if (campaign) update.mutate({ id: campaign.id, ...body }, { onSuccess: (r) => onSaved(r.campaign) });
    else create.mutate(body, { onSuccess: (r) => onSaved(r.campaign) });
  };

  return (
    <form id={FORM_ID} className="msg-composer stack" onSubmit={onSubmit} noValidate>
      <section className="card stack">
        <div className="form-row">
          <label className="field">
            <span className="field__label">Campaign name</span>
            <input
              type="text"
              required
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. GOTV — advance polls, Komoka"
            />
            <span className="field__hint">Internal only. Nobody receiving the message sees it.</span>
          </label>
        </div>

        <fieldset className="fs">
          <legend>Purpose</legend>
          {/* Not a label: it decides which consent column a recipient must hold, so somebody who
              only agreed to updates is never in a get-out-the-vote send, and vice versa. */}
          <div className="msg-purpose">
            {(['gotv', 'updates'] as const).map((p) => (
              <label key={p} className={`msg-purpose__opt${purpose === p ? ' msg-purpose__opt--on' : ''}`}>
                <input
                  type="radio"
                  name="msg-purpose"
                  value={p}
                  checked={purpose === p}
                  onChange={() => setPurpose(p)}
                />
                <span>
                  <strong>{PURPOSE_LABELS[p]}</strong>
                  <span className="muted small msg-purpose__note">{PURPOSE_CONSENT[p]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="muted small fs__note">
            These draw on different consent. Changing it changes who is counted below — often by a lot.
          </p>
        </fieldset>

        <AudienceFilters wards={wards} communities={communities} onWards={setWards} onCommunities={setCommunities} />
      </section>

      {/* Before the compose box, deliberately. */}
      <AudienceReadout purpose={purpose} audience={audience} />

      <section className="card stack">
        <h3 className="msg-h">The text message</h3>
        <label className="field">
          <span className="field__label">SMS body</span>
          <textarea
            className="msg-textarea"
            rows={5}
            value={bodySms}
            onChange={(e) => setBodySms(e.target.value)}
            placeholder={`Hi — it's Sean Hunt. Advance voting is open Saturday 9-5 at the Komoka arena. ${OPT_OUT}`}
          />
        </label>
        <SegmentMeter text={bodySms} onFix={setBodySms} smsRecipients={counts.data?.sms} />

        {bodySms.trim().length > 0 && !hasOptOut && (
          <div className="msg-note msg-note--warn">
            <p>
              <span aria-hidden="true">⚑ </span>
              <span className="visually-hidden">Warning: </span>
              No opt-out instruction. Every message has to tell people how to stop — and STOP has to keep working
              whether or not it is written down.
            </p>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => setBodySms(`${bodySms.trimEnd()} ${OPT_OUT}`)}
            >
              Add “{OPT_OUT}”
            </button>
          </div>
        )}
      </section>

      <section className="card stack">
        <h3 className="msg-h">Email (optional)</h3>
        <p className="muted small">
          Email is the fallback, never a second copy: anyone reachable by SMS gets the text and nothing else. It only
          reaches the {n(counts.data?.email ?? 0)} people who gave an address and no phone.
        </p>
        <label className="field">
          <span className="field__label">Subject</span>
          <input type="text" value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span className="field__label">Email body</span>
          <textarea className="msg-textarea" rows={6} value={bodyEmail} onChange={(e) => setBodyEmail(e.target.value)} />
          <span className="field__hint">A one-click unsubscribe link is added on the way out.</span>
        </label>
      </section>

      {error !== null && <ErrorBox title="Could not save the draft" error={error} />}

      {/* Saving a draft is silent otherwise, and "did that save?" is the question that produces two
          campaigns instead of one. */}
      <p aria-live="polite" className="msg-saved">
        {!saving && (create.isSuccess || update.isSuccess) ? 'Draft saved.' : ''}
      </p>

      <div className="msg-actions">
        <p className="muted small msg-actions__note" id="msg-save-note">
          Saving only stores the draft. Nothing is sent until you test it, approve it, and start it — three separate
          steps.
        </p>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!ready || saving} aria-describedby="msg-save-note">
          {saving ? 'Saving…' : campaign ? 'Save changes' : 'Save draft'}
        </button>
      </div>
    </form>
  );
}
