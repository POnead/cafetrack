/**
 * Head pose in degrees, from 2D face landmarks.
 *
 * ## Why this exists
 *
 * The screens used to decide "straight on / left / right" from a 2D distance
 * ratio — how much nearer the nose tip was to one outer eye corner than the
 * other. That number is not an angle. It moves when the head tilts (roll), when
 * the person looks up or down (pitch), and when the landmarks jitter by a couple
 * of pixels, and it saturates, so the useful decision window ended up four
 * hundredths wide. Staff were told to turn further while visibly turned, then
 * refused for being "still straight on".
 *
 * Every serious implementation of this — Google ML Kit (`headEulerAngleY`),
 * MediaPipe (a 4x4 facial transformation matrix), OpenCV (`solvePnP`), every
 * KYC vendor — answers the same question in the same units: **how many degrees
 * did the head rotate**. This module does that.
 *
 * ## How
 *
 * A scaled-orthographic ("weak perspective") pose fit. Given a set of 2D
 * landmarks and a generic 3D face model, the projection
 *
 *     u = s * (r1 · X) + tx
 *     v = s * (r2 · X) + ty
 *
 * is linear in the eight unknowns `s*r1`, `s*r2`, `tx`, `ty`, so it is a single
 * least-squares solve — no iteration, no starting guess, no OpenCV. The two rows
 * are then orthonormalised into a rotation matrix, which decomposes into yaw,
 * pitch and roll.
 *
 * This is the same maths family as the initialiser inside `solvePnP`, and it is
 * more than accurate enough for a ±12° / 25° decision. It is also pure: no model,
 * no browser, no camera, so it is tested against synthetic rotations with exact
 * ground truth (see `scripts/_head-pose-tests.mjs`).
 *
 * ## The model is generic, and that is a known limit
 *
 * The 3D face below is a generic adult head, not the person in front of the
 * camera. That biases the *absolute* angle slightly — a face with a flatter nose
 * reads a degree or two off — but the decision this drives is a band, not a
 * measurement, and the bands are wide compared with that bias. What it must not
 * do is confuse the three poses, and it does not: the difference between "front"
 * and "turned" is 25°, not 2°.
 */

import type { FacePose } from "./face";

export type Point2D = { x: number; y: number };
export type Point3D = { x: number; y: number; z: number };

/**
 * The result of a pose fit.
 *
 * `yaw` is the one that decides the pose. `pitch` and `roll` exist to refuse a
 * frame that is turned *and* tilted, which is a frame that produces a bad
 * descriptor however well its angle matches the prompt.
 */
export type HeadPose = {
  /**
   * Degrees about the vertical axis. **Positive means the person turned to their
   * own left**, which is the same convention `headTurnSignal` used, so stored
   * samples and the screens keep meaning what they meant.
   */
  yaw: number;
  /** Degrees about the horizontal axis. Positive means the chin came down. */
  pitch: number;
  /** Degrees in the image plane. Positive means the head tilted towards their own left. */
  roll: number;
  /** Pixels per model unit. Not meaningful on its own; useful for diagnostics. */
  scale: number;
  /**
   * RMS reprojection error, in pixels. A fit that does not explain the landmarks
   * is a fit that should not be trusted, and this is how the caller finds out.
   */
  residual: number;
};

/** A 3D face model plus the landmark indices it corresponds to. */
export type CanonicalFace = {
  /** iBUG-68 indices (legacy engine) or ArcFace 0-4 indices (SFace engine). */
  indices: readonly number[];
  /** Model points, same order. X right, Y down, Z away from the camera. */
  points: readonly Point3D[];
};

/*
 * A generic head, in arbitrary units (roughly millimetres at 5 units/mm).
 *
 * The scale is absorbed by the solve, so only the *relative* geometry matters:
 * the eye baseline is 450 units, the nose sits 135 units in front of the eye
 * plane, and the mouth is 125 units in front. Those proportions are what make
 * yaw recoverable at all — a flat model would make a turned head and a shifted
 * head indistinguishable.
 *
 * Eight points, all unambiguous in iBUG order: the two outer eye corners, the
 * two inner eye corners, the nose tip, both mouth corners, and the chin. Deliberately
 * no jaw or brow points: their 3D position is the least certain part of a generic
 * model, and they add nothing to a yaw decision that these eight do not already give.
 */
export const CANONICAL_68: CanonicalFace = {
  indices: [36, 39, 42, 45, 30, 48, 54, 8],
  points: [
    { x: -225, y: -170, z: -135 }, // 36 person's right eye, outer corner (image left)
    { x: -75, y: -165, z: -130 }, //  39 person's right eye, inner corner
    { x: 75, y: -165, z: -130 }, //   42 person's left eye, inner corner
    { x: 225, y: -170, z: -135 }, //  45 person's left eye, outer corner (image right)
    { x: 0, y: 0, z: 0 }, //          30 nose tip — the most protruding point
    { x: -150, y: 150, z: -125 }, //  48 person's right mouth corner
    { x: 150, y: 150, z: -125 }, //   54 person's left mouth corner
    { x: 0, y: 330, z: -65 }, //       8 chin
  ],
};

/**
 * The same head described by YuNet's five points.
 *
 * YuNet reports eye *centres*, the nose tip and the two mouth corners, in
 * ArcFace order: index 0 is the person's right eye (image left), 1 their left,
 * 2 the nose, 3 the right mouth corner, 4 the left. That is enough for a pose:
 * the eye pair and the mouth pair sit at two different depths, and the nose
 * sticks out in front of both, so yaw moves them against each other.
 */
export const CANONICAL_5: CanonicalFace = {
  indices: [0, 1, 2, 3, 4],
  points: [
    { x: -225, y: -170, z: -135 }, // 0 person's right eye (image left)
    { x: 225, y: -170, z: -135 }, //  1 person's left eye (image right)
    { x: 0, y: 0, z: 0 }, //          2 nose tip
    { x: -150, y: 150, z: -125 }, //  3 person's right mouth corner
    { x: 150, y: 150, z: -125 }, //   4 person's left mouth corner
  ],
};

/* ------------------------------------------------------------- the fit ---- */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Solve `A x = b` for a small dense system, by Gaussian elimination.
 *
 * The normal equations below are 8x8 at most, so this is plenty and it keeps the
 * module dependency-free. Returns null when the system is singular — which means
 * the landmarks were degenerate (all on one line, or all the same point) and the
 * honest answer is "no pose" rather than a made-up one.
 */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting: the largest magnitude in this column becomes the pivot.
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (!Number.isFinite(m[pivot][col]) || Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = m[pivot];
      m[pivot] = m[col];
      m[col] = tmp;
    }

    const p = m[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / p;
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k++) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }

  return x.every((v) => Number.isFinite(v)) ? x : null;
}

function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function cross(a: number[], b: number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Fit a head pose to 2D landmarks.
 *
 * Returns null when there is nothing trustworthy to report: missing or
 * non-finite points, too few points for the eight unknowns, or a degenerate
 * configuration. A guessed pose files a sample under the wrong angle, which is
 * worse than no sample, so this refuses rather than guesses.
 */
export function estimateHeadPose(
  points: readonly Point2D[] | null | undefined,
  canonical: CanonicalFace = CANONICAL_68
): HeadPose | null {
  if (!points || points.length === 0) return null;
  if (canonical.indices.length !== canonical.points.length) return null;
  // Eight unknowns need at least four correspondences; fewer is under-determined.
  if (canonical.indices.length < 4) return null;

  const observed: Point2D[] = [];
  for (const index of canonical.indices) {
    const p = points[index];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    observed.push(p);
  }

  /*
   * Build the normal equations directly rather than a full 2n x 8 matrix.
   *
   * Each correspondence contributes two rows:
   *   [X Y Z 1 0 0 0 0] . [a1 a2 a3 tx b1 b2 b3 ty] = u
   *   [0 0 0 0 X Y Z 1] .                            = v
   */
  const ata: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);

  const accumulate = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (row[i] === 0) continue;
      atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
    }
  };

  canonical.points.forEach((X, i) => {
    const p = observed[i];
    accumulate([X.x, X.y, X.z, 1, 0, 0, 0, 0], p.x);
    accumulate([0, 0, 0, 0, X.x, X.y, X.z, 1], p.y);
  });

  const solution = solve(ata, atb);
  if (!solution) return null;

  // The unknowns are ordered [a1 a2 a3 tx b1 b2 b3 ty] — see the rows above.
  const a = solution.slice(0, 3);
  const tx = solution[3];
  const b = solution.slice(4, 7);
  const ty = solution[7];

  const scale = (norm(a) + norm(b)) / 2;
  if (!Number.isFinite(scale) || scale <= 0) return null;

  let r1 = a.map((v) => v / norm(a));
  let r2 = b.map((v) => v / norm(b));

  /*
   * Orthonormalise into a real rotation.
   *
   * The two rows come out of the least-squares fit nearly perpendicular but not
   * exactly, and a non-orthogonal "rotation" produces angles that drift. Build
   * the third axis from the cross product, then rebuild the first two from it,
   * which leaves a right-handed basis close to what was fitted.
   */
  const r3raw = cross(r1, r2);
  const r3len = norm(r3raw);
  if (!Number.isFinite(r3len) || r3len < 1e-9) return null;
  const r3 = r3raw.map((v) => v / r3len);

  const r2raw = cross(r3, r1);
  const r2len = norm(r2raw);
  if (!Number.isFinite(r2len) || r2len < 1e-9) return null;
  r2 = r2raw.map((v) => v / r2len);
  r1 = cross(r2, r3);

  /*
   * Decompose R = Ry(yaw) · Rx(pitch) · Rz(roll), with rows r1, r2, r3:
   *
   *   pitch = asin(-R21)      (row 2, column 3 in 1-based terms)
   *   yaw   = atan2(R13, R33)
   *   roll  = atan2(R21, R22)
   *
   * Verified against pure single-axis rotations in the tests, so the sign
   * convention cannot drift silently.
   */
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r2[2]))) * DEG;
  const yaw = Math.atan2(r1[2], r3[2]) * DEG;
  const roll = Math.atan2(r2[0], r2[1]) * DEG;

  // Reprojection error, so the caller can refuse a fit that explains nothing.
  let sumSquares = 0;
  canonical.points.forEach((X, i) => {
    const u = scale * (r1[0] * X.x + r1[1] * X.y + r1[2] * X.z) + tx;
    const v = scale * (r2[0] * X.x + r2[1] * X.y + r2[2] * X.z) + ty;
    const du = u - observed[i].x;
    const dv = v - observed[i].y;
    sumSquares += du * du + dv * dv;
  });
  const residual = Math.sqrt(sumSquares / canonical.points.length);

  return { yaw, pitch, roll, scale, residual };
}

/* ------------------------------------------------------------- the gate ---- */

/**
 * How far off straight-on still counts as facing the camera.
 *
 * Fifteen degrees is the figure the recognition vendors converge on: Neurotechnology
 * documents ±15° on all three axes for best verification performance, and ML Kit's
 * own liveness samples treat roughly ±10-15° as frontal. Twelve is deliberately
 * inside that, because a frontal sample that is slightly turned is still a good
 * frontal sample, and the cost of asking someone to straighten up is one second.
 */
export const FRONT_MAX_YAW = 12;

/**
 * How far the head has to turn before a frame counts as a side sample.
 *
 * Twenty-five degrees is a clear turn rather than a lean, and it is the floor
 * because a frame that is barely turned is a worse side sample than a good
 * frontal one.
 */
export const SIDE_MIN_YAW = 25;

/**
 * How far is too far.
 *
 * This was 55°, which turned out to be the wrong side of a very common mistake:
 * people asked to turn "about a third of the way round" often turn much further,
 * and 55° is inside what a willing person produces. At 70° the far eye is still
 * visible and SFace still aligns a usable crop; past it the eye is occluded and
 * the descriptor stops being comparable with a three-quarter sample.
 *
 * The old cap also produced a message that made things worse — see `poseRefusal`,
 * which used to call every refusal "not turned far enough", including one that
 * was too far.
 */
export const SIDE_MAX_YAW = 70;

/** Beyond this the head is tilted, not turned, and the frame is not usable. */
export const MAX_ROLL = 15;

/** Beyond this the person is looking up or down rather than at the camera. */
export const MAX_PITCH = 18;

/**
 * How much the angle has to come back inside a band before the pose is dropped.
 *
 * Without this the classification flickers at the boundary: a head held at
 * exactly 25° reads "left" on one frame and "between" on the next, so the capture
 * loop alternates between accepting and refusing while nothing has moved.
 */
export const POSE_HYSTERESIS_DEG = 7;

/** Why a reading is not one of the three poses. */
export type PoseBlock = "between" | "tilted" | "pitched" | "too-far";

export type PoseState = {
  /** The angle the head is showing, or null when it is not a usable one. */
  pose: FacePose | null;
  /** Why it is not a pose, when it is not. Null when `pose` is set. */
  block: PoseBlock | null;
  yaw: number;
  pitch: number;
  roll: number;
};

/**
 * Turn angles into one of the three poses, or into a reason it is none of them.
 *
 * Roll and pitch are checked first. A head turned 30° and tilted 25° matches the
 * prompt's angle and still produces a bad sample, so the tilt has to win — and
 * the person needs to be told to straighten up, not to turn further.
 */
export function poseStateFromAngles(pose: {
  yaw: number;
  pitch: number;
  roll: number;
}): PoseState {
  const { yaw, pitch, roll } = pose;

  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(roll)) {
    return { pose: null, block: "between", yaw, pitch, roll };
  }

  if (Math.abs(roll) > MAX_ROLL) return { pose: null, block: "tilted", yaw, pitch, roll };
  if (Math.abs(pitch) > MAX_PITCH) return { pose: null, block: "pitched", yaw, pitch, roll };

  if (Math.abs(yaw) <= FRONT_MAX_YAW) return { pose: "front", block: null, yaw, pitch, roll };
  if (Math.abs(yaw) < SIDE_MIN_YAW) return { pose: null, block: "between", yaw, pitch, roll };
  if (Math.abs(yaw) > SIDE_MAX_YAW) return { pose: null, block: "too-far", yaw, pitch, roll };

  // Positive yaw is the person's own left, matching headTurnSignal's convention.
  return { pose: yaw > 0 ? "left" : "right", block: null, yaw, pitch, roll };
}

/** The pose alone, for callers that do not need the reason. */
export function poseFromAngles(pose: {
  yaw: number;
  pitch: number;
  roll: number;
}): FacePose | null {
  return poseStateFromAngles(pose).pose;
}

/**
 * Keep a side classification through the hysteresis band.
 *
 * The gate is asked "is the head still turned?" many times a second, and at the
 * band edge the honest answer alternates. This holds the previous answer until
 * the angle has clearly left it, which is what stops the prompt and the capture
 * loop disagreeing about the same head.
 */
export function poseWithHysteresis(
  previous: FacePose | null,
  state: PoseState
): FacePose | null {
  // A decided pose always wins, including the return to straight on.
  if (state.pose) return state.pose;
  if (!previous || previous === "front") return null;

  /*
   * Only hold a side while the head is still on that side. Without the direction
   * check, a head that swung from +20° to -20° would keep being reported as the
   * turn it no longer is.
   */
  const sameDirection = previous === "left" ? state.yaw > 0 : state.yaw < 0;
  const stillSide =
    sameDirection &&
    state.block === "between" &&
    Math.abs(state.yaw) >= SIDE_MIN_YAW - POSE_HYSTERESIS_DEG;

  return stillSide ? previous : null;
}

/** Signed yaw as a -1..1 fraction of a full quarter turn, for a UI needle. */
export function yawFraction(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  return Math.max(-1, Math.min(1, yaw / 90));
}
