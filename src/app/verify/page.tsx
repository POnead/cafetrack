"use client";

/**
 * The duty check a staff member passes before starting work.
 *
 * Shown after sign-in when the account still owes a check. Three states, and the
 * order matters:
 *
 *   loading  — reading whether a check is even owed, from /api/auth/me. The
 *              screen must never flash the camera at someone who is already
 *              inside their window, so this is a real state and not a spinner
 *              over the form.
 *   capture  — the person proves who they are.
 *   verifying— a full-screen hold while the numbers go up and are compared. Not
 *              a corner spinner: the person has just pointed a camera at their
 *              own face and needs to be told it is being read rather than
 *              abandoned.
 *
 * The comparison itself happens on the server. Only 128 floats travel, never a
 * photograph, and the answer is never a score — see the route. This page's whole
 * job is to get one good reading and hand it over.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  cameraOriginProblem,
  classifyCameraError,
  describeCameraProblem,
} from "@/lib/face-diagnostics";
import { POSE_COPY } from "@/lib/face";
import { framesBody, useFacePoses, type PoseFrame } from "@/lib/use-face-poses";
import { useAutoFaceCapture } from "@/lib/use-auto-face-capture";
import FaceScanOverlay from "@/components/FaceScanOverlay";
import FaceCaptureGuide from "@/components/FaceCaptureGuide";

type Phase =
  | "loading"
  | "not-required"
  | "no-camera"
  | "denied"
  | "capture"
  | "verifying"
  | "passed"
  | "failed";

type FaceStatus = {
  required: boolean;
  enabled: boolean;
  enrolled: boolean;
  dutyHours: number;
  verifiedAt: string | null;
  nextDueAt: string | null;
};

export default function VerifyPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<FaceStatus | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotRef = useRef<HTMLImageElement | null>(null);

  /*
   * Whether the camera is actually running and should be on screen.
   *
   * Separate from `phase`, because `phase` describes what the *check* is doing
   * (waiting, reading, passed) and says nothing about the hardware. This screen
   * opens a camera and then has to decide what to draw, and drawing it from
   * `phase` meant a successful open changed nothing visible at all.
   */
  const [cameraOn, setCameraOn] = useState(false);

  /*
   * Model download progress.
   *
   * Without this the screen does nothing visible for the several seconds the
   * ~7MB recognition weights take, which is the same "no hint anything is
   * happening" complaint as a dead camera — the button simply stops responding.
   * The other two camera screens both show this, and this one has to as well.
   */
  const [loadingModels, setLoadingModels] = useState(false);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });

  /*
   * Attach the stream to the video element as it mounts.
   *
   * A callback ref, not `videoRef.current = ...` in the open routine. The two
   * used to be ordered so that the element did not exist yet when the stream was
   * assigned to it, so the assignment landed on null and was discarded — the
   * camera opened, its light came on, the stream ran, and the page showed no
   * picture of any kind. Assigning on mount makes the order irrelevant.
   */
  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    const stream = streamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  // face-client pulls in tfjs, which has no server. Loaded on first use so the
  // 6MB model is not fetched by anyone who turns out not to owe a check.
  const faceRef = useRef<typeof import("@/lib/face-client") | null>(null);
  const faceLib = async () => {
    if (!faceRef.current) faceRef.current = await import("@/lib/face-client");
    return faceRef.current;
  };

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  // Ask whether a check is owed. Anything other than "yes, and there is a face to
  // compare against" sends them on to the app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) {
          router.replace("/login");
          return;
        }
        const data = await res.json();
        if (cancelled) return;

        const face: FaceStatus = data.face;
        setStatus(face);

        if (!face.required) {
          router.replace("/dashboard");
          return;
        }
        if (!face.enrolled) {
          // The feature was switched on after this person was hired. They cannot
          // fix it from here; the manager standing next to them can.
          setPhase("no-camera");
          setMessage(
            "Your account has no reference photo yet, so there is nothing to " +
              "compare against. Ask your manager to enrol you, or approve this " +
              "duty for you."
          );
          return;
        }

        const lib = await faceLib();
        if (!lib.cameraAvailable()) {
          // Plain http on the LAN. The in-page camera is unavailable, but the
          // native camera app through a capture input still works.
          setPhase("capture");
          return;
        }
        setPhase("capture");
      } catch {
        if (!cancelled) router.replace("/login");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const startCamera = useCallback(async () => {
    setMessage(null);

    /*
     * Checked before asking for one. On plain http to a phone on the LAN there
     * is no navigator.mediaDevices at all, so calling getUserMedia first would
     * fail in a way that reads as "the camera is broken" rather than "this
     * address cannot have a camera" — and this is the common case at a cafe, not
     * the rare one.
     */
    const originProblem = cameraOriginProblem();
    if (originProblem) {
      setMessage(describeCameraProblem(originProblem).help ?? describeCameraProblem(originProblem).message);
      return;
    }

    try {
      const lib = await faceLib();

      /*
       * The model first, then the camera.
       *
       * `verify` runs the recognition weights, so opening the camera ahead of
       * them means holding still in front of a live preview for the length of a
       * ~7MB download. FaceSignIn and the enrolment capture already load first;
       * this now matches them — with a progress bar, because a button that stops
       * responding for several seconds is indistinguishable from a broken one.
       */
      setLoadingModels(true);
      setProgress({ loaded: 0, total: 6_700_000 });
      try {
        await lib.loadFaceModels((loaded, total) => {
          if (total > 0) setProgress({ loaded, total });
        });
      } finally {
        setLoadingModels(false);
      }

      const stream = await lib.openCamera();
      streamRef.current = stream;
      // Mounts the <video>; attachStream picks the stream up on that mount.
      setCameraOn(true);
    } catch (e) {
      const lib = await faceLib();

      /*
       * The real cause, read off the exception rather than re-derived from a
       * second permission query.
       *
       * Everything that was not a refusal used to be reported as "no camera",
       * so a camera held open by a video call and a machine with no webcam at all
       * both sent someone to check hardware that was working fine. The wording
       * comes from the shared table so this screen, the enrolment capture and
       * sign-in cannot drift apart again.
       */
      const problem = classifyCameraError(e);
      const { message, help } = describeCameraProblem(problem);

      setPhase(problem === "permission-denied" ? "denied" : "no-camera");
      setMessage(
        problem === "permission-denied" && lib.permissionHelp("denied")
          ? lib.permissionHelp("denied")
          : `${message} ${help ?? ""} You can take a photo instead with the button below.`
      );
    }
  }, []);

  /*
   * The three-angle sequence: straight on, then the person's left, then their
   * right. The prompt on screen and the button label both come from the same
   * active angle, so they cannot disagree about what is being asked for.
   */
  const poses = useFacePoses();

  /** Send a complete presentation to the server and act on the answer. */
  const submitFrames = useCallback(
    async (frames: readonly PoseFrame[]) => {
      setPhase("verifying");
      setMessage(null);
      try {
        const res = await fetch("/api/auth/verify-face", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Every angle, in one body. A check that sent only the straight-on
          // frame would fail on any account holding side samples.
          body: JSON.stringify(framesBody(frames)),
        });
        const data = await res.json();

        if (res.ok && data.ok) {
          setPhase("passed");
          // Nothing left to read, so the light goes off while they read the
          // confirmation rather than staying on until the next page loads.
          stopCamera();
          // Long enough to read the confirmation, then in.
          setTimeout(() => router.replace("/dashboard"), 1200);
          return;
        }

        setPhase("failed");
        setMessage(
          data.error ||
            "That face was not recognised. Try again, or ask your manager for an override."
        );
      } catch {
        setPhase("capture");
        setMessage("That could not be checked. Try again.");
      }
    },
    [router, stopCamera]
  );

  /** Read one image (the file-upload path), and submit once the set is complete. */
  const verify = useCallback(
    async (source: HTMLVideoElement | HTMLImageElement) => {
      setPhase("verifying");
      setMessage(null);
      try {
        const result = await poses.read(source);

        if (result.outcome === "retry") {
          setPhase("capture");
          setMessage(result.message);
          return;
        }

        if (result.outcome !== "complete") {
          // Accepted, and there are more angles to ask for.
          setPhase("capture");
          return;
        }

        await submitFrames(result.frames);
      } catch {
        setPhase("capture");
        setMessage("That could not be checked. Try again.");
      }
    },
    [poses, submitFrames]
  );

  /** The insecure-origin path: the OS camera app hands back a file. */
  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setMessage(null);
      try {
        const lib = await faceLib();
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
        await verify(img);
      } catch {
        setPhase("capture");
        setMessage("That file could not be read as an image.");
      }
    },
    [verify]
  );

  /*
   * Automatic capture. Once the camera is live the loop watches for a face,
   * waits for the head to reach the angle being asked for, reads it, and moves
   * on — no capture button while it is working. See use-auto-face-capture.
   */
  const scan = useAutoFaceCapture({
    sequence: poses,
    videoRef,
    /*
     * Only while the live camera is the thing being used. A file picked through
     * "Take a photo instead" moves the screen to `verifying`, which stops the
     * loop — otherwise the camera could finish its own presentation while the
     * file is still being read, and the two would submit against each other.
     */
    active: cameraOn && phase === "capture",
    onComplete: (frames) => void submitFrames(frames),
  });

  if (phase === "loading") {
    return (
      <Screen title="Checking your duty status…">
        <Spinner label="" />
      </Screen>
    );
  }

  // Passed — the hold screen, so "reading" is never mistaken for "hung".
  if (phase === "verifying" || phase === "passed") {
    return (
      <Screen title={phase === "passed" ? "Face confirmed" : "Checking your face…"}>
        <div
          className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full ${
            phase === "passed" ? "bg-ochre-100 text-ochre-700" : "bg-cream-200 text-cocoa-500"
          }`}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
            {phase === "passed" ? (
              <path d="m4 12 5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <circle cx="12" cy="12" r="9" opacity="0.25" />
                <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
              </>
            )}
          </svg>
        </div>
        <p className="text-center text-sm text-cocoa-600">
          {phase === "passed"
            ? "You're on duty. Taking you in…"
            : "Hold still — this only takes a moment."}
        </p>
      </Screen>
    );
  }

  return (
    <Screen
      title={
        phase === "no-camera" && !status?.enrolled
          ? "No reference photo"
          : "Confirm it's you"
      }
      subtitle={
        status
          ? `One check covers ${status.dutyHours} hours of duty.`
          : undefined
      }
    >
      {/*
        The live preview.

        This element did not exist at all, while the code above opened a camera
        and assigned the stream to a ref that nothing ever pointed at. So the
        camera light came on, the stream ran, the page showed no picture, and the
        only evidence anything had happened was a green LED — with no way to take
        the photo even if it had shown something.

        `autoPlay` and `muted` are both required, not decoration: a video with a
        MediaStream will not start drawing frames until it is playing, and a
        browser will refuse to play audible media that did not start from a user
        gesture. Both are satisfied here, and `attachStream` calls play() as well
        so a browser that ignores autoplay for the stream still starts.
      */}
      {cameraOn && (
        <div className="mb-5 overflow-hidden rounded-2xl bg-cocoa-900 p-2 sm:p-3">
          <div className="relative mx-auto aspect-[4/5] max-h-[65vh] w-full max-w-sm overflow-hidden rounded-xl">
            <video
              ref={attachStream}
              playsInline
              muted
              autoPlay
              className="block h-full w-full object-cover"
            />
            {/* The loading screen for the angle being read. */}
            {scan.phase === "scanning" && (
              <FaceScanOverlay
                step={Math.min(scan.progress + 1, scan.total)}
                total={scan.total}
              />
            )}
            {/* The live guide, until the loop hands over to the manual button. */}
            {scan.phase === "prompt" && (
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
          </div>
        </div>
      )}

      {cameraOn ? (
        /*
         * The manual fallback. Hidden while auto-capture is working; it appears
         * only after repeated failures, which is the one case where the loop has
         * stopped being useful.
         */
        scan.showManual ? (
          <div className="mb-5 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              className="btn-primary"
              onClick={() => void scan.captureNow()}
            >
              Take the {POSE_COPY[scan.activePose].short} photo
            </button>
            <button type="button" className="btn-ghost" onClick={scan.resume}>
              Keep scanning
            </button>
          </div>
        ) : phase === "failed" ? (
          <div className="mb-5 flex justify-center">
            <button
              type="button"
              className="btn-primary min-h-12 w-full"
              onClick={() => {
                scan.reset();
                setPhase("capture");
              }}
            >
              Try again
            </button>
          </div>
        ) : null
      ) : (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            className="btn-primary"
            disabled={loadingModels}
            onClick={() => void startCamera()}
          >
            {loadingModels ? "Getting ready…" : "Turn on the camera"}
          </button>
        </div>
      )}

      {loadingModels && (
        <div className="mb-5 rounded-xl border border-cream-200 bg-white px-4 py-3.5">
          <div className="h-2 overflow-hidden rounded-full bg-cream-200">
            <div
              className="h-full rounded-full bg-ochre-400 transition-all"
              style={{
                width: `${
                  progress.total > 0
                    ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {/*
        Framing, before anyone tries rather than after they fail.

        Measured on the real model: the same person re-shot with room around the
        face sits at 0.002-0.02 from their own reference, and cropped tight enough
        to clip the chin, at 0.030. That last figure is close to the stricter
        0.033 cut-off, so a badly framed photo still costs a scan, and one line
        here buys a retake instead.

        Only while the camera is off. Once it is open the live guide carries the
        angle, the nudge and the count on the preview itself.
      */}

      {/*
        Always available. On an address that cannot use getUserMedia this is the
        only way to get a camera at all — it opens the device's own camera app —
        and on a till with no camera it is the whole point. It is never hidden,
        because the people who need it most are the ones a failed camera leaves
        stranded.
      */}
      <div className="mt-4 space-y-2 rounded-2xl border border-cream-200 bg-white p-3.5">
        <label className="btn-ghost flex min-h-12 w-full cursor-pointer items-center justify-center">
          Take a photo instead
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="user"
            className="sr-only"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {message && (
        <div
          role="status"
          className={`mt-4 rounded-2xl border px-4 py-3.5 text-sm leading-relaxed ${
            phase === "failed"
              ? "border-terracotta-100 bg-terracotta-50 text-terracotta-700"
              : "border-amber-200 bg-amber-50 text-cocoa-700"
          }`}
        >
          {message}
        </div>
      )}

      <button
        type="button"
        className="mt-4 w-full rounded-xl px-3 py-2.5 text-center text-sm font-medium text-cocoa-500 transition hover:bg-cream-100 hover:text-cocoa-700"
        onClick={() => router.replace("/login")}
      >
        Sign out
      </button>
    </Screen>
  );
}

/** Shared chrome. Kept here so the three states cannot drift apart. */
function Screen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100svh] items-center justify-center bg-cream-50 px-4 py-8 sm:px-6 sm:py-12">
      <div className="w-full max-w-md text-center">
        <div className="script-logo-dark mb-5 text-3xl">CafeTrack</div>
        <h1 className="deco-title text-3xl sm:text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-cocoa-500">{subtitle}</p>}
        <div className="mt-6 rounded-3xl border border-cream-200 bg-cream-50/70 p-4 text-left shadow-sm sm:p-6">
          {children}
        </div>
      </div>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-cream-200 border-t-ochre-400" />
      {label && <p className="text-sm text-cocoa-500">{label}</p>}
    </div>
  );
}