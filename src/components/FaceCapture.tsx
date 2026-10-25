"use client";

/**
 * Capture a face for enrolment.
 *
 * Two ways in, because the two situations are different:
 *
 *   camera  — the admin is standing there with the person. One photo, taken
 *             live, with a detection box so they can see when it is right.
 *   file    — the photo already exists (a phone picture, a company badge
 *             photo, a photo taken on a device with no camera here).
 *
 * Both produce the same thing: a small JPEG and a 128-float embedding, produced
 * in the browser by lib/face-client. The server never computes an embedding —
 * it has no model — so these two are the only place a face is ever read.
 *
 * Used by the Staff Accounts page, on both the create form and the details
 * panel. Nothing here knows about users or roles; it takes a photo and hands
 * back the pair.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailable,
  cameraPermissionState,
  cameraUnavailableReason,
  captureHint,
  dataUrlToJpeg,
  loadFaceModels,
  modelsPresent,
  openCamera,
  permissionHelp,
  readFace,
  toJpegDataUrl,
} from "@/lib/face-client";
import { Spinner } from "@/components/ui";
import {
  classifyCameraError,
  describeCameraProblem,
  probeCamera,
  type CameraProblem,
} from "@/lib/face-diagnostics";

export type FaceCaptureResult = {
  /** A ~30KB JPEG data URL, which is what gets stored as the reference. */
  photo: string;
  /** 128 floats, sent alongside the photo and stored as text. */
  embedding: number[];
};

type Props = {
  /** Called once a usable photo and embedding exist. */
  onCapture: (result: FaceCaptureResult) => void;
  /** Existing photo, to show as the current reference when replacing one. */
  currentPhoto?: string | null;
  disabled?: boolean;
};

type Phase =
  | "idle"
  | "checking-models"
  | "loading-models"
  | "ready"
  | "camera"
  | "capturing"
  | "reading"
  | "no-camera"
  | "denied"
  | "models-missing";

export default function FaceCapture({ onCapture, currentPhoto, disabled }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [shot, setShot] = useState<string | null>(null);

  /*
   * Why the camera is not available, when it is not.
   *
   * Holds a CameraProblem rather than a boolean so the panel can say which of
   * several very different things went wrong — a blocked site, an http address
   * and a camera held by another program all end with no picture, and telling
   * someone to check their hardware when the cause is a browser setting is how
   * "the camera doesn't work" becomes an afternoon of pointless troubleshooting.
   */
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  /* Anything that holds the camera open while the panel is closed would keep a
   * green privacy light on after someone thought they had stopped. */
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  /*
   * Attach the stream to the video element as it mounts.
   *
   * Same reasoning as the other two camera screens. Here the old ordering
   * happened to be safe — `setPhase("camera")` ran before `await openCamera()`,
   * so the element existed by the time the stream arrived — but that was luck
   * rather than design, resting on how long a permission prompt takes. A callback
   * ref makes it correct regardless of timing, so the three screens can no longer
   * disagree about how a stream is shown.
   */
  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    const stream = streamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  /* Verify the weights are really there before asking for a camera. A missing
   * model discovered halfway through a capture has already made someone sit in
   * front of a webcam for nothing. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("checking-models");
      const present = await modelsPresent();
      if (cancelled) return;
      if (!present) {
        setPhase("models-missing");
        return;
      }
      setPhase("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Load the three models, reporting progress. ~6.7MB on a first visit. */
  const warmUp = useCallback(async () => {
    setPhase("loading-models");
    setMessage(null);
    setProgress({ loaded: 0, total: 6_700_000 });
    try {
      await loadFaceModels((loaded, total) => {
        if (total > 0) setProgress({ loaded, total });
      });
      return true;
    } catch (e: any) {
      setPhase("idle");
      /*
       * The real reason, not a guess.
       *
       * This said "check your connection" for any failure, which is worse than
       * saying nothing: the one failure that actually happened on a phone was not
       * a connection at all, and the wording sent whoever was looking at it in
       * entirely the wrong direction. face-api wraps its own errors, so this
       * unwraps to the innermost message where there is one.
       */
      const reason =
        e?.message && !/load|fetch|network|weights/i.test(e.message)
          ? e.message
          : "The face model could not be downloaded. Check the connection to this address and try again.";
      setMessage(reason);
      console.error("face model load failed:", e);
      return false;
    }
  }, []);

  const startCamera = useCallback(async () => {
    setMessage(null);
    setBlocked(null);

    // Checked before anything else, including the permission query. Over plain
    // http to a LAN address there is no navigator.mediaDevices at all, so both
    // the query and getUserMedia would fail in ways that read as "the camera is
    // broken" rather than "this address cannot have one".
    if (!cameraAvailable()) {
      setBlocked("insecure-origin");
      setPhase("no-camera");
      return;
    }

    const state = await cameraPermissionState();
    if (state === "denied") {
      setBlocked("permission-denied");
      setPhase("denied");
      return;
    }

    setPhase("checking-models");
    if (!(await warmUp())) return;

    setPhase("camera");
    try {
      const stream = await openCamera();
      streamRef.current = stream;
      // attachStream does the attaching, on the video's own mount — see below.
      attachStream(videoRef.current);
    } catch (e) {
      /*
       * The real reason, read off the exception rather than guessed at.
       *
       * This used to re-query the permission and pick between two messages, so a
       * camera held by a video call and a machine with no camera at all both
       * reported "the camera could not be opened here" — advice to check your
       * hardware for what is really a browser setting. `name` is the only field
       * the spec guarantees; the message text is browser-specific and has
       * changed wording between versions.
       */
      stopCamera();
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setPhase(problem === "permission-denied" ? "denied" : "no-camera");
    }
  }, [warmUp, stopCamera, attachStream]);

  /**
   * Re-test the camera after the user has changed a setting outside the page.
   *
   * The permission a browser has already refused cannot be re-requested from
   * inside the page — `permissions.query()` is read-only, and the prompt is not
   * coming back. So the only honest recovery is for the person to change the
   * browser setting and then ask us to look again. Without this button they have
   * no way to find out whether it worked except reloading and guessing, and the
   * obvious thing to try — clicking the camera button again — fails silently and
   * identically every time, so it reads as a broken feature.
   */
  const checkAgain = useCallback(async () => {
    setMessage(null);
    setPhase("checking-models");

    const diagnosis = await probeCamera();
    if (diagnosis.ok) {
      setBlocked(null);
      setPhase("idle");
      return;
    }

    setBlocked(diagnosis.problem);
    setPhase(
      diagnosis.problem === "permission-denied" ? "denied" : "no-camera"
    );
  }, []);

  /** Take one frame and turn it into a photo plus an embedding. */
  const grab = useCallback(
    async (source: HTMLVideoElement | HTMLImageElement, w: number, h: number) => {
      setPhase("reading");
      setMessage(null);
      try {
        const photo = toJpegDataUrl(source, w, h);
        const read = await readFace(source);
        if (!read.ok) {
          setPhase(videoRef.current?.srcObject ? "camera" : "idle");
          setMessage(read.message);
          return;
        }
        setShot(photo);
        onCapture({ photo, embedding: read.embedding });
        setPhase(videoRef.current?.srcObject ? "camera" : "idle");
        setMessage(null);
      } catch {
        setPhase(videoRef.current?.srcObject ? "camera" : "idle");
        setMessage("That photo could not be read. Try again in better light.");
      }
    },
    [onCapture]
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setMessage(null);
      setPhase("checking-models");
      if (!(await warmUp())) return;

      setPhase("reading");
      const reader = new FileReader();
      reader.onerror = () => {
        setPhase("idle");
        setMessage("That file could not be read as an image.");
      };
      reader.onload = async () => {
        const raw = String(reader.result ?? "");
        const img = new Image();
        img.onerror = () => {
          setPhase("idle");
          setMessage("That file could not be read as an image.");
        };
        img.onload = async () => {
          try {
            // Shrunk before anything else touches it, so a 12-megapixel photo
            // off a phone does not have to be carried through the model.
            const photo = await dataUrlToJpeg(raw);
            const read = await readFace(img);
            if (!read.ok) {
              setPhase("idle");
              setMessage(read.message);
              return;
            }
            setShot(photo);
            onCapture({ photo, embedding: read.embedding });
            setPhase("idle");
          } catch (e) {
            /*
             * Logged, because this catch used to be silent.
             *
             * It reports "could not be read" for anything at all that throws
             * between decoding the file and running the model — including a
             * backend that failed to initialise, which has nothing to do with the
             * photo. With nothing in the console, every failure of a different
             * cause looked identical, and that is what made this take so long to
             * pin down: the message says "bad photo" when it may well be a
             * broken compute backend on the device.
             */
            console.error("face read failed for an uploaded photo:", e);
            setPhase("idle");
            setMessage("That photo could not be read. Try another one.");
          }
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    },
    [warmUp, onCapture]
  );

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-cocoa-400">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" strokeLinecap="round" />
            <circle cx="12" cy="12" r="3.2" />
          </svg>
        </span>
        <p className="text-sm text-cocoa-600">
          Take a clear, straight-on photo of their face. The system compares later
          photos against this one, so a bad photo here means they cannot start a
          duty.
        </p>
      </div>

      {phase === "models-missing" && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-3 text-sm text-terracotta-700">
          <p className="font-semibold">The face model files are not installed.</p>
          <p className="mt-1">
            Run <code className="font-mono">npm run setup:face</code> and reload
            this page. Without them the camera cannot recognise a face at all.
          </p>
        </div>
      )}

      {/*
        One panel for both blocked states, worded by lib/face-diagnostics.

        They used to be separate with their own hardcoded copy, which meant the
        same failure could be explained two different ways depending on which
        branch happened to catch it. The wording now comes from one table, so
        enrolment, the duty check and sign-in cannot drift apart again.
      */}
      {(phase === "denied" || phase === "no-camera") && (
        <div
          className={`rounded-xl px-3.5 py-3 text-sm ${
            phase === "denied"
              ? "bg-terracotta-50 text-terracotta-700"
              : "bg-amber-50 text-cocoa-700"
          }`}
        >
          <p className="font-semibold">
            {blocked ? describeCameraProblem(blocked).message : "The camera is not available here."}
          </p>
          <p className="mt-1">
            {blocked
              ? // permissionHelp() knows the difference between Safari's settings
                // path and everyone else's, which the shared table cannot.
                blocked === "permission-denied" && permissionHelp("denied")
                ? permissionHelp("denied")
                : describeCameraProblem(blocked).help
              : cameraUnavailableReason() ??
                "The upload button below does the same job and is still available."}
          </p>
          <p className="mt-1">
            Until then you can still choose a photo from a file — it produces
            exactly the same result.
          </p>

          {/*
            Only offered when retrying could plausibly help.

            An insecure address will not become secure by itself and missing
            weights will not appear without running the setup command, so for
            those two the button would be a dead control sitting under an
            instruction to do something else entirely.
          */}
          {blocked && describeCameraProblem(blocked).retryable && (
            <button
              type="button"
              className="btn-ghost mt-2.5 !py-1.5 text-xs"
              onClick={() => void checkAgain()}
            >
              Check again
            </button>
          )}
        </div>
      )}

      {phase === "camera" && (
        <div className="space-y-2.5">
          <div className="relative overflow-hidden rounded-2xl bg-cocoa-900">
            <video
              ref={attachStream}
              playsInline
              muted
              autoPlay
              className="mx-auto block w-full max-w-sm"
            />
          </div>
          <p className="text-center text-xs text-cocoa-500">
            Face the camera, straight on, in even light.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={disabled}
              onClick={() => {
                const v = videoRef.current;
                if (v) void grab(v, v.videoWidth || 640, v.videoHeight || 480);
              }}
            >
              Take the photo
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                stopCamera();
                setPhase("idle");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/*
        An explicit, named step for every part of the wait.

        Picking a photo used to look like nothing had happened: the 6.7MB model
        download and then the inference can take a while on a phone, and with no
        feedback during that the control simply stops responding. An admin takes
        that as the app being broken and picks the photo again, which re-runs the
        whole thing and queues up another 6.7MB.

        The labels are deliberately specific — which stage, and whether bytes are
        still arriving — so a long pause is legible as slow rather than stuck.
      */}
      {(phase === "checking-models" ||
        phase === "loading-models" ||
        phase === "reading" ||
        phase === "capturing") && (
        <div className="rounded-xl bg-cream-50 px-3.5 py-3 text-sm text-cocoa-700">
          <div className="flex items-center gap-2.5">
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cream-200 border-t-ochre-400" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-cocoa-800">
                {phase === "checking-models" && "Checking the face model…"}
                {phase === "loading-models" &&
                  `Loading the face model${pct > 0 ? ` — ${pct}%` : ""}`}
                {phase === "loading-models" && pct === 0 && " — starting"}
                {phase === "reading" && "Reading the face…"}
                {phase === "capturing" && "Reading the face…"}
              </p>
              {phase === "reading" && (
                <p className="mt-0.5 text-xs text-cocoa-500">
                  Checking that there is a face here, and turning it into the
                  numbers the system stores. This runs on your device.
                </p>
              )}
              {phase === "loading-models" && (
                <>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-cream-200">
                    <div
                      className="h-full rounded-full bg-ochre-400 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-cocoa-500">
                    About 7MB, once. It is kept afterwards, so this only happens
                    the first time.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {message && (
        <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-cocoa-700">
          {message}
        </div>
      )}

      {/*
            An unmistakable "yes, that was accepted" — which is what the person
            actually needs to know at this point.

            This used to be a small grey row reading "Photo captured. Save the
            account to store it." with the same treatment as a stored photo, so
            there was no way to tell a freshly accepted capture from one that had
            been saved weeks ago, and nothing at all to say whether the system
            had understood the face. Green, and spelled out.
          */}
      {(shot || currentPhoto) && phase !== "camera" && (
        <div
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${
            shot ? "bg-ochre-50" : "border border-cream-200 bg-cream-50"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shot ?? currentPhoto ?? ""}
            alt="The reference photo for this account"
            className="h-14 w-14 shrink-0 rounded-lg object-cover"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-cocoa-800">
              {shot ? "Photo accepted" : "Reference photo on file"}
            </p>
            <p className="text-xs text-cocoa-600">
              {shot
                ? "The face was read successfully. Choose Save changes to store it — closing this box without saving keeps the old photo."
                : "This is the photo the system compares against. Use Replace photo to change it."}
            </p>
            {shot && (
              /*
                Framing is the one thing that reliably moves a face away from its
                own reference. Measured on the real model, a re-capture with the
                face cropped tight sits at 0.030 against its own reference, while
                the same person framed normally sits at 0.002-0.02 — the difference
                between passing comfortably and being refused. Clipping the chin or
                running the face out of frame is the failure that reaches support
                as "it says it's not me".
              */
              <p className="mt-1 text-xs text-cocoa-500">
                If this person struggles to be recognised later, the usual cause is
                a photo cropped so tight it cuts off the chin or the top of the
                head. A photo framed with room around the face works far better.
              </p>
            )}
          </div>
        </div>
      )}

      {/*
            Shown whenever the person can still get a photo in — which includes
            the states where the camera refused.

            These used to be gated on `phase === "idle"` alone, so the moment a
            camera failed the two buttons disappeared and the warning went on
            saying "use the other option instead" about a button that was no
            longer on screen. A camera that will not open is exactly when the
            upload route matters most, so it stays available; the camera button
            stays too, because a failed open is often a transient thing and the
            device may well be able to retry.
          */}
        {(phase === "idle" || phase === "no-camera" || phase === "denied") && (
        <div className="space-y-3">
          {/*
            Two explicit routes, side by side. Which one is right depends on
            where you are standing: the admin in front of the person, or someone
            on a phone across the cafe.

            The "Take a photo" button is deliberately two different things
            depending on the address. Where the page may use getUserMedia it does,
            and the person gets a live preview with a detection box. Where it may
            not — any phone on plain http over the LAN, which is the common case
            here — it hands off to the phone's own camera app through a file
            input with `capture`.

            That second path is the whole reason this works on the LAN.
            `<input type="file" capture>` is handled by the OS picker and opens
            the native camera app, and it is not gated on getUserMedia or on a
            secure context. No library can lift that restriction from
            getUserMedia — it is enforced by the browser before any script runs —
            so the honest way to have a working camera on a phone over http is
            not to ask the page for one, but to let the phone supply it.
          */}
          <div className="grid gap-2 sm:grid-cols-2">
            {cameraAvailable() ? (
              <button
                type="button"
                className="btn-primary"
                disabled={disabled}
                onClick={() => void startCamera()}
              >
                Take a photo
              </button>
            ) : (
              <label className="btn-primary inline-flex cursor-pointer items-center justify-center">
                Take a photo
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  capture="user"
                  className="sr-only"
                  disabled={disabled}
                  onChange={(e) => {
                    void onFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            )}

            <label className="btn-ghost inline-flex cursor-pointer items-center justify-center">
              Upload a photo
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                disabled={disabled}
                onChange={(e) => {
                  void onFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          {!cameraAvailable() && (
            <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs text-cocoa-700">
              <p className="font-semibold text-cocoa-800">
                {captureHint()}
              </p>
              <p className="mt-1">{cameraUnavailableReason()}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
