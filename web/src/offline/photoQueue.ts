/**
 * Sign photos that were taken before the sign existed on the server.
 *
 * A sign goes up on a concession road with no bars. The placement itself survives — `outbox.ts`
 * holds the JSON and replays it — but the photo is the half that actually finds the sign again in
 * November, and "third gate past the church" is not a location. Before this module the photo was
 * simply dropped, because `POST /api/signs/:id/photo` needs a server id that a queued sign does not
 * have yet.
 *
 * WHY a separate queue rather than a new entry type in the outbox
 * ---------------------------------------------------------------
 * The outbox is a JSON queue: `body: Record<string, unknown>` posted through `api.post`, retried,
 * and — this is the deciding one — rendered entry by entry in the sync panel
 * (`canvass/SyncStatus.tsx`), where its counts drive the pill a volunteer reads as "how many doors
 * are still on my phone". Teaching it to carry image bytes would mean a union body type threading
 * through every consumer, an 8 MB blob living beside 400-byte door records under one retry budget,
 * and photos silently changing what the door-canvassing pill says. So photos get their own store
 * and their own queue with the SAME contract — backoff on a network failure, park with the server's
 * own message on a definite 4xx, never drop anything on the app's own initiative — and hang off the
 * one thing they genuinely depend on: the moment the outbox learns the sign's real id.
 *
 * That dependency is explicit rather than timed: `outbox.flush()` calls `adoptSignId()` with the
 * `client_id` it queued under and the `id` the server just returned. Nothing here polls, and
 * nothing guesses that "the sign has probably synced by now".
 *
 * WHY the bytes are capped. This is a volunteer's own phone. Photos are held until they upload, so
 * a bad afternoon with no signal could otherwise fill it. The cap is checked at capture time and
 * refused out loud — a photo that will not be kept must never look like one that was.
 *
 * WHY they are deleted the moment they land. A sign photo is a photograph of somebody's house,
 * which makes it personal information under the Municipal Elections Act however mundane it looks.
 * It is on the phone only for as long as it has to be: gone on a successful upload, gone when the
 * sign it belongs to is discarded, and gone with "Clear saved turf data" (see turfCache.ts).
 */
import { ApiError } from '../api/client';
import { PENDING_PHOTOS, idbDelete, idbGetAll, idbPut, isMemoryOnly } from './db';

/** Same two words the outbox uses, and they mean the same things. Neither is a deletion. */
export type PhotoParkedReason = 'rejected' | 'stalled';

export interface PendingPhoto {
  /** Local id for this photo. Not a server id, and never sent anywhere. */
  id: string;
  /**
   * The sign's `client_id`. This is the key, because it is the only identifier that exists at the
   * moment the photo is taken — the server id may still be minutes or hours away.
   */
  client_id: string;
  /** The real sign id, once the outbox has told us. Null means "not uploadable yet". */
  sign_id: string | null;
  /** The downscaled image itself. IndexedDB stores blobs natively; no base64 round trip. */
  blob: Blob;
  content_type: string;
  bytes: number;
  /** One line the volunteer recognises — the sign's label or address. */
  label: string;
  state: 'pending' | 'parked';
  parked_reason: PhotoParkedReason | null;
  attempts: number;
  queued_at: number;
  last_tried_at: number | null;
  last_error: string | null;
  last_status: number | null;
}

export interface PhotoQueueSnapshot {
  photos: PendingPhoto[];
  /** Bytes held on this phone, and the ceiling — both shown, because it is the user's storage. */
  bytes: number;
  maxBytes: number;
  maxPhotos: number;
  uploading: boolean;
  /** False when IndexedDB refused to open: the photo is then only as durable as this tab. */
  durable: boolean;
}

/** Refusal reasons a capture can hit. Told to the volunteer at capture time, never swallowed. */
export type QueueRefusal = 'too_many' | 'too_large' | 'phone_full';

export type QueuePhotoResult =
  | { ok: true; photo: PendingPhoto }
  | { ok: false; reason: QueueRefusal; message: string };

// Backoff identical to the outbox: quick enough to catch a bar of signal in a driveway, capped so
// nothing spins a radio for a whole shift.
const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 20;

/**
 * Storage ceiling. A downscaled sign photo is 200–400 kB (signs/downscale.ts), so 20 photos is a
 * whole afternoon of placements in well under 10 MB. The byte cap is the one that actually bites,
 * and it exists for the phone that hands over HEIC: downscaling passes those through untouched at
 * up to the API's 8 MB limit.
 */
const MAX_PHOTOS = 20;
const MAX_BYTES = 32 * 1024 * 1024;
/** The API's own ceiling (API.md: `413 file_too_large`). Storing more than it accepts is pointless. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

// ------------------------------------------------------------------ state

let photos: PendingPhoto[] = [];
let uploading = false;
let started: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
const uploadedListeners = new Set<(e: UploadedPhoto) => void>();

/** What a finished upload tells the screen, so a thumbnail can switch to the server's copy. */
export interface UploadedPhoto {
  client_id: string;
  /** The `sign_photo.id` the API assigned — usable with `GET /api/signs/photo/:id`. */
  photo_id: string;
  sign_id: string;
}

let snapshot: PhotoQueueSnapshot = {
  photos: [],
  bytes: 0,
  maxBytes: MAX_BYTES,
  maxPhotos: MAX_PHOTOS,
  uploading: false,
  durable: true,
};

const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

function rebuild(): void {
  const sorted = [...photos].sort((a, b) => a.queued_at - b.queued_at);
  snapshot = {
    photos: sorted,
    bytes: sorted.reduce((sum, p) => sum + p.bytes, 0),
    maxBytes: MAX_BYTES,
    maxPhotos: MAX_PHOTOS,
    uploading,
    durable: !isMemoryOnly(),
  };
}

function notify(): void {
  rebuild();
  for (const fn of listeners) fn();
}

/** useSyncExternalStore needs a stable object between changes, so the snapshot is cached. */
export const getPhotoSnapshot = (): PhotoQueueSnapshot => snapshot;

export function subscribePhotos(fn: () => void): () => void {
  listeners.add(fn);
  void startPhotoQueue();
  return () => listeners.delete(fn);
}

/** Fires when a held photo finally reaches the server, with the id the API gave it. */
export function onPhotoUploaded(fn: (e: UploadedPhoto) => void): () => void {
  uploadedListeners.add(fn);
  return () => uploadedListeners.delete(fn);
}

// ------------------------------------------------------------------ startup

export function startPhotoQueue(): Promise<void> {
  if (started) return started;
  started = (async () => {
    photos = await idbGetAll<PendingPhoto>(PENDING_PHOTOS);
    if (typeof window !== 'undefined') {
      // The same three moments the outbox watches: signal coming back, the app being looked at
      // again, a phone waking up in a pocket.
      window.addEventListener('online', () => void flushPhotos());
      window.addEventListener('focus', () => void flushPhotos());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void flushPhotos();
      });
    }
    notify();
    void flushPhotos();
  })();
  return started;
}

// ------------------------------------------------------------------ failure classification

type Failure = 'network' | 'auth' | 'server' | 'rejected';

/**
 * Deliberately NOT `outbox.classify`, even though the shape matches: this endpoint's 4xx set is its
 * own. A `413 file_too_large` or `400 unsupported_image` is a verdict on these exact bytes and will
 * be the same verdict forever, and a `404` means the sign row is gone — none of which can be fixed
 * by trying again on a better road. Sharing the outbox's classifier would also mean importing it
 * from a module that imports this one.
 */
function classifyUpload(err: unknown): Failure {
  if (err instanceof ApiError) {
    // The session simply expired; the upload becomes valid again on the next sign-in.
    if (err.status === 401) return 'auth';
    if (err.status === 408 || err.status === 425 || err.status === 429) return 'server';
    if (err.status >= 500) return 'server';
    if (err.status >= 400) return 'rejected';
    return 'server';
  }
  // fetch() rejects with a TypeError when the request never reached the server.
  return 'network';
}

const message = (err: unknown): string => {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.name === 'TypeError') return 'No connection.';
  if (err instanceof Error) return err.message;
  return 'Unknown error.';
};

const statusOf = (err: unknown): number | null => (err instanceof ApiError ? err.status : null);

// ------------------------------------------------------------------ storage

async function persist(photo: PendingPhoto): Promise<void> {
  const i = photos.findIndex((p) => p.id === photo.id);
  if (i >= 0) photos[i] = photo;
  else photos.push(photo);
  await idbPut(PENDING_PHOTOS, photo);
  notify();
}

async function forget(id: string): Promise<void> {
  photos = photos.filter((p) => p.id !== id);
  await idbDelete(PENDING_PHOTOS, id);
  notify();
}

const bytesHeld = (): number => photos.reduce((sum, p) => sum + p.bytes, 0);

export interface QueuePhotoInput {
  /** The sign's `client_id` — the key the photo is filed under until the sign has a server id. */
  clientId: string;
  /** The server id when it is already known (an online sign whose upload failed on the wire). */
  signId: string | null;
  /** Already downscaled by the caller: this store must never hold an 8 MB original by choice. */
  file: Blob;
  contentType: string;
  label: string;
}

/**
 * Hold a photo until its sign exists and the network allows it.
 *
 * Refusals are returned rather than thrown, because every one of them is something the volunteer
 * has to be told while they are still standing at the sign and can do something about it.
 */
export async function queuePhoto(input: QueuePhotoInput): Promise<QueuePhotoResult> {
  await startPhotoQueue();
  if (!input.clientId) throw new Error('Refusing to hold a photo with no sign client_id to file it under.');

  if (input.file.size === 0) {
    return { ok: false, reason: 'too_large', message: 'That file is empty — take the photo again.' };
  }
  if (input.file.size > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      message: 'That photo is over the 8 MB the server accepts, and this phone cannot shrink it.',
    };
  }
  if (photos.length >= MAX_PHOTOS) {
    return {
      ok: false,
      reason: 'too_many',
      message: `This phone is already holding ${MAX_PHOTOS} photos that have not uploaded. Get some signal and let them go up first.`,
    };
  }
  if (bytesHeld() + input.file.size > MAX_BYTES) {
    return {
      ok: false,
      reason: 'phone_full',
      message: 'This phone is holding as many unsent photos as it can. Get some signal and let them go up first.',
    };
  }

  const photo: PendingPhoto = {
    id: crypto.randomUUID(),
    client_id: input.clientId,
    sign_id: input.signId,
    blob: input.file,
    content_type: input.contentType,
    bytes: input.file.size,
    label: input.label,
    state: 'pending',
    parked_reason: null,
    attempts: 0,
    queued_at: Date.now(),
    last_tried_at: null,
    last_error: null,
    last_status: null,
  };
  await persist(photo);
  // Known sign id and a live radio: this may be uploadable right now.
  if (photo.sign_id) void flushPhotos();
  return { ok: true, photo };
}

/**
 * The outbox has placed the sign and the server has named it.
 *
 * Called directly from `outbox.flush()` rather than through a listener: a listener only exists if
 * some screen happened to import this module, and the sign usually syncs while the volunteer is
 * three roads away on the canvass screen. The dependency is one-way — the outbox knows about
 * photos, photos know nothing about the outbox — so there is no cycle and no timing to guess at.
 */
export async function adoptSignId(clientId: string, signId: string): Promise<void> {
  await startPhotoQueue();
  const waiting = photos.filter((p) => p.client_id === clientId && p.sign_id === null);
  if (waiting.length === 0) return;
  for (const p of waiting) {
    // Attempts reset: everything before this point was waiting, not failing.
    await persist({ ...p, sign_id: signId, state: 'pending', parked_reason: null, attempts: 0, last_tried_at: null });
  }
  await flushPhotos();
}

// ------------------------------------------------------------------ uploading

const filenameFor = (contentType: string): string =>
  contentType === 'image/png' ? 'sign.png' : contentType === 'image/webp' ? 'sign.webp' : 'sign.jpg';

/**
 * The multipart POST, by hand. This is the one route in the API that is not JSON, so it cannot go
 * through `api.post` — but its failures are turned into the same `ApiError` so everything above
 * classifies uploads exactly the way it classifies a queued door.
 */
async function upload(photo: PendingPhoto): Promise<string | null> {
  const form = new FormData();
  // The API discards the client filename entirely (API.md); the extension is only ever a courtesy
  // to the multipart parser.
  form.append('file', photo.blob, filenameFor(photo.content_type));
  const res = await fetch(`/api/signs/${encodeURIComponent(photo.sign_id ?? '')}/photo`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? (res.statusText || 'Upload failed'));
  }
  return (data as { photo?: { id?: string } } | null)?.photo?.id ?? null;
}

function dueAt(p: PendingPhoto): number {
  const base = p.last_tried_at ?? p.queued_at;
  // Nothing has failed yet, so there is nothing to back off from. A photo whose sign has just been
  // named must go up on this flush, not five seconds after it — the volunteer is usually driving
  // out of the patch of signal that made it possible.
  if (p.attempts === 0) return base;
  return base + Math.min(FIRST_DELAY_MS * 2 ** (p.attempts - 1), MAX_DELAY_MS);
}

/** One timer, set to the earliest thing actually due; no uploadable photo means no timer at all. */
function schedule(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const waiting = photos.filter((p) => p.state === 'pending' && p.sign_id !== null);
  if (waiting.length === 0) return;
  const next = Math.min(...waiting.map(dueAt));
  const delay = Math.max(1_000, Math.min(next - Date.now(), MAX_DELAY_MS));
  timer = setTimeout(() => {
    timer = null;
    void flushPhotos();
  }, delay);
}

async function park(photo: PendingPhoto, reason: PhotoParkedReason, err: unknown): Promise<void> {
  await persist({
    ...photo,
    state: 'parked',
    parked_reason: reason,
    last_tried_at: Date.now(),
    last_error: message(err),
    last_status: statusOf(err),
  });
}

/**
 * Send what can be sent, oldest first, one at a time.
 *
 * Sequential for the same reason the outbox is: a phone on one bar does not get faster by opening
 * six sockets, and an image is the biggest thing this app ever puts on the wire.
 */
export async function flushPhotos(): Promise<void> {
  if (uploading) return;
  uploading = true;
  try {
    await startPhotoQueue();
    if (!isOnline()) return;
    const due = photos
      .filter((p) => p.state === 'pending' && p.sign_id !== null && dueAt(p) <= Date.now())
      .sort((a, b) => a.queued_at - b.queued_at);
    if (due.length === 0) return;
    notify();
    for (const photo of due) {
      try {
        const photoId = await upload(photo);
        // Off the phone the moment it is safely on the server — this is a picture of a house.
        await forget(photo.id);
        if (photoId && photo.sign_id) {
          for (const fn of uploadedListeners) fn({ client_id: photo.client_id, photo_id: photoId, sign_id: photo.sign_id });
        }
      } catch (err) {
        const kind = classifyUpload(err);
        if (kind === 'rejected') {
          await park(photo, 'rejected', err);
          continue;
        }
        const attempts = photo.attempts + 1;
        await persist({
          ...photo,
          attempts,
          last_tried_at: Date.now(),
          last_error: message(err),
          last_status: statusOf(err),
        });
        if (attempts >= MAX_ATTEMPTS) {
          await park({ ...photo, attempts }, 'stalled', err);
          continue;
        }
        // The connection is gone or the session is: stop rather than burning every photo's attempt
        // budget on the same dead network.
        break;
      }
    }
  } finally {
    uploading = false;
    notify();
    schedule();
  }
}

/** "Try again" on a parked photo — an organiser fixed the sign, or the session was renewed. */
export async function retryPhoto(id: string): Promise<void> {
  await startPhotoQueue();
  const photo = photos.find((p) => p.id === id);
  if (!photo) return;
  await persist({ ...photo, state: 'pending', parked_reason: null, attempts: 0, last_tried_at: null });
  await flushPhotos();
}

/** Deliberate deletion only. A held photo is never dropped on the app's own initiative. */
export async function discardPhoto(id: string): Promise<void> {
  await forget(id);
  schedule();
}

/**
 * The sign this photo belongs to has been discarded for good, so the photo has nothing to attach
 * to. Keeping it would be keeping a picture of somebody's house for no reason at all.
 */
export async function discardPhotosFor(clientId: string): Promise<void> {
  await startPhotoQueue();
  for (const p of photos.filter((x) => x.client_id === clientId)) await forget(p.id);
  schedule();
}

/** Wipe the phone. Called from the same "clear saved data" path as the turf cache. */
export async function clearPendingPhotos(): Promise<void> {
  await startPhotoQueue();
  for (const p of [...photos]) await forget(p.id);
  schedule();
}
