"use client";

/**
 * The live guide drawn over the camera while an angle is being asked for.
 *
 * ## What it is for
 *
 * The capture loop used to be silent between prompts: the person was told "turn
 * your head to your left", the screen showed nothing, and then either the next
 * prompt appeared or the same one did. Nothing said whether the camera could see
 * them, whether they had turned enough, or whether the frame had been kept. That
 * is indistinguishable from a broken camera, and it is why people hold a pose
 * that is already good and then get refused for it.
 *
 * The live preview stays open around the person's face. A compact status at the
 * top identifies the requested angle; a small instruction panel at the bottom
 * explains the next adjustment and shows the angle/hold progress.
 *
 * Avoid a face-shaped target over the camera image: real faces sit at different
 * heights and the illustration can obscure the very features the camera needs.
 * The yaw meter and `hintFor` expose the gate's actionable feedback instead.
 *
 * ## No scores
 *
 * There is no similarity percentage and no "confidence". The meter shows head
 * angle, which is what the gate decides on; a number that looked like a match
 * score would imply the recognition result is already known here, and it is not
 * — that is the server's call. The one thing this deliberately shows is *pose*,
 * because pose is the part the person can still fix.
 *
 * `?pose=debug` adds the raw angles and the block reason. It exists because "it
 * says turn more when I am already turned" cannot be diagnosed from the meter
 * alone — it needs the number, and the number is what this prints.
 */
import { useEffect, useState } from "react";

import { POSE_COPY, type FacePose } from "@/lib/face";
import {
  FRONT_MAX_YAW,
  SIDE_MAX_YAW,
  SIDE_MIN_YAW,
  type PoseState,
} from "@/lib/head-pose";

type Props = {
  /** Every angle this presentation collects, in order. */
  poses: readonly FacePose[];
  /** The angle being asked for now. */
  activePose: FacePose;
  /** The angles already captured. */
  done: readonly FacePose[];
  /** The last cheap gate's decision, or null when it saw no face. */
  state: PoseState | null;
  /** 0..1 through the hold-still window. */
  holdProgress: number;
  /** The angle just accepted, for a brief "Got it". */
  flashPose: FacePose | null;
  /** A refusal from the loop, which outranks the derived hint. */
  message: string | null;
};

/** The yaw range the meter covers, in degrees either side of straight on. */
const METER_DEG = 80;

/**
 * The band of yaw that satisfies an angle, in degrees.
 *
 * Mirrors the constants in lib/head-pose.ts rather than restating the numbers, so
 * the guide cannot show a target the gate would refuse.
 */
function targetBand(pose: FacePose): [number, number] {
  if (pose === "front") return [-FRONT_MAX_YAW, FRONT_MAX_YAW];
  if (pose === "left") return [SIDE_MIN_YAW, SIDE_MAX_YAW];
  return [-SIDE_MAX_YAW, -SIDE_MIN_YAW];
}

/** Where a yaw sits on the meter, as a percentage from the left edge. */
function meterPercent(yaw: number): number {
  const clamped = Math.max(-METER_DEG, Math.min(METER_DEG, yaw));
  return ((clamped + METER_DEG) / (METER_DEG * 2)) * 100;
}

/** How a completed angle is named in the flash, in the past tense. */
const DONE_COPY: Record<FacePose, string> = {
  front: "straight on",
  left: "left turn",
  right: "right turn",
};

/**
 * One sentence telling the person what to change.
 *
 * The order matters: an explicit message from the loop (bad light, a refused
 * read) wins, because it was written for the exact failure. After that the block
 * reason decides, because the four ways of failing need opposite corrections —
 * "too far round" and "not far enough" are the same null pose and used to get the
 * same sentence, which sent people further in the wrong direction.
 */
function hintFor(
  active: FacePose,
  state: PoseState | null,
  holdProgress: number,
  message: string | null
): string {
  if (message) return message;
  if (!state) return "Looking for your face — move into the light and face the camera.";

  const { pose, block, yaw, pitch } = state;
  if (pose === active) {
    return holdProgress >= 1 ? "Hold still…" : "That is it — hold still.";
  }

  if (block === "too-far") return "A little less — that is too far round.";
  if (block === "tilted") {
    return active === "front"
      ? "Keep your head level and look straight ahead."
      : "Keep your head level as you turn.";
  }
  if (block === "pitched") {
    return Number.isFinite(pitch) && pitch > 0
      ? "Lift your chin a little."
      : "Lower your chin a little.";
  }

  // Between straight on and turned.
  if (active === "front") return "Straighten up to face the camera.";
  if (pose === "front") return `Turn your head to your ${active}.`;

  // A decided pose on the other side.
  if (pose !== null) {
    return `You have turned to your ${pose} — turn the other way, to your ${active}.`;
  }

  const magnitude = Math.abs(yaw);
  return Number.isFinite(magnitude) && magnitude < SIDE_MIN_YAW
    ? `Turn your head a little further to your ${active}.`
    : `Turn your head to your ${active}.`;
}

export default function FaceCaptureGuide({
  poses,
  activePose,
  done,
  state,
  holdProgress,
  flashPose,
  message,
}: Props) {
  const inBand = state?.pose === activePose;
  const yaw = state && Number.isFinite(state.yaw) ? state.yaw : null;
  const hint = hintFor(activePose, state, holdProgress, message);
  const [bandFrom, bandTo] = targetBand(activePose);

  /*
   * The raw angles, for the one question a meter cannot answer: is the gate
   * under-reading, or is it refusing for a reason the words got wrong? Dev only —
   * a customer-facing screen has no business printing radians.
   */
  const [debug, setDebug] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    setDebug(new URLSearchParams(window.location.search).get("pose") === "debug");
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3 sm:p-4">
      <div className="flex items-center justify-between self-center rounded-full bg-cocoa-900/80 px-3.5 py-2 text-xs text-cream-100 shadow-sm backdrop-blur-sm">
        <span className="font-semibold">{POSE_COPY[activePose].label}</span>
        <span className="ml-2 border-l border-cream-100/25 pl-2 text-cream-100/70">
          View {Math.min(done.length + 1, poses.length)} of {poses.length}
        </span>
      </div>

      <div className="space-y-2 rounded-2xl bg-cocoa-900/85 px-3.5 py-3 text-center text-cream-100 shadow-lg backdrop-blur-sm sm:px-4 sm:py-3.5">
        {flashPose ? (
          <p role="status" className="text-sm font-semibold text-sage-300">
            ✓ Got it — {DONE_COPY[flashPose]}
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold leading-snug sm:text-base">
              {POSE_COPY[activePose].instruction}
            </p>
            <p role="status" aria-live="polite" className="text-xs leading-relaxed text-cream-100/80 sm:text-sm">
              {hint}
            </p>
          </>
        )}

        {holdProgress > 0 && (
          <div
            role="progressbar"
            aria-label="Hold still to capture"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(holdProgress * 100)}
            className="h-1 overflow-hidden rounded-full bg-cream-100/20"
          >
            <div
              className="h-full rounded-full bg-sage-400 transition-[width] duration-150"
              style={{ width: `${Math.round(holdProgress * 100)}%` }}
            />
          </div>
        )}

        <div className="mx-auto w-full max-w-[220px]">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-cream-100/20">
            <div
              className={`absolute inset-y-0 rounded-full ${inBand ? "bg-sage-400" : "bg-cream-100/70"}`}
              style={{
                left: `${meterPercent(bandFrom)}%`,
                width: `${meterPercent(bandTo) - meterPercent(bandFrom)}%`,
              }}
            />
            {yaw !== null && (
              <div
                className={`absolute inset-y-0 w-0.5 rounded-full ${
                  inBand ? "bg-white" : "bg-cream-100"
                }`}
                style={{ left: `${meterPercent(yaw)}%` }}
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-cream-100/60">
            <span>your right</span>
            <span>your left</span>
          </div>
        </div>

        {debug && (
          <p className="font-mono text-[10px] leading-tight text-cream-100/65">
            yaw {Number.isFinite(state?.yaw ?? NaN) ? state!.yaw.toFixed(1) : "—"}° ·
            pitch {Number.isFinite(state?.pitch ?? NaN) ? state!.pitch.toFixed(1) : "—"}° ·
            roll {Number.isFinite(state?.roll ?? NaN) ? state!.roll.toFixed(1) : "—"}° ·
            {state ? (state.block ?? state.pose ?? "—") : "no face"}
          </p>
        )}
      </div>
    </div>
  );
}
