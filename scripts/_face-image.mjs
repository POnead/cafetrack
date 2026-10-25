/**
 * Unit tests for src/lib/face-image.ts — the reference photo.
 *
 *   node scripts/_face-image.mjs
 *
 * The rules about what may be stored as a staff member's reference photo are
 * worth stating exactly, and they are testable by handing the function bytes
 * rather than by driving a camera and a browser.
 *
 * The bytes here are real file signatures with made-up contents after them. That
 * is the point: the check is a magic-number test, and the interesting cases are
 * the ones where the declared type and the actual bytes disagree.
 */
import { readFaceImage, MAX_IMAGE_BYTES, ACCEPTED_IMAGE_TYPES } from "../src/lib/face-image.ts";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Build a File. Node has a real one, and it is what the route actually receives.
 *
 * `padTo` grows the buffer with filler after the signature bytes, because
 * `new File(...)` derives `size` from the bytes given and ignores anything the
 * caller hopes the size will be. Without this a "200KB" test file would silently
 * be 8 bytes and the size limit would never be exercised at all.
 */
function makeFile(bytes, type, padTo = 0) {
  const buf = new Uint8Array(Math.max(bytes.length, padTo));
  buf.set(bytes, 0);
  return new File([buf], "photo", { type });
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

/* --------------------------------------------------------------- accept -- */

section("accepts a real file of each supported type");

for (const [label, sig, type] of [
  ["PNG", PNG, "image/png"],
  ["JPEG", JPEG, "image/jpeg"],
  ["WebP", WEBP, "image/webp"],
]) {
  const r = await readFaceImage(makeFile(sig, type));
  check(`a ${label} is accepted`, r.ok === true, r.ok ? `${r.bytes} bytes` : r.message);
}

const accepted = await readFaceImage(makeFile(PNG, "image/png"));
check(
  "the result is a data URL with the sniffed type",
  accepted.ok && accepted.dataUrl.startsWith("data:image/png;base64,"),
  accepted.ok ? accepted.dataUrl.slice(0, 32) : ""
);
check(
  "the data URL carries the bytes",
  accepted.ok && Buffer.from(accepted.dataUrl.split(",")[1], "base64").length === PNG.length
);
check(
  "the accepted list is exactly jpeg, png and webp",
  ACCEPTED_IMAGE_TYPES.length === 3 &&
    ACCEPTED_IMAGE_TYPES.includes("image/jpeg") &&
    ACCEPTED_IMAGE_TYPES.includes("image/png") &&
    ACCEPTED_IMAGE_TYPES.includes("image/webp"),
  ACCEPTED_IMAGE_TYPES.join(", ")
);

section("normalises the declared type");

check("a charset parameter is still accepted", (await readFaceImage(makeFile(PNG, "image/png; charset=binary"))).ok === true);
check("an upper-case type is accepted", (await readFaceImage(makeFile(PNG, "IMAGE/PNG"))).ok === true);

/* -------------------------------------------------------------- missing -- */

section("refuses what is not there");

for (const [label, value] of [
  ["null", null],
  ["undefined", undefined],
  ["a string", "not a file"],
  ["a number", 42],
]) {
  const r = await readFaceImage(value);
  check(`${label} -> missing`, r.ok === false && r.reason === "missing", r.ok ? "accepted" : r.reason);
}

const empty = await readFaceImage(makeFile([], "image/png"));
check(
  "a zero-byte part is 'no photo', not an empty photo",
  empty.ok === false && empty.reason === "missing",
  empty.ok ? "accepted" : empty.reason
);

/* ---------------------------------------------------------- wrong type -- */

section("refuses an unsupported declared type");

for (const [label, type] of [
  ["GIF", "image/gif"],
  ["BMP", "image/bmp"],
  ["SVG", "image/svg+xml"],
  ["HEIC", "image/heic"],
  ["plain text", "text/plain"],
  ["no type at all", ""],
]) {
  const r = await readFaceImage(makeFile(PNG, type));
  check(`${label} is refused`, r.ok === false && r.reason === "wrong-type", r.ok ? "accepted" : r.reason);
}

// SVG is refused by name rather than by content: it is text that can carry
// script, and there is no version of a staff photograph that needs it.
check("SVG is not in the accepted list", !ACCEPTED_IMAGE_TYPES.includes("image/svg+xml"));
// HEIC is an iPhone default no browser decodes for us, so accepting it would
// mean storing something this app can never display again.
check("HEIC is not in the accepted list", !ACCEPTED_IMAGE_TYPES.includes("image/heic"));

/* --------------------------------------------------------------- size --- */

section("refuses an oversized photo");

const tooBig = await readFaceImage(makeFile(PNG, "image/png", MAX_IMAGE_BYTES + 1));
check(
  "one byte over the limit is refused",
  tooBig.ok === false && tooBig.reason === "too-large",
  tooBig.ok ? "accepted" : tooBig.message.slice(0, 58)
);
check("exactly at the limit is allowed", (await readFaceImage(makeFile(PNG, "image/png", MAX_IMAGE_BYTES))).ok === true);
check("the limit is 200KB", MAX_IMAGE_BYTES === 200 * 1024, `${MAX_IMAGE_BYTES} bytes`);

/* ------------------------------------------------------------- lying --- */

section("refuses bytes that disagree with the declared type");

// The case this whole check exists for: a client can label anything it likes.
for (const [label, sig, declared] of [
  ["PNG bytes declared as JPEG", PNG, "image/jpeg"],
  ["JPEG bytes declared as PNG", JPEG, "image/png"],
  ["JPEG bytes declared as WebP", JPEG, "image/webp"],
]) {
  const r = await readFaceImage(makeFile(sig, declared));
  check(`${label} is refused`, r.ok === false && r.reason === "not-an-image", r.ok ? "accepted" : r.reason);
}

const riffNotWebp = await readFaceImage(
  makeFile([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], "image/webp")
);
check("a RIFF file that is not WebP is refused", riffNotWebp.ok === false && riffNotWebp.reason === "not-an-image");

section("refuses a file that is not an image at all");

for (const [label, bytes] of [
  ["plain text", [0x68, 0x65, 0x6c, 0x6c, 0x6f]],
  ["a PDF", [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]],
  ["a zip", [0x50, 0x4b, 0x03, 0x04]],
  ["an HTML page", [0x3c, 0x68, 0x74, 0x6d, 0x6c]],
  ["random bytes", [0x01, 0x02, 0x03, 0x04, 0x05]],
]) {
  const r = await readFaceImage(makeFile(bytes, "image/jpeg"));
  check(`${label} declared as an image is refused`, r.ok === false && r.reason === "not-an-image", r.ok ? "accepted" : r.reason);
}

/* ------------------------------------------------------ does not over-reach -- */

section("the signature check does not over-reach");

// A minimal JPEG is barely longer than the 3-byte marker. Checking further would
// reject a valid tiny file, which is why the marker is deliberately short.
check("a 4-byte JPEG is still accepted", (await readFaceImage(makeFile([0xff, 0xd8, 0xff, 0xd9], "image/jpeg"))).ok === true);

// Bytes that are a valid signature and nothing else. The magic-number test cannot
// detect that the image is truncated, and the module says so — decoding properly
// would mean shipping an image library on the server purely to validate input,
// which is not worth it for a thumbnail.
check(
  "a valid signature with nothing after it is accepted, as documented",
  (await readFaceImage(makeFile(PNG, "image/png"))).ok === true,
  "the signature check is not a decoder"
);
const tooShortToSniff = await readFaceImage(makeFile([0x89, 0x50, 0x4e, 0x47], "image/png"));
check(
  "a file shorter than the signature it claims is refused",
  tooShortToSniff.ok === false && tooShortToSniff.reason === "not-an-image",
  tooShortToSniff.ok ? "accepted" : tooShortToSniff.reason
);

console.log(`\n${"-".repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
