/**
 * Unit tests for src/lib/face.ts — the matching arithmetic and the duty window.
 *
 *   node scripts/_face-math.mjs
 *
 * Every other suite in this repo drives the running app over HTTP. This one does
 * not, and that is the point: the decision "does this barista still owe a check"
 * is the control the whole feature rests on, and it is pure logic over a
 * timestamp. Testing it here means it is covered with no camera, no browser, no
 * webcam permission prompt and no model — so the highest-risk logic is also the
 * part that is easiest to test exhaustively.
 *
 * Node strips the type annotations off the import, so the module under test is
 * the file the app loads — not a copy, and not a reimplementation.
 */
import {
  DEFAULT_DUTY_HOURS,
  DEFAULT_MATCH_THRESHOLD,
  EMBEDDING_LENGTH,
  FACE_POSES,
  FRONT_MAX_SIGNAL,
  MAX_DUTY_HOURS,
  MAX_MATCH_THRESHOLD,
  MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  MEASURED_FARTHEST_DIFFERENT_PEOPLE,
  MEASURED_SAME_PERSON_WORST,
  MIN_DUTY_HOURS,
  MIN_MATCH_THRESHOLD,
  PRIMARY_POSE,
  SIDE_MIN_SIGNAL,
  distance,
  fileFrame,
  formatEmbedding,
  headTurnSignal,
  isMatch,
  matchGallery,
  matchPresentation,
  nextVerificationAt,
  parseEmbedding,
  parsePose,
  parseStoredEmbedding,
  poseAlreadyHeld,
  poseFromSignal,
  poseSatisfies,
  posesRequired,
  verificationRequired,
} from "../src/lib/face.ts";

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

/**
 * A deterministic L2-normalised embedding, so "the same face" means the same
 * bytes across runs. Seeded rather than Math.random, so a failure reproduces.
 */
function makeEmbedding(seed = 1) {
  const raw = new Float64Array(EMBEDDING_LENGTH);
  let state = seed >>> 0;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_LENGTH; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = ((state >>> 0) / 0xffffffff) * 2 - 1;
    raw[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  const out = new Float32Array(EMBEDDING_LENGTH);
  for (let i = 0; i < EMBEDDING_LENGTH; i++) out[i] = raw[i] / norm;
  return out;
}

/** Nudge a vector along its own first axis, producing a known distance. */
function shift(vector, amount) {
  const out = new Float32Array(vector);
  out[0] += amount;
  return out;
}

/**
 * A vector at exactly `target` *cosine* distance from `vector`.
 *
 * Builds a unit vector `u` from the base, picks a unit direction perpendicular to
 * it, and returns `u * s + perpendicular * sqrt(1 - s*s)` where `s = 1 - target`.
 * The result has length 1 and angle `target` from the base, whatever the base was.
 *
 * The `shift` helper above cannot do this job: it displaces one component, which
 * under cosine moves the angle by an amount that depends on the vector's length.
 * Boundary tests need a distance they asked for, not one they got.
 */
function atCosine(vector, target) {
  const n = Math.sqrt(vector.reduce((s, x) => s + x * x, 0));
  const u = Array.from(vector, (x) => x / n);

  // Any direction, with whatever points along u removed so it is perpendicular.
  const seed = u.map((_, i) => Math.sin(i * 1.7 + 0.3));
  const proj = seed.reduce((s, x, i) => s + x * u[i], 0);
  let perp = seed.map((x, i) => x - proj * u[i]);
  const pn = Math.sqrt(perp.reduce((s, x) => s + x * x, 0));
  perp = perp.map((x) => x / pn);

  const s = 1 - target;
  const k = Math.sqrt(Math.max(0, 1 - s * s));
  return new Float32Array(u.map((x, i) => x * s + perp[i] * k));
}

/* ---------------------------------------------------------------- parse -- */

section("parseEmbedding — accepts the three shapes a caller can hold");

const real = makeEmbedding(7);

check("a Float32Array is accepted", parseEmbedding(real) !== null);
check("a plain array is accepted", parseEmbedding(Array.from(real)) !== null);
check("comma-joined text is accepted", parseEmbedding(Array.from(real).join(",")) !== null);
check("text with surrounding whitespace", parseEmbedding(`  ${Array.from(real).join(",")}  `) !== null);

section("parseEmbedding — refuses what is not an embedding");

check("too few values", parseEmbedding(Array.from(real).slice(0, EMBEDDING_LENGTH - 1)) === null);
check("too many values", parseEmbedding([...Array.from(real), 0.5]) === null);
check("an empty array", parseEmbedding([]) === null);
check("an empty string", parseEmbedding("") === null);
check("a whitespace-only string", parseEmbedding("   ") === null);
check("null", parseEmbedding(null) === null);
check("undefined", parseEmbedding(undefined) === null);
check("a bare number", parseEmbedding(1) === null);
check("an object", parseEmbedding({ length: 128 }) === null);

section("parseEmbedding — refuses coercion");

// Each of these becomes a plausible-looking vector if the parser runs values
// through Number(): Number("") is 0, Number(true) is 1, Number(null) is 0. All
// three would pass a length check and produce a "face" that is really zeroes.

const withNaN = Array.from(real); withNaN[7] = NaN;
check("NaN mid-vector", parseEmbedding(withNaN) === null);
const withNaNEnd = Array.from(real); withNaNEnd[EMBEDDING_LENGTH - 1] = NaN;
check("NaN in the last position", parseEmbedding(withNaNEnd) === null);
const withInfinity = Array.from(real); withInfinity[3] = Infinity;
check("Infinity", parseEmbedding(withInfinity) === null);
const withNegInf = Array.from(real); withNegInf[3] = -Infinity;
check("-Infinity", parseEmbedding(withNegInf) === null);
const asString = Array.from(real); asString[0] = "0.5";
check("a number sent as a string", parseEmbedding(asString) === null);
const asEmpty = Array.from(real); asEmpty[0] = "";
check("an empty string as a value", parseEmbedding(asEmpty) === null);
const asNull = Array.from(real); asNull[0] = null;
check("null as a value", parseEmbedding(asNull) === null);
const asBool = Array.from(real); asBool[0] = true;
check("a boolean as a value", parseEmbedding(asBool) === null);
const asNested = Array.from(real); asNested[0] = [0.5];
check("a nested array as a value", parseEmbedding(asNested) === null);

section("parseEmbedding — the all-zeros hole");

// Distance between two all-zero vectors is 0: a perfect match at any threshold. A
// client posting 128 zeroes would otherwise walk straight in.
check("an all-zero array", parseEmbedding(new Array(EMBEDDING_LENGTH).fill(0)) === null);
check("an all-zero text form", parseEmbedding(new Array(EMBEDDING_LENGTH).fill(0).join(",")) === null);
check("an all-zero Float32Array", parseEmbedding(new Float32Array(EMBEDDING_LENGTH)) === null);
check("a vector with no direction", parseEmbedding(new Array(EMBEDDING_LENGTH).fill(1e-12)) === null);
check(
  "two rejected zero vectors do not match",
  isMatch(
    parseEmbedding(new Array(EMBEDDING_LENGTH).fill(0)),
    parseEmbedding(new Array(EMBEDDING_LENGTH).fill(0)),
    MAX_MATCH_THRESHOLD
  ) === false
);

/* ----------------------------------------------------------- round trip -- */

section("formatEmbedding — round trip");

const stored = formatEmbedding(real);
const recovered = parseEmbedding(stored);

check("a formatted embedding parses back", recovered !== null);
check(
  "every value survives exactly",
  recovered !== null && Array.from(real).every((v, i) => v === recovered[i]),
  recovered
    ? `max drift ${Math.max(...Array.from(real).map((v, i) => Math.abs(v - recovered[i]))).toExponential(2)}`
    : "did not parse"
);
check("a second pass changes nothing", formatEmbedding(recovered) === stored);
check("a reasonable size for a text column", stored.length < 4000, `${stored.length} chars`);

/* ------------------------------------------------------------- distance -- */

section("distance");

check("zero from itself", distance(real, real) === 0);
check("symmetric", distance(real, makeEmbedding(9)) === distance(makeEmbedding(9), real));
check("grows as vectors separate", distance(real, shift(real, 0.05)) < distance(real, shift(real, 0.3)));

const unitA = new Float32Array(EMBEDDING_LENGTH);
const unitB = new Float32Array(EMBEDDING_LENGTH);
unitA[0] = 1;
unitB[1] = 1;
check("orthogonal unit vectors are 1 apart", Math.abs(distance(unitA, unitB) - 1) < 1e-6);
check("opposite unit vectors are 2 apart", Math.abs(distance(unitA, new Float32Array(unitA).map((v) => -v)) - 2) < 1e-6);

/*
 * The reason cosine replaced euclidean, as an executable claim rather than a
 * comment: rescaling a descriptor must not change how far it is from anything.
 *
 * Under euclidean, multiplying one side by 100 turns a match into a non-match —
 * a descriptor's length is a property of the photograph, not the face, so
 * charging for it made the same person fail depending on how they were framed.
 */
const scaled = new Float32Array(real).map((x) => x * 100);
check("scaling one side does not change the distance", Math.abs(distance(real, scaled)) < 1e-6);
check("a scaled vector still matches", isMatch(real, scaled, DEFAULT_MATCH_THRESHOLD) === true);

let threw = false;
try { distance(new Float32Array(4), new Float32Array(8)); } catch { threw = true; }
check("different lengths throw rather than reading past the end", threw);

/* -------------------------------------------------------------- isMatch -- */

section("isMatch");

check("the same embedding matches itself", isMatch(real, makeEmbedding(7), DEFAULT_MATCH_THRESHOLD) === true);
check("two different people do not match", isMatch(makeEmbedding(1), makeEmbedding(2), DEFAULT_MATCH_THRESHOLD) === false);

section("isMatch — the threshold boundary");

const atThreshold = atCosine(real, DEFAULT_MATCH_THRESHOLD);
check(
  "exactly on the threshold is a match",
  isMatch(real, atThreshold, DEFAULT_MATCH_THRESHOLD) === true,
  `distance ${distance(real, atThreshold).toFixed(9)}`
);
check("a hair beyond", isMatch(real, atCosine(real, DEFAULT_MATCH_THRESHOLD + 1e-4), DEFAULT_MATCH_THRESHOLD) === false);
check("a hair inside", isMatch(real, atCosine(real, DEFAULT_MATCH_THRESHOLD - 1e-4), DEFAULT_MATCH_THRESHOLD) === true);
check("lower threshold is stricter", isMatch(real, atCosine(real, 0.2), MIN_MATCH_THRESHOLD) === false);
check("still fails at the loosest when far apart", isMatch(real, atCosine(real, 1.4), MAX_MATCH_THRESHOLD) === false);

/*
 * The failure the user actually hit: the same face, photographed again, turned
 * away by more than a euclidean threshold would allow. It has to pass.
 *
 * MEASURED_SAME_PERSON_WORST is the largest cosine reading taken from a real
 * face re-captured ten ways; the value just past it is the next thing that could
 * plausibly arrive.
 */
check(
  "the worst measured same-person re-capture still matches",
  isMatch(real, atCosine(real, MEASURED_SAME_PERSON_WORST), DEFAULT_MATCH_THRESHOLD) === true
);
check(
  "the default rejects the closest measured stranger pair",
  isMatch(real, atCosine(real, MEASURED_CLOSEST_DIFFERENT_PEOPLE), DEFAULT_MATCH_THRESHOLD) === false
);
check(
  "the configurable ceiling also rejects the closest measured stranger pair",
  isMatch(real, atCosine(real, MEASURED_CLOSEST_DIFFERENT_PEOPLE), MAX_MATCH_THRESHOLD) === false
);

section("isMatch — a missing vector is never a match");

check("nothing on the left", isMatch(null, real, DEFAULT_MATCH_THRESHOLD) === false);
check("nothing on the right", isMatch(real, null, DEFAULT_MATCH_THRESHOLD) === false);
check("neither side", isMatch(null, null, DEFAULT_MATCH_THRESHOLD) === false);
check("an unparseable submission", isMatch(real, parseEmbedding([1, 2, 3]), DEFAULT_MATCH_THRESHOLD) === false);
check("a NaN threshold fails closed", isMatch(real, real, NaN) === false);
check("an infinite threshold fails closed", isMatch(real, real, Infinity) === false);

section("parseStoredEmbedding");

check("a null column is a normal answer", parseStoredEmbedding(null) === null);
check("undefined", parseStoredEmbedding(undefined) === null);
check("empty", parseStoredEmbedding("") === null);
check("corrupt", parseStoredEmbedding("not,numbers,at,all") === null);
check("one value short", parseStoredEmbedding(Array.from(real).slice(0, 10).join(",")) === null);
check("well-formed", parseStoredEmbedding(stored) !== null);
check(
  "an empty component is refused, not read as a zero",
  parseStoredEmbedding(
    Array.from(real).map((v, i) => (i === 4 ? "" : v.toPrecision(9))).join(",")
  ) === null
);
check(
  "matches itself after a round trip",
  isMatch(parseStoredEmbedding(stored), parseEmbedding(stored), DEFAULT_MATCH_THRESHOLD) === true
);

/* ------------------------------------------------------- the duty window -- */

const NOW = new Date("2026-10-13T08:00:00.000Z");
const HOURS_AGO = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** The ordinary case: enabled, staff, enrolled. Individual tests override. */
function gate(overrides = {}) {
  return verificationRequired({
    enabled: true,
    role: "staff",
    faceEnabled: true,
    lastVerifiedAt: HOURS_AGO(1),
    hours: DEFAULT_DUTY_HOURS,
    now: NOW,
    ...overrides,
  });
}

section("duty window — who is held at the verify screen");

check("verified an hour ago, duty is 9h — let in", gate() === false);
check("never verified — held", gate({ lastVerifiedAt: null }) === true);
check("verified 8h ago — still inside the window", gate({ lastVerifiedAt: HOURS_AGO(8) }) === false);
check("verified exactly 9h ago — due again", gate({ lastVerifiedAt: HOURS_AGO(9) }) === true);
check("verified 9.01h ago — due again", gate({ lastVerifiedAt: HOURS_AGO(9.01) }) === true);
check("verified 30 seconds ago — let in", gate({ lastVerifiedAt: HOURS_AGO(0.00001) }) === false);

section("duty window — the two things that are never gated");

check("an admin is never held", gate({ role: "admin" }) === false);
check("an admin with no face is never held", gate({ role: "admin", faceEnabled: false }) === false);
check("the feature switched off is never held", gate({ enabled: false }) === false);
check("off, with a stale timestamp, is still let in", gate({ enabled: false, lastVerifiedAt: HOURS_AGO(99) }) === false);

// Not enrolled means the admin chose not to enrol them. Holding such an account
// would make it permanently unreachable, which is a lockout rather than a
// control — the manager override exists for the cases that are genuinely stuck.
check("an account with no face enrolled is let through", gate({ faceEnabled: false }) === false);

section("duty window — unanswerable input fails closed");

check("a garbage timestamp is held", gate({ lastVerifiedAt: "not-a-date" }) === true);
check("an empty-string timestamp is held", gate({ lastVerifiedAt: "" }) === true);
check("a timestamp in the future is held", gate({ lastVerifiedAt: new Date(NOW.getTime() + 3_600_000).toISOString() }) === true);

// A clock change can leave a timestamp in the future. Reading that as "verified"
// would silently hand out hours of free access, so it is checked explicitly.
check(
  "a future timestamp does not grant free access",
  verificationRequired({
    enabled: true, role: "staff", faceEnabled: true,
    lastVerifiedAt: new Date(NOW.getTime() + 6 * 3_600_000),
    hours: 9, now: NOW,
  }) === true
);

check("a duty of zero falls back to the minimum, not to always-due", gate({ hours: 0, lastVerifiedAt: HOURS_AGO(0.5) }) === false);
check("a duty of NaN falls back too", gate({ hours: NaN, lastVerifiedAt: HOURS_AGO(0.5) }) === false);
check("a negative duty falls back too", gate({ hours: -5, lastVerifiedAt: HOURS_AGO(0.5) }) === false);
check("a duty of 1 still lets someone in after 30 minutes", gate({ hours: 1, lastVerifiedAt: HOURS_AGO(0.5) }) === false);
check("a duty of 1 holds them after 90 minutes", gate({ hours: 1, lastVerifiedAt: HOURS_AGO(1.5) }) === true);
check("a duty of 24 still lets someone in after 8 hours", gate({ hours: 24, lastVerifiedAt: HOURS_AGO(8) }) === false);

section("duty window — accepts both Date and string");

check("a Date is accepted", gate({ lastVerifiedAt: new Date(NOW.getTime() - 3_600_000) }) === false);
check("an ISO string is accepted", gate({ lastVerifiedAt: HOURS_AGO(3) }) === false);

section("nextVerificationAt — what the UI shows");

const due = nextVerificationAt(HOURS_AGO(2), 9, NOW);
check("returns the moment the window closes", due !== null && due.toISOString() === "2026-10-13T15:00:00.000Z", due?.toISOString());
check("null when never verified", nextVerificationAt(null, 9, NOW) === null);
check("null when already overdue", nextVerificationAt(HOURS_AGO(10), 9, NOW) === null);
check("null for a garbage timestamp", nextVerificationAt("nonsense", 9, NOW) === null);
check(
  "a future timestamp yields a future moment",
  (nextVerificationAt(new Date(NOW.getTime() + 3_600_000), 9, NOW) ?? new Date(0)).getTime() > NOW.getTime()
);

section("defaults");

check("the default duty is 9 hours", DEFAULT_DUTY_HOURS === 9);
check("the default sits inside its own range", DEFAULT_DUTY_HOURS >= MIN_DUTY_HOURS && DEFAULT_DUTY_HOURS <= MAX_DUTY_HOURS);
check("the threshold default sits inside its own range", DEFAULT_MATCH_THRESHOLD >= MIN_MATCH_THRESHOLD && DEFAULT_MATCH_THRESHOLD <= MAX_MATCH_THRESHOLD);
check("the ranges are ordered", MIN_DUTY_HOURS < MAX_DUTY_HOURS && MIN_MATCH_THRESHOLD < MAX_MATCH_THRESHOLD);

/*
 * The default has to be judged against measured distances, not against its own
 * range — a threshold comfortably inside its range can still accept every
 * stranger. These came from running the real recognition model over five
 * known-different faces and over one face re-captured at different resolution,
 * brightness and compression.
 *
 * The old cosine default was deliberately looser than the closest stranger
 * pair. The security-first default now rejects that pair; these checks keep it
 * from drifting back into a known false-accept region.
 */
section("the threshold against measured faces");

check(
  "the default admits the worst measured same-person reading",
  DEFAULT_MATCH_THRESHOLD > MEASURED_SAME_PERSON_WORST,
  `default ${DEFAULT_MATCH_THRESHOLD} would refuse a real person (worst case ${MEASURED_SAME_PERSON_WORST})`
);

check(
  "the default stays below the closest measured stranger pair",
  DEFAULT_MATCH_THRESHOLD < MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  `default ${DEFAULT_MATCH_THRESHOLD} must reject the closest measured stranger (${MEASURED_CLOSEST_DIFFERENT_PEOPLE})`
);

check(
  "the allowed ceiling stays below the closest measured stranger pair",
  MAX_MATCH_THRESHOLD < MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  `ceiling ${MAX_MATCH_THRESHOLD} must not be configurable into the measured impostor band`
);

check(
  "the editable floor does not forbid a safe threshold",
  MIN_MATCH_THRESHOLD < MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  `floor ${MIN_MATCH_THRESHOLD} blocks any value that would work`
);

/* ---------------------------------------------------- the three angles -- */

/**
 * A 68-point face whose nose sits `noseX` across a 70..130 eye span.
 *
 * Only three of the points matter to headTurnSignal — the nose tip and the two
 * outer eye corners — so the rest are zeros at the origin. That is deliberately
 * not a realistic face: the point of these tests is the arithmetic that turns
 * three points into a sign and a magnitude, and a realistic point cloud would
 * make it harder to see which input moved the answer.
 *
 * The eye corners are `right` at x=70 and `left` at x=130 in *image* order,
 * which is the person's right eye on the left of the frame — a mirror, as a
 * camera preview is.
 */
function landmarks({ noseX = 100, scale = 1, shiftX = 0 } = {}) {
  const points = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  points[30] = { x: noseX, y: 120 }; // nose tip
  points[36] = { x: 70, y: 90 }; // the person's right eye, outer corner
  points[45] = { x: 130, y: 90 }; // the person's left eye, outer corner
  return points.map((p) => ({ x: p.x * scale + shiftX, y: p.y * scale }));
}

function sampleOf(pose, embedding) {
  return { pose, embedding };
}

section("headTurnSignal — turns three points into a signed proxy");

check("no points at all is not a pose", headTurnSignal(null) === null);
check("undefined is not a pose", headTurnSignal(undefined) === null);
check(
  "fewer than 48 points is refused rather than guessed at",
  headTurnSignal(Array.from({ length: 47 }, () => ({ x: 0, y: 0 }))) === null
);

const symmetric = headTurnSignal(landmarks());
check("a symmetric face reads as no turn", symmetric !== null && Math.abs(symmetric) < 1e-12, String(symmetric));

const turnedLeft = headTurnSignal(landmarks({ noseX: 115 }));
check(
  "turning towards the person's left gives a positive signal",
  turnedLeft !== null && turnedLeft > SIDE_MIN_SIGNAL,
  String(turnedLeft)
);

const turnedRight = headTurnSignal(landmarks({ noseX: 85 }));
check(
  "turning towards their right gives the same magnitude, negative",
  turnedRight !== null && Math.abs(turnedRight + turnedLeft) < 1e-12,
  String(turnedRight)
);

check(
  "standing off-centre in the frame does not read as a turn",
  Math.abs(headTurnSignal(landmarks({ shiftX: 40 }))) < 1e-12
);

check(
  "a closer face does not read as a turn",
  Math.abs(headTurnSignal(landmarks({ scale: 2 }))) < 1e-12
);

const brokenEye = landmarks();
brokenEye[45] = { x: Number.NaN, y: 90 };
check("one unusable eye corner is refused", headTurnSignal(brokenEye) === null);

const collapsed = landmarks();
collapsed[30] = { x: 70, y: 90 };
collapsed[45] = { x: 70, y: 90 };
check(
  "three points in one place is not a pose",
  headTurnSignal(collapsed) === null
);

section("poseFromSignal — the bands, and the dead zone between them");

check("null is not front", poseFromSignal(null) === null);
check("undefined is not front", poseFromSignal(undefined) === null);
check("NaN is not front", poseFromSignal(Number.NaN) === null);
check("Infinity is not a pose", poseFromSignal(Infinity) === null);

check("zero is front", poseFromSignal(0) === "front");
check("the edge of the band is still front", poseFromSignal(FRONT_MAX_SIGNAL) === "front");
check("and mirrored", poseFromSignal(-FRONT_MAX_SIGNAL) === "front");
check(
  "just past the band is not yet a side",
  poseFromSignal(FRONT_MAX_SIGNAL + 1e-6) === null
);
check(
  "just short of the side is still not a side",
  poseFromSignal(SIDE_MIN_SIGNAL - 1e-6) === null
);
check("the side threshold is a side", poseFromSignal(SIDE_MIN_SIGNAL) === "left");
check("and mirrored", poseFromSignal(-SIDE_MIN_SIGNAL) === "right");
check("a hard turn is still a side", poseFromSignal(0.9) === "left");

const deadZone = headTurnSignal(landmarks({ noseX: 109 }));
check(
  "a half-turned real frame lands in the dead zone rather than a side",
  deadZone !== null && poseFromSignal(deadZone) === null,
  String(deadZone)
);

check(
  "the bands do not overlap",
  FRONT_MAX_SIGNAL < SIDE_MIN_SIGNAL,
  `${FRONT_MAX_SIGNAL} must be below ${SIDE_MIN_SIGNAL}`
);
check(
  "the primary pose is the first thing captured",
  FACE_POSES[0] === PRIMARY_POSE,
  FACE_POSES.join(", ")
);

section("poseSatisfies and parsePose");

check("a matching pose satisfies", poseSatisfies("left", "left"));
check("a different pose does not", !poseSatisfies("left", "right"));
check("no pose does not satisfy anything", !poseSatisfies("front", null));

check("a pose label is read", parsePose("left") === "left");
check("surrounding space is ignored", parsePose("  RIGHT ") === "right");
check("case is ignored", parsePose("Front") === "front");
check("an unknown label is refused", parsePose("up") === null);
check("an empty label is refused", parsePose("") === null);
check("a non-string is refused", parsePose(3) === null);
check("null is refused", parsePose(null) === null);

section("fileFrame — a frame of the wrong angle is still usable");

/*
 * The rule this replaced was "refuse anything that is not the angle asked for",
 * which made the capture fussy about a mistake that costs nothing: an admin
 * holding a queue turns a head the wrong way and is told to do it again, when
 * the frame in hand is exactly right for a different slot. The invariant that
 * still holds is the one that matters — a frame is never *filed* under an angle
 * it does not show.
 */
const fileFront = fileFrame({ expected: "left", seen: "front", held: [] });
check(
  "a straight-on frame while the left is asked for is filed as straight on",
  fileFront.kind === "file" && fileFront.pose === "front",
  JSON.stringify(fileFront)
);

const fileLeft = fileFrame({ expected: "left", seen: "left", held: ["front"] });
check(
  "the angle asked for is filed",
  fileLeft.kind === "file" && fileLeft.pose === "left",
  JSON.stringify(fileLeft)
);

const retake = fileFrame({ expected: "left", seen: "left", held: ["front", "left"] });
check(
  "a retake of an angle already held is still filed",
  retake.kind === "file" && retake.pose === "left",
  JSON.stringify(retake)
);

const duplex = fileFrame({ expected: "front", seen: "right", held: ["front"] });
check(
  "a needed side angle is taken even when the front was asked for",
  duplex.kind === "file" && duplex.pose === "right",
  JSON.stringify(duplex)
);

const surplus = fileFrame({ expected: "right", seen: "left", held: ["front", "left"] });
check(
  "a second photo of an angle already held is refused",
  surplus.kind === "already-have" && surplus.pose === "left",
  JSON.stringify(surplus)
);

const between = fileFrame({ expected: "left", seen: null, held: ["front"] });
check("a frame in the dead zone asks for another", between.kind === "turn-more");

check(
  "nothing is ever filed under an angle the frame does not show",
  [fileFront, fileLeft, retake, duplex].every((f) => f.kind !== "file" || f.pose === fileFrame({ expected: f.pose, seen: f.pose, held: [] }).pose)
);

check(
  "the already-have message names what is still missing",
  /right-turn/.test(poseAlreadyHeld("left", "right")),
  poseAlreadyHeld("left", "right")
);

section("posesRequired — what this account has to present");

const frontOnly = [sampleOf("front", makeEmbedding(1))];
const allThree = [
  sampleOf("front", makeEmbedding(1)),
  sampleOf("left", makeEmbedding(2)),
  sampleOf("right", makeEmbedding(3)),
];

check(
  "an account with no face needs the frontal frame",
  JSON.stringify(posesRequired([], true)) === JSON.stringify(["front"])
);
check(
  "an account with only a frontal sample is asked for one frame",
  JSON.stringify(posesRequired(frontOnly, true)) === JSON.stringify(["front"]),
  posesRequired(frontOnly, true).join(", ")
);
check(
  "turned-head checks switched off means one frame even with all three",
  JSON.stringify(posesRequired(allThree, false)) === JSON.stringify(["front"])
);
check(
  "all three enrolled and switched on means all three, front first",
  JSON.stringify(posesRequired(allThree, true)) === JSON.stringify(["front", "left", "right"]),
  posesRequired(allThree, true).join(", ")
);

const missingRight = allThree.filter((s) => s.pose !== "right");
check(
  "a missing side is not required — an account is never asked for what it cannot present",
  JSON.stringify(posesRequired(missingRight, true)) === JSON.stringify(["front", "left"]),
  posesRequired(missingRight, true).join(", ")
);

section("matchGallery — one frame, every angle on the account");

const person = makeEmbedding(11);
const stranger = makeEmbedding(12);
const gallery = [
  sampleOf("front", person),
  sampleOf("left", stranger),
  sampleOf("right", stranger),
];

check("no probe never matches", matchGallery(null, gallery, 0.033) === null);
check("an empty gallery never matches", matchGallery(person, [], 0.033) === null);
check("the enrolled person matches", matchGallery(person, gallery, 0.033) === "front");
check(
  "a probe is matched against the whole gallery, not only its own pose's sample",
  matchGallery(person, [sampleOf("front", stranger), sampleOf("left", person)], 0.033) === "left"
);
check(
  "someone else matches nothing",
  matchGallery(stranger, [sampleOf("front", person)], 0.033) === null
);
check(
  "a distance just under the threshold matches",
  matchGallery(atCosine(person, 0.032), [sampleOf("front", person)], 0.033) === "front"
);
check(
  "a distance just over it does not",
  matchGallery(atCosine(person, 0.034), [sampleOf("front", person)], 0.033) === null
);

section("matchPresentation — a full three-frame check");

const threeFrames = [
  { pose: "front", embedding: person },
  { pose: "left", embedding: person },
  { pose: "right", embedding: person },
];
const threeSamples = [
  sampleOf("front", person),
  sampleOf("left", person),
  sampleOf("right", person),
];

const complete = matchPresentation(threeFrames, threeSamples, ["front", "left", "right"], 0.033);
check("three frames, three samples, all matching", complete.matched);
check("and no pose is named as failed", complete.failedPose === null);
check("and it reports which sample carried it", complete.matchedBy === "front");

const absentRight = matchPresentation(
  threeFrames.filter((f) => f.pose !== "right"),
  threeSamples,
  ["front", "left", "right"],
  0.033
);
check("a missing frame fails the check", !absentRight.matched);
check("and names the frame that was missing", absentRight.failedPose === "right");

const strangerLeft = matchPresentation(
  [
    { pose: "front", embedding: person },
    { pose: "left", embedding: stranger },
    { pose: "right", embedding: person },
  ],
  [sampleOf("front", person)],
  ["front", "left", "right"],
  0.033
);
check("a frame that does not match fails the check", !strangerLeft.matched);
check("and names the angle it failed on", strangerLeft.failedPose === "left");
check("and keeps the match it had already made", strangerLeft.matchedBy === "front");

const sideFrameMatchesFrontSample = matchPresentation(
  [{ pose: "front", embedding: person }, { pose: "left", embedding: person }],
  [sampleOf("front", person)],
  ["front", "left"],
  0.033
);
check(
  "a turned frame is allowed to match the frontal sample",
  sideFrameMatchesFrontSample.matched,
  "the gallery rule, not the pose label, decides what a frame may match"
);

check(
  "a check with only the frontal frame required ignores the side frames it was given",
  matchPresentation(
    [{ pose: "front", embedding: person }],
    [sampleOf("front", person)],
    ["front"],
    0.033
  ).matched
);

console.log(`\n${"-".repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
