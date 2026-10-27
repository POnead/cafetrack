"use client";

import { readFaceFor, useFaceEngine } from "@/lib/face-engine";

/**
 * Password-confirmation step for staff sign-in. A person chooses either the
 * enrolled face or the card already stored on their account. The card photo is
 * fingerprinted on-device; only the fingerprint and the stored portrait
 * descriptor are sent to the confirmation route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cameraAvailable,
  cameraPermissionState,
  dataUrlToJpeg,
  loadFaceModels,
  openCamera,
  permissionHelp,
} from "@/lib/face-client";
import { openIdCamera } from "@/lib/id-camera";
import {
  classifyCameraError,
  describeCameraProblem,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import { fingerprintFromCanvas } from "@/lib/card-fingerprint";
import { PRIMARY_POSE } from "@/lib/face";
import { useFacePoses } from "@/lib/use-face-poses";
import { useAutoFaceCapture } from "@/lib/use-auto-face-capture";
import { useAutoIdCapture } from "@/lib/use-auto-id-capture";
import { fingerprintFile } from "@/lib/card-fingerprint";
import FaceScanOverlay from "@/components/FaceScanOverlay";
import FaceCaptureGuide from "@/components/FaceCaptureGuide";

/**
 * This screen only needs the straight-on angle: a card cannot turn its head, and
 * the server compares this screen against the single front sample.
 */
const STAFF_POSES = [PRIMARY_POSE] as const;

type Props = {
  /** The ticket from step one. Single use, five minutes, and not a session. */
  ticket: string;
  /** The account's display name, so the greeting is a name rather than a title. */
  fullName?: string;
  /** Called with what the server matched, after the session cookie exists. */
  onVerified: (matchedBy: "face" | "id_card") => void;
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
  const [method, setMethod] = useState<"face" | "id_card">("face");

  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
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
      // openCamera, not openIdCamera. The rear camera is the right one for a
      // card held flat on a table and the wrong one for a face, and there is no
      // way to know which this is until the frame is read.
      const stream = method === "id_card" ? await openIdCamera() : await openCamera();
      streamRef.current = stream;

      // Only the stream is stored here. setLive mounts the <video>, and
      // attachStream hands it the stream on that mount — see its comment.
      setProgress(null);
      setLive(true);
      setMessage(
        method === "id_card"
          ? "Center the front of your ID inside the guide."
          : "Look into the camera and hold still."
      );
    } catch (e) {
      stopCamera();
      const problem = classifyCameraError(e);
      setBlocked(problem);
      setMessage(describeCameraProblem(problem).message);
    }
  }, [method, stopCamera]);

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
   * Send one presentation: a face embedding (from the automatic scan or a manual
   * read), the card hash of the frame currently in view, and the ID-card
   * portrait's embedding. The server tries the face first, then the card.
   */
  const submitFrame = useCallback(
    async (faceEmbedding: number[] | null, capturedCardHash?: string | null) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const video = videoRef.current;
      setBusy(true);
      setMessage(null);

      try {
        // One canvas, two readings. Sized to the video's own dimensions so the
        // fingerprint is taken at a resolution comparable to enrolment.
        let cardHash: string | null = capturedCardHash ?? null;
        if (capturedCardHash === undefined && video && video.videoWidth) {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            // The card hash does not care what the detector thought, which is
            // what makes one presentation safe for either subject.
            cardHash = fingerprintFromCanvas(canvas);
          }
        }

        if (!faceEmbedding && !cardHash) {
          setMessage(
            "Nothing recognisable in that. Fill the frame with your face, or with the front of your ID card."
          );
          return;
        }

        let idFaceEmbedding: number[] | null = null;
        try {
          const imgRes = await fetch(
            `/api/auth/staff/id-image?ticket=${encodeURIComponent(ticket)}`
          );
          if (imgRes.ok) {
            const imgData = await imgRes.json();
            const dataUrl: string = imgData.image ?? "";
            if (dataUrl) {
              const jpeg = await dataUrlToJpeg(dataUrl);
              const img = new Image();
              img.src = jpeg;
              await img.decode().catch(() => {});
              if (img.naturalWidth > 0) {
                const idFace = await readFaceFor(engine, img);
                if (idFace.ok) idFaceEmbedding = idFace.embedding;
              }
            }
          }
        } catch {
          // The ID card image may be missing or unreadable; skip silently.
        }

        const res = await fetch("/api/auth/staff/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket,
            face_embedding: faceEmbedding,
            card_hash: cardHash,
            id_face_embedding: idFaceEmbedding,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          setMessage(data.error || "That did not match.");
          if (data.expired || res.status === 401) {
            // A spent or expired ticket cannot be recovered from here, and the
            // honest thing is to say so rather than loop the person on a button
            // that will never work.
            setMessage(
              data.error && data.expired
                ? data.error
                : "That did not match. Check your password to start again."
            );
          }
          return;
        }

        stopCamera();
        onVerified(data.matched_by === "id_card" ? "id_card" : "face");
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
   * The manual fallback. Reads the face from the live frame (a card simply reads
   * as no face), then hands off to the same submit. Used only when the automatic
   * scan has given up — see `scan.showManual`.
   */
  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setMessage("The camera is not showing anything yet.");
      return;
    }

    if (method === "id_card") {
      await submitFrame(null);
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
      // A face model that will not run leaves the card reading intact.
    }

    await submitFrame(faceEmbedding);
  }, [engine, method, submitFrame]);

  /*
   * Automatic capture for the face path. A card cannot satisfy the pose gate —
   * it is not a face — so a card user sees the manual fallback once the no-face
   * timeout passes. Six seconds rather than the usual thirty: this screen is a
   * queue at a till, and someone holding a card should not have to wait half a
   * minute for a button that is the only thing their subject can use.
   */
  const scan = useAutoFaceCapture({
    sequence: poses,
    videoRef,
    active: live && method === "face",
    poses: STAFF_POSES,
    noFaceTimeoutMs: 6_000,
    onComplete: (frames) => void submitFrame(frames[0]?.embedding ?? null),
  });

  const submitScannedId = useCallback(
    async (file: File) => {
      await submitFrame(null, await fingerprintFile(file));
    },
    [submitFrame]
  );

  const idScan = useAutoIdCapture({
    videoRef,
    active: live && method === "id_card",
    paused: busy,
    onCapture: submitScannedId,
  });

  const submitIdFile = useCallback(
    async (file: File) => {
      await submitFrame(null, await fingerprintFile(file));
    },
    [submitFrame]
  );

  const problem = blocked ? describeCameraProblem(blocked) : null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4 sm:px-5">
        <h2 className="text-xl font-semibold text-cocoa-800">
          {fullName ? `Hello ${fullName.split(" ")[0]}` : "One more thing"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-cocoa-600">
          Your password is right. Choose a face scan or scan the ID card on your
          account to confirm it is you.
        </p>
      </div>

      {!live ? (
        <div className="space-y-4 rounded-2xl border border-cream-200 bg-white p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Choose sign-in check">
            {([
              ["face", "Face scan", "Use the front camera"],
              ["id_card", "ID card", "Use the card on your account"],
            ] as const).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                aria-pressed={method === value}
                onClick={() => {
                  setMethod(value);
                  setBlocked(null);
                  setMessage(null);
                }}
                className={`rounded-xl border px-3 py-3 text-left transition ${
                  method === value
                    ? "border-ochre-400 bg-ochre-50 ring-1 ring-ochre-300"
                    : "border-cream-200 bg-white hover:bg-cream-50"
                }`}
              >
                <span className="block text-sm font-semibold text-cocoa-800">{label}</span>
                <span className="mt-1 block text-[11px] leading-snug text-cocoa-500">{hint}</span>
              </button>
            ))}
          </div>

          <p className="text-xs leading-relaxed text-cocoa-500">
            The ID finds the account; your face or the card already on file confirms it.
          </p>

          <button
            type="button"
            onClick={start}
            disabled={Boolean(progress)}
            className="w-full min-h-12 rounded-xl bg-cream-400 px-4 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300 disabled:opacity-60"
          >
            {progress
              ? `Loading the reader… ${progress.loaded}/${progress.total}`
              : "Open the camera"}
          </button>

          {method === "id_card" && (
            <label className="btn-ghost block w-full cursor-pointer text-center text-sm">
              Use a photo of the ID instead
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void submitIdFile(file);
                }}
              />
            </label>
          )}

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
              className={`mx-auto ${
                method === "id_card"
                  ? "aspect-[4/3] max-h-[50vh] w-full max-w-xl object-contain"
                  : "aspect-[4/5] max-h-[65vh] w-full max-w-sm object-cover"
              } rounded-xl`}
            />
            {method === "id_card" && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center p-5"
              >
                <div className="aspect-[1.59/1] w-[88%] max-w-[28rem] rounded-xl border-2 border-dashed border-cream-100/90 shadow-[0_0_0_999px_rgba(22,18,14,0.32)]" />
              </div>
            )}
            {method === "face" && scan.phase === "scanning" && (
              <FaceScanOverlay step={1} total={1} />
            )}
            {method === "face" && scan.phase === "prompt" && (
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

          {method === "id_card" && !busy && (
            <div className="space-y-2 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3">
              <div className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                    idScan.phase === "hold"
                      ? "bg-green-600"
                      : idScan.phase === "capturing"
                        ? "animate-pulse bg-ochre-500"
                        : "bg-cocoa-300"
                  }`}
                />
                <p role="status" aria-live="polite" className="text-xs font-medium text-cocoa-700">
                  {idScan.message}
                </p>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-cream-200"
                role="progressbar"
                aria-label="ID steadiness"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(idScan.holdProgress * 100)}
              >
                <div
                  className="h-full rounded-full bg-ochre-500 transition-[width] duration-200"
                  style={{ width: `${Math.round(idScan.holdProgress * 100)}%` }}
                />
              </div>
              <p className="text-[10px] leading-snug text-cocoa-400">
                Keep the whole card flat inside the guide. Automatic capture checks only visible
                detail and steadiness — it does not verify whether the ID is genuine.
              </p>
            </div>
          )}

          {busy ? (
            <p role="status" className="text-center text-xs text-cocoa-500">
              Checking your sign-in…
            </p>
          ) : method === "id_card" ? (
            <button
              type="button"
              onClick={() => void idScan.captureManually()}
              className="w-full min-h-12 rounded-xl bg-cream-400 px-4 py-3 text-sm font-semibold text-cocoa-900 transition hover:bg-cream-300"
            >
              Capture ID now
            </button>
          ) : scan.showManual ? (
            /*
             * The manual fallback. Hidden while the automatic scan is working;
             * it appears after repeated failures or once the no-face timeout
             * passes (which is how a card user reaches it).
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

          {method === "id_card" && idScan.phase === "manual" && !busy && (
            <button
              type="button"
              onClick={idScan.resume}
              className="w-full text-center text-xs text-cocoa-500 underline"
            >
              Try the guided scan again
            </button>
          )}

          {!busy && (
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setBlocked(null);
                setMessage(null);
                setMethod((value) => (value === "face" ? "id_card" : "face"));
              }}
              className="w-full text-center text-xs text-cocoa-500 underline"
            >
              Switch to {method === "face" ? "ID card" : "face"} scan
            </button>
          )}
        </div>
      )}

      {live && method === "id_card" && (
        <label className="btn-ghost block w-full cursor-pointer text-center text-sm">
          Choose an ID photo instead
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void submitIdFile(file);
            }}
          />
        </label>
      )}

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

      {/*
        The loop's own message is shown by the guide while it is running. It only
        belongs down here once the guide is gone — after a give-up, where the
        reason for it is the whole point of the manual step.
      */}
      {!problem && (message || (live && scan.showManual && scan.message)) && (
        <p role="status" className="text-center text-xs leading-relaxed text-cocoa-500">
          {message ?? scan.message}
        </p>
      )}
    </div>
  );
}
