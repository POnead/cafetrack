"use client";

/**
 * A browser-side probe for the face pipeline, used only by `scripts/_face-probe.mjs`.
 *
 * ## Why this exists
 *
 * Every face test in this repo before now asserted on hand-built vectors. That is
 * exactly how the "descriptor of the whole room" bug survived: the tests proved
 * the *matching arithmetic* was right while the *reader* was feeding it garbage.
 * A unit test cannot tell you that a real photograph of a real face produced a
 * real embedding.
 *
 * So this page runs the actual models in an actual browser on actual photographs,
 * and publishes the result on `window.__faceProbe`. Playwright drives it, collects
 * the numbers, and prints the distance matrix. Nothing here ships to a customer:
 * the page 404s unless it is a dev build or `CAFETRACK_FACE_PROBE=1`.
 *
 * ## What it reports
 *
 *   - both engines, so the rework can be checked against the old one on the same
 *     photograph rather than argued about;
 *   - the pose in degrees, so real photographs can confirm the synthetic-rotation
 *     tests;
 *   - the five landmarks and a drawn overlay, so "it found a face" can be checked
 *     by eye rather than trusted.
 */

import { useEffect, useState } from "react";
import { readFace } from "@/lib/face-client";
import { readFaceSface } from "@/lib/face-sface";
import { poseOfRead } from "@/lib/face-engine";

type ProbeResult = {
  width: number;
  height: number;
  sface:
    | {
        ok: true;
        embedding: number[];
        headPose: { yaw: number; pitch: number; roll: number; scale: number; residual: number } | null;
        poseSignal: number | null;
        pose: string | null;
        points: { x: number; y: number }[];
        box: { x: number; y: number; width: number; height: number };
        score: number;
        brightness: number | null;
      }
    | { ok: false; reason: string; message: string };
  legacy:
    | {
        ok: true;
        embedding: number[];
        headPose: { yaw: number; pitch: number; roll: number; scale: number; residual: number } | null;
        poseSignal: number | null;
        pose: string | null;
        box: { x: number; y: number; width: number; height: number };
        score: number;
        detector: string;
      }
    | { ok: false; reason: string; message: string; thrown?: string };
  /** The source with the box and five points drawn on it, for eyeballing. */
  annotated: string | null;
};

/** Load a data URL into a decoded image element. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the image could not be decoded"));
    img.src = dataUrl;
  });
}

/**
 * Draw the detection box and the five landmarks on a copy of the photograph.
 *
 * The crop the recogniser actually sees is not exposed, but these are the points
 * the crop is aligned from — if they are on the eyes, nose and mouth, the crop is
 * of the face.
 */
function annotate(
  img: HTMLImageElement,
  box: { x: number; y: number; width: number; height: number },
  points: { x: number; y: number }[]
): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(img, 0, 0);

  ctx.strokeStyle = "#22c55e";
  ctx.lineWidth = Math.max(2, canvas.width / 200);
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const radius = Math.max(3, canvas.width / 120);
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#f97316";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  return canvas.toDataURL("image/jpeg", 0.9);
}

async function probe(dataUrl: string): Promise<ProbeResult> {
  const img = await loadImage(dataUrl);
  const result: ProbeResult = {
    width: img.naturalWidth,
    height: img.naturalHeight,
    sface: { ok: false, reason: "not-run", message: "" },
    legacy: { ok: false, reason: "not-run", message: "" },
    annotated: null,
  };

  try {
    const sface = await readFaceSface(img);
    if (sface.ok) {
      result.sface = {
        ok: true,
        embedding: sface.embedding,
        headPose: sface.headPose,
        poseSignal: sface.poseSignal,
        pose: poseOfRead(sface),
        points: sface.points,
        box: sface.box,
        score: sface.score,
        brightness: sface.brightness,
      };
      result.annotated = annotate(img, sface.box, sface.points);
    } else {
      result.sface = { ok: false, reason: sface.reason, message: sface.message };
    }
  } catch (e) {
    result.sface = { ok: false, reason: "threw", message: String(e) };
  }

  /*
   * The legacy engine runs second and its failure is not fatal. Its models are a
   * separate download, and the point of measuring it is comparison — a missing
   * legacy model set means "no comparison today", not "the probe is broken".
   */
  try {
    const legacy = await readFace(img);
    if (legacy.ok) {
      result.legacy = {
        ok: true,
        embedding: legacy.embedding,
        headPose: legacy.headPose,
        poseSignal: legacy.poseSignal,
        pose: poseOfRead(legacy),
        box: legacy.box,
        score: legacy.score,
        detector: legacy.detector,
      };
    } else {
      result.legacy = { ok: false, reason: legacy.reason, message: legacy.message };
    }
  } catch (e) {
    result.legacy = { ok: false, reason: "threw", message: "", thrown: String(e) };
  }

  return result;
}

export default function FaceProbe() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      __faceProbe?: (dataUrl: string) => Promise<ProbeResult>;
      __faceProbeReady?: boolean;
      __faceProbeError?: string | null;
    };

    // Playwright waits for this rather than for a selector, so it cannot race the
    // effect that installs the function.
    w.__faceProbe = probe;
    w.__faceProbeReady = true;
    w.__faceProbeError = null;

    // Surface a failure to *install* the probe, which would otherwise look like a
    // probe that never answers.
    void Promise.resolve().catch((e) => {
      w.__faceProbeError = String(e);
      setError(String(e));
    });

    setReady(true);
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans text-sm">
      <h1 className="mb-3 text-xl font-bold">Face probe</h1>
      <p className="mb-3 text-cocoa-700">
        Development tool. Nothing here is used by the app; it exists so{" "}
        <code>scripts/_face-probe.mjs</code> can run the real models on real photographs
        and measure them.
      </p>
      <p>
        Status:{" "}
        <strong>{error ? "failed" : ready ? "window.__faceProbe is ready" : "loading models…"}</strong>
      </p>
      {error ? <pre className="mt-3 whitespace-pre-wrap text-red-700">{error}</pre> : null}
    </main>
  );
}
