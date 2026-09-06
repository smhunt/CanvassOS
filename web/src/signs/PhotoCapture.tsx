/**
 * Attach a photo to a sign that has just been recorded.
 *
 * The photo is what actually finds the sign in November — a coordinate plus "you are looking for a
 * sign against a cedar hedge, left of the gate" beats a coordinate alone. It is optional and it is
 * attached AFTER the sign exists, so a failed upload can never cost the placement record.
 */
import { useRef, useState } from 'react';
import { useUploadSignPhoto } from '../api/hooks';
import { Spinner } from '../components/ui';
import { downscalePhoto, formatBytes } from './downscale';
import { PhotoStrip } from './PhotoStrip';

interface Props {
  signId: string;
  /** Label or address of the sign — becomes the photo's alt text. */
  describe: string;
}

export function PhotoCapture({ signId, describe }: Props) {
  const upload = useUploadSignPhoto();
  const [ids, setIds] = useState<string[]>([]);
  const [shrunk, setShrunk] = useState<{ from: number; to: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Held so a retry re-sends the same bytes without making the volunteer find the photo again.
  const attempt = useRef<File | null>(null);

  async function pick(file: File) {
    setPreparing(true);
    setShrunk(null);
    const result = await downscalePhoto(file).finally(() => setPreparing(false));
    if (result.shrunk) setShrunk({ from: result.originalBytes, to: result.file.size });
    attempt.current = result.file;
    send(result.file);
  }

  function send(file: File) {
    upload.mutate(
      { signId, file },
      {
        onSuccess: (data) => {
          // The upload hook returns the raw JSON body; the API sends `{ photo }`.
          const id = (data as { photo?: { id?: string } } | null)?.photo?.id;
          if (id) setIds((prev) => [...prev, id]);
          attempt.current = null;
          if (inputRef.current) inputRef.current.value = '';
        },
      },
    );
  }

  function retry() {
    const file = attempt.current;
    if (file) send(file);
  }

  const busy = preparing || upload.isPending;

  return (
    <div className="sg-photo-capture">
      <label className="field__label" htmlFor="sg-photo-input">
        Photo of the sign {ids.length > 0 && <span className="muted">({ids.length} attached)</span>}
      </label>
      <p className="field__hint" id="sg-photo-hint">
        Frame the sign and something permanent beside it — the gate, the hydro pole, the culvert.
        JPEG, PNG or WebP, up to 8 MB. Large photos are shrunk on the phone before they are sent.
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
            Shrunk from {formatBytes(shrunk.from)} to {formatBytes(shrunk.to)} before uploading.
          </span>
        )}
        {!busy && !shrunk && ids.length > 0 && <span className="sg-ok">Photo attached.</span>}
      </p>

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

      <PhotoStrip ids={ids} describe={describe} />
    </div>
  );
}
