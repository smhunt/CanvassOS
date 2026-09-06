/**
 * Attach a photo to a sign that has just been placed.
 *
 * The photo is what actually finds the sign in November — a coordinate plus "you are looking for a
 * sign against a cedar hedge, left of the gate" beats a coordinate alone. It is optional and it is
 * attached AFTER the sign exists, so a failed upload can never cost the placement record.
 *
 * Signs go up on concession roads with no bars, which is exactly where the photo matters most, so
 * there are two paths and the volunteer is always told which one they are on:
 *
 *   - the sign already has a server id and the phone has a connection → upload now, unchanged;
 *   - the sign is still in the outbox, or the upload never reached the server → the downscaled
 *     bytes are held in IndexedDB under the sign's `client_id` and go up by themselves the moment
 *     the outbox learns the real sign id (offline/photoQueue.ts).
 *
 * Nothing is discarded quietly: a photo the phone will not hold is refused out loud, at capture
 * time, while the volunteer is still standing at the sign and can do something about it.
 */
import { useEffect, useRef, useState } from 'react';
import { useUploadSignPhoto } from '../api/hooks';
import {
  discardPhoto,
  onPhotoUploaded,
  queuePhoto,
  retryPhoto,
  type PendingPhoto,
} from '../offline/photoQueue';
import { useOutbox, usePendingPhotosFor, usePhotoQueue } from '../offline/useOutbox';
import { Spinner, n } from '../components/ui';
import { downscalePhoto, formatBytes } from './downscale';
import { PhotoStrip } from './PhotoStrip';

interface Props {
  /** The server id, or null while the sign itself is still waiting in the outbox. */
  signId: string | null;
  /** The sign's `client_id`: the key a photo is filed under when there is no server id yet. */
  clientId: string;
  /** Label or address of the sign — becomes the photo's alt text and the queue's label. */
  describe: string;
}

export function PhotoCapture({ signId, clientId, describe }: Props) {
  const upload = useUploadSignPhoto();
  // Subscribing starts the outbox on this screen: a volunteer who reopens the app on the signs tab
  // with a queued sign needs it flushing, because a held photo is waiting on that sign's real id.
  const outbox = useOutbox();
  const photoQ = usePhotoQueue();
  const held = usePendingPhotosFor(photoQ, clientId);

  const [ids, setIds] = useState<string[]>([]);
  const [shrunk, setShrunk] = useState<{ from: number; to: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Held so a retry re-sends the same bytes without making the volunteer find the photo again.
  const attempt = useRef<File | null>(null);

  // A photo that was held and has now gone up: swap the local thumbnail for the server's copy
  // without making the volunteer reload anything.
  useEffect(
    () =>
      onPhotoUploaded((e) => {
        if (e.client_id !== clientId) return;
        setIds((prev) => (prev.includes(e.photo_id) ? prev : [...prev, e.photo_id]));
      }),
    [clientId],
  );

  function clearInput() {
    attempt.current = null;
    if (inputRef.current) inputRef.current.value = '';
  }

  /** Keep the bytes on the phone until the sign exists and the network is willing. */
  async function hold(file: File) {
    if (!clientId) {
      // Nothing to file the photo under. Refusing out loud beats holding bytes that could never be
      // matched to a sign — this should be unreachable, since every placement generates a client_id.
      setRefused('This photo cannot be saved on the phone: the sign has no reference to file it under.');
      return;
    }
    const result = await queuePhoto({
      clientId,
      signId,
      file,
      contentType: file.type || 'image/jpeg',
      label: describe,
    });
    if (result.ok) {
      setRefused(null);
      clearInput();
    } else {
      // The photo is NOT kept. Saying so here, now, is the whole point — a volunteer who thinks a
      // photo was saved does not take another one.
      setRefused(result.message);
    }
  }

  function send(file: File) {
    if (!signId) return;
    upload.mutate(
      { signId, file },
      {
        onSuccess: (data) => {
          // The upload hook returns the raw JSON body; the API sends `{ photo }`.
          const id = (data as { photo?: { id?: string } } | null)?.photo?.id;
          if (id) setIds((prev) => [...prev, id]);
          clearInput();
        },
        onError: (err) => {
          // fetch() rejects with a TypeError only when the request never reached the server — a
          // dead radio, not a verdict on the photo. Those bytes are worth keeping and retrying;
          // anything the server actually answered stays on screen with its own message.
          if (err instanceof TypeError) {
            upload.reset();
            void hold(file);
          }
        },
      },
    );
  }

  async function pick(file: File) {
    setPreparing(true);
    setShrunk(null);
    setRefused(null);
    // Downscale first either way: the phone must never be asked to hold an 8 MB original.
    const result = await downscalePhoto(file).finally(() => setPreparing(false));
    if (result.shrunk) setShrunk({ from: result.originalBytes, to: result.file.size });
    attempt.current = result.file;
    if (signId && outbox.online) send(result.file);
    else await hold(result.file);
  }

  function retry() {
    const file = attempt.current;
    if (file) send(file);
  }

  const busy = preparing || upload.isPending;
  const waiting = held.filter((p) => p.state === 'pending');
  const parked = held.filter((p) => p.state === 'parked');
  const holdingAny = photoQ.photos.length > 0;

  return (
    <div className="sg-photo-capture">
      <label className="field__label" htmlFor="sg-photo-input">
        Photo of the sign {ids.length > 0 && <span className="muted">({n(ids.length)} attached)</span>}
      </label>
      <p className="field__hint" id="sg-photo-hint">
        Frame the sign and something permanent beside it — the gate, the hydro pole, the culvert.
        JPEG, PNG or WebP, up to 8 MB. Large photos are shrunk on the phone before they are sent.
        {' '}
        With no signal the photo is kept on this phone until the sign syncs, then goes up on its own;
        it is removed by “Clear saved turf data” in the sync panel.
      </p>
      <input
        id="sg-photo-input"
        ref={inputRef}
        className="sg-file"
        type="file"
        accept="image/*"
        capture="environment"
        aria-describedby="sg-photo-hint"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void pick(file);
        }}
      />

      <p className="sg-photo-capture__state small" aria-live="polite">
        {preparing && (
          <>
            <Spinner size={14} /> Shrinking the photo…
          </>
        )}
        {upload.isPending && (
          <>
            <Spinner size={14} /> Uploading…
          </>
        )}
        {!busy && shrunk && (
          <span className="muted">
            {/* True on both paths — a held photo was shrunk before it was stored, not before it was sent. */}
            Shrunk from {formatBytes(shrunk.from)} to {formatBytes(shrunk.to)} on this phone.
          </span>
        )}
        {!busy && !shrunk && ids.length > 0 && <span className="sg-ok">Photo attached.</span>}
      </p>

      {refused && (
        <div className="alert alert--danger alert--compact" role="alert">
          <div>
            <strong>This photo was not kept</strong>
            <div className="alert__detail">{refused}</div>
          </div>
        </div>
      )}

      {upload.isError && (
        <div className="alert alert--danger alert--compact" role="alert">
          <div>
            <strong>Photo not uploaded</strong>
            {/* The API's own message is the useful one: it sniffs magic bytes, so it knows whether
                this was the wrong format, too big, or empty. Do not paraphrase it. */}
            <div className="alert__detail">
              {upload.error instanceof Error ? upload.error.message : 'Upload failed.'}
            </div>
          </div>
          {attempt.current && !upload.isPending && (
            <button type="button" className="btn btn--small" onClick={retry}>
              Retry
            </button>
          )}
        </div>
      )}

      {waiting.length > 0 && (
        <div className="sg-held" role="status">
          <p className="sg-held__line">
            <strong>
              {n(waiting.length)} photo{waiting.length === 1 ? '' : 's'} saved on this phone
            </strong>{' '}
            <span className="muted">
              {signId
                ? 'They will go up as soon as there is signal.'
                : 'They go up on their own once this sign reaches the server — nothing here needs you to remember it.'}
            </span>
          </p>
          <ul className="sg-photos" aria-label="Photos waiting to upload">
            {waiting.map((p) => (
              <li key={p.id} className="sg-photos__item">
                <HeldThumb photo={p} describe={describe} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {parked.map((p) => (
        <div key={p.id} className="alert alert--danger alert--compact" role="alert">
          <div>
            <strong>Photo not uploaded</strong>
            <div className="alert__detail">
              {p.parked_reason === 'stalled'
                ? `Could not reach the server after ${n(p.attempts)} attempts. ${p.last_error ?? ''}`
                : `${p.last_status ? `${p.last_status}: ` : ''}${p.last_error ?? 'Refused'}`}
            </div>
          </div>
          <div className="sg-held__actions">
            <button type="button" className="btn btn--small" onClick={() => void retryPhoto(p.id)}>
              Try again
            </button>
            <DiscardHeld id={p.id} />
          </div>
        </div>
      ))}

      {holdingAny && (
        // The phone's storage is the volunteer's, so what is being used of it is never hidden.
        <p className="sg-held__cap muted small">
          This phone is holding {n(photoQ.photos.length)} of {n(photoQ.maxPhotos)} unsent photos ·{' '}
          {formatBytes(photoQ.bytes)} of {formatBytes(photoQ.maxBytes)}
          {!photoQ.durable && ' · this browser will not store them past this tab'}
        </p>
      )}

      <PhotoStrip ids={ids} describe={describe} />
    </div>
  );
}

/**
 * The held photo itself, drawn from the blob on the phone.
 *
 * Same restraint as `PhotoStrip`: no download, no share, no open-in-new-tab. The object URL is
 * revoked when the thumbnail goes away, so the bytes are not pinned in the page after the upload.
 */
function HeldThumb({ photo, describe }: { photo: PendingPhoto; describe: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(photo.blob);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.blob]);

  return (
    <div className="sg-photo sg-photo--held">
      {src && (
        <img
          className="sg-photo__img"
          src={src}
          alt={`Photo of the sign at ${describe}, waiting to upload`}
          draggable={false}
        />
      )}
      <span className="sg-photo__hint">Waiting · {formatBytes(photo.bytes)}</span>
    </div>
  );
}

/** Deleting a held photo is the volunteer's decision, and it is confirmed before it happens. */
function DiscardHeld({ id }: { id: string }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <button type="button" className="btn btn--small" onClick={() => setConfirm(true)}>
        Discard
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn btn--small btn--danger-outline" onClick={() => void discardPhoto(id)}>
        Discard for good
      </button>
      <button type="button" className="btn btn--small" onClick={() => setConfirm(false)}>
        Keep
      </button>
    </>
  );
}
