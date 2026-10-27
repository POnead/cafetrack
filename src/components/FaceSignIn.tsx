"use client";

/**
 * Sign in with a face, after your badge.
 *
 * Used by the login page once someone has typed or scanned their identifier.
 * The camera is asked for here and nowhere else — never on page load — because
 * the permission prompt is the single most disruptive thing this app does to a
 * person standing at a till, and it must be a response to them choosing it.
 *
 * Deliberately *not* a reuse of `FaceCapture`. That component is built for an
 * admin enrolling a colleague: it explains that the photo will be stored, shows
 * what was accepted, and talks about saving. None of that is true here — this
 * photo is never uploaded, only 128 floats are sent, and nothing is kept. The
 * matching itself is shared (lib/face.ts) and the camera problems are shared
 * (lib/face-diagnostics.ts); the wording is not, because the two situations are
 * genuinely different.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailable,
  cameraPermissionState,
  openCamera,
  permissionHelp,
} from "@/lib/face-client";
import { FACE_POSES, POSE_COPY } from "@/lib/face";
import { framesBody, useFacePoses } from "@/lib/use-face-poses";
import { useAutoFaceCapture } from "@/lib/use-auto-face-capture";
import FaceScanOverlay from "@/components/FaceScanOverlay";
import FaceCaptureGuide from "@/components/FaceCaptureGuide";
import {
  classifyCameraError,
  describeCameraProblem,
  probeCamera,
  type CameraProblem,
} from "@/lib/face-diagnostics";

type Phase =
  | "starting"
  | "checking-models"
  | "loading-models"
  | "camera"
  | "reading"
  | "checking"
  | "failed";

type Props = {
  /** The barcode or username the person typed. Who we are looking for. */
  identifier: string;
  /** Called with the sign-in response once the server has minted a session. */
  onSignedIn: (data: { user: unknown; session_conflict: boolean }) => void;
  onCancel: () => void;
};

export default function FaceSignIn({ identifier, onSignedIn, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotRef = useRef<HTMLImageElement | null>(null);
  const [modelsPresent, setModelsPresent] = useState<boolean | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  /**
   * Attach the stream to the video element the moment it exists.
   *
   * A callback ref rather than `videoRef.current = ...` in the open routine,
   * because the element is rendered conditionally and the two used to race:
   * the open routine ran, found `videoRef.current` still null (the `<video>` is
   * only mounted once the phase becomes "camera", which happened *after* the
   * attach), and silently skipped it. The camera was genuinely open — the
   * privacy light came on and the stream was running — with nothing assigned to
   * the element, so the screen stayed black and it read as "the camera does not
   * work" rather than as a bug.
   *
   * Assigning on mount means the order of the two things no longer matters.
   */
  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    const stream = streamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  /* Are the recognition weights installed? Checked before anyone is asked to
     point a camera at themselves, because discovering a missing 6.7MB download
     halfway through a capture is after they have already committed to it. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lib = await import("@/lib/face-client");
      const present = await lib.modelsPresent();
      if (!cancelled) setModelsPresent(present);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Warm the model up, then open the camera — in that order.
   *
   * The order matters and was previously the other way round here. `readFace`
   * needs the recognition weights, so opening the camera first means the person
   * holds still in front of a live preview for the length of a ~7MB download and
   * then presses the button, only to wait through the same download again. Face
   * enrolment already loads first; this now matches it.
   */
  const warmUp = useCallback(async (): Promise<boolean> => {
    setPhase("loading-models");
    setMessage(null);
    setProgress({ loaded: 0, total: 6_700_000 });
    try {
      const lib = await import("@/lib/face-client");
      await lib.loadFaceModels((loaded, total) => {
        if (total > 0) setProgress({ loaded, total });
      });
      return true;
    } catch (e: any) {
      setBlocked("models-missing");
      setMessage(
        "The face model could not be downloaded. Check the connection and try again."
      );
      console.error("face model load failed:", e);
      return false;
    }
  }, []);

  const startCamera = useCallback(async () => {
    setMessage(null);
    setBlocked(null);

    if (!cameraAvailable()) {
      setBlocked("insecure-origin");
      return;
    }

    if ((await cameraPermissionState()) === "denied") {
      setBlocked("permission-denied");
      return;
    }

    if (!(await warmUp())) return;

    try {
      const stream = await openCamera();
      streamRef.current = stream;
      // The phase change mounts the <video>; attachStream runs on that mount and
      // picks the stream up. No ordering assumption either way.
      setPhase("camera");
      attachStream(videoRef.current);
    } catch (e) {
      stopCamera();
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setPhase("failed");
      setMessage(describeCameraProblem(problem).message);
    }
  }, [warmUp, attachStream, stopCamera]);

  /** Send the presentation up and let the server decide. */
  const submit = useCallback(
    async (frames: Parameters<typeof framesBody>[0]) => {
      setPhase("checking");
      try {
        const res = await fetch("/api/auth/face-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The whole presentation: one frame per angle. See framesBody.
          body: JSON.stringify({ identifier, ...framesBody(frames) }),
        });
        const data = await res.json();

        if (res.ok) {
          stopCamera();
          onSignedIn(data);
          return;
        }

        setPhase("failed");
        setMessage(data.error || "That did not match. Try again.");
        // The preview is hidden in the failed state, so leaving the stream open
        // would keep the privacy light on with nothing on screen. "Take a
        // picture" opens a fresh one.
        stopCamera();
      } catch {
        setPhase("failed");
        setMessage("Could not reach the server. Check the connection and try again.");
        stopCamera();
      }
    },
    [identifier, onSignedIn, stopCamera]
  );

  /*
   * The three-angle sequence. A check asks for straight on, then the person's
   * left, then their right — see lib/use-face-poses.ts for why the order and the
   * pose check live in one place.
   */
  const poses = useFacePoses();

  /*
   * Automatic capture. Once the camera is live the loop watches for a face, waits
   * for the head to reach the angle being asked for, reads it, and moves on —
   * there is no capture button while it is working. See use-auto-face-capture.
   */
  const scan = useAutoFaceCapture({
    sequence: poses,
    videoRef,
    active: phase === "camera",
    onComplete: (frames) => void submit(frames),
  });

  /**
   * The insecure-origin path: the OS camera app hands back a file.
   *
   * Not a nicety. A phone on the cafe Wi-Fi is on plain http, the browser refuses
   * a camera there before any script runs, and there is no library that can lift
   * that. This input is handled by the operating system, so it works exactly
   * where `getUserMedia` cannot — which on a real cafe floor is most of the time.
   */
  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setMessage(null);
      /*
       * Same order as the camera: weights first. Without this the person picks a
       * photo, sits through a silent ~7MB download, and only then finds out
       * whether the face in it could be read at all.
       */
      if (!(await warmUp())) return;

      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(new Error("unreadable"));
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.readAsDataURL(file);
        });

        const img = new Image();
        img.src = dataUrl;
        await img.decode().catch(() => {});
        if (img.naturalWidth === 0) throw new Error("unreadable");
        shotRef.current = img;

        setPhase("reading");
        const result = await poses.read(img);

        if (result.outcome === "retry") {
          setPhase("failed");
          setMessage(result.message);
          return;
        }

        if (result.outcome === "complete") {
          await submit(result.frames);
          return;
        }

        // One angle read; the file picker has to be used again for the next one.
        const missing = FACE_POSES.find((pose) => !result.frames.some((f) => f.pose === pose));
        setPhase("failed");
        setMessage(
          missing
            ? `Got that one. Now choose the ${POSE_COPY[missing].short} photo.`
            : "Got that one."
        );
      } catch {
        setPhase("failed");
        setMessage("That file could not be read as an image.");
      }
    },
    [submit, warmUp, poses]
  );

  const working = phase === "reading" || phase === "checking";
  const busyStarting = phase === "loading-models" || phase === "checking-models";
  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  return (
    <div className="space-y-3.5">
      <div className="relative overflow-hidden rounded-2xl bg-cocoa-900">
        {phase === "camera" && (
          <video
            /* The callback ref, not the plain one — see attachStream. */
            ref={attachStream}
            playsInline
            muted
            autoPlay
            className="mx-auto block w-full max-w-xs"
          />
        )}

        {/* The loading screen for the angle being read. */}
        {phase === "camera" && scan.phase === "scanning" && (
          <FaceScanOverlay
            step={Math.min(scan.progress + 1, scan.total)}
            total={scan.total}
          />
        )}

        {/*
          The live guide, for every moment that is not the scanning screen.

          It replaces the instruction/progress lines that used to sit under the
          video: those were several pixels from where the person is looking, and
          they could not show whether the camera could see them at all. Hidden
          once the loop gives up, because the manual controls and their own
          message take over then.
        */}
        {phase === "camera" && scan.phase === "prompt" && (
          <FaceCaptureGuide
            poses={scan.poses}
            activePose={scan.activePose}
            done={scan.frames.map((f) => f.pose)}
            state={scan.liveState}
            holdProgress={scan.holdProgress}
            flashPose={scan.flashPose}
            message={scan.message}
          />
        )}

        {(phase === "starting" || busyStarting || working) && (
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-cream-200 border-t-ochre-400" />
          </div>
        )}

        {/*
          Deliberately not repeating the diagnosis here. This box and the panel
          below sit a few pixels apart, and when both carried the same sentence
          the person read the same failure twice before reaching the part that
          tells them what to do about it. The panel owns the wording; the box
          stays neutral so the eye goes to the instruction.
        */}
        {(phase === "failed" || blocked) && (
          <div className="flex h-48 items-center justify-center px-6 text-center">
            <p className="text-sm text-cream-200/60">
              {blocked ? "Camera unavailable" : "The camera is not showing."}
            </p>
          </div>
        )}
      </div>

      {modelsPresent === false && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-3 text-sm text-terracotta-700">
          <p className="font-semibold">The face model files are not installed.</p>
          <p className="mt-1">
            Run <code className="font-mono">npm run setup:face</code> and reload.
            Without them no camera can recognise a face. You can still use
            &ldquo;Take a photo instead&rdquo; once they are installed.
          </p>
        </div>
      )}

      {phase === "loading-models" && (
        <div className="px-1">
          <div className="h-2 overflow-hidden rounded-full bg-cream-200">
            <div
              className="h-full rounded-full bg-ochre-400 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-cocoa-500">
            About 7MB, once. It is kept afterwards, so this only happens the first
            time.
          </p>
        </div>
      )}

      {/*
        Framing, before someone fails rather than after.

        The same note as the duty screen: the model compares against the photo the
        admin enrolled, and a face cropped tight enough to clip the chin sits
        close enough to the cut-off that a perfectly good photo of the right
        person gets refused. "That is not you" is worse than useless when it is
        untrue, so one line here buys a retake.

        Only while the camera is off. Once it is open the live guide carries the
        instruction, the angle and the nudge on the preview itself, and repeating
        them down here put the same sentence in two places.
      */}
      {phase !== "camera" && (
        <p className="text-center text-xs text-cocoa-500">
          Fill the frame with your face but keep room around it — your whole head,
          top of hair to chin.
        </p>
      )}

      {blocked && (
        <div className="rounded-xl bg-amber-50 px-3.5 py-3 text-sm text-cocoa-700">
          <p className="font-semibold">{describeCameraProblem(blocked).message}</p>
          <p className="mt-1">
            {blocked === "permission-denied" && permissionHelp("denied")
              ? permissionHelp("denied")
              : describeCameraProblem(blocked).help}
          </p>
          {describeCameraProblem(blocked).retryable && (
            <button
              type="button"
              className="btn-ghost mt-2.5 !py-1.5 text-xs"
              onClick={() => {
                /*
                 * Re-test in place and, if the camera is now permitted, open it.
                 *
                 * This used to reload the page, which threw away the badge they
                 * had just scanned and made them do it again — after they had
                 * already followed the instructions. Re-running the same open
                 * routine is both kinder and the only thing that can actually
                 * tell them whether the browser setting took effect.
                 */
                setBlocked(null);
                setMessage(null);
                void startCamera();
              }}
            >
              Check again
            </button>
          )}
        </div>
      )}

      {message && !blocked && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-3 text-sm text-terracotta-700">
          {message}
        </div>
      )}

      {/*
        The button that actually starts the camera.

        This is a deliberate action rather than something that happens on mount.
        Opening a camera is a permission prompt and a green privacy light, and
        asking for both the instant this panel appears — before anyone has
        confirmed they meant to use the camera — is the behaviour the enrolment
        capture already avoids for exactly this reason. It also gives the person a
        visible thing to press when nothing is on screen, which is what a missing
        preview looks like from their side.
      */}
      {phase !== "camera" && (
        <button
          type="button"
          className="btn-primary w-full !py-2.5"
          disabled={busyStarting || working || modelsPresent === false}
          onClick={() => void startCamera()}
        >
          {busyStarting ? "Getting ready…" : "Take a picture"}
        </button>
      )}

      {/*
        The manual fallback. Hidden while auto-capture is working; it appears only
        after repeated failures, which is the one case where the loop has stopped
        being useful.
      */}
      {phase === "camera" && scan.showManual && (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1 !py-2.5"
            disabled={working}
            onClick={() => void scan.captureNow()}
          >
            Take the {POSE_COPY[scan.activePose].short} photo
          </button>
          <button type="button" className="btn-ghost" onClick={scan.resume}>
            Keep scanning
          </button>
        </div>
      )}

      {working && (
        <p className="text-center text-sm text-cocoa-500">
          {phase === "reading" ? "Reading your face…" : "Checking…"}
        </p>
      )}

      {/* Always available, and never hidden. On a phone over plain http this is
          the only camera there is, and on a till with no webcam it is the whole
          point. */}
      <label className="btn-ghost flex w-full cursor-pointer items-center justify-center">
        Take a photo instead
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="user"
          className="sr-only"
          disabled={working}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>

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