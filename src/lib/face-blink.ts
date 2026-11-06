"use client";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";

export type EyeBlinkState = "open" | "closed" | "transition";
export type EyeBlinkScores = { left: number; right: number };

const MODEL_URL = "/models/face_landmarker.task";
const WASM_URL = "/mediapipe/wasm";
const CLOSED_THRESHOLD = 0.6;
const OPEN_THRESHOLD = 0.3;

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
const XNNPACK_INFO_MESSAGE =
  /^(?:INFO: )?Created TensorFlow Lite XNNPACK delegate for CPU\.$/;

function describeLoaderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== "object") return String(error);

  const event = error as {
    type?: unknown;
    target?: {
      src?: unknown;
      href?: unknown;
      responseURL?: unknown;
      status?: unknown;
      statusText?: unknown;
    } | null;
  };
  const target = event.target;
  const url = target?.src ?? target?.href ?? target?.responseURL;
  const status =
    typeof target?.status === "number" && target.status > 0
      ? ` HTTP ${target.status}${target.statusText ? ` ${target.statusText}` : ""}`
      : "";
  const type = typeof event.type === "string" ? event.type : "unknown";
  return `MediaPipe loader event (${type}${url ? `: ${String(url)}` : ""}${status})`;
}

export async function withXnnpackInfoFiltered<T>(
  operation: () => Promise<T>
): Promise<T> {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string" && XNNPACK_INFO_MESSAGE.test(args[0])) {
      return;
    }
    originalConsoleError.apply(console, args);
  };

  try {
    return await operation();
  } finally {
    console.error = originalConsoleError;
  }
}

export function classifyEyeBlink(scores: EyeBlinkScores): EyeBlinkState {
  if (scores.left >= CLOSED_THRESHOLD && scores.right >= CLOSED_THRESHOLD) {
    return "closed";
  }
  if (scores.left <= OPEN_THRESHOLD && scores.right <= OPEN_THRESHOLD) {
    return "open";
  }
  return "transition";
}

export function loadFaceLandmarker(): Promise<FaceLandmarker> {
  if (landmarkerPromise) return landmarkerPromise;

  landmarkerPromise = (async () => {
    const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
      runningMode: "VIDEO" as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };

    return withXnnpackInfoFiltered(async () => {
      try {
        return await FaceLandmarker.createFromOptions(vision, options);
      } catch (gpuError) {
        try {
          return await FaceLandmarker.createFromOptions(vision, {
            ...options,
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          });
        } catch (cpuError) {
          const detail = describeLoaderError(cpuError);
          const gpuDetail = describeLoaderError(gpuError);
          throw new Error(
            `Face Landmarker could not start on GPU (${gpuDetail}) or CPU (${detail}).`
          );
        }
      }
    });
  })().catch((error: unknown) => {
    landmarkerPromise = null;
    throw error;
  });

  return landmarkerPromise;
}

export function readEyeBlinkScores(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestamp: number
): EyeBlinkScores | null {
  const result = landmarker.detectForVideo(video, timestamp);
  const categories = result.faceBlendshapes[0]?.categories;
  if (!categories) return null;

  const left = categories.find((category) => category.categoryName === "eyeBlinkLeft");
  const right = categories.find((category) => category.categoryName === "eyeBlinkRight");
  if (
    !left ||
    !right ||
    !Number.isFinite(left.score) ||
    !Number.isFinite(right.score)
  ) {
    throw new Error("Face Landmarker did not return valid eye-blink scores.");
  }

  return { left: left.score, right: right.score };
}
