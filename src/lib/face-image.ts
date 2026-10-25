/**
 * The reference photo half of a face enrollment.
 *
 * `lib/face.ts` holds the arithmetic; this holds everything about the *image*:
 * what will be accepted, how big it may get, and how it is turned into the base64
 * text the `users` table stores. Separated so the routes stay thin, and so the
 * rules live in one place — the photo is biometric data, and where it may come
 * from and how large it can be should not be decided independently in several
 * handlers.
 *
 * The photo is never turned into an embedding here. The browser computes that
 * with the recognition model and sends it alongside the image, because only the
 * browser has the model. So this module's job is narrower than it looks: accept
 * an image the server cannot check the *contents* of, and refuse anything that
 * is provably not one.
 */

/** Largest photo accepted. */
export const MAX_IMAGE_BYTES = 200 * 1024;

/**
 * Types accepted. Everything else is refused by name rather than sniffed for.
 *
 * These are the three a browser camera or file picker produces without a
 * conversion step. SVG is excluded deliberately: it is text that can carry
 * script, and it has no place in a face photo. HEIC is excluded because it is
 * what an iPhone produces by default and no browser decodes it for us, so
 * accepting it would mean storing something this app can never display again.
 */
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/**
 * Why a photo was refused, for the UI to map onto wording.
 *
 * Deliberately few and coarse: `not-an-image` covers both "these bytes are not a
 * supported format" and "these bytes disagree with the declared type", because
 * telling a caller *which* only helps someone probing the endpoint.
 */
export type ImageRejectReason =
  | "missing"
  | "too-large"
  | "wrong-type"
  | "not-an-image"
  | "corrupt";

export type ImageResult =
  | { ok: true; dataUrl: string; bytes: number; type: string }
  | { ok: false; reason: ImageRejectReason; message: string };

/**
 * The leading bytes of each accepted format, as they appear in a real file.
 *
 * PNG  - the 8-byte signature.
 * JPEG - the three-byte start-of-image marker. Deliberately short: a valid
 *        minimal JPEG is not much longer than this, and checking for the full
 *        SOF sequence would reject small files that are genuinely fine.
 * WEBP - "RIFF", four length bytes, then "WEBP" at offset 8.
 */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8

/** The media type implied by the file's leading bytes, or null if unrecognised. */
function sniffType(bytes: Uint8Array): string | null {
  const startsWith = (sig: number[], at = 0) => {
    if (bytes.length < at + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[at + i] !== sig[i]) return false;
    }
    return true;
  };

  if (startsWith(PNG)) return "image/png";
  if (startsWith(JPEG)) return "image/jpeg";
  if (startsWith(WEBP_RIFF, 0) && startsWith(WEBP_TAG, 8)) return "image/webp";
  return null;
}

function reject(reason: ImageRejectReason, message: string): ImageResult {
  return { ok: false, reason, message };
}

/**
 * Validate a multipart image field and return it as a base64 data URL.
 *
 * Everything the file claims about itself is checked, and then the bytes are
 * checked too, because a declared type is only a string the client sent. Without
 * the second check this endpoint would accept any file renamed to `.jpg` — and
 * the size limit, the only thing standing between this and an unbounded write,
 * would be measuring whatever the client chose to send.
 *
 * Returns a reason instead of throwing, because every rejection here is a client
 * mistake with specific advice attached and the caller wants to answer 400 with
 * that wording. It never throws for bad input; only an unreadable part does, and
 * that is reported as `corrupt` too.
 */
export async function readFaceImage(file: unknown): Promise<ImageResult> {
  if (!file || typeof file !== "object") return reject("missing", "A photo is required");

  const candidate = file as File;
  const size = typeof candidate.size === "number" ? candidate.size : 0;

  // A file input that is present but empty sends a zero-byte part. That means no
  // photo was chosen, which is not the same as a photo of zero bytes.
  if (size === 0) return reject("missing", "A photo is required");

  if (size > MAX_IMAGE_BYTES) {
    return reject(
      "too-large",
      `That photo is ${Math.round(size / 1024)}KB. It must be under ` +
        `${Math.round(MAX_IMAGE_BYTES / 1024)}KB — take it again with one ` +
        "face filling the frame."
    );
  }

  const declared = String(candidate.type ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(declared)) {
    return reject("wrong-type", "The photo must be a JPEG, PNG or WebP image");
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await candidate.arrayBuffer();
  } catch {
    return reject("corrupt", "That photo could not be read — take it again");
  }

  const bytes = new Uint8Array(buffer);

  // A part can arrive claiming a length it does not have; the declared size is
  // only a hint, so the real length is re-checked.
  if (bytes.length === 0) return reject("missing", "A photo is required");
  if (bytes.length > MAX_IMAGE_BYTES) {
    return reject("too-large", "That photo is too large — take it again");
  }

  const sniffed = sniffType(bytes);
  if (!sniffed || sniffed !== declared) {
    return reject("not-an-image", "That file is not a JPEG, PNG or WebP image");
  }

  // base64 rather than a binary column, so hosted Supabase and the local PGlite
  // adapter return the identical value and the read route needs no per-mode
  // handling. See the note on the users.face_image column in db/schema.sql.
  return {
    ok: true,
    dataUrl: `data:${sniffed};base64,${Buffer.from(bytes).toString("base64")}`,
    bytes: bytes.length,
    type: sniffed,
  };
}
