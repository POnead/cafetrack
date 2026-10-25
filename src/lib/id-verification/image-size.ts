/**
 * Reading an image's pixel dimensions from its header, with no image library.
 *
 * Exists because the local ID check wants to know whether an upload is shaped
 * like an ID card, and pulling in `sharp` or `jpeg-js` to read two integers off
 * the front of a file would be a large native dependency for a cosmetic signal.
 *
 * Every format handled here is checked by its own magic bytes in
 * lib/id-document.ts before it reaches this module, so the caller has already
 * established what the file claims to be and this only has to live up to it.
 *
 * Returns null rather than throwing. A malformed header means "could not tell",
 * which the caller reports as an `unknown` signal — it is not evidence of
 * anything, and refusing the upload over it would turn a cosmetic check into a
 * gate.
 */

export type ImageSize = { width: number; height: number };

/** The biggest value any of these fields can hold; anything larger is nonsense. */
const MAX_DIMENSION = 20_000;

function valid(w: number, h: number): ImageSize | null {
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  if (w < 1 || h < 1) return null;
  // A crafted header can claim a 4-billion-pixel canvas. Nothing this app
  // accepts is remotely that large, and the number is only ever used to make a
  // ratio, so an absurd value is treated as unreadable rather than believed.
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) return null;
  return { width: w, height: h };
}

/**
 * PNG. Fixed layout: 8-byte signature, then the IHDR chunk, whose first eight
 * bytes after its length/type are the width and height as big-endian uint32.
 */
function readPng(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // "IHDR" sits at offset 12.
  if (view.getUint32(12, false) !== 0x49484452) return null;
  return valid(view.getUint32(16, false), view.getUint32(20, false));
}

/**
 * JPEG. There is no fixed offset for the size — it lives in whichever frame
 * header comes first, which may be preceded by any number of APPn/EXIF/COM
 * segments (a phone photo has several). So the file is walked segment by segment
 * until a start-of-frame marker turns up.
 *
 * SOF0-SOF15, excluding the four markers that are not frame headers:
 *   C4  DHT   Huffman table
 *   C8  JPG   reserved
 *   CC  DAC   arithmetic coding
 * The frame header is then: 1 byte precision, 2 bytes height, 2 bytes width.
 */
function readJpeg(b: Uint8Array): ImageSize | null {
  let i = 2; // past SOI

  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      // Not sitting on a marker. Resynchronise by advancing one byte rather than
      // giving up — a stray 0xff inside entropy-coded data before the first frame
      // header is malformed anyway, but walking on is cheaper than failing.
      i++;
      continue;
    }

    // 0xFF followed by another 0xFF is legal padding; skip to the real marker.
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return null;

    const marker = b[i];
    i++;

    // Standalone markers: no length field follows.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    // Start of scan — the image data follows and there is no frame header after
    // it, so a file that has not produced one by now will not.
    if (marker === 0xda) return null;

    if (i + 1 >= b.length) return null;
    const length = (b[i] << 8) | b[i + 1];
    if (length < 2) return null;

    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isSof) {
      // length(2) + precision(1), then height and width.
      if (i + 7 >= b.length) return null;
      const h = (b[i + 3] << 8) | b[i + 4];
      const w = (b[i + 5] << 8) | b[i + 6];
      return valid(w, h);
    }

    i += length;
  }

  return null;
}

/**
 * WebP. Three sub-formats with three different layouts, told apart by the
 * four-character tag at offset 12:
 *
 *   "VP8 "  lossy    — 3 bytes of sync code, then 2+2 little-endian dimensions
 *   "VP8L"  lossless— 1 signature byte, 4 packed bytes, dimensions at 21 and 24
 *   "VP8X"  extended — 3 bytes flags, 3 bytes canvas width-1, same for height
 */
function readWebp(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;

  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  if (tag === "VP8 ") {
    return valid(view.getUint16(26, true), view.getUint16(28, true));
  }

  if (tag === "VP8L") {
    const bits = view.getUint32(21, true);
    // 14 bits each: bits 0-13 width-1, bits 14-27 height-1.
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }

  if (tag === "VP8X") {
    // 24-bit little-endian, minus one, at offsets 24 and 27.
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return valid(w, h);
  }

  return null;
}

/** Dimensions of a JPEG, PNG or WebP, or null when they cannot be read. */
export function readImageSize(type: string, bytes: Uint8Array): ImageSize | null {
  try {
    if (type === "image/png") return readPng(bytes);
    if (type === "image/jpeg") return readJpeg(bytes);
    if (type === "image/webp") return readWebp(bytes);
    return null;
  } catch {
    // A truncated or hostile buffer. Unreadable dimensions are not a reason to
    // refuse an upload — the image still displays, and the dimension signal is
    // explicitly advisory.
    return null;
  }
}
