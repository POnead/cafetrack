"use client";

/**
 * The SFace face engine: YuNet detection and SFace recognition, on onnxruntime-web.
 *
 * ## Status: built and measured, not yet switched on
 *
 * Nothing imports this yet. It exists so the next step — choosing the engine per
 * cafe, storing which engine each enrolment used, and re-enrolling staff — has
 * something verified to switch to. Until that is done and a real threshold is
 * measured on till-quality captures, the app stays on the original face model.
 *
 * ## Why this pair
 *
 * The original engine is the tiny face-api detector plus a 128-float descriptor,
 * and its measured separation is thin: a worst genuine reading of 0.0301 against
 * a closest impostor of 0.0362, which is about ten percent of headroom each way.
 * That is the structural reason the check feels fragile — there is no room for a
 * haircut, glasses or a change of light.
 *
 *   YuNet   detection + 5 landmarks   98KB     MIT
 *   SFace   128-float embedding       9.4MB    Apache 2.0
 *
 * Both come from OpenCV Zoo and both are commercially usable, which is why this
 * is not InsightFace: its model packages need a separate commercial licence.
 *
 * ## Two things that are easy to get wrong, and were
 *
 * **The YuNet build takes a fixed 640x640 input.** Not a dynamic shape. Feeding
 * 320x320 fails at run time with "Got: 320 Expected: 640" — after the models have
 * already downloaded.
 *
 * **YuNet's five points are already in ArcFace order.** OpenCV documents them as
 * right eye, left eye, nose, right mouth, left mouth — but "right" there is the
 * subject's right, which is the left of the image, so they line up with ArcFace's
 * left-eye-first reference as-is. Swapping the pairs shifts the fit by 134.8
 * degrees; leaving them alone fits seven real faces at 3.0 degrees mean rotation.
 *
 * The decoder here was validated against OpenCV's own demo output: the seven
 * detection scores it produced (0.894, 0.882, 0.876, 0.868, 0.845, 0.839, 0.603)
 * match the ones drawn on that image exactly.
 */
import { cosineDistance } from "./face";
import { frameBrightness } from "./face-client";

/* ------------------------------------------------------------- constants -- */

/** Where the models are served from. */
const MODEL_BASE = "/models";

/** Where the wasm runtime is served from — see scripts/setup-face-sface.mjs. */
const RUNTIME_BASE = "/onnx/";

/** The detector's fixed input. Not negotiable; see the note above. */
export const YUNET_INPUT = 640;

/** Detections below this score are dropped. OpenCV's demo uses 0.6. */
export const YUNET_SCORE_THRESHOLD = 0.6;

/** Overlap above which two detections are the same face. */
export const YUNET_NMS_IOU = 0.3;

/** The recognition crop. ArcFace family models all take 112x112. */
export const SFACE_INPUT = 112;

/** Floats in an SFace embedding. Same count as the old model, different space. */
export const SFACE_LENGTH = 128;

/**
 * How far apart two SFace embeddings may be, by cosine distance.
 *
 * **Provisional, and deliberately conservative.** Measured on one photograph of
 * eight people — the target and a group — the genuine pair sat at 0.308 while
 * several different people sat between 0.14 and 0.35. That image cannot settle a
 * threshold: the group faces are 40 pixels wide, and at that size the descriptor
 * is dominated by pose and light rather than by who the person is. What it does
 * show is that the scale is nothing like the old model's 0.033 — an ArcFace-family
 * threshold lives near 0.6 — so carrying the old number across would refuse
 * everybody.
 *
 * The number is therefore set where OpenCV's own guidance puts it (cosine
 * similarity 0.363, i.e. distance 0.637) rather than where this measurement puts
 * it, because the honest conclusion is "measure on real captures". It must be
 * re-measured from till-quality enrolments before this engine gates a shift.
 */
export const SFACE_MATCH_THRESHOLD = 0.637;

/** ArcFace five-point reference for a 112x112 crop: eyes, nose, mouth corners. */
export const ARCFACE_REFERENCE: readonly { x: number; y: number }[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];

/* --------------------------------------------------------------- types ---- */

export type SfaceDetection = {
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Five points in ArcFace order: left eye, right eye, nose, mouth corners. */
  points: { x: number; y: number }[];
};

type TensorLike = { data: Float32Array | Uint8Array; dims: readonly number[] };

/* ---------------------------------------------------------- pure maths ---- */

/**
 * Least-squares similarity transform from `src` to `dst`.
 *
 * Written over complex numbers because that is the form in which it cannot be
 * got wrong: a similarity is `b = c * a + t`, so the least-squares `c` is
 * `sum(b * conj(a)) / sum(|a|^2)`. Its modulus is the scale and its argument the
 * rotation. The two-real-equations form was tried first and had the rotation sign
 * inverted — every crop came out rotated, which looks exactly like a broken model.
 *
 * Returns the forward map: `x' = a*x - b*y + tx`, `y' = b*x + a*y + ty`.
 */
export function similarityTransform(
  src: readonly { x: number; y: number }[],
  dst: readonly { x: number; y: number }[]
): { a: number; b: number; tx: number; ty: number } {
  const n = src.length;
  if (n === 0 || dst.length !== n) return { a: 1, b: 0, tx: 0, ty: 0 };

  const meanSrc = src.reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n }), {
    x: 0,
    y: 0,
  });
  const meanDst = dst.reduce((acc, p) => ({ x: acc.x + p.x / n, y: acc.y + p.y / n }), {
    x: 0,
    y: 0,
  });

  let re = 0;
  let im = 0;
  let varSrc = 0;

  for (let i = 0; i < n; i++) {
    const ax = src[i].x - meanSrc.x;
    const ay = src[i].y - meanSrc.y;
    const bx = dst[i].x - meanDst.x;
    const by = dst[i].y - meanDst.y;
    re += ax * bx + ay * by;
    /*
     * The imaginary part of `dst * conj(src)`, which is `ax*by - ay*bx`.
     *
     * Written the other way round first — `ay*bx - ax*by` — which is its
     * negation, so the fit corrected every head tilt in the wrong direction.
     * That survives a test image of upright faces (a 3-degree tilt corrected by
     * minus 3 still looks like a face) and doubles the error on a real one.
     */
    im += ax * by - ay * bx;
    varSrc += ax * ax + ay * ay;
  }

  // Five coincident points, or a degenerate fit: fall back to no transform rather
  // than dividing by zero and producing an all-black crop that still "works".
  if (!(varSrc > 0) || !Number.isFinite(varSrc)) return { a: 1, b: 0, tx: 0, ty: 0 };

  const scale = Math.hypot(re, im) / varSrc;
  const theta = Math.atan2(im, re);
  const a = scale * Math.cos(theta);
  const b = scale * Math.sin(theta);

  return {
    a,
    b,
    tx: meanDst.x - (a * meanSrc.x - b * meanSrc.y),
    ty: meanDst.y - (b * meanSrc.x + a * meanSrc.y),
  };
}

/**
 * Sample the aligned crop out of an RGB buffer.
 *
 * The transform is applied backwards — destination pixel to source coordinate —
 * and divided by `a²+b²`, which is what puts the translation into the right
 * units. Sampling forward and using `tx`/`ty` directly produced the same crop for
 * every face.
 */
export function alignCrop(
  rgb: Uint8Array,
  width: number,
  height: number,
  transform: { a: number; b: number; tx: number; ty: number },
  size: number = SFACE_INPUT
): Float32Array {
  const out = new Float32Array(size * size * 3);
  const s2 = transform.a * transform.a + transform.b * transform.b;

  if (!(s2 > 0) || !Number.isFinite(s2)) {
    // A degenerate transform samples nothing; return black rather than NaN, so a
    // failure downstream is a weak embedding instead of a crash.
    return out;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - transform.tx;
      const dy = y - transform.ty;
      const sx = (transform.a * dx + transform.b * dy) / s2;
      const sy = (-transform.b * dx + transform.a * dy) / s2;

      const x0 = Math.max(0, Math.min(width - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(sy)));
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      const wy = Math.max(0, Math.min(1, sy - y0));

      const o = (y * size + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = rgb[(y0 * width + x0) * 3 + c];
        const p10 = rgb[(y0 * width + x1) * 3 + c];
        const p01 = rgb[(y1 * width + x0) * 3 + c];
        const p11 = rgb[(y1 * width + x1) * 3 + c];
        out[o + c] = p00 * (1 - wx) * (1 - wy) + p10 * wx * (1 - wy) + p01 * (1 - wx) * wy + p11 * wx * wy;
      }
    }
  }

  return out;
}

/**
 * Decode YuNet's three stride heads into candidate detections.
 *
 * The score is `sqrt(cls * obj)` and the box is exponential in the last two
 * outputs, both as OpenCV's own post-processing does it. Coordinates come back in
 * input space (640x640 here); the caller scales them to the source image.
 */
export function decodeYunet(
  outputs: Record<string, TensorLike>,
  inputSize: number = YUNET_INPUT
): SfaceDetection[] {
  const candidates: SfaceDetection[] = [];

  for (const stride of [8, 16, 32]) {
    const cls = outputs[`cls_${stride}`];
    const obj = outputs[`obj_${stride}`];
    const bbox = outputs[`bbox_${stride}`];
    const kps = outputs[`kps_${stride}`];
    if (!cls || !obj || !bbox || !kps) continue;

    const rows = Math.floor(inputSize / stride);
    const total = rows * rows;

    for (let i = 0; i < total; i++) {
      const score = Math.sqrt(Math.max(0, cls.data[i]) * Math.max(0, obj.data[i]));
      if (score < YUNET_SCORE_THRESHOLD) continue;

      const col = i % rows;
      const row = Math.floor(i / rows);
      const b = i * 4;

      const cx = (col + bbox.data[b]) * stride;
      const cy = (row + bbox.data[b + 1]) * stride;
      const bw = Math.exp(bbox.data[b + 2]) * stride;
      const bh = Math.exp(bbox.data[b + 3]) * stride;

      const points: { x: number; y: number }[] = [];
      for (let k = 0; k < 5; k++) {
        points.push({
          x: (col + kps.data[i * 10 + k * 2]) * stride,
          y: (row + kps.data[i * 10 + k * 2 + 1]) * stride,
        });
      }

      candidates.push({
        score,
        x1: cx - bw / 2,
        y1: cy - bh / 2,
        x2: cx + bw / 2,
        y2: cy + bh / 2,
        points,
      });
    }
  }

  return candidates;
}

function iou(a: SfaceDetection, b: SfaceDetection): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  if (areaA <= 0 || areaB <= 0) return 0;
  return inter / (areaA + areaB - inter);
}

/** Keep the best of each overlapping cluster, highest score first. */
export function nonMaximumSuppression(
  candidates: readonly SfaceDetection[],
  threshold: number = YUNET_NMS_IOU
): SfaceDetection[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: SfaceDetection[] = [];
  for (const candidate of sorted) {
    if (kept.every((k) => iou(k, candidate) < threshold)) kept.push(candidate);
  }
  return kept;
}

/**
 * Head turn from YuNet's five points.
 *
 * The same sign convention as `headTurnSignal` in lib/face.ts: positive means the
 * head turned towards the person's own left, so the nose moves towards the eye on
 * the right of the image. Points are ArcFace-ordered, so `points[0]` is the
 * person's right eye and `points[1]` their left.
 *
 * A different proxy from the 68-point one and therefore a different scale — the
 * bands in lib/face.ts were measured against that one and must not be applied
 * here without re-measuring.
 */
export function headTurnSignal5(
  points: readonly { x: number; y: number }[] | null | undefined
): number | null {
  if (!points || points.length < 3) return null;

  const rightEye = points[0];
  const leftEye = points[1];
  const nose = points[2];

  for (const p of [rightEye, leftEye, nose]) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }

  const dRight = Math.hypot(nose.x - rightEye.x, nose.y - rightEye.y);
  const dLeft = Math.hypot(nose.x - leftEye.x, nose.y - leftEye.y);
  const total = dRight + dLeft;
  if (!(total > 0)) return null;

  // Positive when the nose is nearer the person's left eye.
  return (dRight - dLeft) / total;
}

/* ------------------------------------------------------------- runtime ---- */

type Engine = {
  detector: any;
  recogniser: any;
  ort: any;
};

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;

/** True when both model files are actually served. */
export async function sfaceModelsPresent(): Promise<boolean> {
  try {
    const res = await fetch(`${MODEL_BASE}/face_recognition_sface_2021dec_int8.onnx`, {
      method: "HEAD",
      cache: "no-store",
    });
    if (!res.ok) return false;
    const type = res.headers.get("content-type") || "";
    // The proxy answers an HTML page for a path it intercepts.
    return !type.includes("text/html");
  } catch {
    return false;
  }
}

/**
 * Load onnxruntime-web and both sessions, once per page.
 *
 * The wasm runtime is configured before the first session is created, because
 * onnxruntime resolves it lazily and a failure there surfaces as an unrelated
 * error later. Single-threaded: the threading build needs cross-origin isolation
 * headers this app does not send, and without them it silently falls back anyway.
 */
export function loadSfaceEngine(): Promise<Engine> {
  if (engine) return Promise.resolve(engine);
  if (loading) return loading;

  loading = (async () => {
    const ort: any = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    /*
     * Warnings off, errors on.
     *
     * Both models declare their weights as graph inputs, so onnxruntime emits
     * several hundred "Initializer ... appears in graph inputs" warnings while
     * the sessions are created. They are true, harmless, and unactionable without
     * re-exporting the models — and in a dev build they raise the Next.js error
     * overlay over a screen that is working perfectly.
     */
    ort.env.logLevel = "error";

    /*
     * Pin the exact runtime files, rather than pointing at a directory.
     *
     * Given only a directory, onnxruntime picks a build by feature detection and
     * reaches for `ort-wasm-simd-threaded.jsep.mjs` — the WebGPU-enabled variant,
     * 27MB instead of 13.6MB — which is not the file the setup script copies, so
     * it 404s and reports "no available backend found". The error names neither
     * the missing file nor the reason, and the console shows only a bare 404.
     * Handing it the two paths it should use is unambiguous.
     */
    ort.env.wasm.wasmPaths = {
      mjs: `${RUNTIME_BASE}ort-wasm-simd-threaded.mjs`,
      wasm: `${RUNTIME_BASE}ort-wasm-simd-threaded.wasm`,
    };

    const sessionOptions = {
      // Wasm only: the WebGPU and WebNN paths need their own binaries, and this
      // runs on whatever tablet the cafe already owns.
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    };

    const [detector, recogniser] = await Promise.all([
      ort.InferenceSession.create(
        `${MODEL_BASE}/face_detection_yunet_2023mar_int8.onnx`,
        sessionOptions
      ),
      ort.InferenceSession.create(
        `${MODEL_BASE}/face_recognition_sface_2021dec_int8.onnx`,
        sessionOptions
      ),
    ]);

    engine = { detector, recogniser, ort };
    return engine;
  })();

  // A failed load must not be cached, or one offline attempt disables the engine
  // for the rest of the session with no way to retry.
  loading.catch(() => {
    loading = null;
  });

  return loading;
}

/** Forget the sessions. Used by the retry path. */
export function resetSfaceEngine(): void {
  engine = null;
  loading = null;
}

/** Draw a source into a canvas at the given square size and read its pixels. */
function pixelsAt(source: CanvasImageSource, size: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot read the camera image");
  ctx.drawImage(source, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * Packed pixels -> NCHW float32.
 *
 * `stride` is 4 for canvas ImageData (RGBA) and 3 for the aligned crop (RGB),
 * which is why it is a parameter rather than an assumption. Channel order is
 * swapped for the detector because YuNet's export expects BGR, the way OpenCV
 * feeds it — the recogniser takes RGB.
 */
function toNchw(
  pixels: ArrayLike<number>,
  stride: number,
  size: number,
  { bgr = false, scale = 1 }: { bgr?: boolean; scale?: number } = {}
): Float32Array {
  const data = new Float32Array(3 * size * size);
  const plane = size * size;
  const order = bgr ? [2, 1, 0] : [0, 1, 2];

  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      data[c * plane + i] = pixels[i * stride + order[c]] * scale;
    }
  }
  return data;
}

export type SfaceRead =
  | {
      ok: true;
      /** 128 floats in the SFace space. Not comparable with the old model's. */
      embedding: number[];
      /** Head-turn proxy from the five points; see headTurnSignal5. */
      poseSignal: number | null;
      /** Which detector found it — there is only one here, but callers log it. */
      detector: "yunet";
      brightness: number | null;
      /** Detector confidence, 0..1. */
      score: number;
      box: { x: number; y: number; width: number; height: number };
    }
  | { ok: false; reason: "no-face" | "too-dark"; message: string };

/**
 * Read one face from a video frame, image or canvas.
 *
 * Everything runs at full size for the crop and at 640 square for detection, so
 * the landmarks the alignment uses are as precise as the source allows.
 */
export async function readFaceSface(source: CanvasImageSource): Promise<SfaceRead> {
  const brightness = frameBrightness(source);
  if (brightness !== null && brightness < 35) {
    return {
      ok: false,
      reason: "too-dark",
      message:
        "It is too dark to read a face. Move somewhere with more light on your face — " +
        "a window or a lamp in front of you, not behind.",
    };
  }

  const { detector, recogniser, ort } = await loadSfaceEngine();

  const detectionInput = pixelsAt(source, YUNET_INPUT);
  const outputs = await detector.run({
    input: new ort.Tensor(
      "float32",
      toNchw(detectionInput.data, 4, YUNET_INPUT, { bgr: true }),
      [1, 3, YUNET_INPUT, YUNET_INPUT]
    ),
  });

  const candidates = nonMaximumSuppression(decodeYunet(outputs as Record<string, TensorLike>));
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no-face",
      message: "No face found. Face the camera, in even light, with nothing covering your face.",
    };
  }

  const best = candidates[0];

  /*
   * Back to source coordinates.
   *
   * Two scales, not one: the detection frame is square, so a 16:9 video is
   * stretched to fill it and the x and y mappings differ. Using the width for
   * both puts every landmark progressively further up the frame the further it
   * is from the origin — which produces a plausible-looking crop of the wrong
   * part of the face.
   */
  const sourceW = sourceWidth(source);
  const sourceH = sourceHeight(source);
  const scaleX = sourceW / YUNET_INPUT;
  const scaleY = sourceH / YUNET_INPUT;

  const points = best.points.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));

  const full = document.createElement("canvas");
  full.width = sourceW;
  full.height = sourceH;
  const fullCtx = full.getContext("2d", { willReadFrequently: true });
  if (!fullCtx) throw new Error("This browser cannot read the camera image");
  fullCtx.drawImage(source, 0, 0, full.width, full.height);

  const rgba = fullCtx.getImageData(0, 0, full.width, full.height).data;
  // Packed RGB: the alignment sampler walks three channels per pixel.
  const rgb = new Uint8Array(full.width * full.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }

  const transform = similarityTransform(points, ARCFACE_REFERENCE);
  const crop = alignCrop(rgb, full.width, full.height, transform);

  const cropInput = new ort.Tensor(
    "float32",
    toNchw(crop, 3, SFACE_INPUT, { scale: 1 / 255 }),
    [1, 3, SFACE_INPUT, SFACE_INPUT]
  );

  const embeddingOut = await recogniser.run({
    [recogniser.inputNames[0]]: cropInput,
  });
  const embedding = Array.from(
    (embeddingOut[recogniser.outputNames[0]] as TensorLike).data
  ) as number[];

  return {
    ok: true,
    embedding,
    poseSignal: headTurnSignal5(points),
    detector: "yunet",
    brightness,
    score: best.score,
    box: {
      x: best.x1 * scaleX,
      y: best.y1 * scaleY,
      width: (best.x2 - best.x1) * scaleX,
      height: (best.y2 - best.y1) * scaleY,
    },
  };
}

/** Source dimensions of anything drawable. */
function sourceWidth(source: CanvasImageSource): number {
  const anySource = source as any;
  return anySource.videoWidth || anySource.naturalWidth || anySource.width || YUNET_INPUT;
}

function sourceHeight(source: CanvasImageSource): number {
  const anySource = source as any;
  return anySource.videoHeight || anySource.naturalHeight || anySource.height || YUNET_INPUT;
}

/**
 * Do two SFace embeddings describe the same person?
 *
 * Same cosine distance as every other comparison in this app — the metric does
 * not change with the model, only the threshold does, and that is the whole
 * danger of a model swap: 0.033 would refuse everyone here and 0.637 would admit
 * everyone on the old vectors.
 */
export function isSfaceMatch(a: number[] | Float32Array, b: number[] | Float32Array): boolean {
  const left = a instanceof Float32Array ? a : Float32Array.from(a);
  const right = b instanceof Float32Array ? b : Float32Array.from(b);
  if (left.length !== right.length) return false;
  const d = cosineDistance(left, right);
  return Number.isFinite(d) && d <= SFACE_MATCH_THRESHOLD;
}
