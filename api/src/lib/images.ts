/**
 * Image sniffing for sign photos.
 *
 * The declared `Content-Type` on a multipart part is whatever the client typed; it is not evidence.
 * A volunteer's phone uploads a real photo, but the endpoint is reachable by any signed-in user and
 * the bytes end up on the campaign's disk and are later streamed back with that content-type — so
 * the type we store and serve is the one we read out of the file's own header, never the one that
 * arrived. Anything we cannot recognise as JPEG/PNG/WebP is refused.
 *
 * Dimensions are a nice-to-have (they let the UI reserve space before the image loads), so every
 * parser below returns null rather than throwing on a header it does not understand.
 */

export type ImageKind = 'image/jpeg' | 'image/png' | 'image/webp';

export interface SniffedImage {
  contentType: ImageKind;
  width: number | null;
  height: number | null;
}

/** Filename extension used on disk for each accepted type. */
export const IMAGE_EXT: Record<ImageKind, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (buf: Buffer, sig: number[]): boolean =>
  buf.length >= sig.length && sig.every((b, i) => buf[i] === b);

/** Recognise the container from its magic bytes; null when it is not an image we accept. */
export function sniffImage(buf: Buffer): SniffedImage | null {
  if (startsWith(buf, PNG)) return { contentType: 'image/png', ...pngSize(buf) };
  if (startsWith(buf, JPEG)) return { contentType: 'image/jpeg', ...jpegSize(buf) };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { contentType: 'image/webp', ...webpSize(buf) };
  }
  return null;
}

interface Size {
  width: number | null;
  height: number | null;
}

const NO_SIZE: Size = { width: null, height: null };

/** PNG: the IHDR chunk is mandatory and always first, so width/height sit at fixed offsets. */
function pngSize(buf: Buffer): Size {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return NO_SIZE;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: walk the marker segments until a start-of-frame (SOFn) carries the size. SOF4 (0xC4,
 * Huffman tables), SOF8 (0xC8, reserved) and SOF12 (0xCC, arithmetic coding tables) are not frames.
 */
function jpegSize(buf: Buffer): Size {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1] as number;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return NO_SIZE;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xda) return NO_SIZE; // start of scan: no frame header found
    i += 2 + len;
  }
  return NO_SIZE;
}

/** WebP has three shapes; phones emit VP8 (lossy) or VP8X (with EXIF/ICC), editors emit VP8L. */
function webpSize(buf: Buffer): Size {
  if (buf.length < 30) return NO_SIZE;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { width: read24LE(buf, 24) + 1, height: read24LE(buf, 27) + 1 };
  }
  if (chunk === 'VP8 ') {
    // Key-frame start code, then a 14-bit width and height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return NO_SIZE;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return NO_SIZE;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return NO_SIZE;
}

const read24LE = (buf: Buffer, at: number): number =>
  (buf[at] as number) | ((buf[at + 1] as number) << 8) | ((buf[at + 2] as number) << 16);
