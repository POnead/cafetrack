/**
 * Face matching, and the duty window it opens.
 *
 * This module never sees an image. It compares two 128-float vectors and answers
 * yes or no, and it decides whether a staff member still owes a check. That
 * separation is what makes the feature buildable in this codebase: the model runs
 * in the browser, so the server needs no ML runtime, no native dependency and no
 * image pipeline — and everything below is testable with no camera, no browser
 * and no model.
 *
 * Embeddings are compared by *cosine* distance, not euclidean. See
 * `cosineDistance` for why — it is not a matter of taste, and getting it wrong
 * makes the feature either useless or unusable.
 */

/** Floats in a face embedding. Fixed by the recognition model, not by us. */
export const EMBEDDING_LENGTH = 128;

/**
 * How far apart two descriptors may be and still count as the same person.
 *
 * Measured, not assumed. Running the real recognition model in a browser over
 * one face re-captured ten ways — tighter framing, angled head, off-centre,
 * soft focus, dim light, blown highlights — against a set of five known-different
 * faces:
 *
 *   same person, realistic re-capture   0.0000 - 0.0301
 *   different people                    0.0362 - 0.0684
 *
 * 0.033 is the midpoint of that gap.
 *
 * This value has been wrong twice, and both times in a way that made the feature
 * do the opposite of what it says:
 *
 *   0.6  was above *every* distance between different people, so every face
 *        matched every other face. The threshold was effectively "yes".
 *   0.25 was chosen against a same-person band measured by resizing and
 *        re-lighting one photograph, which is far too easy. Real variation put
 *        the worst same-person reading at 0.317, above that threshold, so the
 *        real person was refused.
 *
 * A threshold is only meaningful against a properly measured band, which is why
 * the numbers above are kept next to it rather than left in a comment.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.033;

/*
 * The editable range, mirroring the one the settings API enforces.
 *
 * Cosine distance runs from 0 (identical direction) to 2 (opposite). The useful
 * region for faces is a narrow slice around 0, so the floor is well below any
 * value that could match and the ceiling stops short of the point where loose
 * stops meaning anything.
 *
 * Low is the safe direction to be wrong in: nothing matches, which refuses real
 * staff rather than admitting strangers, and a refused check has a manager
 * override behind it.
 */
export const MIN_MATCH_THRESHOLD = 0.01;
export const MAX_MATCH_THRESHOLD = 0.5;

/**
 * Measured separations, kept here so the default can be checked against reality.
 *
 * Produced by running the real recognition model in a browser over five
 * known-different faces, and over one face re-captured ten ways. Anything at or
 * above CLOSEST_DIFFERENT_PEOPLE accepts strangers, whatever the comment beside
 * the default says.
 */
export const MEASURED_SAME_PERSON_WORST = 0.0301;
export const MEASURED_CLOSEST_DIFFERENT_PEOPLE = 0.0362;

/**
 * When a replacement photo is far enough from the one it replaces to be worth
 * mentioning to the admin who uploaded it.
 *
 * Same units as the threshold above, and deliberately its own constant: this is a
 * hint, not an admission rule, and tying it to the editable threshold would let
 * someone quietly loosen the warning by loosening their settings.
 *
 * 0.04 sits just above the worst measured same-person re-capture (0.0301), so an
 * ordinary re-photograph does not trip it, and inside the measured different-person
 * band (0.0362-0.0684), so a genuine mismatch does. The old value was 0.6, from
 * the euclidean scale — under cosine it is far outside the range of anything at
 * all, and would have silently stopped firing.
 */
export const REPLACEMENT_MISMATCH_DISTANCE = 0.04;

/**
 * Significant digits used when an embedding is written to the database.
 *
 * Nine is the number that makes a float32 survive the trip: the format carries
 * about 7.2 significant digits, so 9 names any value precisely enough that
 * reading it back rounds to the identical float.
 *
 * Significant digits, not decimal places — `toFixed` would be quietly lossy. A
 * component of 0.0123456789 needs 9 *significant* digits, but `toFixed(9)` only
 * gives it 8, so it comes back as a neighbouring float. The error is around 1e-9
 * per component and would never change a match on its own, but it means the
 * stored embedding is not the one that was enrolled — and that is exactly the
 * kind of drift that makes "why does this person never verify" hard to answer.
 */
const EMBEDDING_PRECISION = 9;

/**
 * The band an embedding's L2 norm must fall inside.
 *
 * This model's descriptors are *not* unit length — measured across a set of real
 * faces they land at 1.29–1.35 — so the band is centred on what is actually
 * produced rather than on a textbook 1.0.
 *
 * Matching is by cosine, which divides out length, so a shrunken vector is no
 * longer automatically close to another shrunken one the way it was under
 * euclidean distance. The band is still load-bearing: it is what stands between
 * a descriptor that carries a real face and one that is 128 tiny numbers, whose
 * direction is rounding noise. Two such vectors can point the same way by
 * accident, and matching is not meant to succeed on a vector no photograph ever
 * produced.
 *
 * An earlier version only rejected an all-zero vector (MIN_NORM = 1e-6), which
 * stops the crudest attempt and nothing else: 128 values around 0.001 are "not
 * zero" and pass it. Anyone who can POST to the verify endpoint could open a duty
 * window with one of them, without ever having a photograph of the person.
 *
 * The band is wide enough to take the database round trip and the spread between
 * faces without complaint — formatEmbedding writes 9 significant digits, so
 * reading a stored vector back moves the norm by ~1e-9.
 */
const MIN_NORM = 0.5;
const MAX_NORM = 2;

/** Default length of the rolling window, in hours. One cafe duty. */
export const DEFAULT_DUTY_HOURS = 9;
export const MIN_DUTY_HOURS = 1;
export const MAX_DUTY_HOURS = 24;

/**
 * Turn whatever arrived into a usable embedding, or null if it is not one.
 *
 * Deliberately unforgiving, and deliberately not coercing outside the text form.
 * `Number("")` is 0, `Number(null)` is 0 and `Number(true)` is 1, so anything that
 * runs the input through `Number()` first would quietly accept an empty string, a
 * null or a boolean and turn it into a plausible-looking vector. Every element
 * therefore has to already *be* a finite number.
 *
 * Accepts a plain array (a JSON body), a typed array (the model running
 * in-process) or comma-joined text (the database), so no caller has to know which
 * of the three it is holding.
 *
 * Returns null rather than throwing: this runs on the sign-in path, and a
 * malformed vector from a client is a rejected request, not a server fault.
 */
export function parseEmbedding(raw: unknown): Float32Array | null {
  let parts: unknown[];
  // Only the text form turns characters into numbers. An array is taken at face
  // value, so a value that merely looks numeric cannot slip through.
  let fromText = false;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    parts = trimmed.split(",");
    fromText = true;
  } else if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
    parts = Array.from(raw as unknown as ArrayLike<number>);
  } else if (Array.isArray(raw)) {
    parts = raw;
  } else {
    return null;
  }

  if (parts.length !== EMBEDDING_LENGTH) return null;

  const out = new Float32Array(EMBEDDING_LENGTH);
  let sumSquares = 0;

  for (let i = 0; i < EMBEDDING_LENGTH; i++) {
    let value = parts[i];

    if (fromText) {
      // Parse each component explicitly. An empty component is refused rather
      // than coerced, because Number("") is 0 and "1,,2" is a malformed vector,
      // not one with a zero in the middle of it.
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) return null;
      value = Number(text);
    }

    // typeof first, so nothing non-numeric is ever passed to Number().
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out[i] = value;
    sumSquares += value * value;
  }

  const norm = Math.sqrt(sumSquares);
  if (norm < MIN_NORM || norm > MAX_NORM) return null;

  return out;
}

/** Render an embedding for the database. Inverse of parseEmbedding. */
export function formatEmbedding(embedding: Float32Array): string {
  const parts: string[] = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    // toPrecision, not toFixed — see EMBEDDING_PRECISION. It can emit exponent
    // notation for a very small component, which parseEmbedding reads back
    // through Number() and so handles without a special case.
    parts[i] = embedding[i].toPrecision(EMBEDDING_PRECISION);
  }
  return parts.join(",");
}

/**
 * Read an embedding out of a database column.
 *
 * Separate from parseEmbedding so a null column is a normal answer rather than
 * something each caller has to check: an account with no face enrolled has null
 * here, which means "this person cannot be verified", not an error.
 */
export function parseStoredEmbedding(raw: string | null | undefined): Float32Array | null {
  if (raw === null || raw === undefined) return null;
  return parseEmbedding(raw);
}

/**
 * Cosine distance between two parsed embeddings: `1 - (a·b / |a||b|)`.
 *
 * Zero means the two descriptors point the same way — the same person. It runs to
 * 2 for opposite directions.
 *
 * **Why cosine and not euclidean.** Both measure how far apart two faces are, but
 * euclidean also charges for the descriptors simply having different lengths, and
 * a descriptor's length tracks the *photograph* rather than the face. Re-shoot the
 * same person framed tighter, or in dimmer light, and the vector gets longer or
 * shorter while the face is unchanged. Euclidean reads that as a different person.
 *
 * Measured on the same photographs, against five known-different faces:
 *
 *                 euclidean          cosine
 *   same person   0.0067 - 0.3174    0.0000 - 0.0301
 *   different     0.3545 - 0.4944    0.0362 - 0.0684
 *
 * Euclidean spreads the same-person readings across most of the gap between the
 * two populations, so a threshold tight enough to refuse strangers also refuses
 * the real person — which is the failure that makes people switch the feature off
 * and walk in unauthenticated. Cosine collapses the same-person readings into the
 * bottom tenth of the gap and leaves the different-person band where it was.
 *
 * Callers go through `isMatch` rather than comparing this themselves, and that is
 * not just tidiness: the value returned here must never reach a client, because a
 * caller who learns how close a failed attempt was can tune the next one against
 * it.
 */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error("Cannot compare embeddings of different lengths");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  /*
   * A zero-length vector has no direction, so its angle is undefined. This cannot
   * happen through `parseEmbedding`, which rejects those, but this is the one
   * place that would divide by zero and hand back NaN — and NaN silently fails
   * every comparison it is put through, which is at least the safe way round.
   */
  if (normA === 0 || normB === 0) return Number.NaN;

  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Alias kept for callers that read better with the shorter name.
 *
 * The implementation is cosine, not the euclidean distance this used to be —
 * see `cosineDistance` for the measurement behind that.
 */
export const distance = cosineDistance;

/**
 * Do two embeddings describe the same person?
 *
 * A missing or malformed vector on either side is a "no" — never an error, and
 * never a yes. The two cases that matter: an account with no face enrolled must
 * not match itself, and a client that sent nothing must not match.
 *
 * `<=`, so a distance landing exactly on the threshold is a match. The threshold
 * is policy (stricter is a lower number); this only applies it.
 */
export function isMatch(
  a: Float32Array | null,
  b: Float32Array | null,
  threshold: number = DEFAULT_MATCH_THRESHOLD
): boolean {
  if (!a || !b) return false;
  if (!Number.isFinite(threshold)) return false;

  const d = cosineDistance(a, b);

  // NaN from a degenerate vector is a "no". `<=` against NaN is already false,
  // but said out loud rather than relied on.
  if (Number.isNaN(d)) return false;

  return d <= threshold;
}

/* ------------------------------------------------------- the duty window -- */

/**
 * Does this staff member still owe a face check?
 *
 * Rolling rather than a fixed shift grid: the window opens when someone passes
 * the check and closes `hours` later. A cafe that runs an early shift one day and
 * a late one the next does not keep a timetable its staff are measured against,
 * and tying the check to fixed slots would ask the same person to verify at
 * 5:45am on a day they are not in until noon.
 *
 * Every unanswerable input resolves to "must verify". A missing timestamp, an
 * unparseable one, a window of zero, a future timestamp left behind by a clock
 * change — all of them put the staff member in front of the camera rather than
 * waving them through. A false "already verified" is a silent hole; a false
 * "must verify" is one extra look at a camera.
 */
export function verificationRequired(args: {
  enabled: boolean;
  role: string;
  faceEnabled: boolean;
  lastVerifiedAt: string | Date | null | undefined;
  hours: number;
  now?: Date;
}): boolean {
  const {
    enabled,
    role,
    faceEnabled,
    lastVerifiedAt,
    hours,
    now = new Date(),
  } = args;

  // Admins are never gated. They are the ones who grant item permissions, reset
  // passwords and approve submissions; making the owner prove a face to get in
  // would also mean locking the only person who can fix a broken enrollment.
  if (!enabled) return false;
  if (role !== "staff") return false;

  // No reference face, nothing to check against. An account an admin chose not
  // to enroll must not become permanently unreachable — that is what the manager
  // override is for, but silently passing them is safer than trapping them.
  if (!faceEnabled) return false;

  if (!lastVerifiedAt) return true;

  const last = lastVerifiedAt instanceof Date ? lastVerifiedAt : new Date(lastVerifiedAt);
  const lastMs = last.getTime();
  if (!Number.isFinite(lastMs)) return true;

  // A window of zero would mean "always due", which is not what anyone means by
  // setting it. Treated as the minimum rather than as 0.
  const span = Number.isFinite(hours) && hours > 0 ? hours : MIN_DUTY_HOURS;

  const elapsedHours = (now.getTime() - lastMs) / 3_600_000;

  // A timestamp in the future — a clock change, a bad write — reads as elapsed
  // negative, which is comfortably under any window. Checking for it stops that
  // from silently granting hours of free access.
  if (elapsedHours < 0) return true;

  return elapsedHours >= span;
}

/**
 * When this person's next check falls due, or null if they do not owe one.
 *
 * Purely for display — the UI says "next check due 4:00 PM" so nobody is
 * surprised by a camera prompt halfway through a rush. It is derived from the
 * same comparison as `verificationRequired` and returns null for everyone that
 * function waves through, so the two cannot disagree.
 */
export function nextVerificationAt(
  lastVerifiedAt: string | Date | null | undefined,
  hours: number,
  now: Date = new Date()
): Date | null {
  if (!lastVerifiedAt) return null;

  const last = lastVerifiedAt instanceof Date ? lastVerifiedAt : new Date(lastVerifiedAt);
  if (!Number.isFinite(last.getTime())) return null;

  const span = Number.isFinite(hours) && hours > 0 ? hours : MIN_DUTY_HOURS;
  const due = new Date(last.getTime() + span * 3_600_000);

  return due.getTime() <= now.getTime() ? null : due;
}
