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
 * A subtle head outline gives the person a framing target without blocking the
 * camera image. Its border turns green only when the requested pose is accepted.
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
  /** This step accepts either profile, not a particular direction. */
  eitherSide?: boolean;
  /** Renders the instruction and angle meter below the camera. */
  display?: "overlay" | "instructions";
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
  message: string | null,
  eitherSide: boolean
): string {
  if (message) return message;
  if (!state) return "Looking for your face — move into the light and face the camera.";

  const { pose, block, yaw, pitch } = state;
  if (pose === active || (eitherSide && (pose === "left" || pose === "right"))) {
    return holdProgress >= 1 ? "Hold still…" : "That is it — hold still.";
  }

  if (block === "too-far") return "A little less — that is too far round.";
  if (block === "signal") return "Adjust your turn slightly and hold until the outline turns green.";
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
  if (eitherSide) return "Turn your head a little to either side.";
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
  eitherSide = false,
  display = "overlay",
}: Props) {
  const inBand =
    state?.pose === activePose ||
    (eitherSide && (state?.pose === "left" || state?.pose === "right"));
  const yaw = state && Number.isFinite(state.yaw) ? state.yaw : null;
  const hint = hintFor(activePose, state, holdProgress, message, eitherSide);
  const [bandFrom, bandTo] = targetBand(activePose);
  const leftBand = targetBand("left");
  const rightBand = targetBand("right");

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

  if (display === "instructions") {
    return (
      <div className="space-y-2 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3 text-center text-cocoa-800">
        {flashPose ? (
          <p role="status" className="text-sm font-semibold text-sage-700">
            ✓ Got it — {DONE_COPY[flashPose]}
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold leading-snug">
              {eitherSide
                ? "Turn your head a little to either your left or right."
                : POSE_COPY[activePose].instruction}
            </p>
            <p role="status" aria-live="polite" className="text-xs leading-relaxed text-cocoa-600">
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
            className="h-1 overflow-hidden rounded-full bg-cream-200"
          >
            <div
              className="h-full rounded-full bg-sage-500 transition-[width] duration-150"
              style={{ width: `${Math.round(holdProgress * 100)}%` }}
            />
          </div>
        )}

        <div className="mx-auto w-full max-w-[200px]">
          <div className="relative h-1 overflow-hidden rounded-full bg-cream-200">
            {(eitherSide ? [leftBand, rightBand] : [[bandFrom, bandTo]]).map(
              ([from, to], index) => (
                <div
                  key={index}
                  className={`absolute inset-y-0 rounded-full ${inBand ? "bg-sage-500" : "bg-cocoa-400"}`}
                  style={{
                    // The preview is mirrored, so the meter runs backwards: a turn
                    // to the person's own left (positive yaw) lands on screen-left.
                    left: `${meterPercent(-to)}%`,
                    width: `${meterPercent(-from) - meterPercent(-to)}%`,
                  }}
                />
              )
            )}
            {yaw !== null && (
              <div
                className="absolute inset-y-0 w-0.5 rounded-full bg-cocoa-900"
                style={{ left: `${meterPercent(-yaw)}%` }}
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[9px] text-cocoa-500">
            <span>your left</span>
            <span>your right</span>
          </div>
        </div>

        {debug && (
          <p className="font-mono text-[10px] leading-tight text-cocoa-500">
            yaw {Number.isFinite(state?.yaw ?? NaN) ? state!.yaw.toFixed(1) : "—"}° ·
            pitch {Number.isFinite(state?.pitch ?? NaN) ? state!.pitch.toFixed(1) : "—"}° ·
            roll {Number.isFinite(state?.roll ?? NaN) ? state!.roll.toFixed(1) : "—"}° ·
            {state ? (state.block ?? state.pose ?? "—") : "no face"}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 p-2.5 sm:p-3">
      <div
        aria-hidden="true"
        className={`absolute left-1/2 top-[17%] h-[57%] w-[68%] -translate-x-1/2 rounded-[48%_48%_44%_44%/38%_38%_58%_58%] border-2 transition-colors duration-200 ${
          inBand ? "border-sage-300/90" : "border-cream-100/55"
        }`}
      />
      <div className="absolute left-2 right-2 top-2 flex items-center justify-between gap-2 sm:left-3 sm:right-3 sm:top-3">
        <span className="rounded-full bg-cocoa-900/80 px-3 py-1.5 text-xs font-semibold text-cream-100 shadow-sm backdrop-blur-sm">
          {eitherSide ? "Turn either way" : POSE_COPY[activePose].label}
        </span>
        <span className="rounded-full bg-cocoa-900/70 px-2.5 py-1.5 text-[11px] font-medium text-cream-100/80 shadow-sm backdrop-blur-sm">
          View {Math.min(done.length + 1, poses.length)} of {poses.length}
        </span>
      </div>
      <p className="absolute left-1/2 top-[14%] max-w-[85%] -translate-x-1/2 rounded-full bg-cocoa-900/60 px-2.5 py-1 text-center text-[10px] font-medium text-cream-100/85 shadow-sm backdrop-blur-sm">
        Keep your head inside the outline
      </p>
    </div>
  );
}
