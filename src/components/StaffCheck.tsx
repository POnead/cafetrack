"use client";

import { readFaceFor, useFaceEngine } from "@/lib/face-engine";

/**
 * Password-confirmation step for staff sign-in. The live face is matched only
 * against the face enrolled on the account.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailable,
  cameraPermissionState,
  openCamera,
  permissionHelp,
} from "@/lib/face-client";
import {
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import { PRIMARY_POSE, descriptorVersionFor } from "@/lib/face";
import { useFacePoses } from "@/lib/use-face-poses";
import { useAutoFaceCapture } from "@/lib/use-auto-face-capture";
import FaceScanOverlay from "@/components/FaceScanOverlay";
import FaceCaptureGuide from "@/components/FaceCaptureGuide";

/**
 * This screen asks for a straight-on face and compares it with the enrolled face.
 */
const STAFF_POSES = [PRIMARY_POSE] as const;

type Props = {
  /** The ticket from step one. Single use, five minutes, and not a session. */
  ticket: string;
  /** The account's display name, so the greeting is a name rather than a title. */
  fullName?: string;
  /** Called after the enrolled face matches and the session cookie exists. */
  onVerified: (matchedBy: "face") => void;
  /** Back to the password step, e.g. the ticket expired. */
  onBack: () => void;
};

export default function StaffCheck({ ticket, fullName, onVerified, onBack }: Props) {
  /*
   * The café's engine. Every embedding this screen produces has to be in the
   * space the server compares against, or a correct face never matches.
   */
  const engine = useFaceEngine();
  const poses = useFacePoses(STAFF_POSES);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ticketExpired, setTicketExpired] = useState(false);
  /*
   * State is not enough to stop a double submit: two clicks dispatched before a
   * re-render both read `busy` as false. The ref is updated synchronously, so the
   * second one sees the first one already in flight.
   */
  const busyRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  }, []);

  /**
   * A callback ref, not the plain object one — and this is the whole reason the
   * camera showed a black rectangle the first time round.
   *
   * The <video> only exists once `live` is true, and React mounts it on a later
   * render than the one that set it. So attaching the stream by hand inside
   * start(), right after setLive(true), reads videoRef.current as null: the
   * element has not been created yet. The stream is opened and the hardware light
   * comes on, and then it is simply never given to an element. getUserMedia
   * succeeded, so nothing threw, and the failure is invisible from the page.
   *
   * A callback ref runs on the element's own mount, which is the only moment at
   * which the node exists. FaceCapture, FaceSignIn, IdFaceSignIn and the verify
   * screen all do it this way for the same reason.
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

  const start = useCallback(async () => {
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

    setMessage("Getting the reader ready…");
    try {
      const lib = await import("@/lib/face-client");
      await lib.loadFaceModels((loaded, total) => setProgress({ loaded, total }));
    } catch {
      setMessage(
        "The face model could not be downloaded. Check the connection, then try again."
      );
      return;
    }

    try {
      const stream = await openCamera();
      streamRef.current = stream;

      // Only the stream is stored here. setLive mounts the <video>, and
      // attachStream hands it the stream on that mount — see its comment.
      setProgress(null);
      setLive(true);
      setMessage("Look into the camera and hold still.");
    } catch (e) {
      stopCamera();
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setMessage(describeCameraProblem(problem).message);
    }
  }, [stopCamera]);

  /*
   * Preload the face models in the background from the moment this panel
   * appears, rather than waiting for the person to press the button.
   *
   * The models are ~6MB and take several seconds to fetch on first use. When
   * that happened inside `start()`, the person had already committed — camera
   * permission granted, privacy light on — and then sat through a progress bar
   * doing nothing. Loading it here means the download runs while they are still
   * reading the instructions, and by the time they press the button it is done.
   *
   * A failure here is silent on purpose: `start()` calls `loadFaceModels()`
   * again, which either finishes the job or throws, and only that second call
   * reports anything. A preload that surfaced its own error would show two
   * messages for one problem.
   */
  useEffect(() => {
    void import("@/lib/face-client")
      .then((lib) => lib.loadFaceModels())
      .catch(() => {});
  }, []);

  /**
   * Send one face reading from the automatic scan or a manual capture.
   */
  const submitFrame = useCallback(
    async (faceEmbedding: number[] | null) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(null);

      try {
        if (!faceEmbedding) {
          setMessage("No face was detected. Center your face in the camera and try again.");
          return;
        }

        const res = await fetch("/api/auth/staff/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket,
            face_embedding: faceEmbedding,
            /*
             * Which reader produced the vector, and which revision of it.
             *
             * Advisory, but load-bearing for the person in front of the camera:
             * a tab left open across a reader change keeps the old script in
             * memory, and its vectors are in a space the server cannot compare.
             * Without this the only symptom is "that face did not match" for a
             * face that is on file. See the route's stale-client check.
             */
            face_engine: engine,
            descriptor_version: descriptorVersionFor(engine),
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setMessage(data.error || "That face did not match. Try again.");
          if (data.expired) {
            setTicketExpired(true);
            stopCamera();
          }
          return;
        }

        stopCamera();
        onVerified("face");
      } catch {
        setMessage("Something went wrong reading the camera. Try again.");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [engine, onVerified, stopCamera, ticket]
  );

  /**
   * Manual fallback used when the automatic scan has given up — see
   * `scan.showManual`.
   */
  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setMessage("The camera is not showing anything yet.");
      return;
    }

    let faceEmbedding: number[] | null = null;
    try {
      const face = await readFaceFor(engine, video);
      // A low-confidence read is not thrown away here. The server is the only
      // thing entitled to decide whether a face counts, and it compares against
      // a known account rather than trusting this number.
      if (face.ok) faceEmbedding = face.embedding;
    } catch {
      setMessage("Could not read the face. Check the camera and try again.");
      return;
    }

    await submitFrame(faceEmbedding);
  }, [engine, submitFrame]);

  /*
   * Automatic face capture. Six seconds rather than the usual thirty keeps the
   * confirmation responsive at a till while still allowing manual capture.
   */
  const scan = useAutoFaceCapture({
    sequence: poses,
    videoRef,
    active: live,
    poses: STAFF_POSES,
    noFaceTimeoutMs: 6_000,
    onComplete: (frames) => void submitFrame(frames[0]?.embedding ?? null),
  });

  const problem = blocked ? describeCameraProblem(blocked) : null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4 sm:px-5">
        <h2 className="text-xl font-semibold text-cocoa-800">
          {fullName ? `Hello ${fullName.split(" ")[0]}` : "One more thing"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-cocoa-600">
          Your password is right. Look into the camera so we can match your face
          with the one enrolled on your account.
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
      ) : !live ? (
        <div className="space-y-4 rounded-2xl border border-cream-200 bg-white p-4 sm:p-5">
          <button
            type="button"
            onClick={start}
            disabled={Boolean(progress)}
            className="w-full min-h-12 rounded-xl bg-cream-400 px-4 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300 disabled:opacity-60"
          >
            {progress
              ? `Loading the reader… ${progress.loaded}/${progress.total}`
              : "Start face check"}
          </button>

          {problem && (
            <div
              role="status"
              className="space-y-2 rounded-xl border border-terracotta-100 bg-terracotta-50 px-4 py-3.5 text-sm leading-relaxed text-terracotta-700"
            >
              <p className="font-semibold">{problem.message}</p>
              {permissionHelp(blocked!) && <p>{permissionHelp(blocked!)}</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 rounded-2xl border border-cream-200 bg-white p-3 sm:p-4">
          <div className="relative overflow-hidden rounded-2xl bg-cocoa-800 p-2">
            <video
              /* The callback ref, not the plain object one — see attachStream. */
              ref={attachStream}
              playsInline
              muted
              className="mx-auto aspect-[4/5] max-h-[65vh] w-full max-w-sm rounded-xl object-cover"
            />
            {scan.phase === "scanning" && (
              <FaceScanOverlay step={1} total={1} />
            )}
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

          {busy ? (
            <p role="status" className="text-center text-xs text-cocoa-500">
              Checking your sign-in…
            </p>
          ) : scan.showManual ? (
            /*
             * The manual fallback. Hidden while the automatic scan is working;
             * it appears after repeated failures or once the no-face timeout
             * passes.
             */
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void capture()}
                className="w-full min-h-12 rounded-xl bg-cream-400 px-4 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300"
              >
                Use this face
              </button>
              <button
                type="button"
                onClick={scan.resume}
                className="w-full text-center text-xs text-cocoa-400 underline"
              >
                Keep scanning
              </button>
            </div>
          ) : scan.phase === "complete" && message ? (
            /* The server refused the presentation. Let them try again. */
            <button
              type="button"
              onClick={() => {
                setMessage(null);
                scan.reset();
              }}
              className="w-full rounded-xl bg-cream-400 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300"
            >
              Try again
            </button>
          ) : null}

        </div>
      )}

      {!ticketExpired && (
        <div className="border-t border-cream-200 pt-3">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="w-full rounded-xl px-3 py-2.5 text-sm font-medium text-cocoa-500 transition hover:bg-cream-50 hover:text-cocoa-700 disabled:opacity-50"
          >
            Use my password instead
          </button>
        </div>
      )}

      {/*
        The loop's own message is shown by the guide while it is running. It only
        belongs down here once the guide is gone — after a give-up, where the
        reason for it is the whole point of the manual step.
      */}
      {!ticketExpired && !problem && (message || (live && scan.showManual && scan.message)) && (
        <p role="status" className="text-center text-xs leading-relaxed text-cocoa-500">
          {message ?? scan.message}
        </p>
      )}
    </div>
  );
}
