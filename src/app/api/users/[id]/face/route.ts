import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, clientIp, readBody, dbFail } from "@/lib/api";
import { clearSessionCache, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  DEFAULT_FACE_ENGINE,
  FACE_POSES,
  POSE_COPY,
  PRIMARY_POSE,
  type FacePose,
  descriptorVersionFor,
  distance,
  formatEmbedding,
  parseEmbedding,
  parseEngine,
  parsePose,
  poseFromSignal,
  poseSatisfies,
  replacementMismatchDistance,
} from "@/lib/face";
import {
  deleteFaceSamples,
  loadFaceSamples,
  saveFaceSamples,
  type FaceSampleInput,
} from "@/lib/face-samples";
import { readFaceImage } from "@/lib/face-image";
import { getFaceDutyHours } from "@/lib/settings";
import {
  createFacePlusPlusEnrollment,
  deleteFacePlusPlusEnrollment,
  facePlusPlusFaceSetTokens,
  facePlusPlusMode,
} from "@/lib/facepp";

export const runtime = "nodejs";

/**
 * A staff member's reference face: enrol, replace, remove, view, and the manager
 * override that lets someone in when a camera will not cooperate.
 *
 *   POST    multipart — the photo and the embedding, both produced in the browser
 *   DELETE            — remove an enrolment
 *   PATCH             — manager override, or reset the current duty check
 *   GET               — the reference photo, for the admin who enrolled it
 *
 * Three verbs in one file because they are three verbs on one resource and share
 * the same lookup. They do not share handlers: POST validates two inputs with
 * different rules, and folding that into one branchy handler is how a validation
 * ends up skipped on the path nobody tested.
 *
 * **Staff only.** Admins are never gated by the duty check — they are the people
 * who grant permissions, reset passwords and approve submissions — so an admin
 * account is refused here rather than quietly accepted and never used. It would
 * be a row that could never do anything.
 *
 * This is a separate route from /api/users, which stays JSON. The staff list is
 * loaded on every page load and the suites create accounts through it; making it
 * multipart would put a 30KB blob and a second content type into the hot path of
 * both for nothing. Creating an account and enrolling a face are two calls from
 * the UI, which also means a failed photo can be retried without leaving a
 * duplicate account behind.
 */

/** Never selects password_hash, and never selects face_embedding outside POST. */
const USER_COLUMNS =
  "id, username, full_name, role, qr_token, can_manage_items, " +
  "is_active, deactivation_reason, deactivated_at, created_at, " +
  "face_enabled, face_enrolled_at, face_enrolled_by, last_face_verified_at";

/** How each angle is described in an error, in words an admin can act on. */
const POSE_LABEL: Record<FacePose, string> = {
  front: "straight-on",
  left: "left-turn",
  right: "right-turn",
};

/**
 * One field of the upload, per angle.
 *
 * `embedding_front`, `image_front`, `signal_front`, `quality_front` and the same
 * for the two side angles. A bare `embedding`/`image` still means the straight-on
 * angle for compatibility, but every enrolment must include all three angles.
 */
function fieldFor(
  form: FormData,
  base: "embedding" | "image" | "signal" | "quality" | "model",
  pose: FacePose
): FormDataEntryValue | null {
  const suffixed = form.get(`${base}_${pose}`);
  if (suffixed !== null) return suffixed;
  if (pose === PRIMARY_POSE) return form.get(base);
  return null;
}

/** A numeric form field, or null when it is absent or not a number. */
function numberField(value: FormDataEntryValue | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Sentence-case an angle label, for the start of a message. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ---------------------------------------------------------------- POST ---- */

export const POST = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    /*
     * multipart, not readBody().
     *
     * readBody() calls req.text() and JSON.parse, which turns a multipart body
     * into one unreadable string. That is the right behaviour for every other
     * route in the app and the wrong one here, so this route reads the form
     * directly. Nothing else in src/ does this yet.
     */
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("Expected a multipart upload with a photo", 400);
    }

    // Read the row first, so a 404 is answered before any upload work, and so
    // the audit entry records what changed rather than only what was attempted.
    // The previous embedding comes back in the same read — it is needed for the
    // different-person warning below, and a second query to fetch what was
    // already in hand would spend a round trip on a 1.5KB text column.
    const { data: before } = await db()
      .from("users")
      .select(
        "id, username, full_name, role, is_active, face_enabled, face_enrolled_at, face_embedding, " +
          "facepp_faceset_token, facepp_face_token, facepp_retired_facesets"
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    if (before.role !== "staff") {
      return fail("Only staff accounts can have a face enrolled", 400);
    }

    /*
     * Read every angle that was sent, in capture order.
     *
     * All three angles are required for an enrolment or replacement. Accepting a
     * partial set makes the UI claim an account has completed multi-angle
     * verification when it has not.
     *
     * The reverse — a side angle the admin *thinks* they took but which is
     * really straight on — is refused, because that is a sample that would be
     * compared against the wrong expectation later. The client sends the head
     * signal it measured; if that signal says the frame is not the angle it was
     * filed under, the frame is rejected by name.
     */
    const captured: FaceSampleInput[] = [];
    let frontImage: string | null = null;
    let frontEmbedding: Float32Array | null = null;
    let frontBytes = 0;
    let frontType = "";

    for (const pose of FACE_POSES) {
      const rawEmbedding = fieldFor(form, "embedding", pose);
      const rawImage = fieldFor(form, "image", pose);

      // Nothing sent for this angle.
      if (rawEmbedding === null && rawImage === null) {
        return fail(
          `A ${POSE_LABEL[pose]} photo is required. Capture all three views before saving.`
        );
      }

      // Half an angle is a client bug, not a usable sample.
      if (rawEmbedding === null) {
        return fail(`The ${POSE_LABEL[pose]} photo arrived without its face data — take it again`);
      }
      if (rawImage === null) {
        return fail(`The ${POSE_LABEL[pose]} photo is missing — take it again`);
      }

      // Embedding first: it is the part the server actually trusts, and a bad one
      // makes the whole enrolment worthless, so it should not cost a photo upload
      // to find out.
      const embedding = parseEmbedding(rawEmbedding);
      if (!embedding) {
        return fail(
          `The ${POSE_LABEL[pose]} face data was missing or malformed. ` +
            "Take the photo again — the face could not be read from it."
        );
      }

      const image = await readFaceImage(rawImage);
      if (!image.ok) return fail(`${capitalise(POSE_LABEL[pose])}: ${image.message}`);

      const model = parseEngine(fieldFor(form, "model", pose)) ?? DEFAULT_FACE_ENGINE;
      const yawSignal = numberField(fieldFor(form, "signal", pose));
      if (yawSignal !== null) {
        const seen = poseFromSignal(yawSignal, model);
        if (!poseSatisfies(pose, seen)) {
          return fail(
            seen === null
              ? `The ${POSE_LABEL[pose]} photo is not turned enough to use. ` +
                "Take it again with the head clearly turned."
              : `That photo reads as “${POSE_COPY[seen].label}”, but the screen is ` +
                `asking for “${POSE_COPY[pose].label}”. Take it again.`
          );
        }
      }

      captured.push({
        pose,
        embedding,
        /*
         * Which engine produced this vector, declared by the client that ran it.
         *
         * Defaults to legacy because that is what every capture screen computes
         * today, and the truth about the vector matters more than the setting:
         * mislabelling a legacy vector as sface would make it silently
         * incomparable with everything else on the account. A client that uses
         * the other engine says so with `model_<pose>`.
         */
        model,
        image: image.dataUrl,
        yawSignal,
        quality: numberField(fieldFor(form, "quality", pose)),
      });

      if (pose === PRIMARY_POSE) {
        frontImage = image.dataUrl;
        frontEmbedding = embedding;
        frontBytes = image.bytes;
        frontType = image.type;
      }
    }

    // The loop above guarantees these for a valid upload, but the compiler
    // cannot see that through the loop's `continue`.
    if (!frontEmbedding || !frontImage) {
      return fail("A straight-on photo is required");
    }

    const facePlusPlus = facePlusPlusMode();
    let facePlusPlusWarning: string | null = null;
    if (facePlusPlus === "invalid") {
      console.error("Face++ credentials are incomplete; saving the local face reference instead.");
      facePlusPlusWarning =
        "Face++ is not configured, but the reference photo was saved. Sign-in can use local SFace verification if this server has it configured.";
    }

    let facePlusPlusEnrollment: { facesetToken: string; faceToken: string } | null = null;
    if (facePlusPlus === "enabled") {
      const enrolled = await createFacePlusPlusEnrollment(id, frontImage);
      if ("status" in enrolled) {
        if (enrolled.status === "unavailable") {
          console.error(`Face++ enrollment failed (${enrolled.code}).`);
          facePlusPlusWarning =
            "Face++ is temporarily unavailable, but the reference photo was saved. Sign-in can use local SFace verification while the provider is unavailable.";
        } else {
          return fail("Face++ could not find exactly one face in the straight-on photo. Retake it.");
        }
      } else {
        facePlusPlusEnrollment = enrolled;
      }
    }

    const previousFaceSet =
      typeof before.facepp_faceset_token === "string" ? before.facepp_faceset_token : null;
    const retiredFaceSets = facePlusPlusFaceSetTokens(
      null,
      before.facepp_retired_facesets
    );
    if (
      previousFaceSet &&
      previousFaceSet !== facePlusPlusEnrollment?.facesetToken &&
      !retiredFaceSets.includes(previousFaceSet)
    ) {
      retiredFaceSets.push(previousFaceSet);
    }

    const { data, error } = await db()
      .from("users")
      .update({
        face_image: frontImage,
        face_embedding: formatEmbedding(frontEmbedding),
        facepp_faceset_token: facePlusPlusEnrollment?.facesetToken ?? null,
        facepp_face_token: facePlusPlusEnrollment?.faceToken ?? null,
        facepp_retired_facesets: retiredFaceSets,
        face_enabled: true,
        face_enrolled_at: new Date().toISOString(),
        face_enrolled_by: admin.id,
        // A fresh enrolment is not a pass. Someone re-photographed because the
        // old one was unusable should still have to turn up for the check.
        last_face_verified_at: null,
      })
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error || !data) {
      if (facePlusPlusEnrollment) {
        const cleanup = await deleteFacePlusPlusEnrollment(facePlusPlusEnrollment.facesetToken);
        if (cleanup.status === "unavailable") {
          console.error(`Face++ could not remove an unsaved FaceSet (${cleanup.code}).`);
        }
      }
      if (error) return dbFail(error);
      return fail("User not found", 404);
    }

    if (previousFaceSet && previousFaceSet !== facePlusPlusEnrollment?.facesetToken) {
      const deleted = await deleteFacePlusPlusEnrollment(previousFaceSet);
      if (deleted.status === "unavailable") {
        console.error(`Face++ could not remove the replaced FaceSet (${deleted.code}).`);
        facePlusPlusWarning = [
          facePlusPlusWarning,
          "The new face was saved, but Face++ could not remove the previous reference. Ask an administrator to review it.",
        ]
          .filter(Boolean)
          .join(" ");
      } else {
        const remainingRetired = retiredFaceSets.filter((token) => token !== previousFaceSet);
        const { error: retiredUpdateError } = await db()
          .from("users")
          .update({ facepp_retired_facesets: remainingRetired })
          .eq("id", id);
        if (retiredUpdateError) {
          console.error("Face++ retired FaceSet cleanup state could not be updated:", retiredUpdateError.message);
          facePlusPlusWarning = [
            facePlusPlusWarning,
            "The new face was saved, but its previous Face++ reference may need an administrator to review it.",
          ]
            .filter(Boolean)
            .join(" ");
        }
      }
    }
    /*
     * The per-angle rows, after the users row rather than before it.
     *
     * `users.face_enabled = false` is what makes a face unusable; a row in
     * user_face_samples is only ever read for an account that is enabled. So if
     * these two writes are going to disagree, the safe order is the one where
     * the account is enabled and the side angles are missing — that degrades to
     * exactly the pre-angles behaviour. The other order would leave side samples
     * for a person whose face is not enrolled at all.
     */
    const stored = await saveFaceSamples(id, captured, admin.id);

    /*
     * A failed side write is reported, not thrown.
     *
     * The straight-on photo is already stored and the account works. Answering
     * with an error would tell the admin nothing was saved when the one thing
     * that matters most was — and the obvious next step, taking all the photos
     * again, is worse than the state they are actually in.
     */
    const angleWarning = stored.error
      ? "The straight-on photo was saved, but the turned-head angles could not be stored. " +
        "You can add them later with Replace photo."
      : null;
    /*
     * Warn when a replacement looks like a different person.
     *
     * The realistic mistake is an admin photographing the wrong staff member, and
     * without this the symptom appears weeks later as a barista who cannot get in
     * and no record of why. The distance goes to the *admin*, who submitted it,
     * never to the person being enrolled — see the rule that a similarity figure
     * must never reach the face being checked.
     */
    let possiblyDifferentPerson = false;
    let previousDistance: number | null = null;

    /*
     * Compare like with like, or not at all.
     *
     * A vector from another engine — or from the old reader, which embedded the
     * whole frame — lives in a different space, so a distance between it and this
     * capture is a number with no meaning. Warning from one would fire on every
     * re-enrolment after the engine switch, and an admin who sees a false warning
     * every time learns to ignore the true one.
     */
    const newModel = captured.find((c) => c.pose === PRIMARY_POSE)?.model ?? DEFAULT_FACE_ENGINE;
    const previousFront = (await loadFaceSamples(before.id, before.face_embedding)).find(
      (s) =>
        s.pose === PRIMARY_POSE &&
        s.model === newModel &&
        s.version === descriptorVersionFor(newModel)
    );

    if (previousFront) {
      previousDistance = distance(previousFront.embedding, frontEmbedding);
      // A loose bar on purpose: the same person's captures vary more than this
      // under ordinary conditions — lighting, glasses, a long shift — while a
      // different person sits well outside it, so only a real mismatch trips it.
      // The bar is per engine; see replacementMismatchDistance in lib/face.ts.
      possiblyDifferentPerson = previousDistance > replacementMismatchDistance(newModel);
    }

    const warnings = [
      possiblyDifferentPerson
        ? "This photo looks like a different person than the one already enrolled."
        : null,
      angleWarning,
      facePlusPlusWarning,
    ].filter((warning): warning is string => Boolean(warning));

    const angles = captured.map((c) => c.pose);

    await audit(
      admin,
      "USER_FACE_ENROLL",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        replaced: Boolean(before.face_embedding),
        // Which angles this enrolment actually holds, and how far each head was
        // turned when it was captured. This is the record that makes the pose
        // bands in lib/face.ts calibratable later: it is the only place the
        // signals from real captures are written down.
        angles,
        yaw_signals: Object.fromEntries(
          captured.map((c) => [c.pose, c.yawSignal === null ? null : Number(c.yawSignal.toFixed(4))])
        ),
        image_bytes: frontBytes,
        image_type: frontType,
        possibly_different_person: possiblyDifferentPerson,
        previous_distance:
          previousDistance === null ? null : Number(previousDistance.toFixed(4)),
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      angles,
      warning: warnings.length > 0 ? warnings.join(" ") : null,
    });
  }
);

/* -------------------------------------------------------------- DELETE ---- */

export const DELETE = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data: before } = await db()
      .from("users")
      .select(
        "id, username, full_name, role, face_enabled, face_embedding, facepp_faceset_token, " +
          "facepp_retired_facesets"
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    // Refusing a no-op keeps the trail honest: an entry saying a face was
    // removed when there was never one is a claim that something happened.
    if (!before.face_enabled) {
      return fail("That account has no face enrolled", 400);
    }

    /*
     * Which angles were on the account, before they go.
     *
     * Read first so the audit entry can say what was removed rather than only
     * that a removal happened. "Three angles removed" and "one angle removed" are
     * different events when the question later is whether a face was ever fully
     * enrolled.
     */
    const removed = await loadFaceSamples(id, before.face_embedding);
    const removedAngles = removed.map((s) => s.pose);

    const faceSets = facePlusPlusFaceSetTokens(
      before.facepp_faceset_token,
      before.facepp_retired_facesets
    );
    const deletedFaceSets = await Promise.all(faceSets.map(deleteFacePlusPlusEnrollment));
    const undeletedFaceSet = deletedFaceSets.find((result) => result.status === "unavailable");
    if (undeletedFaceSet?.status === "unavailable") {
      console.error(`Face++ could not remove a revoked FaceSet (${undeletedFaceSet.code}).`);
      return fail(
        "Face++ could not remove this account's stored reference. The face was not removed; try again later.",
        503
      );
    }

    // The per-angle rows first. `face_enabled = false` is what makes a face
    // unusable, so if the two writes disagree the account must end up disabled
    // with rows still behind it, never the other way round — biometric data must
    // not stay readable after "remove" was pressed.
    const wiped = await deleteFaceSamples(id);

    // The photo and the embedding go together, and the last pass goes with them.
    // Keeping the vector after an explicit removal would mean "remove" did not
    // remove, and the next person enrolled on that account would inherit a face
    // they never agreed to.
    const { data, error } = await db()
      .from("users")
      .update({
        face_image: null,
        face_embedding: null,
        facepp_faceset_token: null,
        facepp_face_token: null,
        facepp_retired_facesets: [],
        face_enabled: false,
        face_enrolled_at: null,
        face_enrolled_by: null,
        last_face_verified_at: null,
      })
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "USER_FACE_REVOKE",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        angles_removed: removedAngles,
        samples_cleared: wiped.error === null,
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      angles_removed: removedAngles,
      warning: wiped.error
        ? "The account no longer accepts a face, but the stored angles could not be removed. " +
          "Try removing the face again."
        : null,
    });
  }
);

/* --------------------------------------------------------------- PATCH ---- */

/**
 * The manager override: let this person in without a face check.
 *
 * The last resort behind a phone with no camera, a dead webcam, or a face the
 * model will not read at the cafe's lighting. It stamps the same column a real
 * check would, so the window behaves identically — and it is *not* a way to
 * switch the feature off for one person, because it only buys them this one
 * window. Tomorrow they are back in front of the camera, which is the point.
 *
 * A reason is mandatory. Without one, the audit log records that someone was let
 * through with no explanation, which is precisely the entry an owner needs to be
 * able to explain to themselves a week later.
 */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    // JSON, not multipart — this one carries no file, and readBody() is right
    // for it. The two shapes on one route is the cost of putting all four verbs
    // in one place.
    const body = await readBody(req);

    const { data: before } = await db()
      .from("users")
      .select("id, username, full_name, role, is_active, face_enabled, last_face_verified_at")
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    if (before.role !== "staff") {
      return fail("Only staff accounts are subject to the duty check", 400);
    }

    if (body.action === "reset") {
      if (!before.face_enabled) {
        return fail("This account has no enrolled face check to reset", 400);
      }

      const resetAt = new Date().toISOString();
      const { data: bypasses, error: bypassError } = await db()
        .from("duty_bypass_requests")
        .update({ approved_until: resetAt })
        .eq("requested_by", id)
        .eq("status", "approved")
        .gt("approved_until", resetAt)
        .select("id");

      if (bypassError) {
        console.error("active duty bypass reset failed:", bypassError.message);
        return fail("Could not reset the face check. Try again.", 503);
      }

      const { data, error } = await db()
        .from("users")
        .update({
          last_face_verified_at: null,
          session_token: null,
          session_last_active_at: null,
        })
        .eq("id", id)
        .select(USER_COLUMNS)
        .maybeSingle();

      if (error) return dbFail(error);
      if (!data) return fail("User not found", 404);
      clearSessionCache();

      await audit(
        admin,
        "FACE_VERIFY_RESET",
        "user",
        data.id,
        {
          username: data.username,
          full_name: data.full_name,
          previous_verified_at: before.last_face_verified_at,
          active_bypasses_revoked: bypasses?.length ?? 0,
        },
        { ip: clientIp(req) }
      );

      return ok({ user: data, reset: true });
    }

    const reason = String(body.reason ?? "").trim();
    if (reason.length < 3) {
      return fail("Give a reason for the override — it goes in the audit log");
    }
    if (reason.length > 300) {
      return fail("Reason must be 300 characters or fewer");
    }

    if (!before.is_active) {
      return fail("That account is deactivated", 400);
    }

    const hours = await getFaceDutyHours();
    const now = new Date().toISOString();

    const { data, error } = await db()
      .from("users")
      .update({ last_face_verified_at: now })
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "FACE_VERIFY_OVERRIDE",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        reason,
        duty_hours: hours,
        // Whether this actually let someone in, or just renewed a window they
        // already had. Worth distinguishing: the second means someone is using
        // the override as a default and not noticing.
        was_already_verified: Boolean(before.last_face_verified_at),
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      duty_hours: hours,
      next_due: new Date(Date.now() + hours * 3_600_000).toISOString(),
    });
  }
);

/* ----------------------------------------------------------------- GET ---- */

/**
 * The reference photo.
 *
 * Served rather than inlined into the user list: the list is fetched on every page
 * load and each photo is ~30KB of base64, so embedding them would make the staff
 * list twenty times heavier for a thumbnail that appears in exactly two places.
 *
 * Admin-only, and deliberately not "anyone signed in". The proxy has established
 * that *a* session exists; it says nothing about which account, so a route that
 * trusted that would let any staff member read any other staff member's
 * photograph.
 */
export const GET = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    /*
     * Which angle to serve, defaulting to the straight-on one.
     *
     * `?pose=left` and `?pose=right` are the two turned-head reference photos.
     * An unknown value is a 400 rather than a 404: it is a caller using an angle
     * that does not exist, which is a different mistake from asking for one that
     * was never captured.
     */
    const requested = new URL(req.url).searchParams.get("pose");
    const pose = requested === null ? PRIMARY_POSE : parsePose(requested);
    if (!pose) return fail(`Unknown angle. Use one of: ${FACE_POSES.join(", ")}`, 400);

    const { data: user, error } = await db()
      .from("users")
      .select("face_image")
      .eq("id", id)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!user) return fail("User not found", 404);

    /*
     * The straight-on photo comes from `users.face_image`, which is where it has
     * always been and is what every account enrolled before the angle table
     * exists in. The turned-head photos only exist in the sample table, so a
     * front request only falls through to that table when the column is empty —
     * a legacy account cannot have one, and an account enrolled through the
     * angles has both.
     */
    let stored = pose === PRIMARY_POSE ? String(user.face_image ?? "") : "";

    if (!stored.startsWith("data:")) {
      const { data: rows } = await db()
        .from("user_face_samples")
        .select("pose, image")
        .eq("user_id", id);

      const sample = ((rows ?? []) as { pose: string; image: string | null }[]).find(
        (row) => row.pose === pose && typeof row.image === "string" && row.image.startsWith("data:")
      );
      stored = sample?.image ?? "";
    }

    if (!stored.startsWith("data:")) {
      return fail(
        pose === PRIMARY_POSE ? "No face enrolled" : `No ${POSE_LABEL[pose]} photo enrolled`,
        404
      );
    }

    const match = /^data:([^;,]+);base64,(.*)$/.exec(stored);
    if (!match) return fail("No face enrolled", 404);

    const [, type, base64] = match;

    // Face-image reads are not recorded in the audit trail here; audits remain
    // reserved for actual mutations or administrative actions that change the
    // person or the enrolment. Mere display of the reference photo is not a
    // state change, and logging it created false positives in the staff summary.
    // Private and short-lived. This is biometric data about a named person: it
    // must not sit in a shared cache, and a stale thumbnail after a re-enrolment
    // would be the wrong face beside the right name.
    return new Response(Buffer.from(base64, "base64"), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);
