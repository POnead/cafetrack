"use client";

/**
 * The camera sequence Face++ needs for a login or duty check — captured
 * automatically, like enrolment.
 *
 * Face++ still makes every decision: it finds exactly one face in each frame,
 * checks that the head really is straight on, left and right, verifies the
 * open → closed → open blink, and compares the live frontal frame with the
 * reference photo on the account.
 *
 * The browser watches the same camera and takes the frame itself:
 *
 *   duty check: straight on → left → right → close eyes → open eyes
 *   login:      straight on → left → front-facing blink → right
 *
 * Pose comes from the café's own face engine, the same gate enrolment uses, so
 * the screens cannot disagree about what "left" means. During login, the
 * browser detects the eye closing and reopening to capture the blink frames;
 * Face++ Analyze remains the authority that verifies the sequence.
 *
 * ## The manual fallback
 *
 * Automation must never be the reason someone cannot start work. If a prompt
 * takes too long, the eye model cannot load, or the measurement keeps failing,
 * the screen offers the capture button again and the old manual path finishes
 * the check. The server still validates every frame, so a manual frame is held
 * to exactly the same standard as an automatic one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { POSE_COPY, poseRefusal, type FacePose } from "./face";
import {
  capturePoseStateOfRead,
  detectFaceFor,
  useFaceEngine,
} from "./face-engine";
import { readEyeAspect } from "./face-client";
import {
  classifyEyeBlink,
  loadFaceLandmarker,
  readEyeBlinkScores,
  type EyeBlinkState,
} from "./face-blink";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "./face-diagnostics";
import type { PoseState } from "./head-pose";

export const FACEPP_CAPTURE_ORDER = [
  "front",
  "left",
  "right",
  "closed",
  "open",
] as const;

export const FACEPP_LOGIN_CAPTURE_ORDER = [
  "front",
  "left",
  "frontBlink",
  "right",
] as const;

export type FacePlusPlusCaptureStage =
  | (typeof FACEPP_CAPTURE_ORDER)[number]
  | (typeof FACEPP_LOGIN_CAPTURE_ORDER)[number];

export type FacePlusPlusImages = {
  front: string;
  left: string;
  right: string;
  before: string;
  closed: string;
  after: string;
};

export type FacePlusPlusCapturePhase = "idle" | "camera" | "complete" | "failed";

export const FACEPP_CAPTURE_COPY: Record<
  FacePlusPlusCaptureStage,
  { step: string; prompt: string; button: string }
> = {
  front: {
    step: "Step 1 of 5 · straight on",
    prompt: POSE_COPY.front.instruction,
    button: "Capture straight-on frame",
  },
  left: {
    step: "Step 2 of 5 · turn left",
    prompt: POSE_COPY.left.instruction,
    button: "Capture left-turn frame",
  },
  right: {
    step: "Step 3 of 5 · turn right",
    prompt: POSE_COPY.right.instruction,
    button: "Capture right-turn frame",
  },
  closed: {
    step: "Step 4 of 5 · blink",
    prompt: "Close both eyes and keep them closed for a moment.",
    button: "Capture closed-eye frame",
  },
  open: {
    step: "Step 5 of 5 · blink",
    prompt: "Now open both eyes wide, looking at the camera.",
    button: "Capture open-eye frame",
  },
  frontBlink: {
    step: "Step 3 of 4 · blink",
    prompt: "Face forward and blink slowly — the camera captures closed, then open eyes.",
    button: "Capture blink frame",
  },
};

export const FACEPP_LOGIN_CAPTURE_COPY: Record<
  FacePlusPlusCaptureStage,
  { step: string; prompt: string; button: string; label: string; viewLabel: string }
> = {
  front: {
    step: "Step 1 of 4 · straight on",
    prompt: POSE_COPY.front.instruction,
    button: "Capture straight-on frame",
    label: "Straight on",
    viewLabel: "View 1 of 4",
  },
  left: {
    step: "Step 2 of 4 · turn left",
    prompt: POSE_COPY.left.instruction,
    button: "Capture left-turn frame",
    label: "Turn left",
    viewLabel: "View 2 of 4",
  },
  frontBlink: {
    step: "Step 3 of 4 · front and blink",
    prompt: "Face forward and blink slowly — the camera captures closed, then open eyes.",
    button: "Capture blink frame",
    label: "Front · blink slowly",
    viewLabel: "View 3 of 4",
  },
  right: {
    step: "Step 4 of 4 · turn right",
    prompt: POSE_COPY.right.instruction,
    button: "Capture right-turn frame",
    label: "Turn right",
    viewLabel: "View 4 of 4",
  },
  closed: {
    step: "Step 4 of 5 · blink",
    prompt: "Close both eyes and keep them closed for a moment.",
    button: "Capture closed-eye frame",
    label: "Blink",
    viewLabel: "View 4 of 5",
  },
  open: {
    step: "Step 5 of 5 · blink",
    prompt: "Now open both eyes wide, looking at the camera.",
    button: "Capture open-eye frame",
    label: "Blink",
    viewLabel: "View 5 of 5",
  },
};

/** Square JPEG edge. Matches the enrolment photo, which Face++ compares against. */
const CAPTURE_EDGE = 256;

/** How often the scanner looks at the camera. */
const TICK_MS = 180;

/** Consecutive matching reads required before a pose frame is taken. */
const STABLE_READS = 3;

/** Login takes each valid pose on its first match and samples blink more often. */
const LOGIN_TICK_MS = 100;

/** ms on one prompt before the manual capture button appears. */
const STAGE_TIMEOUT_MS = 25_000;

/** Maximum duration for the standard duty-check capture flow. */
const TOTAL_TIMEOUT_MS = 90_000;

/*
 * Blink thresholds, relative to the open-eye reading taken with the frontal
 * frame. A face with naturally narrow eyes and a face with wide ones do not
 * share an absolute number, but both close to a fraction of their own open
 * value. The absolute numbers are only the fallback for when that baseline
 * could not be measured.
 */
const CLOSED_RATIO = 0.62;
const OPEN_RATIO = 0.85;
const CLOSED_EAR = 0.17;
const OPEN_EAR = 0.21;

export function facePlusPlusCameraAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function facePlusPlusPermissionHelp(): string {
  const isIos =
    typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return isIos
    ? "Open Settings, then Safari, then Camera for this website, and choose Allow."
    : "Open the browser menu, then Site settings, then Camera, and choose Allow.";
}

type Options = {
  /** Called with every frame once the last one lands. */
  onComplete: (images: FacePlusPlusImages) => void | Promise<void>;
  /** Login combines the blink into one guided front-facing step. */
  workflow?: "standard" | "login";
};

export function useFacePlusPlusCapture({ onComplete, workflow = "standard" }: Options) {
  const engine = useFaceEngine();
  const captureOrder: readonly FacePlusPlusCaptureStage[] =
    workflow === "login" ? FACEPP_LOGIN_CAPTURE_ORDER : FACEPP_CAPTURE_ORDER;
  const requiredStableReads = workflow === "login" ? 1 : STABLE_READS;
  const tickIntervalMs = workflow === "login" ? LOGIN_TICK_MS : TICK_MS;
  const [phase, setPhase] = useState<FacePlusPlusCapturePhase>("idle");
  const [stage, setStage] = useState<FacePlusPlusCaptureStage>("front");
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const [liveState, setLiveState] = useState<PoseState | null>(null);
  const [showManual, setShowManual] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const imagesRef = useRef<Partial<FacePlusPlusImages>>({});

  const stageRef = useRef<FacePlusPlusCaptureStage>("front");
  const manualStageRef = useRef<FacePlusPlusCaptureStage | null>(null);
  const engineRef = useRef(engine);
  engineRef.current = engine;

  const runningRef = useRef(false);
  const completedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableRef = useRef(0);
  const stageStartedAtRef = useRef(0);
  const totalStartedAtRef = useRef(0);
  /** The open-eye reading taken with the frontal frame, or null. */
  const baselineRef = useRef<number | null>(null);
  const loginBlinkPhaseRef = useRef<"waiting-closed" | "waiting-open-after">(
    "waiting-closed"
  );
  const captureVersionRef = useRef(0);
  const blinkLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const blinkDetectionFailedRef = useRef(false);
  const blinkTimestampRef = useRef(0);

  /*
   * The callback lives in a ref so a parent that re-renders mid-scan does not
   * restart the sequence or capture a stale closure.
   */
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stopLoop = useCallback(() => {
    runningRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopCamera, [stopCamera]);
  useEffect(() => stopLoop, [stopLoop]);

  /**
   * A callback ref, not a plain object ref.
   *
   * The <video> is mounted on the render after `phase` becomes "camera", so
   * assigning the stream inside start() would run before the element exists and
   * silently drop it — the camera light comes on and the preview stays black.
   */
  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node || !streamRef.current) return;
    node.srcObject = streamRef.current;
    void node.play().catch(() => {});
  }, []);

  const captureImage = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;

    const canvas = document.createElement("canvas");
    canvas.width = CAPTURE_EDGE;
    canvas.height = CAPTURE_EDGE;
    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_EDGE, CAPTURE_EDGE);
    return canvas.toDataURL("image/jpeg", 0.82);
  }, []);

  const finish = useCallback(() => {
    completedRef.current = true;
    stopLoop();
    stopCamera();
    setMessage(null);
    setHoldProgress(0);
    setLiveState(null);
    setPhase("complete");
    void onCompleteRef.current(imagesRef.current as FacePlusPlusImages);
  }, [stopCamera, stopLoop]);

  const advanceStage = useCallback(
    (current: FacePlusPlusCaptureStage) => {
      const index = captureOrder.indexOf(current);
      if (index === captureOrder.length - 1) {
        finish();
        return;
      }

      const following = captureOrder[index + 1];
      stageRef.current = following;
      setStage(following);
      stageStartedAtRef.current = Date.now();
      stableRef.current = 0;
      setHoldProgress(0);
      setShowManual(false);
      setMessage(
        following === "frontBlink"
          ? "Face forward and blink slowly. Three frames will be captured for Face++ to check."
          : null
      );
      if (following === "frontBlink") {
        loginBlinkPhaseRef.current = "waiting-closed";
      }
    },
    [captureOrder, finish]
  );

  /**
   * Take the frame for `stage` and move on.
   *
   * In the standard flow the first frontal image is also the blink's "before"
   * frame. Login replaces it with the open frame detected immediately before the
   * automatic blink capture.
   */
  const acceptStage = useCallback(
    (current: FacePlusPlusCaptureStage): boolean => {
      const image = captureImage();
      if (!image) {
        setMessage("The camera frame is not ready. Hold still for a moment.");
        return false;
      }

      const next = { ...imagesRef.current };
      if (current === "front") {
        next.front = image;
        next.before = image;
      } else if (current === "left") {
        next.left = image;
      } else if (current === "frontBlink") {
        next.front = image;
        next.before = image;
      } else if (current === "right") {
        next.right = image;
      } else if (current === "closed") {
        next.closed = image;
      } else {
        next.after = image;
      }
      imagesRef.current = next;

      advanceStage(current);
      return true;
    },
    [captureImage, advanceStage]
  );

  const captureLoginBlinkFrame = useCallback(
    (eyeState: EyeBlinkState): boolean => {
      const blinkPhase = loginBlinkPhaseRef.current;
      const shouldCapture =
        (blinkPhase === "waiting-closed" && eyeState === "closed") ||
        (blinkPhase === "waiting-open-after" && eyeState === "open");

      if (!shouldCapture) {
        setMessage(
          blinkPhase === "waiting-closed"
            ? "Blink slowly while facing forward. Waiting for eyes to close."
            : "Blink detected. Open your eyes to finish."
        );
        return false;
      }

      const image = captureImage();
      if (!image) {
        setMessage("The camera frame is not ready. Keep facing forward and try again.");
        return false;
      }

      const next = { ...imagesRef.current };
      if (blinkPhase === "waiting-closed") {
        next.closed = image;
        loginBlinkPhaseRef.current = "waiting-open-after";
        setMessage("Blink detected. Open your eyes to finish.");
        setHoldProgress(1 / 2);
      } else {
        next.after = image;
        imagesRef.current = next;
        setHoldProgress(1);
        advanceStage("frontBlink");
        return true;
      }

      imagesRef.current = next;
      return true;
    },
    [advanceStage, captureImage]
  );

  const captureLoginBlinkManually = useCallback(() => {
    const image = captureImage();
    if (!image) {
      setMessage("The camera frame is not ready. Hold still and try again.");
      return;
    }

    const next = { ...imagesRef.current };
    if (loginBlinkPhaseRef.current === "waiting-closed") {
      next.closed = image;
      loginBlinkPhaseRef.current = "waiting-open-after";
      setMessage("Closed-eye frame captured. Open your eyes and capture again.");
      setHoldProgress(1 / 2);
    } else {
      next.after = image;
      setHoldProgress(1);
      imagesRef.current = next;
      advanceStage("frontBlink");
      return;
    }
    imagesRef.current = next;
  }, [advanceStage, captureImage]);

  /**
   * The manual fallback: take whatever the camera is showing for the current
   * prompt. The server still checks pose and eye state, so this cannot smuggle
   * a bad frame past the gate — it only removes the timing requirement.
   */
  const capture = useCallback(() => {
    if (completedRef.current) return;
    setMessage(null);
    const current = stageRef.current;
    manualStageRef.current = current;
    captureVersionRef.current += 1;
    if (workflow === "login" && current === "frontBlink") {
      captureLoginBlinkManually();
      manualStageRef.current = null;
      return;
    }
    acceptStage(current);
    manualStageRef.current = null;
  }, [acceptStage, captureLoginBlinkManually, workflow]);

  const start = useCallback(async (): Promise<boolean> => {
    setMessage(null);
    setBlocked(null);
    setShowManual(false);
    setHoldProgress(0);
    setLiveState(null);
    imagesRef.current = {};
    baselineRef.current = null;
    loginBlinkPhaseRef.current = "waiting-closed";
    captureVersionRef.current = 0;
    blinkLandmarkerRef.current = null;
    blinkDetectionFailedRef.current = false;
    blinkTimestampRef.current = 0;
    manualStageRef.current = null;
    completedRef.current = false;
    stageRef.current = "front";
    setStage("front");

    if (!facePlusPlusCameraAvailable()) {
      setBlocked("insecure-origin");
      setPhase("failed");
      return false;
    }

    try {
      const permission = await navigator.permissions?.query({
        name: "camera" as PermissionName,
      });
      if (permission?.state === "denied") {
        setBlocked("permission-denied");
        setPhase("failed");
        return false;
      }
    } catch {
      // Some browsers do not expose camera permission state; getUserMedia below
      // remains the authoritative check.
    }

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });
      setPhase("camera");
      return true;
    } catch (error) {
      stopCamera();
      const problem = classifyCameraError(error);
      setBlocked(problem);
      setPhase("failed");
      setMessage(describeCameraProblem(problem).message);
      return false;
    }
  }, [stopCamera]);

  /*
   * The scan loop.
   *
   * Written as one function that reads the current stage and engine through
   * refs, so a re-render caused by a prompt change does not restart it with the
   * previous stage captured in a closure.
   */
  const startLoop = useCallback(() => {
    if (runningRef.current || completedRef.current) return;
    runningRef.current = true;
    totalStartedAtRef.current = Date.now();
    stageStartedAtRef.current = Date.now();
    stableRef.current = 0;

    const schedule = () => {
      if (!runningRef.current) return;
      timerRef.current = setTimeout(tick, tickIntervalMs);
    };

    const noteNoFace = (reason: string, text: string) => {
      stableRef.current = 0;
      setLiveState(null);
      if (stageRef.current !== "frontBlink") setHoldProgress(0);
      setMessage(reason === "too-dark" ? text : "No face yet — center your head inside the guide.");
    };

    const tick = async () => {
      if (!runningRef.current) return;

      const now = Date.now();
      if (workflow !== "login" && now - totalStartedAtRef.current >= TOTAL_TIMEOUT_MS) {
        stopLoop();
        setShowManual(true);
        setMessage(
          "This check is taking a while. Hold still and use the button below to capture the current frame."
        );
        return;
      }
      if (now - stageStartedAtRef.current >= STAGE_TIMEOUT_MS) {
        setShowManual(true);
      }

      const video = videoRef.current;
      // The camera can be open before it has produced a frame.
      if (!video || !video.videoWidth) {
        schedule();
        return;
      }

      const current = stageRef.current;
      const captureVersion = captureVersionRef.current;
      if (manualStageRef.current === current) {
        schedule();
        return;
      }
      if (
        workflow === "login" &&
        (current === "front" || current === "frontBlink") &&
        blinkDetectionFailedRef.current
      ) {
        schedule();
        return;
      }

      try {
        /*
         * Blink frames must stay frontal. Login uses eye measurements only to
         * time the closed and reopened captures; Face++ verifies those frames.
         */
        if (
          current === "closed" ||
          current === "open" ||
          current === "frontBlink" ||
          (workflow === "login" && current === "front")
        ) {
          const detected = await detectFaceFor(engineRef.current, video);
          if (
            !runningRef.current ||
            stageRef.current !== current ||
            captureVersionRef.current !== captureVersion ||
            manualStageRef.current === current
          ) {
            schedule();
            return;
          }
          if (!detected.ok) {
            noteNoFace(detected.reason, detected.message);
            schedule();
            return;
          }

          const state = capturePoseStateOfRead(detected, engineRef.current);
          setLiveState(state);
          if (state.pose !== "front") {
            stableRef.current = 0;
            if (current !== "frontBlink") setHoldProgress(0);
            setMessage(
              state.pose
                ? poseRefusal("front", state)
                : "Face the camera straight on for the blink."
            );
            schedule();
            return;
          }

          if (workflow === "login" && (current === "front" || current === "frontBlink")) {
            try {
              if (!blinkLandmarkerRef.current) {
                setMessage("Loading local blink detector…");
                blinkLandmarkerRef.current = await loadFaceLandmarker();
              }
              if (
                !runningRef.current ||
                stageRef.current !== current ||
                captureVersionRef.current !== captureVersion ||
                manualStageRef.current === current
              ) {
                schedule();
                return;
              }

              const timestamp = Math.max(performance.now(), blinkTimestampRef.current + 1);
              blinkTimestampRef.current = timestamp;
              const scores = readEyeBlinkScores(
                blinkLandmarkerRef.current,
                video,
                timestamp
              );
              if (!scores) {
                setShowManual(true);
                setMessage("Blink detector cannot see both eyes. Center your face or use the capture button.");
                schedule();
                return;
              }

              const eyeState = classifyEyeBlink(scores);
              if (current === "front") {
                if (eyeState === "open") {
                  setMessage(null);
                  acceptStage("front");
                } else {
                  setMessage("Face forward with both eyes open for the first photo.");
                }
              } else {
                captureLoginBlinkFrame(eyeState);
              }
            } catch (error) {
              console.error("MediaPipe blink detection could not run.", error);
              blinkDetectionFailedRef.current = true;
              setShowManual(true);
              setMessage(
                "Automatic blink detection is unavailable. Use the capture button for the eye-closed frame, then again with eyes open."
              );
            }
            schedule();
            return;
          }

          const aspect = await readEyeAspect(video).catch(() => null);
          if (
            !runningRef.current ||
            stageRef.current !== current ||
            captureVersionRef.current !== captureVersion ||
            manualStageRef.current === current
          ) {
            schedule();
            return;
          }
          if (aspect === null) {
            setShowManual(true);
            setMessage(
              current === "frontBlink"
                ? "Your eyes could not be measured automatically. Use the capture button for each blink frame."
                : "Your eyes could not be measured automatically. Blink, then use the button below."
            );
            schedule();
            return;
          }

          const baseline = baselineRef.current;
          const eyesClosed =
            baseline !== null ? aspect <= baseline * CLOSED_RATIO : aspect <= CLOSED_EAR;
          const eyesOpen =
            baseline !== null ? aspect >= baseline * OPEN_RATIO : aspect >= OPEN_EAR;

          if (current === "closed" ? eyesClosed : eyesOpen) {
            acceptStage(current);
            schedule();
            return;
          }

          setHoldProgress(0);
          setMessage(
            current === "closed" ? "Close both eyes now." : "Now open your eyes wide."
          );
          schedule();
          return;
        }

        // The three pose frames.
        const detected = await detectFaceFor(engineRef.current, video);
        if (
          !runningRef.current ||
          stageRef.current !== current ||
          captureVersionRef.current !== captureVersion ||
          manualStageRef.current === current
        ) {
          schedule();
          return;
        }
        if (!detected.ok) {
          noteNoFace(detected.reason, detected.message);
          schedule();
          return;
        }

        const state = capturePoseStateOfRead(detected, engineRef.current);
        setLiveState(state);

        if (state.pose !== current) {
          stableRef.current = 0;
          setHoldProgress(0);
          /*
           * Between straight on and turned is the normal path while someone is
           * still moving, so it is not worth a sentence. A settled wrong angle
           * is: `poseRefusal` says which way to correct.
           */
          setMessage(state.pose ? poseRefusal(current, state) : null);
          schedule();
          return;
        }

        setMessage(null);
        stableRef.current += 1;
        setHoldProgress(Math.min(1, stableRef.current / requiredStableReads));
        if (stableRef.current < requiredStableReads) {
          schedule();
          return;
        }

        stableRef.current = 0;

        /*
         * Measure the open-eye baseline at the moment the frontal frame is
         * taken, so it describes the same lighting and distance as the blink
         * that follows.
         */
        if (current === "front") {
          const aspect = await readEyeAspect(video).catch(() => null);
          if (
            !runningRef.current ||
            stageRef.current !== current ||
            captureVersionRef.current !== captureVersion ||
            manualStageRef.current === current
          ) {
            schedule();
            return;
          }
          if (aspect !== null && aspect < OPEN_EAR) {
            setMessage("Keep facing forward with your eyes open for the first photo.");
            schedule();
            return;
          }
          baselineRef.current = aspect;
        }

        acceptStage(current);
        schedule();
      } catch {
        setMessage("That frame could not be read. Move into better light and hold still.");
        schedule();
      }
    };

    void tick();
  }, [
    acceptStage,
    captureLoginBlinkFrame,
    requiredStableReads,
    stopLoop,
    tickIntervalMs,
    workflow,
  ]);

  // The loop starts once the camera phase renders and the video element exists.
  useEffect(() => {
    if (phase !== "camera") return;
    startLoop();
    return stopLoop;
  }, [phase, startLoop, stopLoop]);

  const reset = useCallback(() => {
    stopLoop();
    stopCamera();
    completedRef.current = false;
    imagesRef.current = {};
    baselineRef.current = null;
    loginBlinkPhaseRef.current = "waiting-closed";
    captureVersionRef.current = 0;
    manualStageRef.current = null;
    stageRef.current = "front";
    setStage("front");
    setMessage(null);
    setBlocked(null);
    setHoldProgress(0);
    setLiveState(null);
    setShowManual(false);
    setPhase("idle");
  }, [stopCamera, stopLoop]);

  return {
    phase,
    stage,
    message,
    blocked,
    videoRef,
    attachStream,
    start,
    capture,
    reset,
    stopCamera,
    holdProgress,
    liveState,
    showManual,
  };
}

/** Re-exported so callers can label the prompt order without importing face.ts. */
export type { FacePose };
