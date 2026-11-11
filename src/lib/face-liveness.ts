import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FaceFrameInput, FaceEngine, parseEmbedding, poseFromSignal } from "./face";

type InferenceFrame = {
  live: boolean;
  pose_signal: number | null;
  embedding?: number[];
};

type InferenceResponse = {
  ok: boolean;
  frames?: InferenceFrame[];
};

export type FaceLivenessResult =
  | { ok: true; frames: FaceFrameInput[] }
  | { ok: false; reason: "unavailable" | "rejected" };

class FaceLivenessRuntimeError extends Error {}

const ROOT = process.cwd();
const MODEL_DIR = join(ROOT, "public", "models");
const ANTI_SPOOF_MODEL = join(MODEL_DIR, "silentface.tflite");
const YUNET_MODEL = join(MODEL_DIR, "face_detection_yunet_2023mar_int8.onnx");
const SFACE_MODEL = join(MODEL_DIR, "face_recognition_sface_2021dec_int8.onnx");
const PYTHON_SCRIPT = join(ROOT, "scripts", "face-liveness.py");
const PYTHON = process.env.CAFETRACK_FACE_LIVENESS_PYTHON ??
  join(
    ROOT,
    ".face-liveness",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python"
  );
const MAX_OUTPUT_BYTES = 100_000;

export async function verifyFacePresentation(
  frames: readonly FaceFrameInput[],
  engine: FaceEngine
): Promise<FaceLivenessResult> {
  // Isolated test servers use synthetic embeddings without exposing this bypass
  // outside a process explicitly configured by the test harness.
  if (process.env.CAFETRACK_TEST_FACE_LIVENESS === "1") {
    if (engine !== "sface") return { ok: false, reason: "unavailable" };
    return {
      ok: true,
      frames: frames.map((frame) => ({ ...frame })),
    };
  }

  // Legacy client vectors cannot be tied to the image verified here.
  if (engine !== "sface") return { ok: false, reason: "unavailable" };

  const requiredFiles = [
    ["Python runtime", PYTHON],
    ["liveness script", PYTHON_SCRIPT],
    ["anti-spoof model", ANTI_SPOOF_MODEL],
    ["face detector model", YUNET_MODEL],
    ...(engine === "sface" ? [["SFace model", SFACE_MODEL] as const] : []),
  ] as const;
  const missingFiles = requiredFiles.filter(([, path]) => !existsSync(path));
  if (missingFiles.length > 0) {
    console.error(
      `Face liveness runtime is unavailable; missing ${missingFiles.map(([name]) => name).join(", ")}.`
    );
    return { ok: false, reason: "unavailable" };
  }

  let response: InferenceResponse;
  try {
    response = await runInference(frames, engine);
  } catch (error) {
    if (error instanceof FaceLivenessRuntimeError) {
      console.error(`Face liveness runtime failed: ${error.message}`);
      return { ok: false, reason: "unavailable" };
    }
    throw error;
  }

  if (!response.ok || !Array.isArray(response.frames) || response.frames.length !== frames.length) {
    return { ok: false, reason: "rejected" };
  }

  const verified: FaceFrameInput[] = [];
  for (const [index, result] of response.frames.entries()) {
    const frame = frames[index];
    if (!result.live || poseFromSignal(result.pose_signal, engine) !== frame.pose) {
      return { ok: false, reason: "rejected" };
    }

    const embedding =
      engine === "sface" ? parseEmbedding(result.embedding) : frame.embedding;
    if (!embedding) return { ok: false, reason: "unavailable" };

    verified.push({ ...frame, embedding });
  }

  return { ok: true, frames: verified };
}

function runInference(
  frames: readonly FaceFrameInput[],
  engine: FaceEngine
): Promise<InferenceResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON,
      [PYTHON_SCRIPT, ANTI_SPOOF_MODEL, YUNET_MODEL, SFACE_MODEL],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
    );
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const settle = (error?: Error, result?: InferenceResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new FaceLivenessRuntimeError("Liveness inference returned no result."));
    };

    const timer = setTimeout(() => {
      child.kill();
      settle(new FaceLivenessRuntimeError("Liveness inference timed out."));
    }, 20_000);

    child.once("error", () => {
      settle(new FaceLivenessRuntimeError("Could not start the local liveness runtime."));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        settle(new FaceLivenessRuntimeError("Liveness inference returned too much data."));
        return;
      }
      stdout.push(chunk);
    });

    child.once("close", (code) => {
      if (code !== 0) {
        settle(new FaceLivenessRuntimeError("Liveness inference failed."));
        return;
      }

      try {
        const result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as InferenceResponse;
        settle(undefined, result);
      } catch {
        settle(new FaceLivenessRuntimeError("Liveness inference returned invalid data."));
      }
    });

    child.stdin.once("error", () => {
      settle(new FaceLivenessRuntimeError("Could not send camera evidence to liveness inference."));
    });
    child.stdin.end(
      JSON.stringify({
        engine,
        frames: frames.map((frame) => ({ pose: frame.pose, image: frame.evidence })),
      })
    );
  });
}
