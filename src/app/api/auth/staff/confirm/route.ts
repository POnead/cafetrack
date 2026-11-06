import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import {
  signSession,
  setSessionCookie,
  hasActiveSession,
  deactivatedMessage,
} from "@/lib/auth";
import { readStep2Ticket } from "@/lib/auth/step2-ticket";
import { audit } from "@/lib/audit";
import { getFaceEngine, getSessionMinutes, getFaceMatchThreshold } from "@/lib/settings";
import {
  PRIMARY_POSE,
  descriptorVersionFor,
  parseEmbedding,
  parseFaceBlinkEvidence,
  parseFaceEvidence,
  parseFaceFrames,
  matchPresentation,
} from "@/lib/face";
import { facePlusPlusMode, verifyFacePlusPlusLogin } from "@/lib/facepp";
import { verifyFacePresentation } from "@/lib/face-liveness";
import { galleryFor, loadFaceSamples } from "@/lib/face-samples";
import { recordFaceVerification } from "@/lib/face-gate";
import { getIdGate } from "@/lib/id-gate";
import { isValidFingerprint } from "@/lib/id-verification/card-hash";
import {
  checkLoginThrottle,
  tooManyAttempts,
  recordLoginAttempt,
  userKey,
  STEP2_METHOD,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Step two of staff sign-in: prove the face enrolled on the account and receive
 * the session that step one deliberately withheld.
 *
 * ## What makes this different from the two routes it replaces
 *
 * /api/auth/face-login and /api/auth/id-login both had to answer a question from
 * scratch: *which account is this?* Face sign-in searched the roster by a
 * barcode or username the caller supplied. ID sign-in searched every staff row by
 * card fingerprint, and had to cope with two accounts holding the same card by
 * refusing.
 *
 * There is no such question here. The ticket already names the account, and step
 * one already proved the password against it, so this route loads one row and
 * compares against it. The ambiguity problem does not get solved, it stops
 * existing: there is exactly one candidate because the password named it.
 *
 * That is also why nothing here is an oracle. Every refusal below is reachable
 * only by someone who already presented a correct password, so telling them
 * "this account has no face enrolled" leaks nothing about anybody else. The rules
 * in face-login about uniform answers existed to stop a stranger walking the
 * staff room; that attacker cannot get this far.
 *
 * Only the enrolled face can complete this step. ID-card verification is not a
 * substitute for the face check here.
 */
export const POST = handler(async (req: Request) => {
  const body = await readBody(req);

  const token = String(body.ticket ?? "").trim();

  if (!token) {
    return fail(EXPIRED, 401, { expired: true });
  }

  /*
   * Verify the signature and the expiry. This is what makes the ticket useless as
   * a session cookie: it is signed with a key readSessionToken never holds, so
   * presenting one as cafetrack_session fails there rather than here.
   */
  const ticket = await readStep2Ticket(token);
  if (!ticket) {
    return fail(EXPIRED, 401, { expired: true });
  }

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select(
      "id, username, full_name, is_active, deactivation_reason, deactivated_at, " +
      "face_embedding, face_image, face_enabled, id_card_hash, " +
      "verification_status, session_token, session_last_active_at, step2_nonce"
    )
    .eq("id", ticket.userId)
    .eq("role", "staff")
    .maybeSingle();

  if (lookupError) {
    console.error("staff confirm lookup failed:", lookupError.message);
    return fail("Cannot reach the database. Try again in a moment.", 503);
  }

  // A ticket for an account that has since been deleted, or a forged user id.
  if (!user) {
    return fail(EXPIRED, 401, { expired: true });
  }

  /*
   * One ticket, one use.
   *
   * The nonce in the ticket has to equal the one on the row, and redeeming
   * overwrites the column. A ticket is therefore spent the moment it works, and
   * a second attempt with the same one reads as a mismatch.
   *
   * A stale ticket (the person gave up and started again) lands here too, which
   * is correct: the new sign-in issued a new nonce, so the old ticket is dead.
   */
  if (!user.step2_nonce || user.step2_nonce !== ticket.nonce) {
    return fail(EXPIRED, 401, { expired: true });
  }

  /*
   * A login ticket means the password step required this second factor. A duty
   * window or manager's duty bypass must not waive a login face check; those
   * apply only after sign-in. Preflight only confirms the account is still
   * eligible and that the scan is still required, without consuming the ticket.
   */
  if (body.preflight === true) {
    if (!user.is_active) {
      return fail(deactivatedMessage(user.deactivation_reason), 403, {
        deactivated: true,
        deactivation_reason: user.deactivation_reason ?? null,
        deactivated_at: user.deactivated_at ?? null,
      });
    }

    const idGate = await getIdGate(user as never);
    if (idGate.required && !idGate.cleared) {
      return fail(idGate.message ?? "This account is not cleared to sign in yet.", 403, {
        id_unverified: true,
        verification_status: idGate.status,
      });
    }

    return ok({ face_required: true, full_name: user.full_name });
  }

  /*
   * Throttle on the account, not on the credential.
   *
   * There is no credential being guessed here — the password is already proven
   * and the ticket is unforgeable — so this counts *failed second steps on one
   * account*. Five is the right number: it stops someone holding a stolen
   * password from working through face after face, without punishing a person
   * whose camera needs a couple of tries.
   */
  const key = userKey(user.username);
  const throttle = await checkLoginThrottle(key, STEP2_METHOD);
  if (throttle.blocked) {
    return tooManyAttempts(throttle.retryAfterSeconds, "second checks on this account");
  }

  const refuse = async (
    reason: string,
    auditIt: boolean,
    extra?: Record<string, unknown>,
    message: string = NO_MATCH
  ) => {
    await recordLoginAttempt(key, STEP2_METHOD, false);
    if (auditIt) {
      await audit(
        { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
        "LOGIN_FAILED",
        "user",
        user.id,
        { method: STEP2_METHOD, reason },
        { critical: false, ip: clientIp(req), outcome: "failed" }
      );
    }
    return fail(message, 401, extra);
  };

  /* ---- what the account can actually be checked against ------------------- */

  /*
   * The account's samples, loaded once.
   *
   * Read before the second-factor check because whether there is anything to
   * compare against is a fact about the row. It also means the legacy vector —
   * accounts enrolled before the angle table existed — counts as a usable face,
   * exactly as it did before.
   */
  const samples = await loadFaceSamples(user.id, user.face_embedding ?? null);
  // Only vectors from the engine in use may be compared; see FaceEngine.
  const engine = await getFaceEngine();
  const gallery = galleryFor(samples, engine);
  const frontalGallery = gallery.filter((sample) => sample.pose === PRIMARY_POSE);
  const localTestMode =
    process.env.CAFETRACK_TEST_FACE_LIVENESS === "1" &&
    process.env.NODE_ENV !== "production";
  const hasStoredFaceImage =
    typeof user.face_image === "string" && user.face_image.startsWith("data:image/");
  const hasSavedFaceImage =
    hasStoredFaceImage &&
    /^data:image\/(?:jpeg|png);base64,/.test(user.face_image);
  const faceUsable = Boolean(
    user.face_enabled &&
      (localTestMode ? frontalGallery.length > 0 : hasSavedFaceImage)
  );
  const cardUsable = isValidFingerprint(user.id_card_hash);

  /*
   * No enrolled face. An ID card on file is not a substitute for this step.
   *
   * Checked before comparison because this is a fact about the row, not a match
   * outcome; the password holder should be told how to fix an unusable account.
   */
  if (!faceUsable) {
    await recordLoginAttempt(key, STEP2_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: STEP2_METHOD, reason: cardUsable ? "no_enrolled_face" : "no_second_factor" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );

    if (!localTestMode && user.face_enabled && hasStoredFaceImage && !hasSavedFaceImage) {
      return fail(
        "The saved account photo format cannot be compared by Face++. Ask an administrator to re-enrol it as a JPEG or PNG.",
        403,
        { no_face: true }
      );
    }

    if (cardUsable) {
      return fail(
        "This account has no enrolled face, so it cannot finish signing in. " +
          "An administrator can add a face photo on the Staff Accounts page.",
        403,
        { no_face: true }
      );
    }

    return fail(
      "This account has no face on file, so it cannot finish signing in. " +
        "An administrator can add a face photo on the Staff Accounts page.",
      403,
      { no_second_factor: true }
    );
  }

  /* ---- the readings ------------------------------------------------------- */

  let matchedBy: "face" | null = null;

  if (!localTestMode) {
    /*
     * Production: Face++ makes every decision.
     *
     * After the complete camera scan is submitted, Detect finds exactly one
     * face in each frame and reads its head pose, Analyze verifies the captured
     * open/closed/open blink, and Compare matches the straight-on frame against
     * the saved account photo. Nothing local decides the result on this path.
     */
    const facePlusPlus = facePlusPlusMode();
    if (facePlusPlus !== "enabled") {
      console.error(`Face++ staff sign-in comparison is not ready (${facePlusPlus}).`);
      return fail(
        "Face++ verification is not available. Use your password or contact an administrator.",
        503,
        { facePlusPlus: { status: "unavailable" } }
      );
    }

    const referenceImage = hasSavedFaceImage ? user.face_image : null;
    if (!referenceImage) {
      console.error("Face++ staff sign-in skipped: the saved account photo is missing.");
      return fail(
        "The saved account photo is missing. Ask an administrator to re-enrol your face.",
        403,
        { no_face: true }
      );
    }

    const images = body.face_images;
    const imageRecord =
      images && typeof images === "object" && !Array.isArray(images)
        ? (images as Record<string, unknown>)
        : null;
    const frontImage = parseFaceEvidence(imageRecord?.front);
    const leftImage = parseFaceEvidence(imageRecord?.left);
    const rightImage = parseFaceEvidence(imageRecord?.right);
    const blinkEvidence = parseFaceBlinkEvidence(body.blink_evidence);

    if (!frontImage || !leftImage || !rightImage || !blinkEvidence) {
      return refuse("nothing_recognised", false, {
        facePlusPlus: { status: "not_run" },
      });
    }

    const verification = await verifyFacePlusPlusLogin({
      referenceImage,
      frontImage,
      leftImage,
      rightImage,
      blinkEvidence,
    });
    const { steps } = verification;
    console.info(
      `[Face++ staff-confirm] Detect ${steps.detect}; pose ${steps.pose}; blink ${steps.blink}; Compare ${steps.compare}.`
    );

    if (verification.status === "unavailable") {
      console.error(
        `[Face++ staff-confirm] Provider unavailable (${verification.code ?? "unknown"}).`
      );
      return fail(
        "Face++ could not complete verification. Use your password or contact an administrator.",
        503,
        {
          facePlusPlus: {
            status: "unavailable",
            steps,
            ...(verification.poseChecks ? { poseChecks: verification.poseChecks } : {}),
          },
        }
      );
    }

    if (verification.status === "rejected") {
      const extra = {
        facePlusPlus: {
          status: "responded",
          steps,
          ...(verification.poseChecks ? { poseChecks: verification.poseChecks } : {}),
        },
      };

      if (verification.reason === "blink_not_verified") {
        return refuse(
          "blink_not_verified",
          true,
          extra,
          "Face++ did not verify an open, closed, open eye sequence. Capture the blink again."
        );
      }
      if (verification.reason === "pose_not_verified") {
        return refuse(
          "face_pose_not_verified",
          true,
          extra,
          "Face++ could not confirm the straight-on and turned-head poses. Follow the prompts and try again."
        );
      }
      if (verification.reason === "face_not_detected") {
        return refuse(
          "face_not_detected",
          true,
          extra,
          "Face++ could not find exactly one clear face in every frame. Center your face and retake the scan."
        );
      }
      if (verification.reason === "identity_not_matched") {
        return refuse(
          "facepp_compare_rejected",
          true,
          extra,
          "Face++ compared the live face with the saved account photo but did not find a match. Retake the front-facing photo in good lighting."
        );
      }
      return refuse("facepp_rejected", true, extra);
    }

    matchedBy = "face";
  } else {
    /*
     * The isolated route-test harness opts into this path explicitly. It keeps
     * the local reader and vector comparison so the existing suites can exercise
     * the same route without calling out to Face++.
     */
    const parsedFrames = parseFaceFrames(body.face_frames);
    const legacyFace = parseEmbedding(body.face_embedding);
    const singleEvidence = parseFaceEvidence(body.face_evidence);
    const candidateFrames = parsedFrames.ok
      ? parsedFrames.frames
      : legacyFace && singleEvidence
        ? [{ pose: PRIMARY_POSE, embedding: legacyFace, evidence: singleEvidence }]
        : null;

    /*
     * No face reading.
     *
     * A camera that showed no face is recorded separately from a face that failed
     * to match, but both receive the same generic refusal.
     */
    if (!candidateFrames) {
      return refuse("nothing_recognised", false);
    }

    /*
     * Was this vector produced by the reader the server is comparing with?
     *
     * The login screen declares its engine and that reader's revision with every
     * attempt. A tab left open across a change to the reader keeps the old script
     * in memory, and its vectors are in a space nothing on file can be compared
     * with: every attempt lands about 1.0 away from every real vector, which reads
     * exactly like "the account holder's own face does not match". That is how a
     * stale tab wasted an afternoon; this turns it into an instruction.
     *
     * Not a security check — a caller can declare anything, and a wrong declaration
     * only makes its own comparison fail. It is deliberately not counted as a
     * failed second step, because it is not one: the ticket stays good, and the
     * person does not lose one of their five tries to a page that needs reloading.
     */
    const declaredEngine = typeof body.face_engine === "string" ? body.face_engine.trim() : "";
    const declaredVersion = Number(body.descriptor_version);
    const expectedVersion = descriptorVersionFor(engine);

    const staleClient =
      (declaredEngine !== "" && declaredEngine !== engine) ||
      (Number.isFinite(declaredVersion) && declaredVersion !== expectedVersion);

    if (staleClient) {
      return fail(
        "This page is running an older face reader. Reload the page and sign in again.",
        409,
        { reload: true }
      );
    }

    const liveness = await verifyFacePresentation(candidateFrames, engine);
    if (!liveness.ok) {
      if (liveness.reason === "unavailable") {
        return fail(
          "Face liveness is not available on this server. Go back and use your password, or contact an administrator.",
          503
        );
      }
      return refuse("liveness_failed", true);
    }

    const frames = liveness.frames;
    const threshold = await getFaceMatchThreshold(engine);

    /*
     * The login screen captures a straight-on face, so it may only match the
     * account's enrolled frontal sample. Side-angle references cannot be used as
     * alternate opportunities to match an unrelated live face.
     */
    if (matchPresentation(frames, frontalGallery, [PRIMARY_POSE], threshold).matched) {
      matchedBy = "face";
    }
  }

  if (!matchedBy) {
    return refuse("no_match", true);
  }

  /* ---- gates, now that this is provably the account's holder -------------- */

  if (!user.is_active) {
    await recordLoginAttempt(key, STEP2_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: STEP2_METHOD, reason: "deactivated" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(deactivatedMessage(user.deactivation_reason), 403, {
      deactivated: true,
      deactivation_reason: user.deactivation_reason ?? null,
      deactivated_at: user.deactivated_at ?? null,
    });
  }

  const idGate = await getIdGate(user as never);
  if (idGate.required && !idGate.cleared) {
    await recordLoginAttempt(key, STEP2_METHOD, false);
    return fail(idGate.message ?? "This account is not cleared to sign in yet.", 403, {
      id_unverified: true,
      verification_status: idGate.status,
    });
  }

  /* ---- the session ------------------------------------------------------- */

  /*
   * Burn the ticket by overwriting the nonce, in the same statement that would
   * happen anyway if this were the session token.
   */
  await db().from("users").update({ step2_nonce: null }).eq("id", user.id);

  await recordLoginAttempt(key, STEP2_METHOD, true);

  const session = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: "staff" as const,
  };

  const minutes = await getSessionMinutes();
  const sessionToken = await signSession(session, minutes);
  await setSessionCookie(sessionToken, minutes, user.id, db());

  // Same reason as the other two routes: without this the duty check would ask
  // for the same face again seconds later.
  await recordFaceVerification(user.id);

  await audit(
    session,
    "LOGIN",
    "user",
    user.id,
    { method: STEP2_METHOD, matched_by: matchedBy },
    { ip: clientIp(req), outcome: "success" }
  );

  return ok({
    user: session,
    session_conflict: await hasActiveSession(
      user.session_token,
      user.session_last_active_at
    ),
    matched_by: matchedBy,
    facePlusPlus: localTestMode ? undefined : { status: "passed" },
  });
});

/**
 * One refusal for every failure that is not "this account cannot sign in".
 *
 * The caller has already proven the password, so there is no roster to enumerate
 * and no photograph to test — a stranger cannot reach this route at all. The
 * uniformity is kept anyway because it costs nothing and it means a future caller
 * who wires this up differently has not just opened a hole by accident.
 */
const NO_MATCH = "That face did not match the photo on this account";

/**
 * The ticket is spent, expired, or was never one.
 *
 * Deliberately vague and identical across all three. Whether a ticket was
 * already used says something about a race the caller may have started; that is
 * not information to hand back.
 */
const EXPIRED = "That sign-in attempt has expired. Enter your password again.";
