/**
 * What an ID upload is allowed to be.
 *
 * This is lib/face-image.ts's sibling. That module decides what may be stored as
 * a reference face photo; this decides what may be stored as a government ID,
 * and the two differ in ways that matter.
 *
 * ## Why the limits are different
 *
 * A face photo is captured by the app's own camera control at a known size, so
 * 200KB is generous and the client always lands under it. An ID is a photo of a
 * plastic card, taken by whatever the admin had in their pocket. The same phone
 * that produces a 30KB face photo produces a 4MB card photo.
 *
 * So the cap here is an order of magnitude higher, and it is enforced *before*
 * the bytes are read rather than after. That is the important part — see
 * `exceedsDeclaredLength`.
 *
 * ## Why the body length is checked first
 *
 * App Router route handlers have no body size limit. Unlike the Pages Router,
 * `bodyParser` and its `sizeLimit` do not exist here, so `request.formData()`
 * will happily buffer whatever the socket delivers before a single byte of this
 * module sees it. On a machine reachable from every phone on the café's Wi-Fi,
 * that is an unauthenticated way to make the server allocate as much memory as
 * the caller can send.
 *
 * So the declared Content-Length is checked first and the stream is then read
 * with a byte counter that stops the transfer regardless of what the header
 * claimed. The header is client-controlled and is treated as a hint, not as a
 * fact — which is why both checks exist.
 */

import { HttpError } from "./auth";

/**
 * Largest single image accepted, in bytes.
 *
 * 3MB. A modern phone photo of an ID card, downscaled by the browser to a
 * 1600px long edge, lands around 300-600KB; 3MB is roughly five times that, so
 * there is real headroom for a bad upload while still being a bounded number.
 */
export const MAX_ID_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * The most the whole request may carry — all images plus their base64 overhead
 * and the multipart framing.
 *
 * Front, back and photo at the per-file cap is 9MB, which is too much to want as
 * one request. 10MB leaves room for the overhead and the encoding without ever
 * being the limit that fires in practice.
 */
export const MAX_ID_REQUEST_BYTES = 10 * 1024 * 1024;

export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type IdImageRejectReason =
  | "missing"
  | "too-large"
  | "wrong-type"
  | "not-an-image"
  | "corrupt";

export type IdImageResult =
  | {
      ok: true;
      dataUrl: string;
      bytes: Uint8Array;
      length: number;
      type: string;
    }
  | { ok: false; reason: IdImageRejectReason; message: string };

/* ---------------- magic bytes ---------------- */

/** Identical to face-image.ts, and deliberately so — see the note there. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, sig: number[], at = 0): boolean {
  if (bytes.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[at + i] !== sig[i]) return false;
  }
  return true;
}

export function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, WEBP_RIFF) && startsWith(bytes, WEBP_TAG, 8)) return "image/webp";
  return null;
}

function reject(reason: IdImageRejectReason, message: string): IdImageResult {
  return { ok: false, reason, message };
}

function describeMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Refuse an obviously oversized request before reading any of it.
 *
 * Returns the message to send, or null when the request may proceed. Called
 * before `formData()`, because by the time formData() returns the whole body is
 * already in memory.
 */
export function exceedsDeclaredLength(req: Request): string | null {
  const raw = req.headers.get("content-length");
  if (!raw) return null; // Absent or chunked. The streaming check still applies.

  const declared = Number(raw);
  // A Content-Length that is not a number is not a length. Treated as absent so
  // the streaming check is what decides, rather than refusing a request over a
  // header a proxy may have mangled.
  if (!Number.isFinite(declared) || declared < 0) return null;

  if (declared > MAX_ID_REQUEST_BYTES) {
    return (
      `That upload is ${describeMb(declared)}, over the ${describeMb(MAX_ID_REQUEST_BYTES)} limit. ` +
      "Take the photo again closer to the card so it is a smaller file."
    );
  }

  return null;
}

/**
 * Read the request body with a hard ceiling, whatever the headers claim.
 *
 * The Content-Length check above is an optimisation — it avoids buffering a body
 * we already know is too big, and browsers do set it, so in practice it fires
 * first. This is the one that holds, because it counts what actually arrives. A
 * request sent chunked, or lying about its length, stops here.
 *
 * The bytes are then handed to a fresh Request carrying the original
 * Content-Type, and *that* is what gets parsed. Rewrapping rather than parsing
 * the multipart format by hand is deliberate: App Router's `formData()` is backed
 * by a real MIME parser, and reimplementing boundary handling to save one import
 * would be a lot of code guarding the one thing on this route that must not be
 * subtly wrong.
 */
export async function readBoundedFormData(req: Request): Promise<FormData> {
  const body = req.body;

  // No body at all. Return an empty FormData so the caller's own required-field
  // checks produce the useful message rather than a parse error.
  if (!body) return new FormData();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_ID_REQUEST_BYTES) {
        // Cancel rather than draining. The point is to stop reading, not to
        // finish politely and then complain.
        await reader.cancel().catch(() => {});
        throw new IdRequestTooLargeError(
          `That upload is over the ${describeMb(MAX_ID_REQUEST_BYTES)} limit. ` +
            "Take the photos again closer to the cards so each one is a smaller file."
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bounded = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bounded.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = req.headers.get("content-type");
  if (!contentType) {
    throw new HttpError(400, "Expected a multipart upload");
  }

  const rebuilt = new Request("http://cafetrack.invalid/", {
    method: "POST",
    headers: { "content-type": contentType },
    // Copied across verbatim. Without this the multipart parser sees an empty
    // body and every file part comes back missing.
    body: bounded as unknown as BodyInit,
  });

  try {
    return await rebuilt.formData();
  } catch {
    throw new HttpError(400, "Expected a multipart upload with the ID images");
  }
}

/** Thrown by readBoundedFormData, so the route can answer 413 rather than 500. */
export class IdRequestTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdRequestTooLargeError";
  }
}

/**
 * Validate one multipart file part and return it as base64 plus raw bytes.
 *
 * `field` names the part so the rejection message can say which image is wrong —
 * three identical uploads in one request would otherwise produce three identical
 * errors with nothing to tell them apart.
 *
 * Returns a reason rather than throwing, matching face-image.ts: every rejection
 * here is a client mistake with specific advice attached, and the caller wants to
 * answer 400 with that wording rather than 500.
 */
export async function readIdImage(file: unknown, field: string): Promise<IdImageResult> {
  const what = fieldLabel(field);

  if (!file || typeof file !== "object") {
    return reject("missing", `No ${what} was attached.`);
  }

  const candidate = file as File;
  const size = typeof candidate.size === "number" ? candidate.size : 0;

  // A file input that is present but empty sends a zero-byte part, which means
  // no image was chosen — not an image of zero bytes.
  if (size === 0) return reject("missing", `No ${what} was attached.`);

  if (size > MAX_ID_IMAGE_BYTES) {
    return reject(
      "too-large",
      `That ${what} is ${describeMb(size)}. It must be under ${describeMb(MAX_ID_IMAGE_BYTES)} — ` +
        "take it again closer to the card, with the whole card filling the frame."
    );
  }

  const declared = String(candidate.type ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(declared)) {
    return reject("wrong-type", `The ${what} must be a JPEG, PNG or WebP image.`);
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await candidate.arrayBuffer();
  } catch {
    return reject("corrupt", `The ${what} could not be read — take it again.`);
  }

  const bytes = new Uint8Array(buffer);

  // A part can arrive claiming a length it does not have. The declared size is a
  // hint; the real length is what gets measured.
  if (bytes.length === 0) return reject("missing", `No ${what} was attached.`);
  if (bytes.length > MAX_ID_IMAGE_BYTES) {
    return reject("too-large", `That ${what} is too large — take it again.`);
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed || sniffed !== declared) {
    return reject(
      "not-an-image",
      `That file is not a JPEG, PNG or WebP image. If it is a PDF, screenshot it or ` +
        "photograph the screen — a PDF is not something this can store."
    );
  }

  return {
    ok: true,
    // `text` and not `bytea`, for the reason on the users.id_doc_front column:
    // supabase-js and PGlite serialise a binary column differently and
    // src/lib/local-db.ts would have to know both.
    dataUrl: `data:${sniffed};base64,${Buffer.from(bytes).toString("base64")}`,
    bytes,
    length: bytes.length,
    type: sniffed,
  };
}

/** Which part a field name refers to, for messages. */
export function fieldLabel(field: string): string {
  switch (field) {
    case "front":
      return "photo of the front of the ID";
    case "back":
      return "photo of the back of the ID";
    case "photo":
      return "photo of the person";
    default:
      return "file";
  }
}
