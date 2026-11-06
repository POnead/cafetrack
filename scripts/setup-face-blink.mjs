import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_DIR = join(ROOT, "public", "models");
const MODEL_PATH = join(MODEL_DIR, "face_landmarker.task");
const WASM_SOURCE = join(ROOT, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const WASM_DESTINATION = join(ROOT, "public", "mediapipe", "wasm");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_BYTES = 3_758_596;
const MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
const WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function installModel() {
  mkdirSync(MODEL_DIR, { recursive: true });

  if (existsSync(MODEL_PATH)) {
    const existing = readFileSync(MODEL_PATH);
    if (existing.byteLength === MODEL_BYTES && sha256(existing) === MODEL_SHA256) {
      console.log("  present  face_landmarker.task");
      return;
    }
    console.log("  replacing face_landmarker.task (size or SHA-256 does not match)");
  }

  const temporary = `${MODEL_PATH}.part`;
  try {
    console.log("  fetching pinned MediaPipe Face Landmarker model (3.6MB)");
    const response = await fetch(MODEL_URL, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const model = Buffer.from(await response.arrayBuffer());
    if (model.byteLength !== MODEL_BYTES || sha256(model) !== MODEL_SHA256) {
      throw new Error("Downloaded model size or SHA-256 did not match the pinned artifact.");
    }

    writeFileSync(temporary, model);
    renameSync(temporary, MODEL_PATH);
    console.log("  saved    face_landmarker.task");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function installWasm() {
  mkdirSync(WASM_DESTINATION, { recursive: true });
  for (const file of WASM_FILES) {
    const source = join(WASM_SOURCE, file);
    if (!existsSync(source)) {
      throw new Error(`MediaPipe runtime file is missing: ${source}. Run npm install first.`);
    }
    copyFileSync(source, join(WASM_DESTINATION, file));
    console.log(`  copied   ${file}`);
  }
}

installWasm();
await installModel();
console.log("MediaPipe blink detection is installed for local browser use.");
