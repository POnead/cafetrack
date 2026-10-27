/**
 * Unit tests for src/lib/head-pose.ts — the pose fit and the pose gate.
 *
 *   npm run test:pose
 *
 * These run against synthetic rotations, which is the only way to have exact
 * ground truth: build the canonical 3D face, rotate it by a known angle, project
 * it, and ask the fit to recover the angle it was given. A camera cannot supply
 * that, and a photograph cannot tell you whether the head was at 29° or 31°.
 *
 * What this does *not* prove is that the generic 3D model matches a particular
 * face. That bias is a known limitation, is a degree or two, and is measured
 * against real photographs by `scripts/_face-probe.mjs` instead.
 */
import {
  CANONICAL_5,
  CANONICAL_68,
  FRONT_MAX_YAW,
  MAX_PITCH,
  MAX_ROLL,
  POSE_HYSTERESIS_DEG,
  SIDE_MAX_YAW,
  SIDE_MIN_YAW,
  estimateHeadPose,
  poseFromAngles,
  poseStateFromAngles,
  poseWithHysteresis,
  yawFraction,
} from "../src/lib/head-pose.ts";
import { poseRefusal } from "../src/lib/face.ts";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const RAD = Math.PI / 180;

/* ---------------------------------------------------------- the camera ---- */

/** 3x3 multiply, row-major. */
function mul(a, b) {
  const out = Array.from({ length: 3 }, () => [0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

const rotY = (deg) => {
  const t = deg * RAD;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
};

const rotX = (deg) => {
  const t = deg * RAD;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
};

const rotZ = (deg) => {
  const t = deg * RAD;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
};

/** The same composition the fit decomposes: Ry(yaw) . Rx(pitch) . Rz(roll). */
function rotation(yaw, pitch, roll) {
  return mul(mul(rotY(yaw), rotX(pitch)), rotZ(roll));
}

/**
 * Project the canonical face through a known rotation, scale and offset, and
 * return the 2D landmark array the app would hold.
 */
function project(canonical, { yaw = 0, pitch = 0, roll = 0, scale = 1.6, tx = 320, ty = 240, noise = 0 } = {}) {
  const R = rotation(yaw, pitch, roll);
  const points = Array.from({ length: 68 }, () => null);

  canonical.indices.forEach((index, i) => {
    const X = canonical.points[i];
    const u = scale * (R[0][0] * X.x + R[0][1] * X.y + R[0][2] * X.z) + tx;
    const v = scale * (R[1][0] * X.x + R[1][1] * X.y + R[1][2] * X.z) + ty;
    points[index] = { x: u + noise, y: v + noise };
  });

  return points;
}

/** A deterministic pseudo-random in [-1, 1], so a failure is reproducible. */
function wobble(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/* --------------------------------------------------------------- tests ---- */

section("estimateHeadPose — recovers a known rotation");

const flat = estimateHeadPose(project(CANONICAL_68), CANONICAL_68);
check("a straight-on face reads zero yaw", Math.abs(flat.yaw) < 0.01, `yaw ${flat.yaw.toFixed(3)}`);
check("and zero pitch", Math.abs(flat.pitch) < 0.01, `pitch ${flat.pitch.toFixed(3)}`);
check("and zero roll", Math.abs(flat.roll) < 0.01, `roll ${flat.roll.toFixed(3)}`);
check("with no reprojection error", flat.residual < 1e-6, `residual ${flat.residual.toExponential(1)}`);

for (const yaw of [-45, -30, -15, 15, 30, 45]) {
  const fit = estimateHeadPose(project(CANONICAL_68, { yaw }), CANONICAL_68);
  check(
    `yaw ${yaw}° comes back as ${yaw}°`,
    Math.abs(fit.yaw - yaw) < 0.5,
    `got ${fit.yaw.toFixed(2)}°`
  );
  check(
    `and does not leak into pitch or roll (${yaw}°)`,
    Math.abs(fit.pitch) < 0.5 && Math.abs(fit.roll) < 0.5,
    `pitch ${fit.pitch.toFixed(2)}, roll ${fit.roll.toFixed(2)}`
  );
}

for (const pitch of [-25, -12, 12, 25]) {
  const fit = estimateHeadPose(project(CANONICAL_68, { pitch }), CANONICAL_68);
  check(
    `pitch ${pitch}° comes back as ${pitch}°`,
    Math.abs(fit.pitch - pitch) < 0.5,
    `got ${fit.pitch.toFixed(2)}°`
  );
  check(
    `and does not leak into yaw (${pitch}°)`,
    Math.abs(fit.yaw) < 0.5,
    `yaw ${fit.yaw.toFixed(2)}°`
  );
}

for (const roll of [-20, -10, 10, 20]) {
  const fit = estimateHeadPose(project(CANONICAL_68, { roll }), CANONICAL_68);
  check(
    `roll ${roll}° comes back as ${roll}°`,
    Math.abs(fit.roll - roll) < 0.5,
    `got ${fit.roll.toFixed(2)}°`
  );
  check(
    `and does not leak into yaw (roll ${roll}°)`,
    Math.abs(fit.yaw) < 0.5,
    `yaw ${fit.yaw.toFixed(2)}°`
  );
}

const combined = estimateHeadPose(
  project(CANONICAL_68, { yaw: 30, pitch: -10, roll: 6 }),
  CANONICAL_68
);
check("a combined pose recovers its yaw", Math.abs(combined.yaw - 30) < 0.5, `yaw ${combined.yaw.toFixed(2)}`);
check("a combined pose recovers its pitch", Math.abs(combined.pitch + 10) < 0.5, `pitch ${combined.pitch.toFixed(2)}`);
check("a combined pose recovers its roll", Math.abs(combined.roll - 6) < 0.5, `roll ${combined.roll.toFixed(2)}`);

section("estimateHeadPose — the sign means what the screens say it means");

/*
 * The one thing that must not drift. Positive yaw has always meant "the person
 * turned to their own left", which puts the nose on the image's right. Checked
 * geometrically rather than against another constant, so a sign flip in the
 * model cannot be cancelled out by a sign flip in the assertion.
 */
const leftTurn = project(CANONICAL_68, { yaw: 30 });
const nose = leftTurn[30];
const eyeMidX = (leftTurn[36].x + leftTurn[45].x) / 2;
check(
  "a positive yaw puts the nose to the image's right",
  nose.x > eyeMidX,
  `nose ${nose.x.toFixed(1)} vs eye midpoint ${eyeMidX.toFixed(1)}`
);
check("and reads as the person's left", poseFromAngles({ yaw: 30, pitch: 0, roll: 0 }) === "left");
check("a negative yaw reads as the person's right", poseFromAngles({ yaw: -30, pitch: 0, roll: 0 }) === "right");

section("estimateHeadPose — scale, position and noise");

const near = estimateHeadPose(project(CANONICAL_68, { yaw: 30, scale: 0.9, tx: 100, ty: 80 }), CANONICAL_68);
const far = estimateHeadPose(project(CANONICAL_68, { yaw: 30, scale: 4.0, tx: 900, ty: 700 }), CANONICAL_68);
check("a small face gives the same angle", Math.abs(near.yaw - 30) < 0.5, `yaw ${near.yaw.toFixed(2)}`);
check("a large face gives the same angle", Math.abs(far.yaw - 30) < 0.5, `yaw ${far.yaw.toFixed(2)}`);

/*
 * One pixel of landmark noise, which is roughly what the models produce on a
 * webcam frame. The bands are 25° wide, so a degree or two of jitter has to be
 * tolerated — and this is what says it is.
 */
let worst = 0;
let sum = 0;
for (let i = 0; i < 50; i++) {
  const points = project(CANONICAL_68, { yaw: 30, noise: 0 }).map((p) =>
    p ? { x: p.x + wobble(i * 2 + 1), y: p.y + wobble(i * 2 + 2) } : p
  );
  const fit = estimateHeadPose(points, CANONICAL_68);
  const error = Math.abs(fit.yaw - 30);
  worst = Math.max(worst, error);
  sum += error;
}
check("one pixel of noise keeps the mean error under a degree", sum / 50 < 1.0, `mean ${(sum / 50).toFixed(2)}°`);
check("and the worst case under three degrees", worst < 3.0, `worst ${worst.toFixed(2)}°`);

section("estimateHeadPose — refuses what it cannot trust");

check("no points at all", estimateHeadPose(null) === null);
check("undefined", estimateHeadPose(undefined) === null);
check("an empty array", estimateHeadPose([]) === null);
check(
  "a missing landmark",
  estimateHeadPose(
    project(CANONICAL_68).map((p, i) => (i === 30 ? null : p)),
    CANONICAL_68
  ) === null
);
check(
  "a non-finite landmark",
  estimateHeadPose(
    project(CANONICAL_68).map((p, i) => (i === 30 ? { x: Number.NaN, y: 0 } : p)),
    CANONICAL_68
  ) === null
);
check(
  "every point in the same place",
  estimateHeadPose(Array.from({ length: 68 }, () => ({ x: 10, y: 10 })), CANONICAL_68) === null
);
check(
  "a model with no depth at all",
  estimateHeadPose(
    project(CANONICAL_68).map((p) => (p ? { x: p.x, y: p.y } : p)),
    {
      indices: [36, 39, 42, 45],
      points: [
        { x: -225, y: -170, z: 0 },
        { x: -75, y: -165, z: 0 },
        { x: 75, y: -165, z: 0 },
        { x: 225, y: -170, z: 0 },
      ],
    }
  ) === null
);

section("estimateHeadPose — the five-point model");

for (const yaw of [-40, -25, 0, 25, 40]) {
  const fit = estimateHeadPose(project(CANONICAL_5, { yaw }), CANONICAL_5);
  check(
    `five points recover yaw ${yaw}°`,
    Math.abs(fit.yaw - yaw) < 0.5,
    `got ${fit.yaw.toFixed(2)}°`
  );
}
check(
  "five points agree with the 68-point model on the same head",
  Math.abs(
    estimateHeadPose(project(CANONICAL_5, { yaw: 32 }), CANONICAL_5).yaw -
      estimateHeadPose(project(CANONICAL_68, { yaw: 32 }), CANONICAL_68).yaw
  ) < 0.5
);

section("poseStateFromAngles — the bands");

check("zero is straight on", poseStateFromAngles({ yaw: 0, pitch: 0, roll: 0 }).pose === "front");
check(
  "the edge of the frontal band is still frontal",
  poseStateFromAngles({ yaw: FRONT_MAX_YAW, pitch: 0, roll: 0 }).pose === "front"
);
check(
  "just past it is not a pose",
  poseStateFromAngles({ yaw: FRONT_MAX_YAW + 0.5, pitch: 0, roll: 0 }).block === "between"
);
check(
  "the side band starts at its own edge",
  poseStateFromAngles({ yaw: SIDE_MIN_YAW, pitch: 0, roll: 0 }).pose === "left"
);
check(
  "and mirrored",
  poseStateFromAngles({ yaw: -SIDE_MIN_YAW, pitch: 0, roll: 0 }).pose === "right"
);
check(
  "past the far edge is too far",
  poseStateFromAngles({ yaw: SIDE_MAX_YAW + 1, pitch: 0, roll: 0 }).block === "too-far"
);
check(
  "a hard turn inside the band is still a side",
  poseStateFromAngles({ yaw: 50, pitch: 0, roll: 0 }).pose === "left"
);
check(
  "and the new far edge is still a side, not a refusal",
  poseStateFromAngles({ yaw: SIDE_MAX_YAW, pitch: 0, roll: 0 }).pose === "left"
);
check(
  "a generous three-quarter turn is accepted",
  poseStateFromAngles({ yaw: 62, pitch: 0, roll: 0 }).pose === "left",
  "55° used to refuse this and call it 'not far enough'"
);

section("poseStateFromAngles — tilt and pitch outrank yaw");

check(
  "a level head is fine",
  poseStateFromAngles({ yaw: 30, pitch: 0, roll: MAX_ROLL - 1 }).pose === "left"
);
check(
  "a tilted head is not filed, however well its yaw matches",
  poseStateFromAngles({ yaw: 30, pitch: 0, roll: MAX_ROLL + 5 }).block === "tilted"
);
check(
  "and the tilt is reported rather than the angle",
  poseStateFromAngles({ yaw: 30, pitch: 0, roll: MAX_ROLL + 5 }).pose === null
);
check(
  "looking down is refused",
  poseStateFromAngles({ yaw: 0, pitch: MAX_PITCH + 5, roll: 0 }).block === "pitched"
);
check(
  "looking up is refused",
  poseStateFromAngles({ yaw: 0, pitch: -MAX_PITCH - 5, roll: 0 }).block === "pitched"
);
check(
  "a non-finite angle is not a pose",
  poseStateFromAngles({ yaw: Number.NaN, pitch: 0, roll: 0 }).pose === null
);

section("poseWithHysteresis — no flicker at the band edge");

const atEdge = poseStateFromAngles({ yaw: SIDE_MIN_YAW - 3, pitch: 0, roll: 0 });
check("a fresh read at the edge is not a side", atEdge.pose === null);
check(
  "but a head already classified as left stays left",
  poseWithHysteresis("left", atEdge) === "left"
);
check(
  "and the mirrored case stays right",
  poseWithHysteresis("right", poseStateFromAngles({ yaw: -SIDE_MIN_YAW + 3, pitch: 0, roll: 0 })) === "right"
);
check(
  "clearly inside the frontal band drops the side",
  poseWithHysteresis("left", poseStateFromAngles({ yaw: 4, pitch: 0, roll: 0 })) === "front"
);
check(
  "well below the side band drops it",
  poseWithHysteresis(
    "left",
    poseStateFromAngles({ yaw: SIDE_MIN_YAW - POSE_HYSTERESIS_DEG - 2, pitch: 0, roll: 0 })
  ) === null
);
check(
  "a tilt drops the side rather than holding it",
  poseWithHysteresis("left", poseStateFromAngles({ yaw: 30, pitch: 0, roll: MAX_ROLL + 10 })) === null
);
check("nothing previous, nothing held", poseWithHysteresis(null, atEdge) === null);

section("poseRefusal — every refusal names the correction");

const refusalOf = (expected, angles) => poseRefusal(expected, poseStateFromAngles(angles));

/*
 * The bug this section exists for: "too far", "tilted" and "pitched" all arrived
 * at the screen as "no pose" and were answered with "turn a little further".
 * Someone already at 70° turned further, and the message never changed. Each one
 * now has to produce the opposite correction.
 */
check(
  "too far asks for less, not more",
  /too far/i.test(refusalOf("left", { yaw: 78, pitch: 0, roll: 0 })) &&
    !/further/i.test(refusalOf("left", { yaw: 78, pitch: 0, roll: 0 })),
  refusalOf("left", { yaw: 78, pitch: 0, roll: 0 })
);
check(
  "a tilted turn asks for a level head",
  /level/i.test(refusalOf("left", { yaw: 35, pitch: 0, roll: MAX_ROLL + 10 })),
  refusalOf("left", { yaw: 35, pitch: 0, roll: MAX_ROLL + 10 })
);
check(
  "chin down asks for a lift",
  /lift your chin/i.test(refusalOf("front", { yaw: 0, pitch: MAX_PITCH + 10, roll: 0 })),
  refusalOf("front", { yaw: 0, pitch: MAX_PITCH + 10, roll: 0 })
);
check(
  "chin up asks for a lower chin",
  /lower your chin/i.test(refusalOf("front", { yaw: 0, pitch: -MAX_PITCH - 10, roll: 0 })),
  refusalOf("front", { yaw: 0, pitch: -MAX_PITCH - 10, roll: 0 })
);
check(
  "between angles asks for a little further",
  /further/i.test(refusalOf("left", { yaw: 16, pitch: 0, roll: 0 })),
  refusalOf("left", { yaw: 16, pitch: 0, roll: 0 })
);
check(
  "a wrong-side turn names the side to turn to",
  /other way/i.test(refusalOf("right", { yaw: 35, pitch: 0, roll: 0 })),
  refusalOf("right", { yaw: 35, pitch: 0, roll: 0 })
);
check(
  "a frontal frame is named as such",
  /straight on/i.test(refusalOf("left", { yaw: 0, pitch: 0, roll: 0 })),
  refusalOf("left", { yaw: 0, pitch: 0, roll: 0 })
);
check(
  "no reading at all says so rather than blaming the angle",
  /could not read/i.test(poseRefusal("left", null)),
  poseRefusal("left", null)
);

section("yawFraction — the UI needle");

check("straight on is centred", yawFraction(0) === 0);
check("a quarter turn is full scale", yawFraction(90) === 1);
check("and mirrored", yawFraction(-90) === -1);
check("a non-finite angle is centred", yawFraction(Number.NaN) === 0);
check("it clamps rather than overshooting", yawFraction(180) === 1);

console.log(`\n${"-".repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
