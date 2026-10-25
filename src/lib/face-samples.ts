/**
 * Reading and writing a staff member's enrolled face, angle by angle.
 *
 * One module rather than the same four queries in four routes, because the
 * routes that compare a face — the duty check, face sign-in, step two, and the
 * ID-card sign-in — all need the same answer to the same question, and four
 * copies of "load the samples, fall back to the old column, skip the corrupt
 * ones" is how they would end up disagreeing about an account.
 *
 * ## The fallback is the point
 *
 * Accounts enrolled before there were three angles hold exactly one vector, in
 * `users.face_embedding`. They have no rows in `user_face_samples`. If this
 * module returned only the table, every one of those accounts would become
 * unverifiable the moment this shipped — a wall of real baristas refused at the
 * till, caused entirely by a schema change.
 *
 * So a front sample is synthesised from the legacy column when the table has
 * none. It is a real sample: same 128 floats, same format, and it matches
 * exactly as it did before.
 */
import { db } from "./supabase";
import {
  DEFAULT_FACE_ENGINE,
  FACE_POSES,
  PRIMARY_POSE,
  type FaceEngine,
  type FaceFrameInput,
  type FacePose,
  type StoredFaceSample,
  formatEmbedding,
  matchPresentation,
  parseEngine,
  parsePose,
  parseStoredEmbedding,
  posesRequired,
} from "./face";

/** A stored angle with everything the review screen needs to show about it. */
export type FaceSample = {
  pose: FacePose;
  /** Null only for a synthesised legacy sample, which has a photo elsewhere. */
  embedding: Float32Array;
  /** Which engine produced the vector. Cross-engine comparison is refused. */
  model: FaceEngine;
  image: string | null;
  yawSignal: number | null;
  quality: number | null;
  capturedAt: string | null;
  /** False when the only sample on the account is the pre-angles legacy vector. */
  fromTable: boolean;
};

/** What the enrolment route writes for one angle. */
export type FaceSampleInput = {
  pose: FacePose;
  embedding: Float32Array;
  model: FaceEngine;
  image: string;
  yawSignal: number | null;
  quality: number | null;
};

const COLUMNS = "pose, embedding, model, image, yaw_signal, quality, captured_at";

function toNumberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every usable angle on this account, in capture order.
 *
 * `legacyEmbedding` is the `users.face_embedding` text the caller has already
 * read. Passing it in rather than querying for it keeps this to one query on the
 * normal path and no extra one on the legacy path.
 *
 * Rows whose pose label or embedding does not parse are dropped rather than
 * throwing. A corrupt row is not a reason to refuse someone at the till — it is
 * a reason for that angle not to be *required*, which is what dropping it
 * achieves. See posesRequired.
 */
export async function loadFaceSamples(
  userId: string,
  legacyEmbedding?: string | null
): Promise<FaceSample[]> {
  const { data } = await db()
    .from("user_face_samples")
    .select(COLUMNS)
    .eq("user_id", userId);

  const samples: FaceSample[] = [];

  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const pose = parsePose(row.pose);
    const embedding = parseStoredEmbedding(
      typeof row.embedding === "string" ? row.embedding : null
    );
    if (!pose || !embedding) continue;

    samples.push({
      pose,
      embedding,
      // A row that predates the column, or holds something unrecognised, is
      // legacy — that is what every vector written before the split actually is.
      model: parseEngine(row.model) ?? DEFAULT_FACE_ENGINE,
      image: typeof row.image === "string" && row.image.startsWith("data:") ? row.image : null,
      yawSignal: toNumberOrNull(row.yaw_signal),
      quality: toNumberOrNull(row.quality),
      capturedAt: typeof row.captured_at === "string" ? row.captured_at : null,
      fromTable: true,
    });
  }

  if (!samples.some((s) => s.pose === PRIMARY_POSE)) {
    const legacy = parseStoredEmbedding(legacyEmbedding ?? null);
    if (legacy) {
      samples.unshift({
        pose: PRIMARY_POSE,
        embedding: legacy,
        model: DEFAULT_FACE_ENGINE,
        image: null,
        yawSignal: null,
        quality: null,
        capturedAt: null,
        fromTable: false,
      });
    }
  }

  // FACE_POSES order rather than whatever the database returned: "front, left,
  // right" is what the review screen shows and what the capture sequence asks
  // for, and relying on row order to produce it is a coincidence, not a design.
  samples.sort((a, b) => FACE_POSES.indexOf(a.pose) - FACE_POSES.indexOf(b.pose));

  return samples;
}

/** Just the vectors, which is all the matching needs. */
export function toGallery(samples: readonly FaceSample[]): StoredFaceSample[] {
  return samples.map((s) => ({ pose: s.pose, embedding: s.embedding }));
}

/**
 * The samples a check may compare against, given the engine in use.
 *
 * Filtering here rather than inside the matcher is the point: a matcher that can
 * see samples from another engine can compare against them by accident, and the
 * result is a genuine person reported as a stranger.
 */
export function galleryFor(
  samples: readonly FaceSample[],
  engine: FaceEngine
): StoredFaceSample[] {
  return toGallery(samples.filter((s) => s.model === engine));
}

/**
 * Store this enrolment's angles, and drop any angle it did not include.
 *
 * The second half is not tidiness. An admin replacing a face may capture only
 * the straight-on photo — the screen allows it, and after a change of appearance
 * that is the normal thing to do. If the old left and right rows survived, the
 * account would keep requiring turned-head frames that belong to the *previous*
 * enrolment: every check would be compared against a face the person no longer
 * presents, and the screen would ask them to turn anyway. So a new enrolment
 * replaces the whole set, which is also what the capture screen shows.
 *
 * A failed delete is reported rather than thrown, like a failed write: the
 * straight-on sample is already stored and the account works.
 */
export async function saveFaceSamples(
  userId: string,
  entries: readonly FaceSampleInput[],
  capturedBy: string | null
): Promise<{ error: string | null }> {
  if (entries.length === 0) return { error: null };

  const rows = entries.map((e) => ({
    user_id: userId,
    pose: e.pose,
    embedding: formatEmbedding(e.embedding),
    model: e.model,
    image: e.image,
    yaw_signal: e.yawSignal,
    quality: e.quality,
    captured_at: new Date().toISOString(),
    captured_by: capturedBy,
  }));

  const { error } = await db()
    .from("user_face_samples")
    /*
     * Conflict target matches the unique index exactly: (user_id, pose, model).
     *
     * It was (user_id, pose) until the engine joined the key. Postgres refuses an
     * ON CONFLICT that matches no unique constraint, and the failure was quiet in
     * the worst way — the route reports a failed side write as a warning while the
     * straight-on photo is already saved, so an enrolment looked successful and
     * merely had one angle. The angles suite is what noticed.
     */
    .upsert(rows, { onConflict: ["user_id", "pose", "model"] });

  if (error) return { error: error.message };

  /*
   * Drop the angles this enrolment replaced, *within the engine it wrote*.
   *
   * Scoped per engine on purpose: an account being migrated holds rows from both,
   * and deleting "every pose I did not capture" without that filter would remove
   * the old engine's rows — which are the ones keeping the person able to work
   * until the cafe switches over.
   */
  const capturedByModel = new Map<FaceEngine, Set<FacePose>>();
  for (const entry of entries) {
    const poses = capturedByModel.get(entry.model) ?? new Set<FacePose>();
    poses.add(entry.pose);
    capturedByModel.set(entry.model, poses);
  }

  for (const [model, kept] of capturedByModel) {
    for (const pose of FACE_POSES) {
      if (kept.has(pose)) continue;

      const { error: deleteError } = await db()
        .from("user_face_samples")
        .delete()
        .eq("user_id", userId)
        .eq("model", model)
        .eq("pose", pose);

      if (deleteError) return { error: deleteError.message };
    }
  }

  return { error: null };
}

/** Remove every angle — what revoking a face means. */
export async function deleteFaceSamples(userId: string): Promise<{ error: string | null }> {
  const { error } = await db().from("user_face_samples").delete().eq("user_id", userId);
  return { error: error ? error.message : null };
}

export type PresentationResult = {
  /** The angles this account had to present, calculated from what it holds. */
  required: FacePose[];
  matched: boolean;
  /** The angle that failed, when it did. Never a distance. */
  failedPose: FacePose | null;
  samples: FaceSample[];
  /**
   * True when the account has a face enrolled, but none of it in the engine now
   * in use. That is the state a cafe is in the moment it switches engines and
   * before each person is re-enrolled, and it deserves its own sentence rather
   * than "not recognised".
   */
  needsEnrolment: boolean;
};

/**
 * Decide one presentation against one account.
 *
 * The single place the four routes that compare a face go through, so they
 * cannot disagree about how many frames a check is or which samples count. Each
 * route keeps its own policy around this — lockout counters, the step-two
 * ticket, the ID portrait comparison — but not its own matching.
 */
export async function evaluatePresentation(args: {
  userId: string;
  legacyEmbedding: string | null;
  frames: readonly FaceFrameInput[];
  threshold: number;
  requireProfileAngles: boolean;
  /** Only samples from this engine may be compared against. */
  engine: FaceEngine;
}): Promise<PresentationResult> {
  const samples = await loadFaceSamples(args.userId, args.legacyEmbedding);
  const gallery = galleryFor(samples, args.engine);
  const required = posesRequired(gallery, args.requireProfileAngles);

  const result = matchPresentation(args.frames, gallery, required, args.threshold);

  return {
    required,
    matched: result.matched,
    failedPose: result.failedPose,
    samples,
    // Has a face, but not in the engine in use: a different problem from "no
    // face enrolled", and the one a half-finished engine migration produces.
    needsEnrolment: gallery.length === 0 && samples.length > 0,
  };
}
