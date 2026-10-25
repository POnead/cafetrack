/**
 * Downloads the SFace face engine into public/models/.
 *
 *   npm run setup:face:sface
 *
 * Two files, both from OpenCV Zoo:
 *
 *   face_detection_yunet_2023mar_int8.onnx       ~98KB   MIT
 *   face_recognition_sface_2021dec_int8.onnx     ~9.4MB  Apache 2.0
 *
 * Licences matter here and are the reason this is not InsightFace, which has a
 * higher ceiling but whose model packages need a commercial licence — a cafe
 * using this to gate staff is commercial use. See README.
 *
 * Why downloads rather than a dependency: the models are not on npm, and
 * committing 9.5MB of binary to git is permanent. A pinned URL plus a pinned
 * hash is the honest middle — the file is not in the repo, and it cannot
 * silently change under us.
 *
 * Both files are idempotent: an existing file with the right hash is left alone,
 * so this can run on every install.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEST = join(here, "..", "public", "models");
/** The wasm runtime, served from the same origin so a cafe with no internet still works. */
const RUNTIME_DEST = join(here, "..", "public", "onnx");
const RUNTIME_SRC = join(here, "..", "node_modules", "onnxruntime-web", "dist");

const BASE = "https://huggingface.co/opencv/opencv_zoo/resolve/main/models";

/**
 * Pinned by hash, not by trust.
 *
 * The hashes were computed from the files this project was developed against and
 * are what the decoder in src/lib/face-sface.ts expects. If an upstream re-export
 * changes the weights, this refuses to use them rather than shipping a different
 * face model than the thresholds were measured against.
 */
const MODELS = [
  {
    name: "face_detection_yunet_2023mar_int8.onnx",
    url: `${BASE}/face_detection_yunet/face_detection_yunet_2023mar_int8.onnx`,
    sha256: "321aa5a6afabf7ecc46a3d06bfab2b579dc96eb5c3be7edd365fa04502ad9294",
    bytes: 100416,
  },
  {
    name: "face_recognition_sface_2021dec_int8.onnx",
    url: `${BASE}/face_recognition_sface/face_recognition_sface_2021dec_int8.onnx`,
    sha256: "2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a",
    bytes: 9896933,
  },
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

if (!existsSync(DEST)) mkdirSync(DEST, { recursive: true });

let downloaded = 0;
let present = 0;
let failed = 0;

for (const model of MODELS) {
  const target = join(DEST, model.name);

  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (sha256(existing) === model.sha256) {
      console.log(`  present  ${model.name}`);
      present++;
      continue;
    }
    console.log(`  replacing ${model.name} (hash does not match)`);
  }

  const temp = `${target}.part`;
  try {
    console.log(`  fetching ${model.name} (${(model.bytes / 1024 / 1024).toFixed(1)}MB)`);
    const res = await fetch(model.url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const got = sha256(buffer);

    if (got !== model.sha256) {
      throw new Error(
        `hash mismatch\n      expected ${model.sha256}\n      got      ${got}\n` +
          "      The upstream file is not the one this code was written against."
      );
    }

    writeFileSync(temp, buffer);
    renameSync(temp, target);
    console.log(`  saved    ${model.name}`);
    downloaded++;
  } catch (e) {
    failed++;
    rmSync(temp, { force: true });
    console.error(`  FAILED   ${model.name}: ${e.message}`);
  }
}

console.log(
  `\n${present} already present, ${downloaded} downloaded, ${failed} failed.`
);

/*
 * The wasm runtime, copied out of node_modules.
 *
 * Self-hosted rather than fetched from a CDN: a cafe till on a LAN may have no
 * working internet, and the one thing this feature must not do is fail because
 * a third party is unreachable. Only the single-threaded SIMD build is copied —
 * threading needs cross-origin isolation headers, which this app does not set,
 * so the other four builds would be dead weight.
 */
if (!existsSync(RUNTIME_DEST)) mkdirSync(RUNTIME_DEST, { recursive: true });
for (const file of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
  const from = join(RUNTIME_SRC, file);
  if (!existsSync(from)) {
    console.error(`  MISSING  ${file} — is onnxruntime-web installed?`);
    failed++;
    continue;
  }
  copyFileSync(from, join(RUNTIME_DEST, file));
  console.log(`  copied   ${file}`);
}

console.log(
  `\nFiles are in public/models/ and public/onnx/ and are gitignored — they are\n` +
    "build products, not source. The browser loads them from /models/ and /onnx/,\n" +
    "so src/proxy.ts must not intercept those paths."
);

if (failed > 0) {
  console.error(
    "\nThe SFace engine will not be selectable until both files are present.\n" +
      "The app is unaffected: it stays on the original face model."
  );
  process.exit(1);
}
