/**
 * A small but genuinely varied PNG, for fixtures that need an image with
 * structure in it.
 *
 *   node scripts/_pattern-png.mjs          # writes a pattern.png next to this file
 *
 * ## Why this exists
 *
 * A card fingerprint is a perceptual hash, so a *flat* image hashes to a
 * constant — every blank, white or single-pixel PNG produces the same 64 bits.
 * That makes a flat image a poor stand-in for a card whenever anything compares
 * fingerprints, because it silently collides with every other flat image.
 *
 * This gives a fixture an image with real structure instead: a diagonal ramp
 * with hard edges, deterministic so a failure is reproducible.
 *
 * Worth being precise about what this does and does not fix, because the first
 * version of this file claimed too much. It does NOT stop two suites colliding:
 * /api/users/[id]/id stores the `card_hash` the caller supplies in the form and
 * does not re-derive one from the image, so the pixel content has no bearing on
 * the stored fingerprint at all. A real collision between two suites came from
 * two fixtures naming the same literal hash, not from a blank image.
 *
 * It is still worth having. A fixture that uploads a single transparent pixel is
 * testing a shape the product never sees, and any future check that does derive
 * a fingerprint from the image would compare against a constant.
 *
 * A 64x64 grayscale PNG, built here rather than checked in as a binary so the
 * bytes it produces are readable and nobody has to trust an opaque blob.
 */

import { deflateSync } from "node:zlib";

/** CRC-32, as PNG chunks require. Table built once. */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  // type + data is what the CRC covers; the length is not included.
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const WIDTH = 64;
const HEIGHT = 64;

/*
 * A diagonal gradient with a couple of hard edges. The edges are what make the
 * perceptual hash interesting: dHash compares adjacent pixels, so a smooth ramp
 * and a flat fill produce different bits.
 */
const raw = Buffer.alloc(HEIGHT * (WIDTH + 1));
let p = 0;
for (let y = 0; y < HEIGHT; y++) {
  raw[p++] = 0; // filter type 0 for this scanline
  for (let x = 0; x < WIDTH; x++) {
    const band = ((x + y) >> 3) & 1;
    const value = band ? 40 + ((x * 3 + y) % 180) : 210 - ((x + y * 2) % 170);
    raw[p++] = Math.max(0, Math.min(255, value));
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // colour type: grayscale
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

/** The same bytes, as a File, for a FormData upload. */
export function patternPngBlob() {
  return new Blob([png], { type: "image/png" });
}

export const PATTERN_PNG = png;