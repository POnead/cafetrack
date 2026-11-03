import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const MODEL_DIR = join(ROOT, "public", "models");
const MODEL_PATH = join(MODEL_DIR, "silentface.tflite");
const VENV = join(ROOT, ".face-liveness");
const WINDOWS = process.platform === "win32";
const VENV_PYTHON = join(VENV, WINDOWS ? "Scripts" : "bin", WINDOWS ? "python.exe" : "python");
const MODEL_URL =
  "https://huggingface.co/litert-community/Silent-Face-Anti-Spoofing-LiteRT/resolve/" +
  "a93eeab801f4b1c2568fb7fa863f4553a50c4b0d/silentface.tflite";
const MODEL_SHA256 = "4ff758f470b757d9005b418c9978693f09b8f2a5e7b7ee848c160db21208e1b2";
const MODEL_BYTES = 1_850_744;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function ensureSfaceModels() {
  const detector = join(MODEL_DIR, "face_detection_yunet_2023mar_int8.onnx");
  const recognizer = join(MODEL_DIR, "face_recognition_sface_2021dec_int8.onnx");
  if (existsSync(detector) && existsSync(recognizer)) return;
  execFileSync(process.execPath, [join(ROOT, "scripts", "setup-face-sface.mjs")], {
    stdio: "inherit",
  });
}

function installPythonDependencies() {
  if (!existsSync(VENV_PYTHON)) {
    const python = process.env.PYTHON || (WINDOWS ? "python" : "python3");
    console.log(`  creating ${VENV}`);
    execFileSync(python, ["-m", "venv", VENV], { stdio: "inherit" });
  }

  console.log("  installing local liveness runtime");
  execFileSync(
    VENV_PYTHON,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      join(ROOT, "requirements-face-liveness.txt"),
    ],
    { stdio: "inherit" }
  );
}

async function installModel() {
  mkdirSync(MODEL_DIR, { recursive: true });

  if (existsSync(MODEL_PATH)) {
    const existing = readFileSync(MODEL_PATH);
    if (sha256(existing) === MODEL_SHA256) {
      console.log("  present  silentface.tflite");
      return;
    }
    console.log("  replacing silentface.tflite (hash does not match)");
  }

  const temporary = `${MODEL_PATH}.part`;
  try {
    console.log("  fetching pinned Silent-Face model (1.8MB)");
    const response = await fetch(MODEL_URL, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const model = Buffer.from(await response.arrayBuffer());
    if (model.byteLength !== MODEL_BYTES || sha256(model) !== MODEL_SHA256) {
      throw new Error("Downloaded model size or SHA-256 did not match the pinned artifact.");
    }

    writeFileSync(temporary, model);
    renameSync(temporary, MODEL_PATH);
    console.log("  saved    silentface.tflite");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

ensureSfaceModels();
installPythonDependencies();
await installModel();

console.log("Local face liveness is installed in .face-liveness/.");
