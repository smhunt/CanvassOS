/**
 * Shrink a phone photo before it goes up the wire.
 *
 * The API accepts 8 MB, and a modern phone happily produces one. Over rural LTE with one bar that
 * is minutes of a volunteer standing in a ditch watching a progress bar — and the photo only has to
 * be good enough to recognise a sign and a driveway, which 1600 px of JPEG does comfortably.
 *
 * Every failure path returns the ORIGINAL file rather than throwing: a slow upload is a nuisance,
 * a lost record of where a sign is standing is a by-law problem. If the browser cannot decode the
 * image (an iPhone that hands over HEIC, say) the original goes up and the API's magic-byte sniff
 * gives the honest error.
 */

/** Below this a re-encode is not worth the risk or the CPU. */
const SKIP_UNDER_BYTES = 900_000;
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

export interface DownscaleResult {
  file: File;
  /** True when the returned file is a re-encode — the UI says so rather than claiming it silently. */
  shrunk: boolean;
  originalBytes: number;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

export async function downscalePhoto(file: File): Promise<DownscaleResult> {
  const originalBytes = file.size;
  const unchanged: DownscaleResult = { file, shrunk: false, originalBytes };
  if (file.size <= SKIP_UNDER_BYTES) return unchanged;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return unchanged;

  let bitmap: ImageBitmap;
  try {
    // `from-image` applies the EXIF rotation, so a portrait photo does not arrive on its side.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return unchanged;
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.type === 'image/jpeg') return unchanged;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return unchanged;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await toBlob(canvas);
    // A re-encode that came out bigger (already-compressed small image) is not an improvement.
    if (!blob || blob.size >= file.size) return unchanged;

    // The API discards the client filename entirely, so this name is only ever shown back to the
    // volunteer in the file picker.
    return {
      file: new File([blob], 'sign.jpg', { type: 'image/jpeg', lastModified: Date.now() }),
      shrunk: true,
      originalBytes,
    };
  } catch {
    return unchanged;
  } finally {
    bitmap.close();
  }
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}
