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
import { cosineDistance, SFACE_MATCH_THRESHOLD } from "./face";
import { frameBrightness } from "./face-client";
import { CANONICAL_5, estimateHeadPose, type HeadPose } from "./head-pose";

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

/** SFace outputs are not unit length; cosine matching only needs their direction. */
export function normalizeSfaceEmbedding(embedding: readonly number[]): number[] | null {
  if (
    embedding.length !== SFACE_LENGTH ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }

  const norm = Math.hypot(...embedding);
  if (norm === 0 || !Number.isFinite(norm)) return null;
  return embedding.map((value) => value / norm);
}

/**
 * How far apart two SFace embeddings may be, by cosine distance.
 *
 * Re-exported from lib/face.ts so the server-side settings reader can clamp the
 * same number without importing this module — which pulls in onnxruntime and is
 * browser-only. The reasoning lives beside the constant.
 */
export { SFACE_MATCH_THRESHOLD } from "./face";

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
     * Warnings off, errors on — for the JavaScript logger.
     *
     * Both models declare their weights as graph inputs, so onnxruntime emits
     * 144 "Initializer ... appears in graph inputs" warnings while the sessions
     * are created. They are true, harmless, and unactionable without re-exporting
     * the models. Those particular lines come from the C++ logger, which this
     * setting does not reach; see `logSeverityLevel` on the session options below.
     * This one covers everything the JS layer itself prints.
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
      /*
       * Error, not warning — and this is the setting that actually does it.
       *
       * `env.logLevel` above only governs the JavaScript logger. The 144
       * "Initializer ... appears in graph inputs" lines come from the C++
       * logger inside the wasm build, whose severity is `logSeverityLevel` on
       * the session, and whose default is 2 (warning). So they arrived anyway:
       * a dev build counted them as issues and put the error overlay over a
       * perfectly working enrolment screen, and a real error would have been
       * 145th in a wall of harmless ones.
       *
       * 3 is `error`, so genuine failures still surface.
       */
      logSeverityLevel: 3,
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

/**
 * How a source was placed into the detector's square input.
 *
 * Kept as a value rather than four loose numbers because both readers have to
 * undo exactly the same transform, and getting one of the two wrong is how the
 * landmarks end up describing a face that is not there.
 */
type Letterbox = {
  data: ImageData;
  /** Model pixels per source pixel. One per axis, and equal but for rounding. */
  scaleX: number;
  scaleY: number;
  /** Where the source's top-left corner landed inside the square. */
  padX: number;
  padY: number;
};

/** The neutral grey used for the letterbox bars. */
const LETTERBOX_FILL = 114;

/**
 * Fit a source into the detector's square input without distorting it.
 *
 * ## Why this is not a resize
 *
 * This used to be `drawImage(source, 0, 0, 640, 640)` — a stretch. A 4:3 webcam
 * frame reached the detector squashed horizontally by a third, a 16:9 one by
 * nearly half. YuNet's landmark head was trained on faces at their real
 * proportions, so it answered with points describing the *stretched* face — and
 * the stretch is not uniform. It moves the nose against the eyes, which is
 * precisely the measurement the head-turn decision is built on.
 *
 * Measured on one photograph of one face, changing nothing but the frame it was
 * pasted into: yaw -0.7° in a square frame, +9.2° at 4:3, -31.2° at 2:1. The head
 * had not moved. A 640x480 camera therefore carried about nine degrees of phantom
 * turn into every reading and a 16:9 one more than that — enough to refuse a
 * straight-on face, to file a frontal frame as a side angle, and to hand SFace an
 * alignment computed from points in the wrong places.
 *
 * Letterboxing preserves the face's own proportions: one scale for both axes,
 * with the leftover space padded. The fill is the neutral grey the detection
 * literature uses, which introduces no edge of its own.
 */
function letterbox(source: CanvasImageSource, size: number): Letterbox {
  const sourceW = sourceWidth(source);
  const sourceH = sourceHeight(source);
  const scale = Math.min(size / sourceW, size / sourceH);
  const drawW = Math.max(1, Math.round(sourceW * scale));
  const drawH = Math.max(1, Math.round(sourceH * scale));
  const padX = Math.floor((size - drawW) / 2);
  const padY = Math.floor((size - drawH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser cannot read the camera image");
  ctx.fillStyle = `rgb(${LETTERBOX_FILL}, ${LETTERBOX_FILL}, ${LETTERBOX_FILL})`;
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, padX, padY, drawW, drawH);

  return {
    data: ctx.getImageData(0, 0, size, size),
    // The drawn size, not the requested scale: rounding moves a pixel or two, and
    // the mapping back has to agree with what was actually drawn.
    scaleX: drawW / sourceW,
    scaleY: drawH / sourceH,
    padX,
    padY,
  };
}

/** A landmark or box coordinate in the square input, mapped back to the source. */
function fromLetterbox(frame: Letterbox, x: number, y: number) {
  return {
    x: (x - frame.padX) / frame.scaleX,
    y: (y - frame.padY) / frame.scaleY,
  };
}

/**
 * A detection box in the square input, mapped back to source coordinates.
 *
 * One function for both readers: the two used to carry their own copy of this
 * arithmetic, and the copy that was missed during the letterbox change is exactly
 * how the box ends up describing a different part of the frame from the
 * landmarks.
 */
function boxFromLetterbox(
  frame: Letterbox,
  detection: { x1: number; y1: number; x2: number; y2: number }
): { x: number; y: number; width: number; height: number } {
  const topLeft = fromLetterbox(frame, detection.x1, detection.y1);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: (detection.x2 - detection.x1) / frame.scaleX,
    height: (detection.y2 - detection.y1) / frame.scaleY,
  };
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
      /**
       * Head pose in degrees, from the same five points. This is the number the
       * capture gate reads — `poseSignal` stays for the stored samples that
       * recorded it and for diagnostics.
       */
      headPose: HeadPose | null;
      /**
       * The five landmarks in source coordinates, in ArcFace order. Exposed so
       * the capture guide can draw on the face and so the measurement harness
       * can check detection against a photograph.
       */
      points: { x: number; y: number }[];
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

  const frame = letterbox(source, YUNET_INPUT);
  const outputs = await detector.run({
    input: new ort.Tensor(
      "float32",
      toNchw(frame.data.data, 4, YUNET_INPUT, { bgr: true }),
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
   * One scale for both axes, minus the letterbox offset. This is the inverse of
   * what `letterbox` did, and it is the only mapping that keeps a square in the
   * source square in the model — see the note there for what the two-scale
   * version did to the head-turn reading.
   */
  const sourceW = sourceWidth(source);
  const sourceH = sourceHeight(source);

  const points = best.points.map((p) => fromLetterbox(frame, p.x, p.y));

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
  const embedding = normalizeSfaceEmbedding(Array.from(
    (embeddingOut[recogniser.outputNames[0]] as TensorLike).data
  ));
  if (!embedding) throw new Error("SFace returned an invalid face embedding");

  return {
    ok: true,
    embedding,
    poseSignal: headTurnSignal5(points),
    headPose: estimateHeadPose(points, CANONICAL_5),
    points,
    detector: "yunet",
    brightness,
    score: best.score,
    box: boxFromLetterbox(frame, best),
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
 * Locate a face with YuNet alone — deliberately without running SFace.
 *
 * This is what the automatic scanner calls on a loop. YuNet is a 98KB model and
 * answers in tens of milliseconds; SFace is a 9.4MB model and answers slower, and
 * its answer is only wanted for the one frame the gate decides to keep. A scanner
 * that embedded every frame would be paying the expensive half of the chain for
 * frames it was about to throw away.
 */
export async function detectSfaceOnly(source: CanvasImageSource): Promise<SfaceRead> {
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
  // The recogniser is loaded by the same call, which is fine — the scanner runs
  // before the first capture, and both sessions are needed within seconds anyway.

  const frame = letterbox(source, YUNET_INPUT);
  const outputs = await detector.run({
    input: new ort.Tensor(
      "float32",
      toNchw(frame.data.data, 4, YUNET_INPUT, { bgr: true }),
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
  const points = best.points.map((p) => fromLetterbox(frame, p.x, p.y));

  return {
    ok: true,
    embedding: [],
    // Deliberately empty: this read did not run SFace. The type carries the field
    // so both readers share one shape, and an empty array is the honest version of
    // "there is no vector here" — a caller that used it would fail loudly.
    poseSignal: headTurnSignal5(points),
    headPose: estimateHeadPose(points, CANONICAL_5),
    points,
    detector: "yunet",
    brightness,
    score: best.score,
    box: boxFromLetterbox(frame, best),
  };
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
