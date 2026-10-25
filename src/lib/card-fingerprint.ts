/**
 * Fingerprinting an ID card in the browser, for the duplicate check.
 *
 * ## Why here and not on the server
 *
 * Because the server has no way to decode an image. This app deliberately avoids
 * `sharp` and every other native image library — see ./id-verification/image-size.ts
 * for the reasoning — so it can read a file's dimensions and nothing else. Adding a
 * decoder to compute 64 bits of brightness comparisons would be a large dependency
 * for a cosmetic signal, and it would put an image codec in the request path of a
 * café machine.
 *
 * The browser already has the card on a canvas: this app draws every uploaded image
 * to downscale it before upload (see components/IdUpload.tsx), and it runs the face
 * model over the same pixels. So the fingerprint is free here and expensive
 * anywhere else.
 *
 * ## The trust model, stated plainly
 *
 * This is a client-supplied number, exactly like `card_embedding` and
 * `photo_embedding`, which this app already accepts and compares server-side. The
 * comparison — every fingerprint of every other account — happens on the server,
 * and the threshold lives in ./id-verification/card-hash.ts rather than here.
 *
 * So someone who wanted to defeat this could send a random fingerprint and avoid a
 * duplicate warning. They could equally have sent a face descriptor of their own
 * choosing for the portrait check, and the app would already have accepted that.
 * Fixing this properly means the server decoding images, which is the dependency
 * this codebase has twice decided against. It is worth being clear that this check
 * is against the honest and the careless, not against an adversary.
 */

import { HASH_BITS, HASH_HEX_LENGTH } from "@/lib/id-verification/card-hash";

/**
 * Grid the card is reduced to.
 *
 * Nine by eight, not eight by eight. The hash compares each cell with the one to
 * its right, so a 9x8 grid yields 8x8 = 64 comparisons; an 8x8 grid would yield 49
 * and a shorter hash. The extra column and row are what make the count come out at
 * exactly 64 bits.
 */
const GRID_W = 9;
const GRID_H = 8;

/**
 * The difference-grayscale hash of an image already drawn to a canvas.
 *
 * dHash: for each cell, record whether it is brighter than its right-hand
 * neighbour. One bit each, 64 of them. The result describes the *shape* of the
 * light and dark across the card — where the portrait sits, where the signature
 * box is, where the hologram catches the light — and is largely indifferent to
 * brightness, which is the property that makes it survive a card being
 * photographed again in a different room.
 */
export function fingerprintFromCanvas(canvas: HTMLCanvasElement): string | null {
  let small: HTMLCanvasElement;
  try {
    small = document.createElement("canvas");
    small.width = GRID_W;
    small.height = GRID_H;
  } catch {
    return null;
  }

  const ctx = small.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  try {
    // Fill first. A transparent source composites onto transparent black, and the
    // comparisons below would then be reading alpha-premultiplied noise rather
    // than the image.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, GRID_W, GRID_H);
    ctx.drawImage(canvas, 0, 0, GRID_W, GRID_H);

    const { data } = ctx.getImageData(0, 0, GRID_W, GRID_H);

    /*
     * Luminance, from the ITU-R BT.601 weights — the same ones the eye is
     * approximated by. Computing it from the average of the channels instead would
     * make a card whose photo is blue-grey hash differently from the same card
     * under warm light, which is precisely the variation this needs to ignore.
     */
    const lum = (i: number): number => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    let hex = "";
    let nibble = 0;
    let bitsInNibble = 0;

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W - 1; x++) {
        const left = lum((y * GRID_W + x) * 4);
        const right = lum((y * GRID_W + x + 1) * 4);

        // Strictly greater. On an evenly-lit region the two are often equal, and
        // >= would call every one of those "the same bit" and bias the hash toward
        // zero — which would make different cards look alike rather than unlike.
        const bit = left > right ? 1 : 0;

        nibble = (nibble << 1) | bit;
        bitsInNibble++;

        if (bitsInNibble === 4) {
          hex += nibble.toString(16);
          nibble = 0;
          bitsInNibble = 0;
        }
      }
    }

    return hex.length === HASH_HEX_LENGTH ? hex : null;
  } catch {
    // A tainted canvas — the image came from somewhere that taints it — or any
    // other failure to read pixels. The duplicate check is advisory, so this
    // reports nothing rather than refusing an upload.
    return null;
  } finally {
    // Release the backing store immediately; it is 9x8 but the browser does not
    // reclaim it until it wants to.
    small.width = 0;
    small.height = 0;
  }
}

/** Fingerprint a File, or null when it cannot be decoded or read. */
export async function fingerprintFile(file: File): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0);
    return fingerprintFromCanvas(canvas);
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** Re-exported so callers can check a fingerprint without a second import. */
export { HASH_BITS, HASH_HEX_LENGTH };
