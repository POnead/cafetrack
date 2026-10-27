"use client";

/**
 * Capture a face for enrolment — three angles, in order, without a button.
 *
 * Straight on, then turned to the person's own left, then to their right. The
 * three are collected here rather than in three separate visits because the
 * point of the angles is that they belong to one enrolment: a side photo stored
 * against an account submitted separately would leave the account half-enrolled
 * whenever the second visit did not happen.
 *
 * ## Why the angles at all
 *
 * One frontal vector is enough to recognise a face that is looking at the camera,
 * which is the common case and the one that already worked. The turned-head
 * frames are for the check: a still photograph cannot produce one, so asking for
 * them at the till is what makes a printed portrait held up to the camera fail.
 * See `matchPresentation` in lib/face.ts.
 *
 * ## Automatic, like the check screens
 *
 * This screen used to be the last one asking for a button press, and the button
 * was gated on a pose the person could not see. The result was a queue of admins
 * turning their heads at a camera that said "not far enough" and gave them
 * nothing to aim at. It now runs the same loop the till runs
 * (`useAutoFaceCapture`): prompt, watch, read, flash, next angle. The manual
 * "take it now" appears only after the loop gives up, which is the same fallback
 * the check screens offer.
 *
 * ## The pose is checked, not assumed
 *
 * A frame is filed under an angle only when the landmarks agree that the head is
 * turned that way (`poseStateOfRead`), so a side slot cannot be filled with
 * another straight-on photo — the mistake an admin would make while holding a
 * queue. The signal is also sent with the photo so the server can refuse the same
 * mistake if the browser's copy of this is ever rewritten.
 *
 * ## Two ways in, as before
 *
 *   camera  — a live preview, the guide, and the angles collected on their own
 *   file    — choose a photo for whichever angle is next
 *
 * Both produce the same thing: a small JPEG and a 128-float embedding, produced
 * in the browser by lib/face-client. The server never computes an embedding.
 *
 * Nothing here knows about users or roles; it collects photographs and hands
 * back the set.
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
  toJpegDataUrl,
} from "@/lib/face-client";
import {
  poseStateOfRead,
  readFaceFor,
  useFaceEngine,
  type EngineRead,
} from "@/lib/face-engine";
import {
  FACE_POSES,
  PRIMARY_POSE,
  POSE_COPY,
  type FaceEngine,
  type FacePose,
  fileFrame,
  poseAlreadyHeld,
  poseRefusal,
} from "@/lib/face";
import {
  classifyCameraError,
  describeCameraProblem,
  probeCamera,
  type CameraProblem,
} from "@/lib/face-diagnostics";
import { useFacePoses, type PoseFrame } from "@/lib/use-face-poses";
import { useAutoFaceCapture } from "@/lib/use-auto-face-capture";
import FaceCaptureGuide from "@/components/FaceCaptureGuide";
import FaceScanOverlay from "@/components/FaceScanOverlay";

/** One captured angle, ready to be sent to the server. */
export type FaceShot = {
  pose: FacePose;
  /** A ~30KB JPEG data URL. */
  photo: string;
  /** 128 floats, sent alongside the photo and stored as text. */
  embedding: number[];
  /**
   * Which engine produced the embedding.
   *
   * Sent with the photo so the server records the truth about the vector rather
   * than guessing from a setting that may have changed since the page loaded.
   */
  model: FaceEngine;
  /** How far the head was turned when it was read. See headTurnSignal. */
  poseSignal: number | null;
  /** Detector confidence, 0..1. */
  quality: number;
};

export type FaceCaptureResult = {
  /** Whatever has been captured so far. All three poses are required to save. */
  shots: FaceShot[];
};

type Props = {
  /** Called every time the set changes, so a form can hold a partial enrolment. */
  onCapture: (result: FaceCaptureResult) => void;
  /** Existing photos, keyed by pose, to show while replacing an enrolment. */
  currentPhotos?: Partial<Record<FacePose, string | null>>;
  disabled?: boolean;
};

type Phase =
  | "idle"
  | "checking-models"
  | "loading-models"
  | "camera"
  | "reading"
  | "no-camera"
  | "denied"
  | "models-missing";

export default function FaceCapture({ onCapture, currentPhotos, disabled }: Props) {
  /*
   * Enrolment uses the same engine the cafe verifies with, always.
   *
   * It is tempting to capture new enrolments in the newer engine while the cafe
   * still verifies with the old one, but that produces an account nothing can
   * verify — the vectors are in a space the matcher is not reading. An account
   * only ever holds vectors from the engine in use, which means a migration is a
   * deliberate switch followed by re-enrolment, not something that happens
   * quietly at the side.
   */
  const enrolmentEngine = useFaceEngine();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [shots, setShots] = useState<Partial<Record<FacePose, FaceShot>>>({});
  const [activePose, setActivePose] = useState<FacePose>(PRIMARY_POSE);
  const [blocked, setBlocked] = useState<CameraProblem | null>(null);

  /*
   * The angles this camera session is collecting.
   *
   * Frozen when the camera opens, and null when it is closed. A retake collects
   * one angle; a fresh enrolment collects whatever is missing. It has to be a
   * snapshot rather than `missing`, because `missing` shrinks as frames land and
   * the sequence would then consider itself complete early.
   */
  const [session, setSession] = useState<readonly FacePose[] | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /*
   * The set as the last publish left it.
   *
   * The capture loop reads this from callbacks that fire between renders, so it
   * cannot rely on the `shots` closure being current.
   */
  const shotsRef = useRef<Partial<Record<FacePose, FaceShot>>>({});
  shotsRef.current = shots;

  /** The angles still missing, in capture order. */
  const missing = FACE_POSES.filter((pose) => !shots[pose]);
  const capturedPoses = FACE_POSES.filter((pose) => shots[pose]);

  /* Anything that holds the camera open while the panel is closed would keep a
   * green privacy light on after someone thought they had stopped. */
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setSession(null);
  }, []);

  const attachStream = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (!node) return;
    const stream = streamRef.current;
    if (!stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {});
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  /** Publish the set upwards, in capture order. */
  const publish = useCallback(
    (next: Partial<Record<FacePose, FaceShot>>) => {
      shotsRef.current = next;
      setShots(next);
      onCapture({ shots: FACE_POSES.map((pose) => next[pose]).filter(Boolean) as FaceShot[] });
    },
    [onCapture]
  );

  /*
   * An angle landed while the camera was open.
   *
   * Published straight away rather than at the end of the set: someone can cancel
   * after two angles, or close the dialog, and those two are still good. Waiting
   * for `onComplete` would throw them away — and on a slow enrolment that is a
   * minute of the admin's time.
   */
  const onFrame = useCallback(
    (frame: PoseFrame, photo: string | null) => {
      if (!photo) return;
      publish({
        ...shotsRef.current,
        [frame.pose]: {
          pose: frame.pose,
          photo,
          embedding: frame.embedding,
          model: enrolmentEngine,
          poseSignal: frame.poseSignal,
          quality: frame.quality,
        },
      });
    },
    [publish, enrolmentEngine]
  );

  /*
   * The sequence the loop drives. Separate from the file-upload path below: that
   * one reads a still and needs no loop, and the two must not share frame state
   * or a cancelled camera would leak into an upload.
   */
  const cameraPoses = useFacePoses(session ?? FACE_POSES);

  /*
   * Automatic capture. Once the camera is live the loop watches for a face, waits
   * for the head to reach the angle being asked for, reads it, and moves on — no
   * capture button while it is working. See use-auto-face-capture.
   */
  const scan = useAutoFaceCapture({
    sequence: cameraPoses,
    videoRef,
    active: phase === "camera",
    poses: session ?? FACE_POSES,
    /*
     * The photo is grabbed at the same instant as the embedding, so the JPEG and
     * the 128 floats always describe the same frame.
     */
    capturePhoto: (video) =>
      toJpegDataUrl(video, video.videoWidth || 640, video.videoHeight || 480),
    onFrame,
    onComplete: () => {
      stopCamera();
      setPhase("idle");
      setMessage(null);
    },
  });

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
      const reason =
        e?.message && !/load|fetch|network|weights/i.test(e.message)
          ? e.message
          : "The face model could not be downloaded. Check the connection to this address and try again.";
      setMessage(reason);
      console.error("face model load failed:", e);
      return false;
    }
  }, []);

  const openFor = useCallback(
    async (sessionPoses: readonly FacePose[]) => {
      setMessage(null);
      setBlocked(null);

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

      setSession(sessionPoses);
      setActivePose(sessionPoses[0] ?? PRIMARY_POSE);
      setPhase("checking-models");
      if (!(await warmUp())) return;

      setPhase("camera");
      try {
        streamRef.current = await openCamera();
        attachStream(videoRef.current);
      } catch (e) {
        stopCamera();
        const problem = classifyCameraError(e);
        setBlocked(problem);
        setPhase(problem === "permission-denied" ? "denied" : "no-camera");
      }
    },
    [warmUp, stopCamera, attachStream]
  );

  const startCamera = useCallback(() => {
    void openFor(missing);
  }, [missing, openFor]);

  const cancelCamera = useCallback(() => {
    stopCamera();
    setPhase("idle");
    setMessage(null);
    setActivePose(missing[0] ?? PRIMARY_POSE);
  }, [stopCamera, missing]);

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
    setPhase(diagnosis.problem === "permission-denied" ? "denied" : "no-camera");
  }, []);

  /**
   * Turn one read into a stored angle, or say why it cannot be one.
   *
   * Used by the file-upload path only; the camera path files frames through
   * `useFacePoses`. Returns whether the frame was filed.
   */
  const accept = useCallback(
    (
      expected: FacePose,
      read: Extract<EngineRead, { ok: true }>,
      photo: string
    ): { accepted: boolean } => {
      const state = poseStateOfRead(read);
      const held = FACE_POSES.filter((pose) => shotsRef.current[pose]);
      const filing = fileFrame({ expected, seen: state.pose, held });

      if (filing.kind === "turn-more") {
        // Too far round, tilted, pitched, or between angles — and the refusal
        // names which. See poseRefusal.
        setMessage(poseRefusal(expected, state));
        return { accepted: false };
      }

      if (filing.kind === "already-have") {
        const left = FACE_POSES.find((pose) => !held.includes(pose)) ?? null;
        setMessage(poseAlreadyHeld(filing.pose, left));
        return { accepted: false };
      }

      // Filed under the angle the frame actually shows — normally the one asked
      // for, and sometimes the one next to it. See fileFrame.
      const next = {
        ...shotsRef.current,
        [filing.pose]: {
          pose: filing.pose,
          photo,
          embedding: read.embedding,
          model: enrolmentEngine,
          poseSignal: read.poseSignal,
          quality: read.score,
        },
      };

      publish(next);
      setMessage(null);
      setActivePose(FACE_POSES.find((pose) => !next[pose]) ?? filing.pose);
      return { accepted: true };
    },
    [publish, enrolmentEngine]
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;

      /*
       * Which angle this file is for, decided now rather than from state.
       *
       * The picker is a child of a label that also moves the active angle, and a
       * state write does not land before this handler runs — reading `missing`
       * here is the only way the upload is filed under the angle the admin can
       * see on screen.
       */
      const target = missing[0] ?? activePose;
      setActivePose(target);
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
            const photo = await dataUrlToJpeg(raw);
            const read = await readFaceFor(enrolmentEngine, img);
            if (!read.ok) {
              setPhase("idle");
              setMessage(read.message);
              return;
            }
            accept(target, read, photo);
            setPhase("idle");
          } catch (e) {
            console.error("face read failed for an uploaded photo:", e);
            setPhase("idle");
            setMessage("That photo could not be read. Try another one.");
          }
        };
        img.src = raw;
      };
      reader.readAsDataURL(file);
    },
    [warmUp, accept, activePose, missing, enrolmentEngine]
  );

  const retake = useCallback(
    (pose: FacePose) => {
      // Drop the angle and ask for it again, without losing the others.
      const next = { ...shotsRef.current };
      delete next[pose];
      publish(next);
      setActivePose(pose);
      setMessage(null);
      if (phase !== "camera") void openFor([pose]);
    },
    [publish, phase, openFor]
  );

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  const busy =
    phase === "checking-models" || phase === "loading-models" || phase === "reading";

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-cream-200 bg-cream-50 p-4 sm:p-5">
        <div className="mb-4">
          <p className="text-sm font-semibold text-cocoa-800">Capture three views</p>
          <p className="mt-1 text-xs leading-relaxed text-cocoa-500">
            Capture the straight-on, left-turn, and right-turn views. All three
            are required to save a face enrolment.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {FACE_POSES.map((pose, index) => {
            const shot = shots[pose];
            const hasExistingPhoto = Boolean(currentPhotos?.[pose]);
            const complete = Boolean(shot || hasExistingPhoto);
            return (
              <div
                key={pose}
                className={`min-w-0 rounded-xl border p-2.5 text-center sm:p-3 ${
                  complete
                    ? "border-sage-100 bg-white"
                    : "border-cream-200 bg-white/70"
                }`}
              >
                <div className="flex items-center justify-center gap-1.5">
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
                      complete
                        ? "bg-sage-500 text-white"
                        : "bg-cream-200 text-cocoa-600"
                    }`}
                  >
                    {complete ? "✓" : index + 1}
                  </span>
                  <span
                    className="hidden rounded-full bg-ochre-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cocoa-700 sm:inline"
                  >
                    Required
                  </span>
                </div>
                <p className="mt-2 flex min-h-8 items-center justify-center text-[11px] font-semibold leading-tight text-cocoa-700 sm:text-xs">
                  {POSE_COPY[pose].label}
                </p>
                <p className="mt-0.5 text-[10px] text-cocoa-400">
                  {shot
                    ? "Captured"
                    : hasExistingPhoto
                      ? "On file"
                      : pose === missing[0]
                        ? "Next"
                        : "Required"}
                </p>
              </div>
            );
          })}
        </div>
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

      {(phase === "denied" || phase === "no-camera") && (
        <div
          role="status"
          className={`rounded-2xl px-4 py-4 text-sm leading-relaxed ${
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
              ? blocked === "permission-denied" && permissionHelp("denied")
                ? permissionHelp("denied")
                : describeCameraProblem(blocked).help
              : cameraUnavailableReason() ??
                "The upload button below does the same job and is still available."}
          </p>
          <p className="mt-1">
            Until then you can still choose a photo from a file — it produces
            exactly the same result.
          </p>

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
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl bg-cocoa-900 p-2 sm:p-3">
            {/*
              The guide is positioned over the video's own box, not the panel's,
              so its status and feedback stay anchored to the live preview.
            */}
            <div className="relative mx-auto aspect-[4/5] max-h-[min(65vh,36rem)] w-full max-w-sm overflow-hidden rounded-xl">
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

          {scan.showManual && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-cocoa-700">
              <p className="font-semibold text-cocoa-800">{scan.message}</p>
              <p className="mt-1">
                The camera is not finding the angle on its own. You can take it
                by hand, or keep scanning.
              </p>
            </div>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {scan.showManual && (
              <>
                <button
                  type="button"
                  className="btn-primary min-h-11"
                  disabled={disabled}
                  onClick={() => void scan.captureNow()}
                >
                  Take the {POSE_COPY[scan.activePose].short} photo
                </button>
                <button type="button" className="btn-ghost min-h-11" onClick={scan.resume}>
                  Keep scanning
                </button>
              </>
            )}
            <button
              type="button"
              className={`btn-ghost min-h-11 ${scan.showManual ? "" : "sm:col-span-2"}`}
              onClick={cancelCamera}
            >
              Cancel
            </button>
          </div>

          <p className="rounded-xl bg-cream-50 px-3.5 py-3 text-center text-xs leading-relaxed text-cocoa-500">
            Nothing to press — each photo is taken on its own once the head is in
            the position shown. Nothing is saved until all three are done.
          </p>
        </div>
      )}

      {busy && (
        <div className="rounded-2xl border border-cream-200 bg-cream-50 px-4 py-4 text-sm text-cocoa-700">
          <div className="flex items-center gap-2.5">
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-cream-200 border-t-ochre-400" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-cocoa-800">
                {phase === "checking-models" && "Checking the face model…"}
                {phase === "loading-models" &&
                  `Loading the face model${pct > 0 ? ` — ${pct}%` : ""}`}
                {phase === "reading" && "Reading the face…"}
              </p>
              {phase === "reading" && (
                <p className="mt-0.5 text-xs text-cocoa-500">
                  Checking that there is a face here, and which way the head is
                  turned. This runs on your device.
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

      {/* While the camera is open the guide already shows this, in the place the
          person is looking. Below it would be the same sentence twice. */}
      {message && phase !== "camera" && (
        <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-cocoa-700">
          {message}
        </div>
      )}

      {/* Filled angles remain visible as photo previews; the step cards above
          keep progress clear before and after capture. */}
      {(capturedPoses.length > 0 || FACE_POSES.some((pose) => currentPhotos?.[pose])) &&
        phase !== "camera" && (
        <div className="grid grid-cols-3 gap-2.5">
          {FACE_POSES.filter((pose) => shots[pose] || currentPhotos?.[pose]).map((pose) => {
            const shot = shots[pose];
            const photo = shot?.photo ?? currentPhotos?.[pose];
            if (!photo) return null;
            return (
              <div
                key={pose}
                className="overflow-hidden rounded-xl border border-cream-200 bg-white p-1.5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photo}
                  alt={`The ${POSE_COPY[pose].short} photo`}
                  className="aspect-square w-full rounded-lg object-cover"
                />
                <div className="flex items-center justify-between gap-1 px-1 pt-2">
                  <span className="truncate text-[10px] font-semibold text-cocoa-600">
                    {POSE_COPY[pose].label}
                  </span>
                  {shot && (
                    <button
                      type="button"
                      className="shrink-0 text-[10px] font-semibold text-cocoa-500 underline"
                      disabled={disabled}
                      onClick={() => retake(pose)}
                    >
                      Retake
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(phase === "idle" || phase === "no-camera" || phase === "denied") && (
        <div className="space-y-4">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {missing.length > 0 &&
              (cameraAvailable() ? (
                <button
                  type="button"
                  className="btn-primary min-h-12"
                  disabled={disabled}
                  onClick={startCamera}
                >
                  {capturedPoses.length === 0
                    ? "Take the photos"
                    : `Take the ${POSE_COPY[missing[0]].short} photo`}
                </button>
              ) : (
                <label className="btn-primary inline-flex min-h-12 cursor-pointer items-center justify-center">
                  Take the photos
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
              ))}

            <label className="btn-ghost inline-flex min-h-12 cursor-pointer items-center justify-center">
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

          {capturedPoses.length > 0 && missing.length > 0 && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-cocoa-700">
              All three views are required. Capture the {POSE_COPY[missing[0]].short}
              {missing.length > 1 ? " and remaining views" : " view"} before saving.
            </p>
          )}

          {!cameraAvailable() && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-sm leading-relaxed text-cocoa-700">
              <p className="font-semibold text-cocoa-800">{captureHint()}</p>
              <p className="mt-1.5">{cameraUnavailableReason()}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
