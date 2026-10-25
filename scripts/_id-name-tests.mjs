/**
 * Unit tests for the name check, and for the two situations it used to conflate.
 *
 *   node scripts/_id-name-tests.mjs
 *
 * ## Why this is its own file
 *
 * The bug this covers is invisible to every existing suite. The HTTP suite
 * uploads a 1x1 pixel, gets "no name read", asserts the tone is `unknown` — and
 * passes identically whether the cause was "no OCR service is configured" or "a
 * service ran and found nothing". Both are correct behaviour and both were
 * reported to the admin in the same words, which is what sent someone looking for
 * a fault in the OCR that does not exist here.
 *
 * So this drives the rule directly and asserts on the *wording*, not merely the
 * tone.
 *
 * ## Why the rule lives in its own module
 *
 * `name-signal.ts` imports nothing at runtime — only a type, which is erased. That
 * is what lets it be tested in plain Node: the orchestrator pulls in the vendor
 * client, which imports its siblings without file extensions and cannot be
 * resolved outside the bundler. Keeping the one rule that is not a provider's job
 * in a leaf module is also just where it belongs.
 */
import { nameSignal } from "../src/lib/id-verification/name-signal.ts";
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

/** A syntactically valid but tiny PNG header — nothing decodes it in this test. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/* ------------------------------------------------- nothing configured -- */

section("with no ID-reading service configured");

/*
 * `no_reader_configured` is the state where nothing in this app can read text off
 * a card. That was the permanent default until the on-device reader arrived, and it
 * is still what a café sees with the reader switched off.
 */
const unconfigured = nameSignal(null, "Juan Dela Cruz", "no_reader_configured");

check("the name signal exists", Boolean(unconfigured));
check("and is unknown, not a pass", unconfigured?.tone === "unknown", unconfigured?.tone);

/*
 * The original fix.
 *
 * This wording has to say *why*. An admin who reads "no name was read" and then
 * waits for a name that will never arrive has been told the app failed, when in
 * fact nothing is configured that reads names.
 */
check(
  "it explains that no reading service is set up",
  /no id-reading service/i.test(unconfigured?.detail ?? ""),
  unconfigured?.detail?.slice(0, 60)
);

check(
  "it does NOT claim a name was read and simply not found",
  !/no name was read/i.test(unconfigured?.detail ?? "")
);

check(
  "it points the admin at the manual check",
  /roster/i.test(unconfigured?.detail ?? "")
);

check("it does not leak a card name into the message", !/dela cruz/i.test(unconfigured?.detail ?? ""));

check(
  "it reassures that the other checks still run",
  /face and card checks still run/i.test(unconfigured?.detail ?? "")
);

/* ------------------------------------------- reader on, model not there -- */

section("with the reader set up but its language file not downloaded");

/*
 * The state that was invisible until the on-device reader existed: a first run on a
 * café machine with no internet. The reader is switched on, nothing is wrong with
 * it, and it has never been able to run.
 *
 * Reporting this as "ran and found no name" — which is what a boolean
 * `readerConfigured` forced it to be — blames a blurry card for a download that
 * never happened, and tells the admin to check the photo when the photo is fine.
 */
const modelMissing = nameSignal(null, "Juan Dela Cruz", "model_missing");

check("it is still unknown", modelMissing?.tone === "unknown", modelMissing?.tone);

check(
  "it names the actual cause",
  /language file has not been downloaded/i.test(modelMissing?.detail ?? ""),
  modelMissing?.detail?.slice(0, 60)
);

check(
  "it does NOT blame the card or the photograph",
  !/no name was read/i.test(modelMissing?.detail ?? "") && !/blurry/i.test(modelMissing?.detail ?? "")
);

check(
  "it does NOT claim no service is configured",
  !/no id-reading service/i.test(modelMissing?.detail ?? "")
);

check(
  "it says what will fix it",
  /internet/i.test(modelMissing?.detail ?? "")
);

check(
  "it still reassures about the other checks",
  /still ran/i.test(modelMissing?.detail ?? "")
);

/* ------------------------------------------------ a reader is configured -- */

section("with an ID-reading service configured but reading nothing");

/*
 * A reader ran and found no name on *this* card. That is a different situation and
 * it has to read differently: the fix here was to stop blaming the setup for a
 * card that simply had nothing readable on it.
 */
const configured = nameSignal(null, "Juan Dela Cruz", "ran_but_read_nothing");

check("the name signal is still unknown", configured?.tone === "unknown", configured?.tone);

check(
  "it blames the card, not the configuration",
  /no name was read/i.test(configured?.detail ?? ""),
  configured?.detail?.slice(0, 60)
);

check(
  "it does NOT claim the service is missing",
  !/no id-reading service/i.test(configured?.detail ?? "")
);

check(
  "it does NOT blame the download",
  !/language file/i.test(configured?.detail ?? "")
);

check(
  "it still points the admin at the manual check",
  /roster/i.test(configured?.detail ?? "")
);

/* -------------------------------------------------- a name was actually read -- */

section("a name that was read is still compared");

const same = nameSignal("DELA CRUZ, JUAN SANTOS", "Juan Dela Cruz", "ok");
check("the same person passes", same.tone === "pass", same.detail);

const different = nameSignal("REYES, MARIA", "Juan Dela Cruz", "ok");
check("a different person fails", different.tone === "fail", different.detail);

const lower = nameSignal("dela cruz, juan", "Juan Santos Dela Cruz", "ok");
check("case does not decide it", lower.tone === "pass", lower.detail);

check(
  "a card name is quoted in the detail an admin has to read",
  /REYES/i.test(different.detail)
);

/* -------------------------------------------------- the two messages -- */

section("the two situations do not read the same");

const configuredText = configured?.detail ?? "";
const unconfiguredText = unconfigured?.detail ?? "";
const missingText = modelMissing?.detail ?? "";

check("they are different sentences", configuredText !== unconfiguredText);
check("all three are non-empty", [configuredText, unconfiguredText, missingText].every((t) => t.length > 0));

check(
  "all three are distinct",
  new Set([configuredText, unconfiguredText, missingText]).size === 3
);

check(
  "only the unconfigured one mentions setting a service up",
  /set up/i.test(unconfiguredText) && !/set up/i.test(configuredText)
);

check(
  "only the missing-model one mentions the download",
  /language file/i.test(missingText) &&
    !/language file/i.test(configuredText) &&
    !/language file/i.test(unconfiguredText)
);

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);