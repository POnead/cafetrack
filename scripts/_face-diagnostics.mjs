/**
 * Unit tests for src/lib/face-diagnostics.ts — reading a camera failure.
 *
 *   node scripts/_face-diagnostics.mjs
 *
 * Like scripts/_face-math.mjs, this drives the module the app actually loads and
 * needs no camera, no browser and no permission prompt.
 *
 * That matters more here than it does for the matching maths. The code under
 * test exists entirely because "the camera didn't open" reached someone as a
 * single undifferentiated report, and the thing it does is decide *which of five
 * quite different faults* a person is looking at — and therefore which of five
 * quite different pieces of advice they should be given. Sending someone to
 * check their hardware when the cause is a browser setting is the exact failure
 * this module was written to prevent, so the mapping deserves to be pinned down
 * exhaustively rather than eyeballed once.
 */
import {
  classifyCameraError,
  describeCameraProblem,
  failure,
} from "../src/lib/face-diagnostics.ts";

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

/** A DOMException stand-in. Only `name` is ever read, as documented. */
function domError(name, message = "") {
  return { name, message };
}

/* -------------------------------------------------- reading the exception -- */

section("reading the real cause out of a getUserMedia rejection");

check(
  "NotAllowedError is a permission refusal",
  classifyCameraError(domError("NotAllowedError")) === "permission-denied"
);

// The legacy alias, still emitted by older Safari. Getting this wrong sends a
// Safari user to check their webcam.
check(
  "PermissionDeniedError is a permission refusal",
  classifyCameraError(domError("PermissionDeniedError")) === "permission-denied"
);

check(
  "SecurityError is treated as a permission refusal",
  classifyCameraError(domError("SecurityError")) === "permission-denied"
);

check(
  "NotFoundError is no device",
  classifyCameraError(domError("NotFoundError")) === "no-device"
);

check(
  "DevicesNotFoundError is no device",
  classifyCameraError(domError("DevicesNotFoundError")) === "no-device"
);

check(
  "OverconstrainedError is no device — nothing matched what was asked for",
  classifyCameraError(domError("OverconstrainedError")) === "no-device"
);

check(
  "NotReadableError is a camera held by something else",
  classifyCameraError(domError("NotReadableError")) === "device-busy"
);

check(
  "TrackStartError is a camera held by something else",
  classifyCameraError(domError("TrackStartError")) === "device-busy"
);

check(
  "an unrecognised error is unknown, never guessed at",
  classifyCameraError(domError("SomethingNewInChrome")) === "unknown"
);

check(
  "a non-exception is unknown rather than a crash",
  classifyCameraError(null) === "unknown" &&
    classifyCameraError(undefined) === "unknown" &&
    classifyCameraError("NotAllowedError") === "unknown"
);

/*
 * The message text must not drive the classification. Browsers have reworded
 * these freely and keying off the text is how a permission denial ends up
 * reported as missing hardware.
 */
check(
  "the message is never used to decide the cause",
  classifyCameraError(domError("NotAllowedError", "Requested device not found")) ===
    "permission-denied"
);

/* --------------------------------------------------------- the wording table -- */

section("every problem has advice, and the advice is actionable");

const ALL = [
  "insecure-origin",
  "no-camera-api",
  "permission-denied",
  "no-device",
  "device-busy",
  "models-missing",
  "unknown",
];

for (const problem of ALL) {
  const d = describeCameraProblem(problem);
  check(
    `${problem} has a message and a next step`,
    typeof d.message === "string" && d.message.length > 0 &&
      typeof d.help === "string" && d.help.length > 20
  );
}

/*
 * Retryable means "clicking again could plausibly change the answer".
 *
 * This is the property that keeps the app from offering a dead control: an
 * insecure address cannot become secure by itself, and the weights cannot appear
 * without running the setup command. Showing a retry button under those two
 * instructions would be a button that is guaranteed not to work.
 */
section("retry is offered only where retry can work");

check(
  "an insecure address is not retryable — the address is the problem",
  describeCameraProblem("insecure-origin").retryable === false
);

check(
  "missing weights are not retryable — a command has to be run",
  describeCameraProblem("models-missing").retryable === false
);

check(
  "a refused permission is retryable — the user can change it outside the page",
  describeCameraProblem("permission-denied").retryable === true
);

check(
  "an absent camera is retryable — it may be plugged in",
  describeCameraProblem("no-device").retryable === true
);

check(
  "a busy camera is retryable — the other program may be closed",
  describeCameraProblem("device-busy").retryable === true
);

section("the two faults that used to be conflated stay distinct");

/*
 * These are the pair that produced every "the camera doesn't work" report worth
 * having: both end with no picture, one is fixed in a browser menu and the other
 * by connecting hardware. Merging them sends someone to the wrong place.
 */
check(
  "blocked and absent are different problems",
  describeCameraProblem("permission-denied").message !==
    describeCameraProblem("no-device").message
);

check(
  "blocked points at the browser, absent points at the device",
  /site settings/i.test(describeCameraProblem("permission-denied").help) &&
    /connect/i.test(describeCameraProblem("no-device").help)
);

section("failure() builds the same diagnosis the browser wrapper would");

const d = failure("permission-denied");
check(
  "carries the problem, wording and retryability",
  !d.ok && d.problem === "permission-denied" &&
    d.message === describeCameraProblem("permission-denied").message &&
    d.retryable === true
);

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);

if (fail > 0) process.exit(1);