import { useState } from 'react';
import { useDecideMatch, useHandleRequest, usePublicRequests } from '../api/hooks';
import type { MatchCandidate, PublicRequest } from '../api/types';
import { ErrorBox, LoadingList } from '../components/ui';

/**
 * The website sign-up queue: everyone who put their name in on the campaign site (plus any direct
 * public-form posts), with the matcher's ranked guesses at which voter they are.
 *
 * The one rule that matters here: a fuzzy match is a QUESTION, and this screen is where a human
 * answers it. "That's them" records the link (and survives voters-list re-imports via the
 * ledger); "Not them" makes sure the same wrong guess never comes back. Exact contact-info hits
 * may arrive already accepted — the matcher is allowed to do that much on its own — and they show
 * up here labelled auto-linked rather than silently.
 */
export function RequestsPage() {
  const [showHandled, setShowHandled] = useState(false);
  const { data: requests, isPending, error, refetch } = usePublicRequests(!showHandled);

  return (
    <main className="page">
      <header className="page__head">
        <h1>Sign-ups</h1>
        <label className="check">
          <input type="checkbox" checked={showHandled} onChange={(e) => setShowHandled(e.target.checked)} />
          Show handled too
        </label>
      </header>

      {isPending && <LoadingList rows={4} label="Loading sign-ups…" />}
      {error != null && <ErrorBox error={error} onRetry={() => void refetch()} />}
      {requests && requests.length === 0 && (
        <p className="muted">Nothing waiting. New website sign-ups appear here within five minutes.</p>
      )}
      {requests?.map((r) => <RequestCard key={r.id} request={r} />)}
    </main>
  );
}

const WANT_LABELS: Record<string, string> = {
  sign: 'lawn sign',
  volunteer: 'volunteer',
  reminders: 'voting reminders',
  donate: 'donate',
  other: 'other',
};

function RequestCard({ request: r }: { request: PublicRequest }) {
  const handle = useHandleRequest();
  const decideAccepted = useDecideMatch();

  const accepted = r.candidates.find((c) => c.status === 'accepted');
  const open = r.candidates.filter((c) => c.status === 'suggested');
  const rejected = r.candidates.filter((c) => c.status === 'rejected');

  return (
    <section className={`card request${r.handled_at ? ' request--handled' : ''}`}>
      <div className="request__head">
        <div>
          <strong>{r.name}</strong>
          <span className="muted">
            {' '}
            · {new Date(r.created_at).toLocaleDateString()} ·{' '}
            {r.source === 'website' ? 'website' : 'public form'}
          </span>
          {r.website_status === 'unsubscribed' && (
            <span className="request__flag request__flag--danger">unsubscribed — do not email</span>
          )}
          {r.website_status === 'pending' && <span className="request__flag">email unconfirmed</span>}
        </div>
        <button
          type="button"
          className="btn btn--small"
          disabled={handle.isPending}
          onClick={() => handle.mutate({ requestId: r.id, handled: !r.handled_at })}
        >
          {r.handled_at ? 'Reopen' : 'Mark handled'}
        </button>
      </div>

      <p className="request__contact muted">
        {[r.email, r.phone, r.address].filter(Boolean).join(' · ') || 'no contact details'}
        {r.wants.length > 0 && <> · wants: {r.wants.map((w) => WANT_LABELS[w] ?? w).join(', ')}</>}
      </p>
      {r.note && <p className="request__note">“{r.note}”</p>}

      {accepted && (
        <p className="request__match">
          ✓ Linked to <strong>{accepted.voter_name}</strong>
          {accepted.household_address && <span className="muted"> — {accepted.household_address}</span>}
          <span className="muted"> ({matchLabel(accepted)})</span>
          <button
            type="button"
            className="linkbtn request__unlink"
            disabled={decideAccepted.isPending}
            onClick={() => decideAccepted.mutate({ requestId: r.id, candidateId: accepted.id, decision: 'reject' })}
          >
            Undo — not them
          </button>
        </p>
      )}

      {!accepted && open.length > 0 && (
        <div className="request__candidates">
          <p className="muted">Is this one of these people?</p>
          {open.map((c) => (
            <CandidateRow key={c.id} requestId={r.id} candidate={c} />
          ))}
        </div>
      )}
      {!accepted && open.length === 0 && rejected.length > 0 && (
        <p className="muted">No match — {rejected.length} candidate{rejected.length > 1 ? 's' : ''} ruled out.</p>
      )}
      {!accepted && r.candidates.length === 0 && <p className="muted">No voter match found yet.</p>}
    </section>
  );
}

function matchLabel(c: MatchCandidate): string {
  switch (c.method) {
    case 'email':
      return 'matched on email';
    case 'phone':
      return 'matched on phone';
    case 'ledger':
      return 'decided earlier';
    case 'name_address':
      return `name + address, ${Math.round(c.score * 100)}%`;
    default:
      return `name, ${Math.round(c.score * 100)}%`;
  }
}

function CandidateRow({ requestId, candidate: c }: { requestId: string; candidate: MatchCandidate }) {
  const decide = useDecideMatch();
  return (
    <div className="candidate">
      <div className="candidate__who">
        <strong>{c.voter_name}</strong>
        {c.household_address && <span className="muted"> — {c.household_address}</span>}
        <span className="muted"> ({matchLabel(c)})</span>
      </div>
      <div className="candidate__actions">
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ requestId, candidateId: c.id, decision: 'accept' })}
        >
          That’s them
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ requestId, candidateId: c.id, decision: 'reject' })}
        >
          Not them
        </button>
      </div>
    </div>
  );
}
