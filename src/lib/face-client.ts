"use client";

/*
 * The pose proxy comes from lib/face.ts, which is deliberately model-free, so
 * the capture side and the matching side agree on one definition of "turned".
 */
import { headTurnSignal } from "./face";

/**
 * The face model, in the browser.
 *
 * Nothing else in the app knows about face-api. Both the enrolment capture and
 * the duty check go through here, so the loading strategy, the normalisation and
 * the failure wording are defined once — and so the two cannot drift into
 * producing vectors in different formats, which would show up as an employee who
 * enrolled perfectly and then could never be recognised.
 *
 * Why it runs here rather than on the server: the server would need a native ML
 * runtime, and the reference photo plus a submitted vector is all it needs to
 * compare. Keeping the model client-side also means a second photograph of a
 * staff member is never transmitted — during a check, only 128 floats travel.
 *
 * The models are static files under /models/, copied by `npm run setup:face`.
 */

/** Where the weights live. Must be a path the proxy does not intercept. */
const MODEL_URL = "/models";

/** The three models, in the order they are needed. */
export const FACE_MODELS = {
  detector: "tiny_face_detector_model",
  /**
   * The accurate detector, and the one that is actually used.
   *
   * face-api ships two: the tiny one (0.18MB) which is fast and misses faces
   * that are angled, partly covered or in uneven light, and SSD MobileNet v1
   * (5.36MB) which costs more per frame and finds those. "It cannot see my
   * face" is almost always the tiny detector's failure, not the recogniser's,
   * so the accurate one runs first and the tiny one is the fallback — including
   * when these weights are not installed, which is why the app still works
   * without re-running `npm run setup:face`.
   */
  detectorAccurate: "ssd_mobilenetv1_model",
  landmarks: "face_landmark_68_model",
  recognition: "face_recognition_model",
} as const;

/**
 * Edge length the captured photo is scaled to before encoding.
 *
 * The recognition net resizes to 150x150 internally, so anything larger is thrown
 * away after paying for the upload. 256 keeps the stored photo ~30KB — which is
 * what stops a staff list carrying a megabyte of thumbnails — while staying
 * comfortably above the model's input size.
 */
export const CAPTURE_EDGE = 256;

export type FaceModels = {
  faceapi: any;
  tinyFaceDetector: any;
  /** Present only when the SSD weights are installed; see FACE_MODELS. */
  ssdMobilenetv1: any;
  faceLandmark68Net: any;
  faceRecognitionNet: any;
  /** Which tfjs backend was actually registered: "webgl" or "cpu". */
  backend: string;
};

export type LoadProgress = (loaded: number, total: number) => void;

let loaded: FaceModels | null = null;
let loading: Promise<FaceModels> | null = null;

/**
 * True when the weights are actually present.
 *
 * Worth checking before anything else, because the alternative is an obscure
 * failure: face-api fetches a manifest, gets back the sign-in page instead if the
 * proxy is intercepting /models/, and throws a JSON parse error with nothing on
 * screen to say what went wrong.
 *
 * The manifest is a top-level *array* of weight groups — the shape face-api's own
 * `loadFromUri` reads. It is not an object with a `weightsManifest` key, and
 * checking for that key made this report "not installed" on every machine where
 * the models were in fact present and loading perfectly.
 */
export async function modelsPresent(): Promise<boolean> {
  try {
    const res = await fetch(`${MODEL_URL}/${FACE_MODELS.detector}-weights_manifest.json`, {
      cache: "no-store",
    });
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") || "";
    // An HTML body means the proxy answered, not that the file is missing.
    if (ct.includes("text/html")) return false;
    const manifest = await res.json();
    return Array.isArray(manifest) && manifest.length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a camera can be opened at all on this origin.
 *
 * `navigator.mediaDevices` only exists in a secure context, so over plain http to
 * anything that is not localhost — which is every phone on the LAN — it is
 * undefined and `getUserMedia` cannot be called at all. That is a browser rule,
 * not something the page can work around, and it fails silently in the sense that
 * there is no error to catch: the object is simply not there.
 *
 * Uploading a file needs no secure context, so the photo route stays available
 * where the camera route does not.
 */
export function cameraAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

/** Why the camera is unavailable, when it is not. */
export function cameraUnavailableReason(): string | null {
  if (typeof window === "undefined") return null;
  if (window.isSecureContext) return null;
  return (
    "This address is plain http, so the page cannot open a camera itself. " +
    "“Take a photo” opens your phone's own camera app instead, which needs " +
    "no secure address — the photo comes back the same way either way."
  );
}

/** What the Take-a-photo button will actually do, given the address. */
export function captureHint(): string {
  if (typeof window === "undefined") return "";
  return window.isSecureContext
    ? "Take a photo opens the camera on this device."
    : "Take a photo opens this device's camera app.";
}

/**
 * Load the three models, once per page.
 *
 * Concurrent callers share one promise, so a capture and a check starting at the
 * same moment do not each pull 6MB.
 */
export function loadFaceModels(onProgress?: LoadProgress): Promise<FaceModels> {
  if (loaded) return Promise.resolve(loaded);
  if (loading) return loading;

  loading = (async () => {
    const tf = await import("@tensorflow/tfjs");

    /*
     * Backend selection, by what is actually registered rather than by guessing.
     *
     * This used to try `webgl` in a try/catch and fall back to `wasm`. Neither
     * half was right: `setBackend` returns false for a backend that is not
     * registered instead of throwing, so the catch never fired and the failure
     * surfaced later at `tf.ready()` with no indication of why. And `wasm` is not
     * a backend `@tensorflow/tfjs` ships — it lives in
     * `@tensorflow/tfjs-backend-wasm`, which is not installed here — so on any
     * device without WebGL the fallback named a backend that could never exist.
     *
     * `webgl` and `cpu` are both in the core package. CPU is much slower, but it
     * is always there, which is the property that matters: a person on a phone
     * with WebGL switched off should get a slow face check rather than an error.
     */
    let chosen: string | null = null;
    for (const backend of ["webgl", "cpu"]) {
      try {
        if (await tf.setBackend(backend)) {
          chosen = backend;
          break;
        }
      } catch {
        // Try the next one rather than failing here.
      }
    }
    if (!chosen) {
      throw new Error(
        "This browser has no usable compute backend for the face model (neither WebGL nor CPU)."
      );
    }
    await tf.ready();

    const faceapi = await import("@vladmandic/face-api");

    /*
     * No `faceapi.tf = tf` here.
     *
     * That assignment threw "Cannot set property tf of #<Object> which has only
     * a getter". face-api exports `tf` from an ESM namespace, and namespace
     * properties are read-only — the bundled build has no setter and no way to
     * add one.
     *
     * It is also unnecessary now. next.config.mjs points webpack at face-api's
     * `esm-nobundle` build, which imports `@tensorflow/tfjs` as an ordinary
     * module, so face-api and this app end up holding the *same* tfjs instance —
     * the one whose backends were just registered above. There is nothing left to
     * inject.
     *
     * The failure was invisible until the model-presence check was fixed,
     * because that check was rejecting every machine and returning before this
     * line was ever reached.
     */

    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);

    /*
     * The accurate detector is loaded separately, and its failure is not fatal.
     *
     * Every install that predates it has the tiny weights and not these, and a
     * browser that 404s on ssd_mobilenetv1_model would otherwise leave the whole
     * feature unusable until someone re-ran `npm run setup:face`. Missing, it
     * simply does not improve detection — the tiny detector still runs.
     */
    let ssdMobilenetv1: any = null;
    try {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
      ssdMobilenetv1 = faceapi.nets.ssdMobilenetv1;
    } catch {
      ssdMobilenetv1 = null;
    }

    loaded = {
      faceapi,
      tinyFaceDetector: faceapi.nets.tinyFaceDetector,
      ssdMobilenetv1,
      faceLandmark68Net: faceapi.nets.faceLandmark68Net,
      faceRecognitionNet: faceapi.nets.faceRecognitionNet,
      backend: chosen,
    };
    return loaded;
  })();

  // A failed load must not be cached, or one offline attempt disables the feature
  // for the rest of the session with no way to retry.
  loading.catch(() => {
    loading = null;
  });

  return loading;
}

/** Forget the loaded models. Used by the retry button after a failure. */
export function resetFaceModels(): void {
  loaded = null;
  loading = null;
}

/** Detection options, tuned for a hand-held camera at arm's length. */
const DETECT_OPTIONS = {
  inputSize: 320,
  // 0.3 rather than 0.4: at 0.4 the detector misses faces that are slightly
  // off-centre or in uneven light, which is the common case on a phone camera.
  // The cost of a lower threshold is a few false positives, which the landmark
  // net filters out anyway.
  scoreThreshold: 0.3,
  // A duty check happens one at a time at a till. Asking for several faces and
  // then guessing which one is meant is how a check passes on the wrong person
  // standing behind the person who is supposed to be there.
  maxResults: 1,
} as const;

/**
 * The second pass, at a larger input, when nothing was found the first time.
 *
 * The tiny detector resizes its input to `inputSize` square, so a face that
 * occupies a small part of a 640x480 frame arrives at the network a handful of
 * pixels across and is simply not detectable. Asking again at 512 gives that
 * face four times the area to be seen in. It is 2.5x the work, which is why it
 * only runs when the first pass found nothing — a normal capture never pays it.
 */
const ESCALATION_INPUT_SIZE = 512;

/**
 * How dark a frame may be before it is refused without running the model.
 *
 * Mean luminance on 0-255. Below this the landmarks are noise whatever the
 * detector says, so the honest answer is "it is too dark", not "no face found" —
 * and it costs no inference to say so. Most "it cannot recognise me" reports in
 * a cafe are a backlit or unlit frame, and the message matters: the person can
 * act on light, but not on "no face".
 */
const MIN_BRIGHTNESS = 35;

/**
 * Mean luminance of a frame, or null when it cannot be read.
 *
 * Sampled at 32x32 rather than full size: an average does not need detail, and
 * this runs on the capture path where every frame costs the person waiting.
 */
export function frameBrightness(source: CanvasImageSource): number | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, 32, 32);
    const { data } = ctx.getImageData(0, 0, 32, 32);

    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (data.length / 4);
  } catch {
    // A source that cannot be drawn to a canvas (a cross-origin image, a frame
    // that is not ready) is not evidence about the light. Says nothing.
    return null;
  }
}

export type FaceRead =
  | {
      ok: true;
      embedding: number[];
      /**
       * How far the head was turned, as the signed proxy from lib/face.ts, or
       * null when the landmarks were not the shape it needs. Computed here
       * because this is the only place the 68 points exist; the server never
       * sees landmarks, only this one number.
       *
       * It is a proxy, and a client controls it, so it orders a capture and
       * refuses an obviously wrong frame — it is not a security control. The
       * match is. See headTurnSignal.
       */
      poseSignal: number | null;
      /** Which detector pass found the face, for diagnosing "it cannot see me". */
      detector: "ssd" | "tiny-320" | "tiny-512";
      /** Mean luminance of the frame, 0-255, or null if it could not be sampled. */
      brightness: number | null;
      box: { x: number; y: number; width: number; height: number };
      score: number;
    }
  | {
      ok: false;
      reason: "no-face" | "low-confidence" | "too-dark";
      message: string;
    };

/**
 * Read one face from an image element or video frame.
 *
 * Runs the full chain — detect, find landmarks, compute the descriptor — because
 * the descriptor is only comparable if the face was aligned the same way it was
 * at enrolment. Skipping the landmarks step makes everything look almost right and
 * match nothing.
 *
 * Detection and landmarks go through face-api's top-level exported functions
 * rather than methods on `nets.tinyFaceDetector`. That instance is not a
 * detection API in this build: its prototype chain carries no `detectSingleFace`
 * at all, so calling it threw "models.tinyFaceDetector.detectSingleFace is not a
 * function". `faceapi.detectSingleFace` is the supported entry point and works.
 * The instance method is still used if it happens to exist, so a future build
 * that restores it is not a downgrade.
 */
export async function readFace(source: any): Promise<FaceRead> {
  const models = await loadFaceModels();
  const faceapi = models.faceapi;

  /*
   * The options have to be a real TinyFaceDetectorOptions instance.
   *
   * Passing a plain object literal — even one with exactly the right keys —
   * throws "detectFaces - expected options to be instance of TinyFaceDetectorOptions
   * | SsdMobilenetv1Options | TinyYolov2Options", because the library checks with
   * `instanceof` rather than by shape. Built from the class where it is exported;
   * left undefined otherwise, which falls through to the library's own defaults.
   */
  /*
   * The light first, because it is free and it is the answer most of the time.
   *
   * A dark frame produces no landmarks whatever detector runs, and the honest
   * sentence for it is about the light. Reporting "no face found" sends someone
   * to check their webcam when the fix is a lamp.
   */
  const brightness = frameBrightness(source as CanvasImageSource);
  if (brightness !== null && brightness < MIN_BRIGHTNESS) {
    return {
      ok: false,
      reason: "too-dark",
      message:
        "It is too dark to read a face. Move somewhere with more light on your face — " +
        "a window or a lamp in front of you, not behind.",
    };
  }

  /*
   * Detection, best first, and escalating rather than giving up.
   *
   * The accurate detector is tried first because "it cannot see my face" is a
   * detection failure far more often than a recognition one. The tiny detector
   * then runs at its normal size, and again at a larger input — a face that is
   * small in frame is invisible to the first pass and obvious to the third.
   *
   * Each step is only reached when the one before found nothing, so an ordinary
   * capture still costs one pass.
   */
  const callDetect = (input: any, options: any): Promise<any> =>
    typeof faceapi.detectSingleFace === "function"
      ? faceapi.detectSingleFace(input, options)
      : models.tinyFaceDetector.detectSingleFace(input, options);

  const tinyOptions = (inputSize: number) =>
    typeof faceapi.TinyFaceDetectorOptions === "function"
      ? new faceapi.TinyFaceDetectorOptions(
          inputSize,
          DETECT_OPTIONS.scoreThreshold,
          DETECT_OPTIONS.maxResults
        )
      : undefined;

  const ssdOptions =
    models.ssdMobilenetv1 && typeof faceapi.SsdMobilenetv1Options === "function"
      ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4, maxResults: 1 })
      : null;

  /*
   * Which order to try, by what the device can actually compute with.
   *
   * On WebGL the accurate detector costs a fraction of a second and is worth it
   * first. On the CPU backend it costs whole seconds per frame — and a café
   * phone falling back to CPU is exactly the device that cannot afford it — so
   * the cheap pass runs first there and the accurate one is the last resort
   * rather than the opening bid.
   */
  const attempts: { detector: "ssd" | "tiny-320" | "tiny-512"; options: any }[] = [];

  const accurateAvailable = models.ssdMobilenetv1 && ssdOptions;
  const onGpu = models.backend === "webgl";

  if (accurateAvailable && onGpu) attempts.push({ detector: "ssd", options: ssdOptions });
  attempts.push({ detector: "tiny-320", options: tinyOptions(DETECT_OPTIONS.inputSize) });
  attempts.push({ detector: "tiny-512", options: tinyOptions(ESCALATION_INPUT_SIZE) });
  if (accurateAvailable && !onGpu) attempts.push({ detector: "ssd", options: ssdOptions });

  let detection: any = null;
  let usedDetector: "ssd" | "tiny-320" | "tiny-512" = "tiny-320";

  for (const attempt of attempts) {
    detection = await callDetect(source, attempt.options);
    if (detection) {
      usedDetector = attempt.detector;
      break;
    }
  }

  if (!detection) {
    return {
      ok: false,
      reason: "no-face",
      message: "No face found. Face the camera, in even light, with nothing covering your face.",
    };
  }

  // Landmarks take FaceLandmark68NetOptions, a different type, so none are passed
  // and the net's own defaults apply. The detector's options were never meant for
  // it in the first place.
  const callLandmarks = (input: any): Promise<any> =>
    typeof faceapi.detectFaceLandmarks === "function"
      ? faceapi.detectFaceLandmarks(input)
      : models.faceLandmark68Net.detectFaceLandmarks(input);

  const landmarks = await callLandmarks(source);
  // No landmarks means the detector saw something face-shaped that the landmark
  // net rejected. Embedding it anyway would produce a vector that compares badly
  // against every real enrolment, so it is refused rather than accepted.
  if (!landmarks) {
    return {
      ok: false,
      reason: "low-confidence",
      message: "That face could not be read clearly. Try again, facing the camera straight on.",
    };
  }

  const descriptor = await models.faceRecognitionNet.computeFaceDescriptor(source, landmarks);
  if (!descriptor) {
    return {
      ok: false,
      reason: "low-confidence",
      message: "That face could not be read clearly. Try again in better light.",
    };
  }

  /*
   * The head turn, from the same 68 points the descriptor was aligned with.
   *
   * `landmarks.positions` is the raw iBUG array headTurnSignal expects. It is
   * read defensively: face-api has shipped this both as a property and as the
   * instance's own indexed points, and a pose that cannot be established reads
   * as null rather than as a guess — a guessed pose files a sample under the
   * wrong angle, which is worse than no sample.
   */
  const points = (landmarks as any)?.positions ?? (landmarks as any)?._positions;
  const poseSignal = headTurnSignal(points);

  return {
    ok: true,
    embedding: Array.from(descriptor),
    poseSignal,
    detector: usedDetector,
    brightness,
    box: detection.box,
    score: detection.score,
  };
}

/**
 * Scale a captured frame to CAPTURE_EDGE and return a JPEG data URL.
 *
 * Done on a canvas rather than sent as-is, for two reasons: the stored photo has
 * to stay small enough to sit in a text column, and the server rejects anything
 * over 200KB with a message about taking the photo again, which is a confusing
 * thing to be told by a page that just took it.
 */
export function toJpegDataUrl(source: CanvasImageSource, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = CAPTURE_EDGE;
  canvas.height = CAPTURE_EDGE;

  // Centre-crop to a square first, so a 16:9 camera frame does not become a
  // squashed head.
  const side = Math.min(width, height);
  const sx = (width - side) / 2;
  const sy = (height - side) / 2;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot process the photo");
  ctx.drawImage(source, sx, sy, side, side, 0, 0, CAPTURE_EDGE, CAPTURE_EDGE);

  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Shrink a data URL the same way, for a photo chosen from a file rather than a camera. */
export function dataUrlToJpeg(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        resolve(toJpegDataUrl(img, img.naturalWidth, img.naturalHeight));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("That file could not be read as an image"));
    img.src = dataUrl;
  });
}

/**
 * Ask for a camera and return the stream.
 *
 * A separate function because the permission prompt is the single most disruptive
 * thing this feature does to someone, and it must never appear on page load — only
 * after they have chosen to enrol or verify.
 *
 * `facingMode: "user"` asks for the front camera, which is the one pointed at the
 * person being checked.
 */
export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Reachable on an insecure origin, which is the one failure that produces no
    // error of its own: navigator.mediaDevices is simply undefined over plain
    // http to anything that is not localhost.
    throw new Error(
      "This browser will not open a camera here. The address has to start with https:// (or be localhost)."
    );
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
}

/**
 * Whether a camera denial can be undone by asking again.
 *
 * Worth distinguishing because Chrome does not re-prompt: once a user has blocked
 * the camera for a site, every later attempt fails immediately and silently. The
 * only way back is the browser's site settings, so the message has to say so
 * rather than offering a retry that will do nothing.
 */
export async function cameraPermissionState(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const status = await navigator.permissions?.query({ name: "camera" as any });
    if (!status) return "unknown";
    return status.state as "granted" | "denied" | "prompt";
  } catch {
    return "unknown";
  }
}

/** The exact steps for getting the camera back, per browser. */
export function permissionHelp(state: string): string | null {
  if (state !== "denied") return null;
  const isIos = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return isIos
    ? "Open Settings, then Safari, then Camera for this website, and choose Allow. Safari will not ask again once it is blocked."
    : "Open the browser menu, then Settings, then Site settings, then Camera, and choose Allow. This browser will not ask again once it is blocked.";
}
