"use client";

/**
 * Capture a face for enrolment — three angles, in order.
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
 * ## The pose is checked, not assumed
 *
 * A frame is filed under an angle only when the landmarks agree that the head is
 * turned that way (`poseFromSignal`), so a side slot cannot be filled with
 * another straight-on photo — the mistake an admin would make while holding a
 * queue. The signal is also sent with the photo so the server can refuse the same
 * mistake if the browser's copy of this is ever rewritten.
 *
 * ## Two ways in, as before
 *
 *   camera  — a live preview per angle, with the prompt for that angle on screen
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
import { readFaceFor, useFaceEngine, type EngineRead } from "@/lib/face-engine";
import {
  FACE_POSES,
  PRIMARY_POSE,
  POSE_COPY,
  type FaceEngine,
  type FacePose,
  fileFrame,
  poseAlreadyHeld,
  poseFromSignal,
  poseRefusal,
} from "@/lib/face";
import {
  classifyCameraError,
  describeCameraProblem,
  probeCamera,
  type CameraProblem,
} from "@/lib/face-diagnostics";

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
  /** Whatever has been captured so far. The straight-on one is the required one. */
  shots: FaceShot[];
};

type Props = {
  /** Called every time the set changes, so a form can hold a partial enrolment. */
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
  | "reading"
  | "no-camera"
  | "denied"
  | "models-missing";

/** What the person is asked to do for each angle. One source for every screen. */

export default function FaceCapture({ onCapture, currentPhoto, disabled }: Props) {
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

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /** The angles still missing, in capture order. */
  const missing = FACE_POSES.filter((pose) => !shots[pose]);
  const capturedPoses = FACE_POSES.filter((pose) => shots[pose]);
  const frontCaptured = Boolean(shots[PRIMARY_POSE]);

  /* Anything that holds the camera open while the panel is closed would keep a
   * green privacy light on after someone thought they had stopped. */
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
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

  /** Publish the set upwards, in capture order. */
  const publish = useCallback(
    (next: Partial<Record<FacePose, FaceShot>>) => {
      setShots(next);
      onCapture({ shots: FACE_POSES.map((pose) => next[pose]).filter(Boolean) as FaceShot[] });
    },
    [onCapture]
  );

  const openFor = useCallback(
    async (pose: FacePose) => {
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

      setActivePose(pose);
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
    const next = missing[0] ?? PRIMARY_POSE;
    void openFor(next);
  }, [missing, openFor]);

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
   * Returns whether the frame was filed, and which angle is asked for next (null
   * when the set is complete). The caller needs the second half to know whether
   * to keep the camera open.
   */
  const accept = useCallback(
    (
      expected: FacePose,
      read: Extract<EngineRead, { ok: true }>,
      photo: string
    ): { accepted: boolean; nextPose: FacePose | null } => {
      const seen = poseFromSignal(read.poseSignal);
      const held = FACE_POSES.filter((pose) => shots[pose]);
      const filing = fileFrame({ expected, seen, held });

      if (filing.kind === "turn-more") {
        setMessage(poseRefusal(expected, null));
        return { accepted: false, nextPose: null };
      }

      if (filing.kind === "already-have") {
        const missing = FACE_POSES.find((pose) => !held.includes(pose)) ?? null;
        setMessage(poseAlreadyHeld(filing.pose, missing));
        return { accepted: false, nextPose: null };
      }

      // Filed under the angle the frame actually shows — normally the one asked
      // for, and sometimes the one next to it. See fileFrame.
      const next = {
        ...shots,
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

      const nextMissing = FACE_POSES.filter((pose) => !next[pose]);
      if (nextMissing.length === 0) {
        stopCamera();
        setPhase("idle");
        return { accepted: true, nextPose: null };
      }

      setActivePose(nextMissing[0]);
      return { accepted: true, nextPose: nextMissing[0] };
    },
    [shots, publish, stopCamera, enrolmentEngine]
  );

  /** Take one frame and turn it into a photo plus an embedding. */
  const grab = useCallback(
    async (source: HTMLVideoElement, w: number, h: number) => {
      setPhase("reading");
      setMessage(null);
      try {
        const photo = toJpegDataUrl(source, w, h);
        const read = await readFaceFor(enrolmentEngine, source);
        if (!read.ok) {
          setPhase("camera");
          setMessage(read.message);
          return;
        }
        const { accepted, nextPose } = accept(activePose, read, photo);
        if (!accepted) {
          setPhase("camera");
          return;
        }
        setPhase(nextPose ? "camera" : "idle");
      } catch {
        setPhase("camera");
        setMessage("That photo could not be read. Try again in better light.");
      }
    },
    [accept, activePose, enrolmentEngine]
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
      const next = { ...shots };
      delete next[pose];
      publish(next);
      setActivePose(pose);
      setMessage(null);
      if (phase !== "camera") void openFor(pose);
    },
    [shots, publish, phase, openFor]
  );

  const pct =
    progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  const busy =
    phase === "checking-models" || phase === "loading-models" || phase === "reading";

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
          Three photos: straight on, then turned to their left, then their right.
          The turned ones are what stop a printed photo being held up at the till,
          so they are worth getting right.
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
            {POSE_COPY[activePose].instruction}
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
              Take the {POSE_COPY[activePose].short} photo
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                stopCamera();
                setPhase("idle");
                setActivePose(missing[0] ?? PRIMARY_POSE);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {busy && (
        <div className="rounded-xl bg-cream-50 px-3.5 py-3 text-sm text-cocoa-700">
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

      {message && (
        <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-cocoa-700">
          {message}
        </div>
      )}

      {/* The three slots, always visible, so it is obvious what is done and what
          is left. Clicking a filled one retakes just that angle. */}
      {(capturedPoses.length > 0 || currentPhoto) && phase !== "camera" && (
        <div className="grid grid-cols-3 gap-2">
          {FACE_POSES.map((pose) => {
            const shot = shots[pose];
            return (
              <div key={pose} className="rounded-xl border border-cream-200 bg-cream-50 p-1.5">
                {shot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={shot.photo}
                    alt={`The ${POSE_COPY[pose].short} photo`}
                    className="h-20 w-full rounded-lg object-cover"
                  />
                ) : pose === PRIMARY_POSE && currentPhoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={currentPhoto}
                    alt="The straight-on photo already on file"
                    className="h-20 w-full rounded-lg object-cover opacity-60"
                  />
                ) : (
                  <div className="flex h-20 w-full items-center justify-center rounded-lg border border-dashed border-cream-300 text-[11px] text-cocoa-400">
                    Not taken
                  </div>
                )}
                <p className="mt-1 text-center text-[11px] font-semibold text-cocoa-600">
                  {POSE_COPY[pose].label}
                </p>
                {shot && (
                  <button
                    type="button"
                    className="mt-0.5 w-full text-center text-[11px] text-cocoa-500 underline"
                    disabled={disabled}
                    onClick={() => retake(pose)}
                  >
                    Retake
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {(phase === "idle" || phase === "no-camera" || phase === "denied") && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {cameraAvailable() ? (
              <button
                type="button"
                className="btn-primary"
                disabled={disabled}
                onClick={startCamera}
              >
                {missing.length === FACE_POSES.length
                  ? "Take the photos"
                  : `Take the ${POSE_COPY[activePose].short} photo`}
              </button>
            ) : (
              <label className="btn-primary inline-flex cursor-pointer items-center justify-center">
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

          {/* Only offered when the straight-on photo exists: it is the one the
              system cannot work without. */}
          {frontCaptured && missing.length > 0 && (
            <p className="text-[11px] text-cocoa-500">
              You can save with the straight-on photo alone — the account will be
              checked on that one. The turned photos are what make the check
              stronger, so add them when you can.
            </p>
          )}

          {!cameraAvailable() && (
            <div className="rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs text-cocoa-700">
              <p className="font-semibold text-cocoa-800">{captureHint()}</p>
              <p className="mt-1">{cameraUnavailableReason()}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}




