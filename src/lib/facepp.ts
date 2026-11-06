import { randomUUID } from "node:crypto";

const API_HOSTS: Record<string, string> = {
  US: "https://api-us.faceplusplus.com",
  CN: "https://api-cn.faceplusplus.com",
  SG: "https://api-sg.faceplusplus.com",
};

const SEARCH_MATCH_THRESHOLD = 80;
const COMPARE_MATCH_THRESHOLD = 75;
const EYE_STATE_THRESHOLD = 60;
const REQUEST_TIMEOUT_MS = 10_000;

/*
 * Face++ plans cap how many calls may be in flight at once, and a plan cap is
 * frequently one call per second. `verifyFacePlusPlusLogin` naturally wants
 * several Detect calls, then Compare — firing those with Promise.all is enough
 * to earn a 403 CONCURRENCY_LIMIT_EXCEEDED, which then looks like an unrelated
 * provider outage at the login screen.
 *
 * This queue makes every provider call whole-process sequential. The gap covers
 * the short window in which Face++ still counts a finished request as active;
 * the retry covers another process on the same API key, where no local queue
 * can help.
 *
 * 300ms was not enough: measured against a real account, a burst of six Detect
 * calls at that spacing produced three 403s. At 1000ms the same burst produced
 * none, so the default sits just above one second with a little margin. Login
 * uses Detect for pose, Analyze for the captured blink, and Compare for identity.
 */
const CONCURRENCY_RETRY_DELAYS_MS = [500, 1_000, 2_000];
const DEFAULT_REQUEST_GAP_MS = 1_050;

let providerQueue: Promise<unknown> = Promise.resolve();
let lastRequestFinishedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withProviderSlot<T>(task: () => Promise<T>): Promise<T> {
  const run = providerQueue.then(task, task);
  providerQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * The gap is a production guard, not part of the contract. The request/response
 * tests replace fetch with a local mock, where a fixed delay only makes the
 * suite slow; they set this to 0.
 */
function requestGapMs(): number {
  const raw = process.env.CAFETRACK_FACEPP_MIN_GAP_MS;
  if (raw === undefined) return DEFAULT_REQUEST_GAP_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REQUEST_GAP_MS;
}

type FacePlusPlusResponse = {
  confidence?: unknown;
  error_message?: unknown;
  error_message_code?: unknown;
  face_token?: unknown;
  faces?: unknown;
  faceset_token?: unknown;
  results?: unknown;
};

type ProviderCall =
  | { status: "ok"; body: FacePlusPlusResponse }
  | { status: "unavailable"; code: string };

type FacePlusPlusMode = "disabled" | "enabled" | "invalid";
export type FacePlusPlusResult =
  | { status: "matched" | "rejected" }
  | { status: "unavailable"; code: string };

export type FacePlusPlusFace = {
  faceToken: string;
  yawAngle: number;
  /**
   * Eye state from Detect. Login validates its blink separately with Analyze.
   */
  eyeState: EyeState;
};

export type FacePlusPlusLoginStep =
  | "passed"
  | "failed"
  | "unavailable"
  | "not_run";

export type FacePlusPlusLoginVerification = {
  status: "matched" | "rejected" | "unavailable";
  reason?: "face_not_detected" | "pose_not_verified" | "blink_not_verified" | "identity_not_matched";
  code?: string;
  poseChecks?: {
    front: boolean;
    left: boolean;
    right: boolean;
    blinkBefore: boolean;
    blinkClosed: boolean;
    blinkAfter: boolean;
  };
  steps: {
    detect: FacePlusPlusLoginStep;
    pose: FacePlusPlusLoginStep;
    /** The blink verdict, from Face++ Analyze over the captured face tokens. */
    blink: FacePlusPlusLoginStep;
    compare: FacePlusPlusLoginStep;
  };
};

export type FacePlusPlusEnrollment = {
  facesetToken: string;
  faceToken: string;
};

export function facePlusPlusFaceSetTokens(
  current: unknown,
  retired: unknown
): string[] {
  const tokens: string[] = [];
  if (typeof current === "string" && current) tokens.push(current);
  if (Array.isArray(retired)) {
    for (const token of retired) {
      if (typeof token === "string" && token) tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

function credentialValue(name: "FACEPP_API_KEY" | "FACEPP_API_SECRET"): string {
  return process.env[name]?.trim() ?? "";
}

function isPlaceholder(value: string): boolean {
  return /^(your[-_ ]|change[-_ ]?me|placeholder)/i.test(value);
}

export function facePlusPlusMode(): FacePlusPlusMode {
  if (process.env.CAFETRACK_TEST_FACE_LIVENESS === "1") return "disabled";
  const key = credentialValue("FACEPP_API_KEY");
  const secret = credentialValue("FACEPP_API_SECRET");
  if (!key && !secret) return "disabled";
  if (!key || !secret || isPlaceholder(key) || isPlaceholder(secret)) return "invalid";
  return "enabled";
}

function base64Image(dataUrl: string | null | undefined): string | null {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:image\/(?:jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  return match?.[1] ?? null;
}

function providerErrorCode(result: FacePlusPlusResponse): string {
  if (typeof result.error_message_code === "string") {
    return result.error_message_code.toLowerCase();
  }
  if (typeof result.error_message === "string") {
    const message = result.error_message.trim();
    const prefix = message.match(/^([A-Z][A-Z0-9_]*):/);
    if (prefix) return prefix[1].toLowerCase();
    // Some errors, including CONCURRENCY_LIMIT_EXCEEDED, arrive as a bare code
    // with no colon and no error_message_code. Losing that distinction turns a
    // retryable throttle into an indistinguishable provider failure.
    if (/^[A-Z][A-Z0-9_]*$/.test(message)) return message.toLowerCase();
  }
  return "provider_error";
}

function isNoFaceError(code: string): boolean {
  return code === "no_face_found" || code === "face_not_found";
}

function isConcurrencyError(result: FacePlusPlusResponse): boolean {
  return [result.error_message, result.error_message_code].some(
    (value) =>
      typeof value === "string" &&
      value.trim().toUpperCase() === "CONCURRENCY_LIMIT_EXCEEDED"
  );
}

function regionHost(): string | null {
  const region = (process.env.FACEPP_API_REGION || "US").trim().toUpperCase();
  return API_HOSTS[region] ?? null;
}

async function callFacePlusPlus(
  path: string,
  parameters: Record<string, string>
): Promise<ProviderCall> {
  const host = regionHost();
  if (!host) return { status: "unavailable", code: "unsupported_region" };

  const body = new URLSearchParams({
    api_key: credentialValue("FACEPP_API_KEY"),
    api_secret: credentialValue("FACEPP_API_SECRET"),
    ...parameters,
  });

  return withProviderSlot(async () => {
    for (let attempt = 0; ; attempt++) {
      const gap = requestGapMs() - (Date.now() - lastRequestFinishedAt);
      if (gap > 0) await sleep(gap);

      let response: Response;
      try {
        response = await fetch(`${host}/facepp/v3/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        lastRequestFinishedAt = Date.now();
        return { status: "unavailable", code: "network_error" };
      }

      let result: FacePlusPlusResponse;
      try {
        result = (await response.json()) as FacePlusPlusResponse;
      } catch {
        lastRequestFinishedAt = Date.now();
        return { status: "unavailable", code: "invalid_response" };
      }
      lastRequestFinishedAt = Date.now();

      if (isConcurrencyError(result) && attempt < CONCURRENCY_RETRY_DELAYS_MS.length) {
        await sleep(CONCURRENCY_RETRY_DELAYS_MS[attempt]);
        continue;
      }

      if (typeof result.error_message === "string") {
        return { status: "unavailable", code: providerErrorCode(result) };
      }
      if (!response.ok) return { status: "unavailable", code: `http_${response.status}` };
      return { status: "ok", body: result };
    }
  });
}

/** Detect exactly one face and return Face++'s head pose and eye state. */
export async function detectFacePlusPlus(
  image: string | null | undefined
): Promise<FacePlusPlusFace | FacePlusPlusResult> {
  const encoded = base64Image(image);
  if (!encoded) return { status: "rejected" };

  const result = await callFacePlusPlus("detect", {
    image_base64: encoded,
    // One call answers both questions the login gate asks: which way the head
    // is turned, and whether the eyes are open.
    return_attributes: "headpose,eyestatus",
  });
  if (result.status === "unavailable") {
    if (isNoFaceError(result.code)) return { status: "rejected" };
    return result;
  }

  const faces = result.body.faces;
  if (!Array.isArray(faces) || faces.length !== 1) return { status: "rejected" };
  const face = faces[0] as Record<string, unknown> | null;
  if (!face || typeof face.face_token !== "string" || !face.face_token) {
    return { status: "unavailable", code: "invalid_response" };
  }
  const attributes = face.attributes;
  const headpose =
    attributes && typeof attributes === "object"
      ? (attributes as Record<string, unknown>).headpose
      : null;
  const yawAngle =
    headpose && typeof headpose === "object"
      ? (headpose as Record<string, unknown>).yaw_angle
      : null;
  if (typeof yawAngle !== "number" || !Number.isFinite(yawAngle)) {
    return { status: "unavailable", code: "invalid_response" };
  }
  const eyeStatus =
    attributes && typeof attributes === "object"
      ? (attributes as Record<string, unknown>).eyestatus
      : null;
  return {
    faceToken: face.face_token,
    yawAngle,
    eyeState: combinedEyeState(eyeStatus),
  };
}

type EyeScores = Record<string, unknown>;
type EyeState = "open" | "closed" | "unknown";

function score(eye: EyeScores, key: string): number {
  const value = eye[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function eyeState(value: unknown): EyeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const eye = value as EyeScores;
  const open = score(eye, "no_glass_eye_open") + score(eye, "normal_glass_eye_open");
  const closed = score(eye, "no_glass_eye_close") + score(eye, "normal_glass_eye_close");
  if (open >= EYE_STATE_THRESHOLD && open > closed) return "open";
  if (closed >= EYE_STATE_THRESHOLD && closed > open) return "closed";
  return "unknown";
}

/**
 * Both eyes must agree before the state is trusted.
 *
 * One eye can be occluded, winking, or misread behind a reflection. Calling that
 * a blink is exactly the false acceptance the challenge exists to prevent.
 */
function combinedEyeState(value: unknown): EyeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const status = value as Record<string, unknown>;
  const left = eyeState(status.left_eye_status);
  const right = eyeState(status.right_eye_status);
  return left !== "unknown" && left === right ? left : "unknown";
}

/**
 * Face++ returns percentage scores for each eye state. Require both eyes to
 * agree so a blink is not inferred from one eye being occluded or misread.
 */
export async function verifyFacePlusPlusBlink(
  faceTokens: readonly [string, string, string]
): Promise<FacePlusPlusResult> {
  if (faceTokens.some((token) => !token)) return { status: "rejected" };
  const result = await callFacePlusPlus("face/analyze", {
    face_tokens: faceTokens.join(","),
    return_attributes: "eyestatus",
  });
  if (result.status === "unavailable") return result;

  const faces = result.body.faces;
  if (!Array.isArray(faces) || faces.length !== 3) {
    return { status: "unavailable", code: "invalid_response" };
  }

  const states: EyeState[] = [];
  for (const [index, value] of faces.entries()) {
    if (!value || typeof value !== "object") {
      return { status: "unavailable", code: "invalid_response" };
    }
    const face = value as Record<string, unknown>;
    if (face.face_token !== faceTokens[index]) {
      return { status: "unavailable", code: "invalid_response" };
    }
    const attributes = face.attributes;
    if (!attributes || typeof attributes !== "object") {
      return { status: "unavailable", code: "invalid_response" };
    }
    const eyeStatus = (attributes as Record<string, unknown>).eyestatus;
    if (!eyeStatus || typeof eyeStatus !== "object") {
      return { status: "unavailable", code: "invalid_response" };
    }
    const status = eyeStatus as Record<string, unknown>;
    const left = eyeState(status.left_eye_status);
    const right = eyeState(status.right_eye_status);
    states.push(left !== "unknown" && left === right ? left : "unknown");
  }

  return states[0] === "open" && states[1] === "closed" && states[2] === "open"
    ? { status: "matched" }
    : { status: "rejected" };
}

export async function searchFacePlusPlus(
  faceToken: string,
  facesetToken: string
): Promise<FacePlusPlusResult> {
  const result = await callFacePlusPlus("search", {
    face_token: faceToken,
    faceset_token: facesetToken,
    return_result_count: "1",
  });
  if (result.status === "unavailable") return result;
  const results = result.body.results;
  if (!Array.isArray(results) || results.length === 0) return { status: "rejected" };
  const confidence = (results[0] as Record<string, unknown> | null)?.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { status: "unavailable", code: "invalid_response" };
  }
  return confidence >= SEARCH_MATCH_THRESHOLD
    ? { status: "matched" }
    : { status: "rejected" };
}

/** Compare the saved enrollment image directly with the live front-facing image. */
export async function compareFacePlusPlus(
  referenceImage: string | null | undefined,
  liveImage: string | null | undefined
): Promise<FacePlusPlusResult> {
  const reference = base64Image(referenceImage);
  const live = base64Image(liveImage);
  if (!reference || !live) return { status: "rejected" };

  const result = await callFacePlusPlus("compare", {
    image_base64_1: reference,
    image_base64_2: live,
  });
  if (result.status === "unavailable") return result;
  const confidence = result.body.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { status: "unavailable", code: "invalid_response" };
  }
  return confidence >= COMPARE_MATCH_THRESHOLD
    ? { status: "matched" }
    : { status: "rejected" };
}

/**
 * Run the production sign-in checks against Face++ only.
 *
 * The frames are sent as five Detect calls (or six when the caller's blink
 * "before" frame is not the same image as the frontal frame). Analyze verifies
 * the open/closed/open blink over the detected face tokens, and Compare checks
 * identity. Analyze and Compare run independently after face detection, so
 * pose, blink, and identity results can be reported separately. Every check
 * remains mandatory to accept the sign-in.
 */
export async function verifyFacePlusPlusLogin(input: {
  referenceImage: string;
  frontImage: string;
  leftImage: string;
  rightImage: string;
  blinkEvidence: {
    before: string;
    closed: string;
    after: string;
  };
}): Promise<FacePlusPlusLoginVerification> {
  const steps: FacePlusPlusLoginVerification["steps"] = {
    detect: "not_run",
    pose: "not_run",
    blink: "not_run",
    compare: "not_run",
  };

  /*
   * The frontal frame is the blink's "before" frame in every capture this app
   * makes: straight on with eyes open is exactly the open state the challenge
   * needs. Only pay for a second Detect when a caller really supplied a
   * different image.
   */
  const beforeIsFront = input.blinkEvidence.before === input.frontImage;
  const images = [
    input.frontImage,
    input.leftImage,
    input.rightImage,
    input.blinkEvidence.closed,
    input.blinkEvidence.after,
  ];
  if (!beforeIsFront) images.push(input.blinkEvidence.before);

  /*
   * The calls are listed together, but `callFacePlusPlus` serialises them
   * through one provider queue, so "parallel" only means "queued now". That is
   * what keeps a one-request-per-second Face++ plan from answering
   * CONCURRENCY_LIMIT_EXCEEDED.
   */
  const detections = await Promise.all(images.map((image) => detectFacePlusPlus(image)));
  const unavailableDetection = detections.find(
    (result): result is { status: "unavailable"; code: string } =>
      "status" in result && result.status === "unavailable"
  );
  if (unavailableDetection) {
    steps.detect = "unavailable";
    return {
      status: "unavailable",
      code: unavailableDetection.code,
      steps,
    };
  }

  if (!detections.every((result): result is FacePlusPlusFace => "faceToken" in result)) {
    steps.detect = "failed";
    return { status: "rejected", reason: "face_not_detected", steps };
  }

  steps.detect = "passed";
  const [frontFace, leftFace, rightFace, closedFace, afterFace, extraBefore] = detections;
  const beforeFace = extraBefore ?? frontFace;
  /*
   * Face++ yaw is positive for a turn to the person's own right, which is the
   * opposite of the app's local sign (see lib/head-pose). The signs below are
   * the ones measured on the enrolled left and right photos, and they are what
   * makes a left frame and a right frame different evidence instead of two
   * copies of the same side.
   */
  const poseChecks = {
    front: Math.abs(frontFace.yawAngle) <= 18,
    left: leftFace.yawAngle <= -20,
    right: rightFace.yawAngle >= 20,
    blinkBefore: Math.abs(beforeFace.yawAngle) <= 25,
    blinkClosed: Math.abs(closedFace.yawAngle) <= 25,
    blinkAfter: Math.abs(afterFace.yawAngle) <= 25,
  };
  steps.pose = Object.values(poseChecks).every(Boolean) ? "passed" : "failed";
  const [blink, identity] = await Promise.all([
    verifyFacePlusPlusBlink([
      beforeFace.faceToken,
      closedFace.faceToken,
      afterFace.faceToken,
    ]),
    compareFacePlusPlus(input.referenceImage, input.frontImage),
  ]);
  steps.blink =
    blink.status === "matched"
      ? "passed"
      : blink.status === "unavailable"
        ? "unavailable"
        : "failed";
  steps.compare =
    identity.status === "matched"
      ? "passed"
      : identity.status === "unavailable"
        ? "unavailable"
        : "failed";

  if (identity.status === "unavailable" || blink.status === "unavailable") {
    return {
      status: "unavailable",
      code:
        identity.status === "unavailable"
          ? identity.code
          : blink.status === "unavailable"
            ? blink.code
            : undefined,
      steps,
      poseChecks,
    };
  }
  if (steps.pose === "failed") {
    return { status: "rejected", reason: "pose_not_verified", steps, poseChecks };
  }
  if (steps.blink === "failed") {
    return { status: "rejected", reason: "blink_not_verified", steps, poseChecks };
  }
  if (identity.status === "rejected") {
    return { status: "rejected", reason: "identity_not_matched", steps, poseChecks };
  }
  return { status: "matched", steps, poseChecks };
}

/**
 * Build a one-person FaceSet from the already-enrolled reference photo. Search
 * must stay scoped to this set; searching a cafe-wide gallery would turn the
 * login screen into a one-to-many identity lookup.
 */
export async function createFacePlusPlusEnrollment(
  userId: string,
  referenceImage: string
): Promise<FacePlusPlusEnrollment | FacePlusPlusResult> {
  const detected = await detectFacePlusPlus(referenceImage);
  if ("status" in detected) return detected;

  const outerId = `cafetrack-${userId.replaceAll("-", "").slice(0, 24)}-${randomUUID()
    .replaceAll("-", "")
    .slice(0, 12)}`;
  const created = await callFacePlusPlus("faceset/create", {
    outer_id: outerId,
    display_name: `CafeTrack ${userId.slice(0, 8)}`,
  });
  if (created.status === "unavailable") return created;
  const facesetToken = created.body.faceset_token;
  if (typeof facesetToken !== "string" || !facesetToken) {
    return { status: "unavailable", code: "invalid_response" };
  }

  const added = await callFacePlusPlus("faceset/addface", {
    faceset_token: facesetToken,
    face_tokens: detected.faceToken,
  });
  if (added.status === "unavailable") {
    const cleanup = await callFacePlusPlus("faceset/delete", {
      faceset_token: facesetToken,
      check_empty: "0",
    });
    if (cleanup.status === "unavailable") {
      console.error(`Face++ could not remove an incomplete FaceSet (${cleanup.code}).`);
    }
    return added;
  }

  return { facesetToken, faceToken: detected.faceToken };
}

export async function deleteFacePlusPlusEnrollment(
  facesetToken: string | null | undefined
): Promise<FacePlusPlusResult> {
  if (!facesetToken) return { status: "matched" };
  if (facePlusPlusMode() !== "enabled") {
    return { status: "unavailable", code: "credentials_unavailable" };
  }
  const result = await callFacePlusPlus("faceset/delete", {
    faceset_token: facesetToken,
    check_empty: "0",
  });
  if (result.status === "unavailable") {
    if (result.code === "faceset_not_exist" || result.code === "faceset_not_found") {
      return { status: "matched" };
    }
    return result;
  }
  return { status: "matched" };
}
