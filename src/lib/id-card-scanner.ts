"use client";

import type { CV } from "@techstark/opencv-js";

export type CardPoint = { x: number; y: number };
export type CardCorners = [CardPoint, CardPoint, CardPoint, CardPoint];

type OpenCvModule = { default?: unknown };
type OpenCvBootstrap = {
  onRuntimeInitialized?: () => void;
  onAbort?: (reason: string) => void;
};

let openCvPromise: Promise<CV> | null = null;

const DETECT_EDGE = 320;
const CARD_OUTPUT_WIDTH = 1024;
const CARD_OUTPUT_HEIGHT = 646;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenCvReady(value: unknown): value is CV {
  return (
    isRecord(value) &&
    typeof value.Mat === "function" &&
    typeof value.MatVector === "function" &&
    typeof value.findContours === "function" &&
    typeof value.warpPerspective === "function"
  );
}

async function loadOpenCv(): Promise<CV> {
  if (!openCvPromise) {
    openCvPromise = (async () => {
      const imported = (await import("./opencv-module")) as OpenCvModule;
      const candidate = imported.default;

      if (candidate instanceof Promise) {
        const ready = await candidate;
        if (!isOpenCvReady(ready)) throw new Error("The local image scanner did not initialize.");
        return ready;
      }

      if (isOpenCvReady(candidate)) return candidate;

      if (!isRecord(candidate)) {
        throw new Error("The local image scanner did not initialize.");
      }

      return new Promise<CV>((resolve, reject) => {
        const bootstrap = candidate as OpenCvBootstrap;
        const timeout = window.setTimeout(
          () => reject(new Error("The local image scanner took too long to start.")),
          15_000
        );
        const failed = bootstrap.onAbort;
        const initialized = bootstrap.onRuntimeInitialized;

        bootstrap.onAbort = (reason) => {
          window.clearTimeout(timeout);
          failed?.(reason);
          reject(new Error(reason || "The local image scanner could not start."));
        };
        bootstrap.onRuntimeInitialized = () => {
          window.clearTimeout(timeout);
          initialized?.();
          if (isOpenCvReady(candidate)) {
            resolve(candidate);
          } else {
            reject(new Error("The local image scanner did not initialize."));
          }
        };
      });
    })().catch((error: unknown) => {
      openCvPromise = null;
      throw error;
    });
  }

  return openCvPromise;
}

function orderedCorners(points: CardPoint[]): CardCorners {
  const center = points.reduce(
    (total, point) => ({ x: total.x + point.x / 4, y: total.y + point.y / 4 }),
    { x: 0, y: 0 }
  );
  const clockwise = [...points].sort(
    (a, b) =>
      Math.atan2(a.y - center.y, a.x - center.x) -
      Math.atan2(b.y - center.y, b.x - center.x)
  );
  const start = clockwise.reduce(
    (best, point, index) =>
      point.x + point.y < clockwise[best].x + clockwise[best].y ? index : best,
    0
  );
  const rotated = [...clockwise.slice(start), ...clockwise.slice(0, start)];
  return rotated as CardCorners;
}

function distance(a: CardPoint, b: CardPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function detectIdCard(video: HTMLVideoElement): Promise<CardCorners | null> {
  if (!video.videoWidth || !video.videoHeight) return null;

  const scale = Math.min(1, DETECT_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot inspect the camera image.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const cv = await loadOpenCv();
  const source = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best: { corners: CardCorners; area: number; aspectPenalty: number } | null = null;

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 55, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = canvas.width * canvas.height;
    for (let index = 0; index < contours.size(); index++) {
      const contour = contours.get(index);
      const polygon = new cv.Mat();
      try {
        const area = Math.abs(cv.contourArea(contour));
        if (area < frameArea * 0.18 || area > frameArea * 0.96) continue;

        cv.approxPolyDP(contour, polygon, cv.arcLength(contour, true) * 0.02, true);
        if (polygon.rows !== 4 || !cv.isContourConvex(polygon)) continue;

        const values = polygon.data32S;
        if (values.length < 8) continue;
        const corners = orderedCorners([
          { x: values[0], y: values[1] },
          { x: values[2], y: values[3] },
          { x: values[4], y: values[5] },
          { x: values[6], y: values[7] },
        ]);

        const horizontal =
          (distance(corners[0], corners[1]) + distance(corners[2], corners[3])) / 2;
        const vertical =
          (distance(corners[1], corners[2]) + distance(corners[3], corners[0])) / 2;
        const ratio = Math.max(horizontal, vertical) / Math.min(horizontal, vertical);
        if (ratio < 1.25 || ratio > 2.5) continue;

        const aspectPenalty = Math.abs(Math.log(ratio / 1.585));
        if (
          !best ||
          area - aspectPenalty * frameArea * 0.05 >
            best.area - best.aspectPenalty * frameArea * 0.05
        ) {
          best = { corners, area, aspectPenalty };
        }
      } finally {
        polygon.delete();
        contour.delete();
      }
    }

    if (!best) return null;
    return best.corners.map((point) => ({
      x: point.x / canvas.width,
      y: point.y / canvas.height,
    })) as CardCorners;
  } finally {
    source.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

export async function captureRectifiedIdFrame(
  video: HTMLVideoElement,
  corners: CardCorners,
  slot: string
): Promise<File> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("The camera is still starting — take the picture again.");

  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot process the ID photo.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const cv = await loadOpenCv();
  const source = cv.imread(canvas);
  const destination = new cv.Mat();
  let transform: InstanceType<typeof cv.Mat> | null = null;
  let sourcePoints: InstanceType<typeof cv.Mat> | null = null;
  let destinationPoints: InstanceType<typeof cv.Mat> | null = null;
  const output = document.createElement("canvas");
  output.width = CARD_OUTPUT_WIDTH;
  output.height = CARD_OUTPUT_HEIGHT;

  try {
    const scaled = corners.map((point) => ({
      x: point.x * canvas.width,
      y: point.y * canvas.height,
    })) as CardCorners;
    const topWidth = distance(scaled[0], scaled[1]);
    const sideHeight = distance(scaled[1], scaled[2]);
    const points =
      sideHeight > topWidth
        ? [scaled[3], scaled[0], scaled[1], scaled[2]]
        : scaled;
    sourcePoints = cv.matFromArray(
      4,
      1,
      cv.CV_32FC2,
      points.flatMap((point) => [point.x, point.y])
    );
    destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      CARD_OUTPUT_WIDTH - 1,
      0,
      CARD_OUTPUT_WIDTH - 1,
      CARD_OUTPUT_HEIGHT - 1,
      0,
      CARD_OUTPUT_HEIGHT - 1,
    ]);
    transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
    cv.warpPerspective(
      source,
      destination,
      transform,
      new cv.Size(CARD_OUTPUT_WIDTH, CARD_OUTPUT_HEIGHT),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
      new cv.Scalar()
    );
    cv.imshow(output, destination);
  } finally {
    source.delete();
    destination.delete();
    transform?.delete();
    sourcePoints?.delete();
    destinationPoints?.delete();
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    output.toBlob(resolve, "image/jpeg", 0.9)
  );
  if (!blob) throw new Error("That picture could not be saved. Take it again.");

  const safe = slot.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "id";
  return new File([blob], `${safe}-camera.jpg`, { type: "image/jpeg" });
}
