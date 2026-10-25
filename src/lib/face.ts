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

/* ------------------------------------------------------ the three angles -- */

/**
 * The angles a face is enrolled from.
 *
 * Straight on, then turned to the person's own left and to their own right —
 * "their own" every time it is written down, because the camera preview is a
 * mirror and "left" on screen is the person's right. The instruction says "turn
 * your head to your left" and the person does; nothing here depends on which
 * side of the screen that looks like.
 */
export type FacePose = "front" | "left" | "right";

/** In the order they are captured and presented, which is also the order they are checked. */
export const FACE_POSES: readonly FacePose[] = ["front", "left", "right"];

/** The one angle an account without side samples is checked on. */
export const PRIMARY_POSE: FacePose = "front";

/**
 * Where `headTurnSignal` sits for a straight-on face.
 *
 * Not zero, and not close to zero: the 68-point outline is not perfectly
 * symmetric on a real face, and someone facing a camera exactly still lands a
 * little to one side of it depending on which cheek is fuller. The band has to
 * be wide enough to call those frames frontal and narrow enough that "straight
 * on" still means something.
 */
export const FRONT_MAX_SIGNAL = 0.12;

/**
 * How far the signal has to travel before a frame counts as turned.
 *
 * The gap between this and FRONT_MAX_SIGNAL is deliberate: a head turned just
 * slightly is neither a frontal sample nor a usable side sample, and the honest
 * answer for it is "turn further" rather than filing it under whichever angle it
 * happens to be nearer. A sample filed under the wrong angle is worse than no
 * sample, because it will be compared against the wrong pose expectation later.
 *
 * Both numbers are provisional. They are bounds on a *proxy*, not a measured
 * angle — face-api supplies 2D landmarks and there is no head-pose solver here —
 * and no real front/left/right captures have been measured against them yet. The
 * enrolment records the signal it actually saw for every angle, which is what
 * makes them calibratable: `npm run test:angles:measure` prints the observed
 * spread, and these two constants are what it would change.
 */
export const SIDE_MIN_SIGNAL = 0.2;

/**
 * How far a head is turned, as a signed proxy in roughly [-1, 1].
 *
 * Positive means the nose has moved towards the person's own left eye, which is
 * what turning your head to your left does. Computed from the nose tip and the
 * outer corners of both eyes, because that is the pair of distances that
 * separates yaw from roll and from the face simply being off-centre: roll moves
 * both distances together, and being off-centre moves the *pair* without
 * changing which is nearer.
 *
 * Takes plain points so it is testable with no model, no browser and no camera —
 * the same reason `cosineDistance` takes vectors. Landmark indices are the iBUG
 * 68 convention face-api uses: 30 is the nose tip, 36-41 the person's right eye,
 * 42-47 their left.
 *
 * Returns null when the points it needs are not there or are degenerate. A pose
 * that cannot be established must not be guessed at: a guessed pose is a sample
 * filed under the wrong angle.
 */
export function headTurnSignal(
  points: readonly { x: number; y: number }[] | null | undefined
): number | null {
  if (!points || points.length < 48) return null;

  const nose = points[30];
  // Outer corners: the 36th and 45th landmark in iBUG order. The outer corner
  // rather than the centre of the eye, because the eye centre moves with the
  // gaze as well as with the head, and this measures the head.
  const rightEyeOuter = points[36];
  const leftEyeOuter = points[45];

  for (const p of [nose, rightEyeOuter, leftEyeOuter]) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  }

  const dRight = Math.hypot(nose.x - rightEyeOuter.x, nose.y - rightEyeOuter.y);
  const dLeft = Math.hypot(nose.x - leftEyeOuter.x, nose.y - leftEyeOuter.y);

  const total = dRight + dLeft;
  // Both distances at zero means the three points coincide, which is not a face.
  if (!Number.isFinite(total) || total <= 0) return null;

  return (dRight - dLeft) / total;
}

/**
 * Which angle a frame shows, or null when it is between two of them.
 *
 * Null is a real answer, not a failure: it is what the capture screens ask
 * someone to turn a little further on, and what stops a half-turned frame being
 * stored as a side sample.
 */
export function poseFromSignal(signal: number | null | undefined): FacePose | null {
  if (signal === null || signal === undefined || !Number.isFinite(signal)) return null;

  if (Math.abs(signal) <= FRONT_MAX_SIGNAL) return "front";
  if (signal >= SIDE_MIN_SIGNAL) return "left";
  if (signal <= -SIDE_MIN_SIGNAL) return "right";

  // The dead zone between a frontal frame and a decided turn.
  return null;
}

/** Does a frame showing `actual` satisfy a request for `expected`? */
export function poseSatisfies(expected: FacePose, actual: FacePose | null): boolean {
  return actual !== null && actual === expected;
}

/**
 * What the person is asked to do for each angle.
 *
 * One copy, used by the enrolment wizard and by every screen that checks a face,
 * because the same instruction appearing two ways is how someone ends up turning
 * the wrong way on one screen and not the other. `label` is the short name on a
 * button or a thumbnail, `short` fits mid-sentence, `instruction` is the sentence
 * printed under the camera.
 */
export const POSE_COPY: Record<
  FacePose,
  { label: string; short: string; instruction: string }
> = {
  front: {
    label: "Straight on",
    short: "straight-on",
    instruction: "Face the camera straight on, in even light.",
  },
  left: {
    label: "Turn left",
    short: "left-turn",
    instruction: "Turn your head to your left, about a third of the way round.",
  },
  right: {
    label: "Turn right",
    short: "right-turn",
    instruction: "Now turn your head to your right, the same amount.",
  },
};

/**
 * Why a frame was refused, in words the person in front of the camera can act on.
 *
 * There is no distance and no score here: this is about where the head is, not
 * how well it matched. The other-side case gets its own sentence because it is
 * the mistake a mirrored preview makes easy — the person's left appears on the
 * right of the screen, so "turn left" can be read either way.
 */
export function poseRefusal(expected: FacePose, seen: FacePose | null): string {
  if (seen === null) {
    return expected === PRIMARY_POSE
      ? "That frame is halfway between straight on and turned. Face the camera directly."
      : `That is not turned far enough for the ${POSE_COPY[expected].short}. Turn your head a little more.`;
  }

  if (expected === PRIMARY_POSE) {
    return "That photo is turned to one side. Face the camera straight on for this one.";
  }

  if (seen === PRIMARY_POSE) {
    return `That is still straight on. Turn your head to your ${expected} — about a third of the way round.`;
  }

  return `That is the ${seen} turn. We need your ${expected} — turn your head the other way.`;
}

/** Read a pose label off a request body or a database row, or null if it is not one. */
export function parsePose(raw: unknown): FacePose | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (FACE_POSES as readonly string[]).includes(value) ? (value as FacePose) : null;
}

/** One stored angle: what the database keeps per row of user_face_samples. */
export type StoredFaceSample = {
  pose: FacePose;
  embedding: Float32Array;
};

/** One frame a client presented for a check. */
export type FaceFrameInput = {
  pose: FacePose;
  embedding: Float32Array;
};

/**
 * Read the frames out of a request body, or explain why they are not usable.
 *
 * A check sends `[{ pose, embedding }, ...]` — one entry per angle the person
 * presented. The rules are strict on purpose:
 *
 *   - at least one frame, because a check with no face is not a check;
 *   - no more frames than there are angles, so a caller cannot ask to be
 *     compared indefinitely until something matches;
 *   - no duplicate angle, because two "left" frames means the caller is choosing
 *     which one counts;
 *   - every embedding parsed, because one unreadable frame in a three-frame
 *     presentation is a malformed request rather than a near miss.
 *
 * The error text names the pose but never a distance, and never says which
 * stored sample was close — the same rule the rest of this module follows.
 */
export function parseFaceFrames(
  raw: unknown
): { ok: true; frames: FaceFrameInput[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      error: "A face check needs at least the straight-on photograph.",
    };
  }

  if (raw.length > FACE_POSES.length) {
    return { ok: false, error: "Too many photographs for one check." };
  }

  const frames: FaceFrameInput[] = [];
  const seen = new Set<FacePose>();

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "A photograph in that check was not readable." };
    }

    const record = entry as Record<string, unknown>;
    const pose = parsePose(record.pose);
    if (!pose) {
      return { ok: false, error: "That check named an angle this system does not use." };
    }

    if (seen.has(pose)) {
      return { ok: false, error: `The ${pose} photograph was sent twice.` };
    }

    const embedding = parseEmbedding(record.embedding);
    if (!embedding) {
      return {
        ok: false,
        error: `The ${pose} photograph could not be read. Take it again.`,
      };
    }

    seen.add(pose);
    frames.push({ pose, embedding });
  }

  // The straight-on frame is the one angle every account has. A presentation
  // without it is either a client mistake or an attempt to be checked only on
  // the angle where a bad sample happens to match.
  if (!seen.has(PRIMARY_POSE)) {
    return { ok: false, error: "A face check has to include the straight-on photograph." };
  }

  return { ok: true, frames };
}

/**
 * The angles a check of this account has to present.
 *
 * Straight on always. A side angle only when three things are true at once: the
 * account holds a sample for it, an admin has asked for turned-head checks, and
 * that sample parsed. Any of those missing means the angle is simply not
 * required —
 *
 *   - an account enrolled before this feature existed has no side samples, and
 *     asking it to present one would leave a real barista unable to start work;
 *   - a cafe that has turned the checks off keeps the samples as reference
 *     images without being asked for them at the till;
 *   - a side row whose embedding is corrupt is not a requirement it is possible
 *     to satisfy.
 *
 * The same function is used by the capture screen (to decide what to ask for)
 * and by the route (to decide what to accept), so the two cannot disagree about
 * how many photographs a check is.
 */
export function posesRequired(
  samples: readonly StoredFaceSample[],
  requireProfileAngles: boolean
): FacePose[] {
  const held = new Set(samples.map((s) => s.pose));

  return FACE_POSES.filter((pose) => {
    if (pose === PRIMARY_POSE) return true;
    return requireProfileAngles && held.has(pose);
  });
}

/**
 * Does this probe match any angle on the account?
 *
 * Compared against the whole gallery rather than only the sample of the same
 * pose, and that is on purpose. The pose tells the capture screen what to ask
 * for and tells the route that the challenge was met; it does not narrow which
 * vector a frame may be compared with. Two reasons:
 *
 *   - a person turned towards their left is still the person in their frontal
 *     sample, and the measured band shows a moderately turned head inside the
 *     same-person range (0.0301 worst case included an angled head). Refusing to
 *     use it would turn a usable comparison into a failed check;
 *   - the side samples are the least reliable vectors on the account. Making a
 *     check depend on the *stored* side vector would mean one bad enrolment locks
 *     somebody out; comparing the live frame against everything enrolled means a
 *     poor side sample can only fail to help, never actively obstruct.
 *
 * Returns the pose that matched, or null. Never the distance: a caller that
 * learns how close a failure was can tune against it, which is why `isMatch`
 * exists in the first place.
 */
export function matchGallery(
  probe: Float32Array | null,
  samples: readonly StoredFaceSample[],
  threshold: number = DEFAULT_MATCH_THRESHOLD
): FacePose | null {
  if (!probe) return null;

  for (const pose of FACE_POSES) {
    const sample = samples.find((s) => s.pose === pose);
    if (!sample) continue;
    if (isMatch(probe, sample.embedding, threshold)) return pose;
  }

  return null;
}

/**
 * Check a full presentation — one frame per required angle — against the gallery.
 *
 * Every required angle has to match, and the failure names the angle that did
 * not, so a screen can say "that one was the left turn" instead of "try again".
 * The name is the requested pose, not which stored sample it matched: telling
 * someone which of their own samples they failed against is a clue about the
 * template, and there is no version of that sentence that helps a real employee.
 *
 * Each frame is matched independently against the whole gallery. A probe is not
 * required to match the sample with its own pose label — see matchGallery.
 */
export function matchPresentation(
  frames: readonly { pose: FacePose; embedding: Float32Array | null }[],
  samples: readonly StoredFaceSample[],
  requiredPoses: readonly FacePose[],
  threshold: number = DEFAULT_MATCH_THRESHOLD
): { matched: boolean; failedPose: FacePose | null; matchedBy: FacePose | null } {
  let firstMatch: FacePose | null = null;

  for (const expected of requiredPoses) {
    const frame = frames.find((f) => f.pose === expected);
    if (!frame) return { matched: false, failedPose: expected, matchedBy: firstMatch };

    const matchedBy = matchGallery(frame.embedding, samples, threshold);
    if (!matchedBy) return { matched: false, failedPose: expected, matchedBy: firstMatch };
    if (firstMatch === null) firstMatch = matchedBy;
  }

  return { matched: true, failedPose: null, matchedBy: firstMatch };
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
