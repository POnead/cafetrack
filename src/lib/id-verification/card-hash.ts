/**
 * Recognising the same ID card when it is photographed twice.
 *
 * ## What this catches, and what it does not
 *
 * It catches the fraud a café actually sees: one card submitted for two accounts,
 * or a relative's ID reused for a second hire. That is not exotic, it is what
 * happens when someone is asked for proof and has already given it once.
 *
 * It does **not** catch a well-made forgery. Someone with a printed PhilSys
 * template and a pasted photograph produces a different hash and sails past. What
 * stops that is the portrait comparison in local.ts, which is why this belongs
 * alongside it rather than in place of it. Nothing local is a substitute for the
 * forgery module HyperVerge charges $0.04 for, and this file does not pretend to
 * be one.
 *
 * ## Why a perceptual hash and not the image
 *
 * The same card photographed twice is not the same file — different angle,
 * different light, a different phone. Comparing bytes finds nothing. A perceptual
 * hash reduces the image to 64 bits describing how the brightness changes from one
 * cell to the next, which survives re-photography, cropping and compression and
 * changes completely for a different document.
 *
 * 64 bits is the standard width for this. It is short enough that unrelated images
 * are 32 bits apart on average, and long enough that two photographs of one card
 * land within a handful.
 */

/** How many bits a card fingerprint carries. */
export const HASH_BITS = 64;

/** Hex characters in a fingerprint — two per bit. */
export const HASH_HEX_LENGTH = HASH_BITS / 4;

/**
 * Below this Hamming distance, two fingerprints are the same physical card.
 *
 * **This number is reasoned, not measured** — the same caveat as
 * `DEFAULT_ID_MATCH_THRESHOLD` in local.ts, and for the same reason.
 *
 * Two photographs of one card differ in angle, glare, shadow and white balance,
 * all of which move a handful of the 64 comparisons. Two different cards disagree
 * on roughly half of them. The gap between those is wide, which is the only reason
 * a fixed threshold is defensible at all.
 *
 * Set high rather than low. A missed duplicate is one person to notice; a false
 * "this is the same card" on two different documents tells an admin that a
 * colleague's ID has been reused, which is an accusation, and the admin has no way
 * to tell the tool got it wrong.
 */
export const DUPLICATE_DISTANCE = 8;

/**
 * Hamming distance between two hex fingerprints, or null if either is unusable.
 *
 * Null rather than a number, because a malformed fingerprint is not "very
 * different from the other one" — it is the absence of an answer, and treating it
 * as a large distance would report every malformed value as a duplicate.
 */
export function hammingDistance(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  if (a.length !== HASH_HEX_LENGTH || b.length !== HASH_HEX_LENGTH) return null;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return null;

  let distance = 0;
  for (let i = 0; i < HASH_HEX_LENGTH; i++) {
    // `parseInt` per character rather than `Number.parseInt` on a pair: the loop
    // is 64 iterations and this is not a hot path, but parsing two nibbles at once
    // needs a shift and a mask, which is more code to get wrong than it saves.
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // Population count of a nibble, without the lookup table.
    distance += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return distance;
}

/** True when two fingerprints are close enough to be the same document. */
export function isSameCard(
  a: string | null | undefined,
  b: string | null | undefined,
  threshold = DUPLICATE_DISTANCE
): boolean {
  const distance = hammingDistance(a, b);
  return distance !== null && distance <= threshold;
}

/** Whether a value is shaped like a fingerprint this module produced. */
export function isValidFingerprint(value: unknown): value is string {
  return typeof value === "string" && value.length === HASH_HEX_LENGTH && /^[0-9a-f]+$/i.test(value);
}

/**
 * How a duplicate read should be worded on the review screen.
 *
 * A pure function so the wording is testable and so the decision about what to say
 * is visible in one place rather than assembled at the call site. The distance is
 * included because an admin deciding whether to accuse a colleague of reusing an ID
 * is entitled to see how close the match actually was.
 */
export function duplicateDetail(
  distance: number,
  threshold: number,
  other: { id: string; full_name: string | null; username: string | null }
): string {
  const who = other.full_name || other.username || "another account";

  return (
    `This looks like the same card already uploaded for ${who} ` +
    `(the two images differ in ${distance} of ${HASH_BITS} places, and anything ` +
    `under ${threshold} counts as the same document). ` +
    `Compare the two accounts before approving — one card cannot cover two people. ` +
    `It may also be the same person photographed twice.`
  );
}
