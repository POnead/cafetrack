"use client";

import { Modal } from "@/components/ui";
import { FaceCheckResult } from "@/components/FaceCheckResult";
import FaceGuideFrame from "@/components/FaceGuideFrame";
import { hintFor, targetBand } from "@/lib/face-guide";

/**
 * Password-confirmation step for staff sign-in.
 *
 * The live frames go to Face++ and nowhere else. Detect checks the face and head
 * pose, Analyze verifies the open → closed → open blink, and Compare matches the
 * straight-on frame against the photo enrolled on this account.
 *
 * The café's own pose gate triggers the straight-on and side frames. The browser
 * captures closed and reopened eyes during the blink; Face++ Analyze verifies
 * the evidence and Compare checks identity.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraOriginProblem,
  classifyCameraError,
  describeCameraProblem,
} from "@/lib/face-diagnostics";
import {
  FACEPP_LOGIN_CAPTURE_COPY,
  facePlusPlusCameraAvailable,
  facePlusPlusPermissionHelp,
  useFacePlusPlusCapture,
  type FacePlusPlusImages,
} from "@/lib/use-facepp-capture";
import {
  FACEPP_LOGIN_SIDE_MIN_YAW,
  isFacePlusPlusLoginSidePoseReady,
} from "@/lib/facepp-capture-policy";

/**
 * This screen collects straight-on, left and right frames plus a blink, then
 * hands them to Face++ for the identity decision.
 */
type Props = {
  /** The ticket from step one. Single use, five minutes, and not a session. */
  ticket: string;
  /** The account's display name, so the greeting is a name rather than a title. */
  fullName?: string;
  /** Called after the enrolled face matches and the session cookie exists. */
  onVerified: (matchedBy: "face", sessionConflict?: boolean) => void;
  /** Back to the password step, e.g. the ticket expired. */
  onBack: () => void;
};

type FacePlusPlusStep = "passed" | "failed" | "unavailable" | "not_run";

type FacePlusPlusSteps = {
  detect: FacePlusPlusStep;
  pose: FacePlusPlusStep;
  blink: FacePlusPlusStep;
  compare: FacePlusPlusStep;
  poseChecks?: {
    front: boolean;
    left: boolean;
    right: boolean;
    blinkBefore: boolean;
    blinkClosed: boolean;
    blinkAfter: boolean;
  };
};

function readFacePlusPlusSteps(data: unknown): FacePlusPlusSteps | null {
  if (!data || typeof data !== "object") return null;
  const facePlusPlus = (data as Record<string, unknown>).facePlusPlus;
  if (!facePlusPlus || typeof facePlusPlus !== "object") return null;
  const steps = (facePlusPlus as Record<string, unknown>).steps;
  if (!steps || typeof steps !== "object") return null;

  const values = steps as Record<string, unknown>;
  const poseChecksValue = (facePlusPlus as Record<string, unknown>).poseChecks;
  let poseChecks: FacePlusPlusSteps["poseChecks"];
  if (poseChecksValue && typeof poseChecksValue === "object") {
    const checks = poseChecksValue as Record<string, unknown>;
    if (
      typeof checks.front === "boolean" &&
      typeof checks.left === "boolean" &&
      typeof checks.right === "boolean" &&
      typeof checks.blinkBefore === "boolean" &&
      typeof checks.blinkClosed === "boolean" &&
      typeof checks.blinkAfter === "boolean"
    ) {
      poseChecks = {
        front: checks.front,
        left: checks.left,
        right: checks.right,
        blinkBefore: checks.blinkBefore,
        blinkClosed: checks.blinkClosed,
        blinkAfter: checks.blinkAfter,
      };
    }
  }
  const isStep = (value: unknown): value is FacePlusPlusStep =>
    value === "passed" ||
    value === "failed" ||
    value === "unavailable" ||
    value === "not_run";
  if (
    !isStep(values.detect) ||
    !isStep(values.pose) ||
    !isStep(values.blink) ||
    !isStep(values.compare)
  ) {
    return null;
  }

  return {
    detect: values.detect,
    pose: values.pose,
    blink: values.blink,
    compare: values.compare,
    poseChecks,
  };
}

function verificationStepLabel(value: FacePlusPlusStep): string {
  switch (value) {
    case "passed":
      return "Passed";
    case "failed":
      return "Not verified";
    case "unavailable":
      return "Unavailable";
    case "not_run":
      return "Not checked";
  }
}

export default function StaffCheck({ ticket, fullName, onVerified, onBack }: Props) {
  const checkPanelRef = useRef<HTMLDivElement>(null);
  const requestVideoRef = useRef<HTMLVideoElement | null>(null);
  const requestStreamRef = useRef<MediaStream | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verificationResult, setVerificationResult] = useState<
    "checking" | "passed" | "failed" | null
  >(null);
  const [verifiedSessionConflict, setVerifiedSessionConflict] = useState(false);
  const [verificationSteps, setVerificationSteps] = useState<FacePlusPlusSteps | null>(
    null
  );
  const [ticketExpired, setTicketExpired] = useState(false);
  const [facePlusPlusState, setFacePlusPlusState] = useState<
    "checking" | "configured" | "unavailable"
  >("checking");
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestReason, setRequestReason] = useState("");
  const [requestConsent, setRequestConsent] = useState(false);
  const [requestCameraLive, setRequestCameraLive] = useState(false);
  const [requestCountdown, setRequestCountdown] = useState<number | null>(null);
  const [requestPhoto, setRequestPhoto] = useState<string | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestSent, setRequestSent] = useState(false);
  /*
   * State is not enough to stop a double submit: two clicks dispatched before a
   * re-render both read `busy` as false. The ref is updated synchronously, so the
   * second one sees the first one already in flight.
   */
  const busyRef = useRef(false);

  useEffect(() => {
    if (verificationResult !== "passed") return;
    const timer = window.setTimeout(
      () => onVerified("face", verifiedSessionConflict),
      1400
    );
    return () => window.clearTimeout(timer);
  }, [onVerified, verificationResult, verifiedSessionConflict]);

  const stopRequestCamera = useCallback(() => {
    requestStreamRef.current?.getTracks().forEach((track) => track.stop());
    requestStreamRef.current = null;
    if (requestVideoRef.current) requestVideoRef.current.srcObject = null;
    setRequestCameraLive(false);
    setRequestCountdown(null);
  }, []);

  const attachRequestStream = useCallback((node: HTMLVideoElement | null) => {
    requestVideoRef.current = node;
    if (!node || !requestStreamRef.current) return;
    if (node.srcObject !== requestStreamRef.current) {
      node.srcObject = requestStreamRef.current;
    }
  }, []);

  const onRequestCameraPlaying = useCallback(() => {
    setRequestCountdown((countdown) => countdown ?? 3);
  }, []);

  useEffect(
    () => () => {
      requestStreamRef.current?.getTracks().forEach((track) => track.stop());
      requestStreamRef.current = null;
    },
    []
  );

  const openRequest = useCallback(() => {
    setRequestReason("");
    setRequestConsent(false);
    setRequestPhoto(null);
    setRequestError(null);
    setRequestOpen(true);
  }, []);

  const closeRequest = useCallback(() => {
    if (requestBusy) return;
    setRequestOpen(false);
    setRequestPhoto(null);
    stopRequestCamera();
  }, [requestBusy, stopRequestCamera]);

  const startRequestCamera = useCallback(async () => {
    setRequestError(null);
    if (!facePlusPlusCameraAvailable()) {
      const diagnosis = describeCameraProblem(cameraOriginProblem() ?? "no-camera-api");
      setRequestError(
        [diagnosis.message, diagnosis.help].filter(Boolean).join(" ")
      );
      return;
    }
    try {
      requestStreamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      setRequestCountdown(null);
      setRequestCameraLive(true);
    } catch (error) {
      const problem = classifyCameraError(error);
      const diagnosis = describeCameraProblem(problem);
      setRequestError(
        problem === "permission-denied"
          ? facePlusPlusPermissionHelp()
          : [diagnosis.message, diagnosis.help].filter(Boolean).join(" ")
      );
    }
  }, []);

  const captureRequestPhoto = useCallback(() => {
    const video = requestVideoRef.current;
    if (!video?.videoWidth || !video.videoHeight) {
      setRequestError("The camera is not ready yet. Wait for the preview and try again.");
      return;
    }

    let photo: string | null = null;
    for (const edge of [720, 540, 400]) {
      const scale = Math.min(1, edge / video.videoWidth);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        setRequestError("Could not prepare the photo. Please try again.");
        return;
      }

      context.drawImage(video, 0, 0, width, height);
      const encoded = canvas.toDataURL("image/jpeg", 0.68);
      if (encoded.length <= 400_000) {
        photo = encoded;
        break;
      }
    }

    if (!photo) {
      setRequestError("The photo is too large to send. Move closer and retake it.");
      return;
    }
    setRequestPhoto(photo);
    setRequestError(null);
    stopRequestCamera();
  }, [stopRequestCamera]);

  useEffect(() => {
    if (!requestCameraLive || requestCountdown === null) return;
    if (requestCountdown === 0) {
      captureRequestPhoto();
      return;
    }

    const timer = window.setTimeout(
      () => setRequestCountdown((countdown) =>
        countdown === null ? null : Math.max(0, countdown - 1)
      ),
      1000
    );
    return () => window.clearTimeout(timer);
  }, [captureRequestPhoto, requestCameraLive, requestCountdown]);

  const submitBypassRequest = useCallback(async () => {
    if (!requestPhoto || !requestConsent || requestReason.trim().length < 5) return;
    setRequestBusy(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/auth/staff/duty-bypass", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket,
          reason: requestReason.trim(),
          photo_data: requestPhoto,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.expired) setTicketExpired(true);
        throw new Error(data.error || "Could not send your request.");
      }

      setRequestSent(true);
      setRequestOpen(false);
      setRequestPhoto(null);
      stopRequestCamera();
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Could not send your request."
      );
    } finally {
      setRequestBusy(false);
    }
  }, [requestConsent, requestPhoto, requestReason, stopRequestCamera, ticket]);

  /**
   * Ask the server whether this sign-in still needs a face.
   *
   * The ticket is issued at the password step, and the manager's one-duty
   * override can be granted after this panel has already been drawn. Without
   * asking again the person is left in front of a camera for a check that has
   * just been waived — the waiver exists, but only on the next password
   * sign-in. See the preflight branch in api/auth/staff/confirm.
   *
   * Called once on mount and again from `start`, because the waiver can land in
   * either gap. Concurrent callers share one request, so a click while the
   * mount-time check is still running waits for it instead of opening a camera
   * beside it. Returns true when a session was minted and `onVerified` was
   * called.
   */
  const preflightRef = useRef<Promise<boolean> | null>(null);
  const checkDutyWindow = useCallback(async () => {
    if (preflightRef.current) return preflightRef.current;

    const attempt = (async () => {
      try {
        const res = await fetch("/api/auth/staff/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket, preflight: true }),
        });
        const data = await res.json();

        if (!res.ok) {
          if (data.expired) setTicketExpired(true);
          else setMessage(data.error || "Could not check this sign-in. Try again.");
          return false;
        }

        if (data.user) {
          onVerified("face", Boolean(data.session_conflict));
          return true;
        }

        return false;
      } catch {
        /*
         * Silent. The camera path reports a real connection problem when the
         * person actually tries, and a check that cannot reach the server must
         * never be the reason someone cannot reach the camera.
         */
        return false;
      }
    })();

    preflightRef.current = attempt;
    try {
      return await attempt;
    } finally {
      preflightRef.current = null;
    }
  }, [onVerified, ticket]);

  /*
   * One preflight when the panel appears. Another when the button is pressed
   * (in `start`), so an override granted while this card sits on screen is
   * picked up at the moment the person acts on it.
   */
  const preflightOnMountRef = useRef(false);
  useEffect(() => {
    if (preflightOnMountRef.current) return;
    preflightOnMountRef.current = true;
    void checkDutyWindow();
  }, [checkDutyWindow]);

  /**
   * Send the captured frames to Face++. Detect, pose, blink and Compare all run
   * there; the server does not compute a local descriptor for this path.
   */
  const submitFrames = useCallback(
    async (images: FacePlusPlusImages) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setVerificationResult("checking");
      setVerificationSteps(null);
      setMessage("Checking your face…");

      try {
        const res = await fetch("/api/auth/staff/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket,
            face_images: {
              front: images.front,
              left: images.left,
              right: images.right,
            },
            blink_evidence: {
              before: images.before,
              closed: images.closed,
              after: images.after,
              closedAgain: images.closedAgain,
              afterAgain: images.afterAgain,
            },
          }),
        });

        const data = await res.json();
        const steps = readFacePlusPlusSteps(data);
        setVerificationSteps(steps);

        if (!res.ok) {
          setVerificationResult("failed");
          const failedPoses = steps?.poseChecks
            ? ([
                ["front", steps.poseChecks.front, "Face the camera straight on and hold still."],
                ["left", steps.poseChecks.left, "Turn your head farther to your left and hold still."],
                ["right", steps.poseChecks.right, "Turn your head farther to your right and hold still."],
              ] as const)
                .filter(([, passed]) => !passed)
                .map(([, , instruction]) => instruction)
            : [];
          setMessage(
            failedPoses.length > 0
              ? `${steps?.compare === "passed" ? "Face++ matched your face, but the head pose was not verified." : "The head pose was not verified."} ${failedPoses.join(" ")} Scan again and follow the pose guide.`
              : data.error || "That face did not match. Try again."
          );
          if (data.expired) setTicketExpired(true);
          return;
        }

        setVerifiedSessionConflict(Boolean(data.session_conflict));
        setVerificationResult("passed");
      } catch {
        setVerificationSteps(null);
        setVerificationResult("failed");
        setMessage("Something went wrong reading the camera. Try again.");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [ticket]
  );

  const capture = useFacePlusPlusCapture({ onComplete: submitFrames, workflow: "login" });
  const resetCapture = capture.reset;
  const cancelFaceCheck = useCallback(() => {
    resetCapture();
    stopRequestCamera();
    setMessage(null);
    setVerificationSteps(null);
    setVerificationResult(null);
  }, [resetCapture, stopRequestCamera]);

  /*
   * Ask Face++ whether the server is configured before offering a camera. The
   * GET is public and returns one boolean, so the login page can say "not
   * available" instead of opening a camera that cannot finish.
   */
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/face-login", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not check Face++ status");
        if (!cancelled) {
          setFacePlusPlusState(data.facePlusPlusConfigured ? "configured" : "unavailable");
        }
      })
      .catch(() => {
        if (!cancelled) setFacePlusPlusState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    setMessage(null);
    setVerificationSteps(null);
    setVerificationResult(null);

    // A waiver may have been granted since this panel mounted. Ask before the
    // camera light comes on, not after a face has already failed to match.
    if (await checkDutyWindow()) return;

    if (facePlusPlusState !== "configured") {
      setMessage(
        "Face check is unavailable right now. Use your password or ask an administrator for help."
      );
      return;
    }

    if (await capture.start()) setMessage(null);
  }, [capture, checkDutyWindow, facePlusPlusState]);

  const problem = capture.blocked ? describeCameraProblem(capture.blocked) : null;
  const captureCopy = FACEPP_LOGIN_CAPTURE_COPY[capture.stage];
  const activePose =
    capture.stage === "left" ? "left" : capture.stage === "right" ? "right" : "front";
  const isBlinkStage = capture.stage === "frontBlink";
  const poseBand = targetBand(activePose);
  const bands: [number, number][] = [
    capture.stage === "left"
      ? [FACEPP_LOGIN_SIDE_MIN_YAW, poseBand[1]]
      : capture.stage === "right"
        ? [poseBand[0], -FACEPP_LOGIN_SIDE_MIN_YAW]
        : poseBand,
  ];
  const poseReady =
    capture.liveState?.pose === activePose &&
    (capture.stage !== "left" && capture.stage !== "right" ||
      isFacePlusPlusLoginSidePoseReady(capture.stage, capture.liveState));
  const hint = isBlinkStage
    ? capture.message ??
      "Blink twice while facing forward: close and open your eyes two times."
    : hintFor(activePose, capture.liveState, capture.holdProgress, capture.message, false);
  const canReturnToPassword =
    capture.phase === "idle" && verificationResult === null;
  const yaw =
    capture.liveState && Number.isFinite(capture.liveState.yaw)
      ? capture.liveState.yaw
      : null;

  useEffect(() => {
    if (capture.phase !== "camera" || window.matchMedia("(min-width: 1024px)").matches) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      checkPanelRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [capture.phase]);

  return (
    <div
      ref={checkPanelRef}
      className={capture.phase === "camera" ? "space-y-2" : "space-y-5"}
      style={{ scrollMarginTop: "1rem" }}
    >
      <div
        className={`rounded-2xl border border-cream-200 bg-cream-50 ${
          capture.phase === "camera" ? "px-3 py-2" : "px-4 py-4 sm:px-5"
        }`}
      >
        <h2 className={`font-semibold text-cocoa-800 ${capture.phase === "camera" ? "text-lg" : "text-xl"}`}>
          {fullName ? `Hello ${fullName.split(" ")[0]}` : "One more thing"}
        </h2>
        <p className={`text-cocoa-600 ${capture.phase === "camera" ? "mt-0.5 text-xs" : "mt-2 text-sm leading-relaxed"}`}>
          Your password is right. Complete the face check to continue.
        </p>
      </div>

      {ticketExpired ? (
        <div className="space-y-3 rounded-2xl border border-cream-200 bg-white p-4 sm:p-5">
          <p role="status" className="text-sm leading-relaxed text-cocoa-600">
            {message || "That sign-in attempt has expired. Enter your password again."}
          </p>
          <button
            type="button"
            onClick={onBack}
            className="w-full rounded-xl bg-cream-400 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300"
          >
            Return to password
          </button>
        </div>
      ) : capture.phase === "camera" ? (
        <div className="space-y-2 rounded-2xl border border-cream-200 bg-white p-2 sm:p-3">
          <div className="overflow-hidden rounded-xl bg-cocoa-900 p-1.5">
            <div className="relative mx-auto h-[min(40dvh,22rem)] w-full max-w-[16rem] overflow-hidden rounded-lg">
              {/* The preview is mirrored (.face-preview-mirror) so it reads like a
                  mirror; the captured frames stay in the raw feed's orientation. */}
              <video
                ref={capture.attachStream}
                playsInline
                muted
                autoPlay
                className="absolute inset-0 h-full w-full object-cover face-preview-mirror"
              />
              <FaceGuideFrame
                label={captureCopy.label}
                viewLabel={captureCopy.viewLabel}
                title={captureCopy.prompt}
                hint={hint}
                inBand={poseReady}
                holdProgress={capture.holdProgress}
                showHoldProgress={!isBlinkStage}
                bands={bands}
                yaw={yaw}
              />
            </div>
          </div>
          {(isBlinkStage || capture.blinkCount > 0) && (
            <div
              role="status"
              aria-live="polite"
              aria-label={`${capture.blinkCount} of 2 blinks detected`}
              className="flex items-center justify-center gap-3 rounded-xl border border-cream-200 bg-cream-50 px-3 py-2 text-sm font-semibold text-cocoa-700"
            >
              <span>Blinks detected</span>
              <span className="flex items-center gap-1.5" aria-hidden="true">
                {[1, 2].map((blink) => (
                  <span
                    key={blink}
                    className={`grid h-6 w-6 place-items-center rounded-full border text-xs transition-colors ${
                      capture.blinkCount >= blink
                        ? "border-sage-600 bg-sage-600 text-white"
                        : "border-cocoa-300 bg-white text-cocoa-400"
                    }`}
                  >
                    {blink}
                  </span>
                ))}
              </span>
              <span className="text-cocoa-500">{capture.blinkCount}/2</span>
            </div>
          )}
          <FaceGuideFrame
            display="instructions"
            label={captureCopy.label}
            viewLabel={captureCopy.viewLabel}
            title={captureCopy.prompt}
            hint={hint}
            inBand={poseReady}
            holdProgress={capture.holdProgress}
            showHoldProgress={!isBlinkStage}
            bands={bands}
            yaw={yaw}
          />

          <button
            type="button"
            onClick={cancelFaceCheck}
            disabled={busy || requestBusy}
            className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-cream-200 bg-cream-50 px-4 py-2 text-sm font-semibold text-cocoa-600 transition hover:border-cream-300 hover:bg-cream-100 hover:text-cocoa-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M19 12H5m0 0 6 6m-6-6 6-6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Restart face check
          </button>
        </div>
      ) : (
        <div className="space-y-4 rounded-2xl border border-cream-200 bg-white p-4 sm:p-5">
          {(verificationResult || verificationSteps) && (
            <section className="space-y-3">
              {verificationResult && (
                <FaceCheckResult
                  status={verificationResult}
                  title={
                    verificationResult === "passed"
                      ? "Face verified"
                      : verificationResult === "failed"
                        ? "Face not accepted"
                        : "Checking your face…"
                  }
                  message={
                    verificationResult === "passed"
                      ? "Verified. Continuing to your account…"
                      : verificationResult === "failed"
                        ? message || "Verification failed. You are not signed in."
                        : "Please wait while we check your face."
                  }
                />
              )}
              {verificationSteps ? (
                <ul className="space-y-1.5 rounded-xl border border-cream-200 bg-cream-50 px-4 py-3.5 text-xs text-cocoa-700">
                  <li>Face detection: {verificationStepLabel(verificationSteps.detect)}</li>
                  <li>Head poses: {verificationStepLabel(verificationSteps.pose)}</li>
                  {verificationSteps.poseChecks && (
                    <li>
                      Pose frames:{" "}
                      {[
                        { label: "front", passed: verificationSteps.poseChecks.front },
                        { label: "left", passed: verificationSteps.poseChecks.left },
                        { label: "right", passed: verificationSteps.poseChecks.right },
                        {
                          label: "blink",
                          passed:
                            verificationSteps.poseChecks.blinkBefore &&
                            verificationSteps.poseChecks.blinkClosed &&
                            verificationSteps.poseChecks.blinkAfter,
                        },
                      ]
                        .map(({ label, passed }) => `${label}: ${passed ? "passed" : "retake"}`)
                        .join(" · ")}
                    </li>
                  )}
                  <li>Double-blink check: {verificationStepLabel(verificationSteps.blink)}</li>
                  <li>Face match: {verificationStepLabel(verificationSteps.compare)}</li>
                </ul>
              ) : null}
            </section>
          )}

          <button
            type="button"
            onClick={() => void start()}
            disabled={
              busy ||
              verificationResult === "passed" ||
              facePlusPlusState === "checking"
            }
            className="w-full min-h-12 rounded-xl bg-cream-400 px-4 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300 disabled:opacity-60"
          >
            {busy
              ? "Checking your face…"
              : verificationResult === "passed"
                ? "Face verified"
                : facePlusPlusState === "checking"
                  ? "Checking availability…"
                  : "Start face check"}
          </button>

          {problem && (
            <div
              role="status"
              className="space-y-2 rounded-xl border border-terracotta-100 bg-terracotta-50 px-4 py-3.5 text-sm leading-relaxed text-terracotta-700"
            >
              <p className="font-semibold">{problem.message}</p>
              <p>
                {capture.blocked === "permission-denied"
                  ? facePlusPlusPermissionHelp()
                  : capture.blocked === "device-busy"
                    ? "Reload this page to release any previous face-check request. If the camera is still busy after reloading, another app or browser tab is holding it; close that app and try again."
                    : problem.help}
              </p>
              {problem.retryable && (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={busy}
                  className="rounded-lg border border-terracotta-200 bg-white px-3 py-2 text-xs font-semibold text-terracotta-800 transition hover:bg-terracotta-50 disabled:opacity-60"
                >
                  Check camera access again
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={canReturnToPassword ? onBack : cancelFaceCheck}
            disabled={busy || verificationResult === "passed" || requestBusy}
            className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-cream-200 bg-cream-50 px-4 py-2 text-sm font-semibold text-cocoa-600 transition hover:border-cream-300 hover:bg-cream-100 hover:text-cocoa-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M19 12H5m0 0 6 6m-6-6 6-6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {canReturnToPassword ? "Back to password sign-in" : "Restart face check"}
          </button>
        </div>
      )}

      {!ticketExpired && !requestSent && (
        <div className={`border-t border-cream-200 ${capture.phase === "camera" ? "pt-1" : "pt-3"}`}>
          <button
            type="button"
            onClick={() => {
              capture.reset();
              openRequest();
            }}
            disabled={busy}
            className={`w-full rounded-xl text-sm font-medium text-cocoa-500 transition hover:bg-cream-50 hover:text-cocoa-700 disabled:opacity-50 ${
              capture.phase === "camera" ? "px-3 py-1.5 text-xs" : "px-3 py-2.5"
            }`}
          >
            Can&apos;t verify face? Contact admin
          </button>
        </div>
      )}

      {requestSent && (
        <div
          role="status"
          className="rounded-2xl border border-ochre-200 bg-ochre-50 px-4 py-3 text-sm leading-relaxed text-cocoa-700"
        >
          Your request and photo were sent to an administrator. You can try the
          face check again; an approval will allow access only until the end of
          today.
        </div>
      )}

      {/*
        The server's refusal belongs under the camera, where the person is still
        looking for the reason a frame was not accepted.
      */}
      {!ticketExpired && !problem && message && !verificationResult && (
        <p role="status" className="text-center text-xs leading-relaxed text-cocoa-500">
          {message}
        </p>
      )}

      <Modal
        open={requestOpen}
        onClose={closeRequest}
        title="Ask an admin to review your face-check request"
        width="max-w-md"
        scrollable
      >
        <div className="space-y-4">
          <p className="rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3 text-xs leading-relaxed text-cocoa-600">
            Explain why you cannot complete the face check. To help the admin
            identify you, take a photo using the camera below. The photo and
            reason will be shared with authorized admins and the photo will be
            deleted after they decide.
          </p>

          <div>
            <label className="label" htmlFor="duty-bypass-reason">
              Reason
            </label>
            <textarea
              id="duty-bypass-reason"
              className="input min-h-[88px] resize-y"
              maxLength={500}
              value={requestReason}
              onChange={(event) => setRequestReason(event.target.value)}
              placeholder="Tell the admin why you cannot verify your face"
            />
          </div>

          {requestCameraLive ? (
            <div className="space-y-2">
              <div className="relative mx-auto w-full max-w-xs">
                {/* Mirrored for the same reason as the check preview above. */}
                <video
                  ref={attachRequestStream}
                  autoPlay
                  playsInline
                  muted
                  onPlaying={onRequestCameraPlaying}
                  className="aspect-[4/5] max-h-[45vh] w-full rounded-xl bg-cocoa-800 object-cover face-preview-mirror"
                />
                {requestCountdown === null ? (
                  <div
                    className="absolute inset-0 flex items-center justify-center rounded-xl bg-cocoa-900/35 text-sm font-medium text-white"
                    role="status"
                  >
                    Starting camera…
                  </div>
                ) : (
                  <div
                    className="absolute inset-0 flex items-center justify-center rounded-xl bg-cocoa-900/25"
                    aria-live="assertive"
                    aria-atomic="true"
                  >
                    <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white/90 text-4xl font-bold tabular-nums text-cocoa-900 shadow-lg">
                      {requestCountdown === 0 ? "●" : requestCountdown}
                    </span>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn-primary w-full"
                onClick={captureRequestPhoto}
              >
                Capture now
              </button>
            </div>
          ) : requestPhoto ? (
            <div className="space-y-2">
              <p
                role="status"
                className="rounded-xl border border-cream-200 bg-cream-50 px-3 py-3 text-center text-sm text-cocoa-600"
              >
                Photo captured. It will only be shown to an authorized admin
                after you send your request.
              </p>
              <button
                type="button"
                className="btn-ghost w-full"
                onClick={() => {
                  setRequestPhoto(null);
                  void startRequestCamera();
                }}
              >
                Retake photo
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                className="btn-ghost w-full"
                onClick={() => void startRequestCamera()}
              >
                Open camera
              </button>
            </div>
          )}

          <label className="flex items-start gap-2 text-xs leading-relaxed text-cocoa-600">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={requestConsent}
              onChange={(event) => setRequestConsent(event.target.checked)}
            />
            <span>
              I understand the photo and reason will be shown to authorized
              admins for this decision, and the photo will be deleted after
              review.
            </span>
          </label>

          {requestError && (
            <p role="alert" className="rounded-xl bg-terracotta-50 px-3 py-2 text-sm text-terracotta-700">
              {requestError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost"
              onClick={closeRequest}
              disabled={requestBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void submitBypassRequest()}
              disabled={
                requestBusy ||
                !requestPhoto ||
                !requestConsent ||
                requestReason.trim().length < 5
              }
            >
              {requestBusy ? "Sending..." : "Send to admin"}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
