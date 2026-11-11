/**
 * The wording and the meter arithmetic shared by every live face guide.
 *
 * There are two guides — one for enrolment (`FaceCaptureGuide`) and one for the
 * Face++ login/duty check (`FaceCheckGuide`) — and they must say the same thing
 * about the same head angle. Keeping the target bands and the refusal sentences
 * here means a change to "how far is a left turn" cannot land in one screen and
 * miss the other.
 *
 * Nothing here touches the camera or React; it turns a `PoseState` into the
 * sentence the person reads.
 */

import type { FacePose } from "./face";
import {
  FRONT_MAX_YAW,
  SIDE_MAX_YAW,
  SIDE_MIN_YAW,
  type PoseState,
} from "./head-pose";

/** The yaw range the meter covers, in degrees either side of straight on. */
export const METER_DEG = 80;

/**
 * The band of yaw that satisfies an angle, in degrees.
 *
 * Mirrors the constants in lib/head-pose.ts rather than restating the numbers, so
 * the guide cannot show a target the gate would refuse.
 */
export function targetBand(pose: FacePose): [number, number] {
  if (pose === "front") return [-FRONT_MAX_YAW, FRONT_MAX_YAW];
  if (pose === "left") return [SIDE_MIN_YAW, SIDE_MAX_YAW];
  return [-SIDE_MAX_YAW, -SIDE_MIN_YAW];
}

/** Where a yaw sits on the meter, as a percentage from the left edge. */
export function meterPercent(yaw: number): number {
  const clamped = Math.max(-METER_DEG, Math.min(METER_DEG, yaw));
  return ((clamped + METER_DEG) / (METER_DEG * 2)) * 100;
}

/** How a completed angle is named in the flash, in the past tense. */
export const DONE_COPY: Record<FacePose, string> = {
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
export function hintFor(
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
