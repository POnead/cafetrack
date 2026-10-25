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

  /** Read the current frame, send the embedding, and act on the answer. */
  const verify = useCallback(async (source: HTMLVideoElement | HTMLImageElement) => {
    setPhase("verifying");
    setMessage(null);
    try {
      const lib = await faceLib();
      const read = await lib.readFace(source);
      if (!read.ok) {
        setPhase("capture");
        setMessage(read.message);
        return;
      }

      const res = await fetch("/api/auth/verify-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embedding: read.embedding }),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        setPhase("passed");
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
  }, [router]);

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
        <div className="relative mb-4 overflow-hidden rounded-2xl bg-cocoa-900">
          <video
            ref={attachStream}
            playsInline
            muted
            autoPlay
            className="mx-auto block w-full max-w-sm"
          />
        </div>
      )}

      {cameraOn ? (
        <div className="mb-4 flex justify-center">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              const v = videoRef.current;
              if (!v) return;
              /*
               * A camera that has just opened can be asked for a frame before it
               * has produced one, and the read fails with a message about the
               * photo rather than about the timing. Saying so plainly is quicker
               * than the person trying three more times.
               */
              if (!v.videoWidth) {
                setMessage("The camera is still starting — try again in a moment.");
                return;
              }
              void verify(v);
            }}
          >
            Take the photo
          </button>
        </div>
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
        <div className="mb-4">
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
          <p className="mt-1.5 text-center text-xs text-cocoa-500">
            About 7MB, once. It is kept afterwards, so this only happens the first
            time.
          </p>
        </div>
      )}

      {/*
        Framing, before anyone tries rather than after they fail.

        Measured on the real model: the same person re-shot with room around the
        face sits at 0.002-0.02 from their own reference, and cropped tight enough
        to clip the chin, at 0.030. That last figure is close enough to the 0.033
        cut-off that a reasonable photo of the right person gets refused — and the
        message that comes back ("that is not you") is worse than useless, because
        it is untrue. One line here costs a retake instead.
      */}
      <p className="mb-4 text-center text-xs text-cocoa-500">
        Fill the frame with your face, but keep room around it — your whole head,
        from the top of your hair down to your chin, with a little to spare. If it
        does not match, try again with a little more light or with the camera a
        little further away.
      </p>

      {/*
        Always available. On an address that cannot use getUserMedia this is the
        only way to get a camera at all — it opens the device's own camera app —
        and on a till with no camera it is the whole point. It is never hidden,
        because the people who need it most are the ones a failed camera leaves
        stranded.
      */}
      <label className="btn-ghost flex w-full cursor-pointer items-center justify-center">
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

      {message && (
        <div
          className={`mt-4 rounded-xl px-3.5 py-3 text-sm ${
            phase === "failed"
              ? "bg-terracotta-50 text-terracotta-700"
              : "bg-amber-50 text-cocoa-700"
          }`}
        >
          {message}
        </div>
      )}

      <button
        type="button"
        className="mt-5 w-full text-center text-xs text-cocoa-400 underline"
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
    <div className="flex min-h-screen items-center justify-center bg-white px-6 py-12">
      <div className="w-full max-w-sm text-center">
        <div className="script-logo-dark mb-6 text-3xl">CafeTrack</div>
        <h1 className="deco-title text-4xl">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-cocoa-500">{subtitle}</p>}
        <div className="mt-6">{children}</div>
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