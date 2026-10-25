/**
 * Tests for the two forgery-adjacent checks: card fingerprints and ID number
 * shapes.
 *
 *   npm run test:id-forgery
 *
 * ## No browser and no canvas
 *
 * The fingerprint is computed from pixel brightness, which needs a canvas and
 * therefore a browser. But everything that decides anything — the distance, the
 * threshold, which numbers are impossible — is arithmetic on two strings, and that
 * is what this file tests.
 *
 * The hash values are produced by a helper below that simulates the same
 * comparison dHash makes over a grid, so the fixtures are real 64-bit hashes
 * produced the same way, not hand-typed hex that might not be reachable.
 */

import {
  hammingDistance,
  isSameCard,
  isValidFingerprint,
  duplicateDetail,
  DUPLICATE_DISTANCE,
  HASH_HEX_LENGTH,
} from "../src/lib/id-verification/card-hash.ts";
import { checkIdNumber } from "../src/lib/id-verification/id-number.ts";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

/**
 * Build a 64-bit dHash the same way card-fingerprint.ts does.
 *
 * `grid` is 8 rows of 8 comparison results, each "left cell brighter than the one
 * to its right". Rows are concatenated, exactly as the 9x8 canvas is walked.
 */
function hashFromBits(bits) {
  let hex = "";
  let nibble = 0;
  let inNibble = 0;

  for (const bit of bits) {
    nibble = (nibble << 1) | (bit ? 1 : 0);
    if (++inNibble === 4) {
      hex += nibble.toString(16);
      nibble = 0;
      inNibble = 0;
    }
  }
  return hex;
}

/**
 * A plausible "card" fingerprint.
 *
 * Card photos are not random: a card is mostly light, the portrait is a dark blob
 * in one corner and the hologram a bright one, so real hashes cluster well away
 * from uniform. This biases toward that so the fixtures behave like the real thing.
 */
function cardHash(seed = 7) {
  const bits = [];
  let s = seed;
  for (let i = 0; i < 64; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    bits.push(s % 3 !== 0 ? 1 : 0); // ~2/3 ones, like a real card
  }
  return hashFromBits(bits);
}

/** The same card photographed again: most bits agree, a few flip. */
function rephotograph(hash, flips = 4) {
  const bits = [];
  for (let i = 0; i < hash.length; i++) bits.push(parseInt(hash[i], 16));
  const all = [];
  for (const n of bits) for (let b = 3; b >= 0; b--) all.push((n >> b) & 1);

  for (let f = 0; f < flips; f++) {
    const at = (f * 13 + 3) % 64;
    all[at] = all[at] ? 0 : 1;
  }
  return hashFromBits(all);
}

/* ------------------------------------------------------------ distances -- */

section("fingerprint distance");

{
  const a = cardHash(7);
  const b = cardHash(19);

  check("a fingerprint is 16 hex characters", a.length === HASH_HEX_LENGTH, String(a.length));
  check("and is valid", isValidFingerprint(a));
  check("a card hashes differently from another card", hammingDistance(a, b) > DUPLICATE_DISTANCE, `${hammingDistance(a, b)}`);

  const same = cardHash(7);
  check("a card hashes identically to itself", hammingDistance(a, same) === 0);

  const again = rephotograph(a, 4);
  const distance = hammingDistance(a, again);
  check(
    "the same card re-photographed stays within the threshold",
    distance !== null && distance <= DUPLICATE_DISTANCE,
    `${distance}`
  );
  check("and is recognised as the same card", isSameCard(a, again));

  const badly = rephotograph(a, 20);
  check(
    "but a card that changed a lot does not",
    !isSameCard(a, badly),
    `${hammingDistance(a, badly)}`
  );

  check("an identical pair is the same card", isSameCard(a, cardHash(7)));
  check("two different cards are not", !isSameCard(a, b));
}

{
  /*
   * Malformed input must be "no answer", not "very different". Reporting a
   * missing fingerprint as a 64-bit difference would flag every account that has
   * one as a duplicate of every account that does not.
   */
  check("a missing fingerprint gives no distance", hammingDistance(null, cardHash()) === null);
  check("and is not the same card as anything", !isSameCard(null, cardHash()));
  check("a short fingerprint is rejected", !isValidFingerprint("abc"));
  check("a non-hex fingerprint is rejected", !isValidFingerprint("zzzzzzzzzzzzzzzz"));
  check("the wrong length is rejected", !isValidFingerprint("abc"));
  check("the right length and hex is accepted", isValidFingerprint("0123456789abcdef"));
  check("uppercase hex is accepted", isValidFingerprint("0123456789ABCDEF"));
  check("uppercase and lowercase hash equal", hammingDistance("0123456789abcdef", "0123456789ABCDEF") === 0);
}

{
  /* The distance must actually be a Hamming distance, not a string comparison.
   * One flipped nibble is four bits, not one character. */
  const a = "0000000000000000";
  const b = "000000000000000f";
  check("a flipped nibble counts as four bits", hammingDistance(a, b) === 4, String(hammingDistance(a, b)));
}

{
  const detail = duplicateDetail(3, DUPLICATE_DISTANCE, {
    id: "x",
    full_name: "Maria Santos",
    username: "msantos",
  });
  check("the message names the other account", /Maria Santos/.test(detail));
  check("it gives the distance", new RegExp(`\\b${3}\\b`).test(detail));
  check("it says what the threshold means", new RegExp(`under ${DUPLICATE_DISTANCE}`).test(detail));
  check("it does not accuse outright", !/(fraud|forged|stolen)/i.test(detail));

  const unnamed = duplicateDetail(2, DUPLICATE_DISTANCE, {
    id: "x",
    full_name: null,
    username: "jdelacruz",
  });
  check("it falls back to the username", /jdelacruz/.test(unnamed));
}

/* --------------------------------------------------------- ID numbers -- */

section("ID number shapes");

{
  /* PhilSys: sixteen digits in four groups. */
  check("a full PhilSys number is accepted", checkIdNumber("1234-5678-9012-3456", "philsys").ok);
  check("the separators are stripped", checkIdNumber("1234-5678-9012-3456", "philsys").normalised === "1234567890123456");
  check("spaces are tolerated", checkIdNumber("1234 5678 9012 3456", "philsys").ok);
  check("no separators at all is still accepted", checkIdNumber("1234567890123456", "philsys").ok);
  check("too few digits is refused", !checkIdNumber("1234-5678-9012", "philsys").ok);
  check("letters are refused", !checkIdNumber("ABCD-5678-9012-3456", "philsys").ok);
  check("the refusal explains the shape", /sixteen digits/.test(checkIdNumber("1234", "philsys").problem ?? ""));
}

{
  /* SSS: ten digits, printed 2-7-1. The last group is a single check digit. */
  check("a printed SSS number is accepted", checkIdNumber("12-3456789-0", "sss").ok);
  check("the check digit is part of the ten", checkIdNumber("12-3456789-0", "sss").normalised === "1234567890");
  check("eight digits is refused", !checkIdNumber("12345678", "sss").ok);
  check("twelve digits is refused", !checkIdNumber("123456789012", "sss").ok);
}

{
  /* UMID: the CRN is twelve, and one older series ran to thirteen. */
  check("a twelve-digit CRN is accepted", checkIdNumber("12-345678-9012", "umid").ok);
  check("the older thirteen-digit series is accepted", checkIdNumber("1234567890123", "umid").ok);
  check("ten digits is refused", !checkIdNumber("1234567890", "umid").ok);
}

{
  /* Passports: a letter, digits, optional trailing letter. */
  check("a modern passport number is accepted", checkIdNumber("P1234567A", "passport").ok);
  check("without the trailing letter", checkIdNumber("P1234567", "passport").ok);
  check("nine digits is accepted", checkIdNumber("X12345678", "passport").ok);
  check("starting with a digit is refused", !checkIdNumber("1P234567", "passport").ok);
  check("too short is refused", !checkIdNumber("P12345", "passport").ok);
}

{
  /*
   * LTO has never had one format, so the rule has to be loose enough to keep
   * working across the whole population of licences in service. The test that
   * matters is the one that must NOT tighten: a provincial series with letters.
   */
  check("a modern LTO number is accepted", checkIdNumber("L12-34-567890", "lto_license").ok);
  check("an older ten-digit number is accepted", checkIdNumber("1234567890", "lto_license").ok);
  check("a lettered provincial series is accepted", checkIdNumber("AB1234567890", "lto_license").ok);
  check("all letters is refused", !checkIdNumber("ABCDEFGH", "lto_license").ok);
  check("too short is refused", !checkIdNumber("L123", "lto_license").ok);
}

{
  /* Voter's IDs are assigned locally, so only "has digits" can be said. */
  check("a plausible local number is accepted", checkIdNumber("1234-5678", "voters").ok);
  check("all letters is refused", !checkIdNumber("ABCDEF", "voters").ok);
  check("absurdly long is refused", !checkIdNumber("1234567890123456789012345", "voters").ok);
}

{
  /*
   * An empty number is optional, not wrong. The admin types it only when they can
   * read it, and reporting a blank as a malformed number would be reporting a
   * missing field as a wrong one.
   */
  check("an empty number is not an error", checkIdNumber("", "philsys").ok);
  check("null is not an error", checkIdNumber(null, "philsys").ok);
  check("whitespace is not an error", checkIdNumber("   ", "philsys").ok);
  check("and it normalises to nothing", checkIdNumber("  ", "philsys").normalised === "");
}

{
  check("lowercase input is accepted", checkIdNumber("p1234567a", "passport").ok);
  check("and normalised to uppercase", checkIdNumber("p1234567a", "passport").normalised === "P1234567A");
}

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
