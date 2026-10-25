import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { PRIMARY_POSE, parseEmbedding, parseFaceFrames } from "@/lib/face";
import { evaluatePresentation } from "@/lib/face-samples";
import { getFaceEngine, getFaceMatchThreshold, getFaceRequireProfileAngles } from "@/lib/settings";
import { getFaceStatus, recordFaceVerification } from "@/lib/face-gate";
import {
  checkLoginThrottle,
  tooManyAttempts,
  userKey,
  recordFaceAttempt,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Confirm a face, and open the duty window.
 *
 *   POST { embedding: [128 numbers] }   ->   { ok, nextDueAt }
 *
 * The only route that decides whether a person gets in. The browser computes the
 * embedding with the recognition model and sends the numbers — no image is
 * uploaded here, so a raw photograph of a staff member exists in exactly one
 * place: the reference the admin enrolled.
 *
 * Three rules shape what comes back, and all three exist because the obvious
 * version of this endpoint leaks:
 *
 *   1. A response never carries a distance, a score or a percentage. A caller
 *      who learns how close a failed attempt was can tune the next one against
 *      it, which turns a one-shot check into an unlimited number of guesses. The
 *      refusal is worded identically whatever was submitted.
 *   2. The threshold comes from settings. Never from the request — a client that
 *      chooses its own threshold has no check at all.
 *   3. Both outcomes are audited. "Who tried to get in and failed" is the whole
 *      reason this feature exists.
 */
export const POST = handler(async (req: Request) => {
  const session = await getSession();
  if (!session) return fail("Not signed in", 401);

  /*
   * Re-read from the database rather than trusting the session payload. Three
   * reasons, any one sufficient: the token was minted at sign-in and only slid
   * since, so it cannot know about a check that just passed; the feature may
   * have been switched off; and the account or its face may have been changed
   * while this session sat open.
   */
  const status = await getFaceStatus(session.id, session.role);

  // Nothing owed — already inside a window, or not subject to one. Answering
  // immediately is what makes this endpoint safe for a screen that does not know
  // yet whether the window has run out: it never prompts for a camera, never
  // loads the 6MB model, and never touches the face columns.
  if (!status.required) {
    return ok({
      ok: true,
      required: false,
      nextDueAt: status.nextDueAt,
      dutyHours: status.dutyHours,
    });
  }

  if (!status.enrolled) {
    /*
     * Required with nothing to compare against — reachable when an admin switches
     * the feature on after hiring staff without a photo.
     *
     * Refused rather than waved through, and refused with an instruction rather
     * than an error. A staff member stranded here cannot fix it themselves, and
     * the person who can is standing next to them. Sending them to the manager
     * override is the difference between a rough morning and a till that does not
     * open.
     */
    return fail(
      "Your account has no face enrolled yet. Ask your manager to approve you for this duty.",
      403
    );
  }

  const key = userKey(session.username);

  // Throttled by credential and, inside checkLoginThrottle, by method — so this
  // has its own counter and cannot be starved by sign-in failures, nor spend the
  // sign-in budget. Without it the screen is an unthrottled oracle for guessing
  // at a face, which is the one thing standing between a photo of someone and
  // their shift.
  const throttle = await checkLoginThrottle(key, "face_verify");
  if (throttle.blocked) {
    await audit(
      session,
      "FACE_VERIFY",
      "user",
      session.id,
      { method: "camera", result: "throttled" },
      { ip: clientIp(req), outcome: "denied", critical: false }
    );
    return tooManyAttempts(throttle.retryAfterSeconds, "failed face checks");
  }

  const body = await readBody(req);

  /*
   * The frames, new format first.
   *
   * `face_frames` is one entry per angle the person presented. A body with a
   * single `embedding` is still accepted and means one straight-on frame: pages
   * already open on a phone when the angles shipped must keep working, and a
   * stale tab is not a reason to refuse someone their shift.
   */
  const legacy = parseEmbedding(body.embedding);
  const parsedFrames = parseFaceFrames(body.face_frames);
  const frames = parsedFrames.ok
    ? parsedFrames.frames
    : legacy
      ? [{ pose: PRIMARY_POSE, embedding: legacy }]
      : null;

  if (!frames) {
    // A malformed vector is a bad request rather than a failed identity check,
    // but it is still recorded as a denial: a client posting garbage here
    // repeatedly is the signature of someone probing the endpoint.
    await recordFaceAttempt(key, false);
    await audit(
      session,
      "FACE_VERIFY",
      "user",
      session.id,
      { method: "camera", result: "malformed" },
      { ip: clientIp(req), outcome: "denied", critical: false }
    );
    return fail(
      "That face could not be read. Take the photo again, facing the camera in good light."
    );
  }

  const { data: row } = await db()
    .from("users")
    .select("face_embedding")
    .eq("id", session.id)
    .maybeSingle();

  const threshold = await getFaceMatchThreshold();
  const requireProfileAngles = await getFaceRequireProfileAngles();

  /*
   * Every angle this account owes, against the samples it holds.
   *
   * A missing or corrupt reference is a refusal, not a crash and not a match:
   * evaluatePresentation finds nothing to compare against, so nothing matches.
   * The gate above already refuses an unenrolled account, so this is only
   * reachable if the face was removed between the two reads.
   */
  const presentation = await evaluatePresentation({
    userId: session.id,
    legacyEmbedding: row?.face_embedding ?? null,
    frames,
    threshold,
    requireProfileAngles,
    engine: await getFaceEngine(),
  });

  if (!presentation.matched && presentation.needsEnrolment) {
    /*
     * Enrolled, but not in the engine now in use. This is the state a cafe is in
     * between switching engines and re-enrolling each person, and saying "not
     * recognised" for it would send someone to the camera again and again for a
     * problem no camera can fix.
     */
    await recordFaceAttempt(key, false);
    return fail(
      "Your face on file was recorded with a different face model, so it cannot be " +
        "compared any more. Ask an administrator to enrol your face again."
    );
  }

  if (!presentation.matched) {
    await recordFaceAttempt(key, false);
    await audit(
      session,
      "FACE_VERIFY",
      "user",
      session.id,
      // No distance. See rule 1 at the top of this file.
      {
        method: "camera",
        result: "no_match",
        angles_required: presentation.required,
        failed_angle: presentation.failedPose,
      },
      { ip: clientIp(req), outcome: "denied", critical: false }
    );
    return fail(
      presentation.failedPose && presentation.failedPose !== PRIMARY_POSE
        ? `That was not recognised on the ${presentation.failedPose} turn. Try again, ` +
            "taking each photograph as the screen asks for it — or ask your manager for an override."
        : "That face was not recognised. Try again, or ask your manager for an override."
    );
  }

  const verifiedAt = await recordFaceVerification(session.id);
  const dutyHours = status.dutyHours;

  // Clears the consecutive-failure counter. Without this a staff member who
  // passed cleanly would still be one failure away from a lockout.
  await recordFaceAttempt(key, true);

  await audit(
    session,
    "FACE_VERIFY",
    "user",
    session.id,
    {
      method: "camera",
      result: "matched",
      duty_hours: dutyHours,
      angles_presented: frames.map((f) => f.pose),
    },
    { ip: clientIp(req), critical: false }
  );

  return ok({
    ok: true,
    required: true,
    verifiedAt,
    dutyHours,
    anglesChecked: presentation.required,
    nextDueAt: new Date(Date.now() + dutyHours * 3_600_000).toISOString(),
  });
});

