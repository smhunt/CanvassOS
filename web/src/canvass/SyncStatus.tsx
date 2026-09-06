/**
 * What the volunteer has to be able to trust: is this phone online, how many recorded doors are
 * still only on the phone, when did they last reach the server, and is anything stuck.
 *
 * Without this the app asks for blind faith — and a volunteer who does not trust it re-knocks doors,
 * which is worse than any bug. So the pill is always present (on the turf header and inside the door
 * sheet, because the sheet is where a shift is actually spent), and one tap opens the whole truth:
 * the queue, the failures with the server's own words, and the "clear this phone" button.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useOutbox } from '../offline/useOutbox';
import { clearTurfCache, cachedTurfSummaries } from '../offline/turfCache';
import { discardEntry, retryEntry, syncNow, type OutboxEntry, type OutboxSnapshot } from '../offline/outbox';
import { n } from '../components/ui';
import { agoLabel as ago } from './status';

type Tone = 'ok' | 'queued' | 'offline' | 'attention';

function toneOf(s: OutboxSnapshot): Tone {
  if (s.parked > 0) return 'attention';
  if (!s.online) return 'offline';
  if (s.pending > 0) return 'queued';
  return 'ok';
}

/** Short enough for the sheet's subtitle line, specific enough to act on. */
function summarise(s: OutboxSnapshot): string {
  if (s.parked > 0) return `${n(s.parked)} need${s.parked === 1 ? 's' : ''} attention`;
  if (s.syncing) return 'Syncing…';
  if (!s.online) return s.pending > 0 ? `Offline · ${n(s.pending)} saved here` : 'Offline';
  if (s.pending > 0) return `${n(s.pending)} to sync`;
  return 'Synced';
}

interface Props {
  /** The sheet's copy sits on a subtitle line, so it drops to dot + word. */
  compact?: boolean;
}

export function SyncStatus({ compact = false }: Props) {
  const snapshot = useOutbox();
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const tone = toneOf(snapshot);
  const label = summarise(snapshot);

  // The panel takes focus when it opens, so closing it must hand focus back — otherwise a keyboard
  // or screen-reader user is dropped on <body>, behind the door sheet they were working in.
  function close() {
    setOpen(false);
    pillRef.current?.focus({ preventScroll: true });
  }

  return (
    <>
      <button
        type="button"
        ref={pillRef}
        className={`cv-sync__pill cv-sync__pill--${tone}${compact ? ' cv-sync__pill--compact' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="cv-sync__dot" aria-hidden="true" />
        {/* Announced rather than merely rendered: going offline mid-shift is the one status change
            nobody should have to notice for themselves. */}
        <span aria-live="polite">{label}</span>
        <span className="visually-hidden"> — open sync details</span>
      </button>
      {open && <SyncPanel snapshot={snapshot} onClose={close} />}
    </>
  );
}

function SyncPanel({ snapshot, onClose }: { snapshot: OutboxSnapshot; onClose: () => void }) {
  const headRef = useRef<HTMLHeadingElement>(null);
  const [cached, setCached] = useState<{ turf_id: string; name: string; n_doors: number; cached_at: number }[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  const refreshCached = useCallback(() => void cachedTurfSummaries().then(setCached), []);
  useEffect(refreshCached, [refreshCached]);
  useEffect(() => headRef.current?.focus({ preventScroll: true }), []);

  // The door sheet closes on Escape from a document listener. Stopping the key here means Escape
  // dismisses this panel and leaves the door underneath it exactly where the volunteer left it.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    onClose();
  }

  const parked = snapshot.entries.filter((e) => e.state === 'parked');
  const pending = snapshot.entries.filter((e) => e.state === 'pending');

  // Rendered into <body>: the pill is sometimes deep inside the door sheet, whose entry animation
  // briefly makes it a containing block for fixed positioning.
  return createPortal(
    <div className="cv-sync__overlay" role="presentation" onKeyDown={onKeyDown}>
      <div className="cv-sync__scrim" onClick={onClose} aria-hidden="true" />
      <div className="card cv-sync__panel" role="dialog" aria-modal="true" aria-labelledby="cv-sync-h">
        <header className="cv-sync__head">
          <h2 id="cv-sync-h" ref={headRef} tabIndex={-1}>
            Syncing
          </h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="Close sync details">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" />
              <line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        </header>

        <dl className="cv-sync__facts">
          <div>
            <dt>Connection</dt>
            <dd>{snapshot.online ? 'Online' : 'Offline — results are being saved on this phone'}</dd>
          </div>
          <div>
            <dt>Waiting to sync</dt>
            <dd className="num">{n(pending.length)}</dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{ago(snapshot.lastSyncAt)}</dd>
          </div>
        </dl>

        {!snapshot.durable && (
          <div className="alert alert--danger alert--compact" role="alert">
            <div>
              <strong>This browser will not store anything</strong>
              {/* Saying nothing here would be a lie by omission: the queue survives until the tab
                  is closed and no longer. */}
              <div className="alert__detail">
                Queued results are held in this tab only and will be lost if it closes. Private browsing usually causes
                this — reopen the app in a normal window and sync before you finish the shift.
              </div>
            </div>
          </div>
        )}

        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={!snapshot.online || snapshot.syncing || pending.length === 0}
          onClick={() => void syncNow()}
        >
          {snapshot.syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {!snapshot.online && pending.length > 0 && (
          <p className="muted small cv-sync__note">
            They will go up on their own as soon as there is signal — nothing here needs you to remember it.
          </p>
        )}

        {pending.length > 0 && (
          <section aria-labelledby="cv-sync-q">
            <h3 id="cv-sync-q" className="sheet__h3">
              In the queue
            </h3>
            <ul className="cv-sync__list">
              {pending.map((e) => (
                <li key={e.id} className="cv-sync__item">
                  <span className="cv-sync__item-label">{e.label}</span>
                  <span className="muted small">
                    {e.attempts > 1 ? `${n(e.attempts)} attempts · ` : ''}
                    {e.last_error ?? 'waiting'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {parked.length > 0 && (
          <section aria-labelledby="cv-sync-p">
            <h3 id="cv-sync-p" className="sheet__h3">
              Needs attention
            </h3>
            {/* Parked, never dropped: a canvass result the server refused is still a door somebody
                knocked, and an organiser can usually fix the reason. */}
            <p className="muted small cv-sync__note">
              The server refused these, so they will not go up on their own. Show an organiser, then try again.
            </p>
            <ul className="cv-sync__list">
              {parked.map((e) => (
                <ParkedRow key={e.id} entry={e} />
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="cv-sync-c">
          <h3 id="cv-sync-c" className="sheet__h3">
            Saved on this phone
          </h3>
          {cached.length === 0 ? (
            <p className="muted small">No turf data is stored on this phone.</p>
          ) : (
            <ul className="cv-sync__list">
              {cached.map((t) => (
                <li key={t.turf_id} className="cv-sync__item">
                  <span className="cv-sync__item-label">{t.name}</span>
                  <span className="muted small">
                    {n(t.n_doors)} doors · saved {ago(t.cached_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small cv-sync__note">
            A turf is only stored here once you open it, so the doors and names are there when the signal is not. It
            stays until you clear it — the campaign’s own post-election purge cannot reach a phone.
          </p>
          {confirmClear ? (
            <div className="cv-sync__confirm">
              <p className="small">
                Clear the saved doors and names? Anything still waiting to sync stays queued.
                {!snapshot.online && ' You are offline, so the turf will not come back until you have signal.'}
              </p>
              <div className="cv-sync__actions">
                <button
                  type="button"
                  className="btn btn--danger-outline"
                  onClick={() => {
                    void clearTurfCache().then(() => {
                      setConfirmClear(false);
                      refreshCached();
                    });
                  }}
                >
                  Clear it
                </button>
                <button type="button" className="btn" onClick={() => setConfirmClear(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn btn--block" disabled={cached.length === 0} onClick={() => setConfirmClear(true)}>
              Clear saved turf data
            </button>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}

function ParkedRow({ entry }: { entry: OutboxEntry }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="cv-sync__item cv-sync__item--parked">
      <span className="cv-sync__item-label">{entry.label}</span>
      <span className="cv-sync__error small">
        {entry.parked_reason === 'stalled'
          ? `Could not reach the server after ${n(entry.attempts)} attempts. ${entry.last_error ?? ''}`
          : `${entry.last_status ? `${entry.last_status}: ` : ''}${entry.last_error ?? 'Refused'}`}
      </span>
      <div className="cv-sync__actions">
        <button type="button" className="btn btn--small" onClick={() => void retryEntry(entry.id)}>
          Try again
        </button>
        {confirm ? (
          <>
            <button type="button" className="btn btn--small btn--danger-outline" onClick={() => void discardEntry(entry.id)}>
              Discard for good
            </button>
            <button type="button" className="btn btn--small" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--small" onClick={() => setConfirm(true)}>
            Discard
          </button>
        )}
      </div>
    </li>
  );
}
