"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { POSE_COPY } from "@/lib/face";
import {
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";

type Phase = "starting" | "camera" | "checking" | "failed";
type CaptureStage = "front" | "left" | "right" | "closed" | "open";
type FaceImages = {
  front?: string;
  left?: string;
  right?: string;
  before?: string;
  closed?: string;
  after?: string;
};

type Props = {
  identifier: string;
  onSignedIn: (data: { user: unknown; session_conflict: boolean }) => void;
  onCancel: () => void;
};

const CAPTURE_EDGE = 256;

const CAPTURE_COPY: Record<CaptureStage, { prompt: string; button: string }> = {
  front: {
    prompt: POSE_COPY.front.instruction,
    button: "Capture straight-on frame",
  },
  left: {
    prompt: POSE_COPY.left.instruction,
    button: "Capture left-turn frame",
  },
  right: {
    prompt: POSE_COPY.right.instruction,
    button: "Capture right-turn frame",
  },
  closed: {
    prompt: "Close both eyes, then capture the closed-eye frame.",
    button: "Capture closed-eye frame",
  },
  open: {
    prompt: "Open both eyes, then capture the open-eye frame.",
    button: "Capture open-eye frame",
  },
};

export default function FaceSignIn({ identifier, onSignedIn, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);
  const [captureStage, setCaptureStage] = useState<CaptureStage>("front");
  const [facePlusPlusState, setFacePlusPlusState] = useState<
    "checking" | "configured" | "working" | "responsive" | "unavailable"
  >("checking");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const imagesRef = useRef<FaceImages>({});

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/face-login")
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

  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node || !streamRef.current) return;
    node.srcObject = streamRef.current;
    void node.play().catch(() => {});
  }, []);

  const cameraAvailable =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia;

  const permissionHelp = () => {
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return isIos
      ? "Open Settings, then Safari, then Camera for this website, and choose Allow."
      : "Open the browser menu, then Site settings, then Camera, and choose Allow.";
  };

  const startCamera = useCallback(async () => {
    setMessage(null);
    setBlocked(null);
    imagesRef.current = {};
    setCaptureStage("front");

    if (facePlusPlusState !== "configured" && facePlusPlusState !== "responsive") {
      setMessage("Face sign-in is unavailable right now. Use your password or badge, or ask an administrator for help.");
      return;
    }
    if (!cameraAvailable) {
      setBlocked("insecure-origin");
      return;
    }
    try {
      const permission = await navigator.permissions?.query({
        name: "camera" as PermissionName,
      });
      if (permission?.state === "denied") {
        setBlocked("permission-denied");
        return;
      }
    } catch {
      // Some browsers do not expose camera permission state; getUserMedia below
      // remains the authoritative check.
    }

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      setPhase("camera");
    } catch (error) {
      stopCamera();
      const problem = classifyCameraError(error);
      setBlocked(problem);
      setPhase("failed");
      setMessage(describeCameraProblem(problem).message);
    }
  }, [cameraAvailable, facePlusPlusState, stopCamera]);

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

  const submit = useCallback(
    async (images: FaceImages) => {
      if (
        !images.front ||
        !images.left ||
        !images.right ||
        !images.before ||
        !images.closed ||
        !images.after
      ) {
        setPhase("failed");
        setMessage("The scan is incomplete. Start again and capture each prompted frame.");
        stopCamera();
        return;
      }

      setPhase("checking");
      setFacePlusPlusState("working");
      try {
        const res = await fetch("/api/auth/face-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            identifier,
            face_images: {
              front: images.front,
              left: images.left,
              right: images.right,
            },
            blink_evidence: {
              before: images.before,
              closed: images.closed,
              after: images.after,
            },
          }),
        });
        const data = await res.json();
        if (res.ok) {
          setFacePlusPlusState("responsive");
          stopCamera();
          onSignedIn(data);
          return;
        }

        setPhase("failed");
        if (res.status === 503 || data.facePlusPlus?.status === "unavailable") {
          setFacePlusPlusState("unavailable");
        } else if (
          data.facePlusPlus?.status === "responded" ||
          data.facePlusPlus?.status === "passed"
        ) {
          setFacePlusPlusState("responsive");
        }
        setMessage(data.error || "We could not verify this scan. Try again.");
        stopCamera();
      } catch {
        setPhase("failed");
        setFacePlusPlusState("unavailable");
        setMessage("Could not reach the verification service. Check the connection and try again.");
        stopCamera();
      }
    },
    [identifier, onSignedIn, stopCamera]
  );

  const captureStep = useCallback(() => {
    const image = captureImage();
    if (!image) {
      setMessage("The camera frame is not ready. Wait a moment and capture again.");
      return;
    }
    setMessage(null);
    const next = { ...imagesRef.current };

    if (captureStage === "front") {
      next.front = image;
      next.before = image;
      setCaptureStage("left");
    } else if (captureStage === "left") {
      next.left = image;
      setCaptureStage("right");
    } else if (captureStage === "right") {
      next.right = image;
      setCaptureStage("closed");
    } else if (captureStage === "closed") {
      next.closed = image;
      setCaptureStage("open");
    } else {
      next.after = image;
      imagesRef.current = next;
      void submit(next);
      return;
    }
    imagesRef.current = next;
  }, [captureImage, captureStage, submit]);

  const working = phase === "checking";
  const statusText =
    facePlusPlusState === "configured"
      ? "Ready"
      : facePlusPlusState === "working"
        ? "Checking your face…"
        : facePlusPlusState === "responsive"
          ? "Ready"
        : facePlusPlusState === "checking"
          ? "Checking availability…"
          : "Unavailable — password or badge sign-in is still available.";

  return (
    <div className="space-y-3.5">
      <div
        role="status"
        aria-live="polite"
        className={`rounded-xl px-3.5 py-2.5 text-sm ${
          facePlusPlusState === "configured" || facePlusPlusState === "responsive"
            ? "bg-sage-50 text-sage-700"
            : facePlusPlusState === "working"
              ? "bg-cream-200 text-cocoa-700"
              : facePlusPlusState === "unavailable"
                ? "bg-terracotta-50 text-terracotta-700"
                : "bg-cream-100 text-cocoa-500"
        }`}
      >
        <span className="font-semibold">Face check:</span> {statusText}
      </div>

      <div className="relative mx-auto w-full max-w-xs overflow-hidden rounded-2xl bg-cocoa-900">
        {phase === "camera" && (
          <video
            ref={attachStream}
            playsInline
            muted
            autoPlay
            className="mx-auto block aspect-square w-full max-w-xs object-cover"
          />
        )}

        {phase === "camera" && (
          <div className="absolute inset-0 flex flex-col items-center justify-between bg-gradient-to-b from-cocoa-900/45 via-transparent to-cocoa-900/75 p-4 text-center text-cream-100">
            <p className="rounded-full bg-cocoa-900/70 px-3 py-1 text-xs font-semibold">
              {captureStage === "front"
                ? "Step 1 of 5 · straight on"
                : captureStage === "left"
                  ? "Step 2 of 5 · turn left"
                  : captureStage === "right"
                    ? "Step 3 of 5 · turn right"
                    : `Step ${captureStage === "closed" ? "4" : "5"} of 5 · blink · ${
                        captureStage === "closed" ? "close eyes" : "open eyes"
                      }`}
            </p>
            <div className="flex aspect-square w-[78%] items-center justify-center rounded-[42%] border-4 border-cream-100/80">
              <span className="sr-only">Position your head inside the guide</span>
            </div>
            <p className="rounded-xl bg-cocoa-900/75 px-3 py-2 text-sm font-medium">
              {CAPTURE_COPY[captureStage].prompt}
            </p>
          </div>
        )}

        {(phase === "starting" || working) && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 px-5 text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-cream-200 border-t-ochre-400" />
            {working && (
              <p className="text-sm text-cream-100">
                Checking your face…
              </p>
            )}
          </div>
        )}

        {(phase === "failed" || blocked) && (
          <div className="flex h-48 items-center justify-center px-6 text-center">
            <p className="text-sm text-cream-200/70">
              {blocked ? "Camera unavailable" : "The live scan has stopped."}
            </p>
          </div>
        )}
      </div>

      {phase === "camera" && (
        <button
          type="button"
          className="btn-primary w-full !py-2.5"
          onClick={captureStep}
        >
          {CAPTURE_COPY[captureStage].button}
        </button>
      )}

      {blocked && (
        <div className="rounded-xl bg-amber-50 px-3.5 py-3 text-sm text-cocoa-700">
          <p className="font-semibold">{describeCameraProblem(blocked).message}</p>
          <p className="mt-1">
            {blocked === "permission-denied"
              ? permissionHelp()
              : describeCameraProblem(blocked).help}
          </p>
        </div>
      )}

      {message && !blocked && (
        <div role="alert" className="rounded-xl bg-terracotta-50 px-3.5 py-3 text-sm text-terracotta-700">
          {message}
        </div>
      )}

      {phase !== "camera" && (
        <button
          type="button"
          className="btn-primary w-full !py-2.5"
          disabled={
            phase === "starting" ||
            working ||
            (facePlusPlusState !== "configured" && facePlusPlusState !== "responsive")
          }
          onClick={() => void startCamera()}
        >
          {facePlusPlusState === "checking"
            ? "Checking availability…"
            : facePlusPlusState === "configured" || facePlusPlusState === "responsive"
              ? "Start face check"
              : "Face check unavailable"}
        </button>
      )}

      <button
        type="button"
        className="w-full text-center text-xs text-cocoa-400 underline"
        onClick={() => {
          stopCamera();
          onCancel();
        }}
      >
        Use my password instead
      </button>
    </div>
  );
}
