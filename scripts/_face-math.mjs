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
  MAX_DUTY_HOURS,
  MAX_MATCH_THRESHOLD,
  MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  MEASURED_SAME_PERSON_WORST,
  MIN_DUTY_HOURS,
  MIN_MATCH_THRESHOLD,
  distance,
  formatEmbedding,
  isMatch,
  nextVerificationAt,
  parseEmbedding,
  parseStoredEmbedding,
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
  "the closest measured pair of different people does not match",
  isMatch(real, atCosine(real, MEASURED_CLOSEST_DIFFERENT_PEOPLE), DEFAULT_MATCH_THRESHOLD) === false
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
 * The old default of 0.6 sat above the whole different-person band, so every
 * face matched every other face.
 */
section("the threshold against measured faces");

check(
  "the default rejects every measured pair of different people",
  DEFAULT_MATCH_THRESHOLD < MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  `default ${DEFAULT_MATCH_THRESHOLD} is not below ${MEASURED_CLOSEST_DIFFERENT_PEOPLE}`
);

check(
  "the default still admits the worst measured same-person reading",
  DEFAULT_MATCH_THRESHOLD > MEASURED_SAME_PERSON_WORST,
  `default ${DEFAULT_MATCH_THRESHOLD} would refuse a real person (worst case ${MEASURED_SAME_PERSON_WORST})`
);

check(
  "the editable floor does not forbid a safe threshold",
  MIN_MATCH_THRESHOLD < MEASURED_CLOSEST_DIFFERENT_PEOPLE,
  `floor ${MIN_MATCH_THRESHOLD} blocks any value that would work`
);

console.log(`\n${"-".repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
