import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import {
  signSession,
  setSessionCookie,
  hasActiveSession,
  deactivatedMessage,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSessionMinutes, getFaceEngine, getFaceLoginEnabled, getFaceMatchThreshold } from "@/lib/settings";
import {
  PRIMARY_POSE,
  type FacePose,
  parseEmbedding,
  parseFaceBlinkEvidence,
  parseFaceEvidence,
  parseFaceFrames,
  type FaceFrameInput,
} from "@/lib/face";
import {
  facePlusPlusMode,
  verifyFacePlusPlusLogin,
} from "@/lib/facepp";
import { recordFaceVerification } from "@/lib/face-gate";
import { getIdGate } from "@/lib/id-gate";
import {
  checkLoginThrottle,
  tooManyAttempts,
  recordLoginAttempt,
  tokenKey,
  FACE_LOGIN_METHOD,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Whether to offer the face option on the sign-in screen.
 *
 *   GET -> { enabled: boolean }
 *
 * Public, and deliberately so: the login page runs before anyone is signed in, so
 * it cannot ask /api/settings — that is admin-only and answers 403 to exactly
 * the person who needs to know whether this option exists. Without it the button
 * could never be drawn at all, and "not shown" is indistinguishable from
 * "broken".
 *
 * Returns a boolean and nothing else. It must not grow into a settings dump: an
 * unauthenticated caller learning the cafe's session timeout from here would be
 * a new hole opened to plug a cosmetic one. The only fact needed to decide what
 * to draw is this one.
 */
export const GET = handler(async () => {
  return ok({
    enabled: await getFaceLoginEnabled(),
    facePlusPlusConfigured: facePlusPlusMode() === "enabled",
  });
});

/**
 * Sign in with a face instead of a password.
 *
 *   POST { identifier, face_images, blink_evidence }
 *   ->   { user, session_conflict }
 *
 * `face_images` is `{ front, left, right }`. The local test harness may instead
 * send `face_frames` with embeddings; that path never runs in production.
 *
 * **The identifier is required, and that is the whole design.**
 *
 * This is not "who is this face?". You present your badge or type your username
 * first, and the camera then confirms the face already enrolled against *that one
 * account*. That makes the comparison one-to-one — exactly the calculation
 * `verify-face` already makes on every duty check — instead of one-to-many.
 *
 * The difference is not a detail. A one-to-many search compares the submitted
 * face against every enrolled member of staff at once, so a false accept is
 * far likelier the more people a cafe employs, and the response to any submitted
 * face tells the submitter who it belongs to. At this cafe's scale the roster
 * search would be a genuine identity oracle pointed at the staff room.
 *
 * With the identifier in hand the bad case is much smaller: a stranger must
 * still present the badge *and* a face that matches the person on it.
 *
 * Three rules shape what comes back:
 *
 *   1. A response never carries a distance, a score or a percentage. Same
 *      reason as verify-face — a caller who learns how close a failed attempt
 *      was can tune the next one against it.
 *   2. Unknown account, malformed vector and unrecognised face all return the
 *      *same* answer. Any difference between them is a way to learn which
 *      accounts exist, or whether a particular photograph worked.
 *   3. The Face++ confidence cutoff is fixed server-side, never from the request.
 *
 * The frames are short-lived camera evidence. In production, Face++ Detect
 * verifies the pose and the submitted blink sequence, and Face++ Compare checks
 * the front-facing frame against the account's saved reference. Local matching
 * and liveness are available only in the isolated test harness.
 */
export const POST = handler(async (req: Request) => {
  /*
   * Checked before the body is even looked at.
   *
   * While this is off the route must not be a way to learn anything at all about
   * staff — not who has a face, not whether a given vector would match. Answering
   * "not switched on" before reading the request keeps the whole surface closed
   * rather than merely guarded.
   */
  if (!(await getFaceLoginEnabled())) {
    return fail("Sign in with a face is not switched on", 404);
  }

  const body = await readBody(req);
  const facePlusPlus = facePlusPlusMode();
  const testLocalMatcher =
    process.env.CAFETRACK_TEST_FACE_LIVENESS === "1" &&
    process.env.NODE_ENV !== "production";
  if (facePlusPlus !== "enabled" && !testLocalMatcher) {
    if (facePlusPlus === "invalid") {
      console.error("Face++ credentials are incomplete; refusing face sign-in.");
      return fail(
        "Face++ verification is not configured correctly. Use your password or scan your badge.",
        503
      );
    }
    return fail(
      "Face++ verification is not configured. Use your password or scan your badge.",
      503
    );
  }

  const identifier = String(body.identifier ?? "").trim();

  if (!identifier) {
    return fail("Scan your staff barcode or enter your username first");
  }

  /*
   * Refuse anything that is not shaped like a username or a staff barcode.
   *
   * The lookup below builds a PostgREST filter by interpolation —
   * `.or(`qr_token.eq.${identifier},username.eq.${identifier}`)` — and that
   * string is a grammar, not an opaque value. A comma is how PostgREST separates
   * conditions, so an identifier of `x,username.eq.y` does not search for a
   * username containing a comma; it becomes two conditions, and the query
   * matches a *different person* than the one presented.
   *
   * On its own that still needs the right face to get in, so it is not a free
   * bypass — but it does mean the identifier a caller sends does not reliably
   * name the account whose face is then compared, which is the single property
   * this whole endpoint is built on. Refusing the characters that carry meaning
   * in the filter grammar makes the mapping true by construction.
   *
   * Usernames are lowercase alphanumerics and staff barcodes are
   * `CT-STF-` plus hex, so a character class of letters, digits, dot, dash and
   * underscore covers every credential this app can actually issue.
   *
   * Answered with the ordinary refusal rather than a complaint about characters:
   * a distinct error for "that contains a comma" would confirm the endpoint
   * reached the parsing stage for input nobody valid would send.
   */
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(identifier)) {
    await recordLoginAttempt(tokenKey(identifier), FACE_LOGIN_METHOD, false);
    return fail(UNRECOGNISED, 401);
  }

  /*
   * One key, used for the check AND for every recorded attempt.
   *
   * They have to be the same string. This originally checked against a hash of
   * the presented identifier but recorded failures against the resolved username
   * — so for anybody who *does* exist, the per-credential counter was reading a
   * bucket nothing was ever written to, and could never once reach its limit of
   * five. Only the method-wide count of twenty was doing any work, which is five
   * times the intended lockout on a credential an attacker is grinding at.
   *
   * Hashing the presented identifier rather than the username is also the honest
   * thing to count: the credential being tried *is* the barcode, and it works
   * identically for an account that does not exist, which is most of them during
   * a walk of the roster.
   */
  const key = tokenKey(identifier);
  const throttle = await checkLoginThrottle(key, FACE_LOGIN_METHOD);
  if (throttle.blocked) {
    return tooManyAttempts(throttle.retryAfterSeconds, "face sign-in attempts");
  }

  /*
   * Production sends only images. The local vector path remains isolated to the
   * test harness so the live identity and blink decisions are made by Face++.
   */
  const blinkEvidence = parseFaceBlinkEvidence(body.blink_evidence);
  let frames: FaceFrameInput[] = [];
  let frontImage: string | null = null;
  let leftImage: string | null = null;
  let rightImage: string | null = null;
  let sidePose: FacePose | null = null;

  if (testLocalMatcher) {
    const legacy = parseEmbedding(body.embedding);
    const parsedFrames = parseFaceFrames(body.face_frames);
    const singleEvidence = parseFaceEvidence(body.face_evidence);
    const candidateFrames = parsedFrames.ok
      ? parsedFrames.frames
      : legacy && singleEvidence
        ? [{ pose: PRIMARY_POSE, embedding: legacy, evidence: singleEvidence }]
        : null;
    const sideCandidates =
      candidateFrames?.filter((frame) => frame.pose === "left" || frame.pose === "right") ?? [];
    const hasFrontAndSide =
      candidateFrames?.length === 2 &&
      candidateFrames.some((frame) => frame.pose === PRIMARY_POSE) &&
      sideCandidates.length === 1;

    if (!candidateFrames || !blinkEvidence || !hasFrontAndSide) {
      await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
      return fail(UNRECOGNISED, 401);
    }

    frames = candidateFrames;
    sidePose = sideCandidates[0]?.pose ?? null;
  } else {
    const images = body.face_images;
    const imageRecord =
      images && typeof images === "object" && !Array.isArray(images)
        ? (images as Record<string, unknown>)
        : null;
    frontImage = parseFaceEvidence(imageRecord?.front);
    leftImage = parseFaceEvidence(imageRecord?.left);
    rightImage = parseFaceEvidence(imageRecord?.right);
    if (!frontImage || !leftImage || !rightImage || !blinkEvidence) {
      await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
      return fail(UNRECOGNISED, 401);
    }
  }

  if (!blinkEvidence) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    await audit(
      null,
      "LOGIN_FAILED",
      "user",
      null,
      { method: FACE_LOGIN_METHOD, reason: "malformed_presentation" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(UNRECOGNISED, 401);
  }

  const engine = testLocalMatcher ? await getFaceEngine() : null;
  const threshold = engine ? await getFaceMatchThreshold(engine) : 0;
  if (testLocalMatcher) {
    const { verifyFacePresentation } = await import("@/lib/face-liveness");
    const frontFrame = frames.find((frame) => frame.pose === PRIMARY_POSE);
    if (!frontFrame) {
      await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
      return fail(UNRECOGNISED, 401);
    }
    const liveness = await verifyFacePresentation(
      [
        ...frames,
        { ...frontFrame, evidence: blinkEvidence.before },
        { ...frontFrame, evidence: blinkEvidence.closed },
        { ...frontFrame, evidence: blinkEvidence.after },
      ],
      engine ?? "sface"
    );
    if (!liveness.ok) {
      if (liveness.reason === "unavailable") {
        return fail(
          "Face liveness is not available on this server. Use your password or scan your badge.",
          503
        );
      }

      await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
      await audit(
        null,
        "LOGIN_FAILED",
        "user",
        null,
        { method: FACE_LOGIN_METHOD, reason: "liveness_failed" },
        { critical: false, ip: clientIp(req), outcome: "failed" }
      );
      return fail(UNRECOGNISED, 401);
    }
    frames = liveness.frames.slice(0, frames.length);
  }

  sidePose =
    sidePose ?? frames.find((frame) => frame.pose === "left" || frame.pose === "right")?.pose ?? null;

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select(
      "id, username, full_name, role, is_active, deactivation_reason, " +
      "deactivated_at, session_token, session_last_active_at, face_embedding, face_image, face_enabled, " +
      // For the ID gate. See getIdGate for why these two columns and no more.
      "verification_status, id_doc_front"
    )
    .eq("role", "staff")
    .or(`qr_token.eq.${identifier},username.eq.${identifier}`)
    .maybeSingle();

  if (lookupError) {
    console.error("face login lookup failed:", lookupError.message);
    return fail("Cannot reach the database. Try again in a moment.", 503);
  }

  // Same generic refusal as a bad face, and the same wording as /api/auth/staff.
  if (!user) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    return fail(UNRECOGNISED, 401);
  }

  /*
   * Deactivated is checked after the face matches, never before.
   *
   * Before, it would be an oracle: a deactivated account would answer differently
   * from an active one, which tells anyone scanning barcodes which accounts still
   * exist. Matching first means this branch is only reachable by someone who has
   * already proved they are that person.
   */
  // Match every presented pose before revealing anything about the account.
  let matched = false;
  let hasFaceSamples = true;
  let facePlusPlusUnavailable = false;
  let facePlusPlusBlinkRejected = false;
  let facePlusPlusPoseRejected = false;
  let facePlusPlusFaceRejected = false;
  let facePlusPlusIdentityRejected = false;
  let facePlusPlusResponded = false;
  const matchLocally = async () => {
    const { evaluatePresentation } = await import("@/lib/face-samples");
    const presentation = await evaluatePresentation({
      userId: user.id,
      legacyEmbedding: user.face_embedding ?? null,
      frames,
      threshold,
      requireProfileAngles: false,
      requiredPoses: [PRIMARY_POSE, sidePose ?? "left"],
      engine: engine ?? "sface",
    });
    matched = presentation.matched;
    hasFaceSamples = presentation.samples.length > 0;
  };

  if (facePlusPlus === "enabled") {
    const referenceImage =
      typeof user.face_image === "string" && user.face_image.startsWith("data:image/")
        ? user.face_image
        : null;
    hasFaceSamples = referenceImage !== null;
    if (referenceImage && frontImage && leftImage && rightImage) {
      const verification = await verifyFacePlusPlusLogin({
        referenceImage,
        frontImage,
        leftImage,
        rightImage,
        blinkEvidence,
      });
      const { steps } = verification;
      console.info(
        `[Face++ face-login] Detect ${steps.detect}; pose ${steps.pose}; blink ${steps.blink}; Compare ${steps.compare}.`
      );
      facePlusPlusResponded = Object.values(steps).some(
        (step) => step === "passed" || step === "failed"
      );
      facePlusPlusUnavailable = verification.status === "unavailable";
      facePlusPlusBlinkRejected = verification.reason === "blink_not_verified";
      facePlusPlusPoseRejected = verification.reason === "pose_not_verified";
      facePlusPlusFaceRejected = verification.reason === "face_not_detected";
      facePlusPlusIdentityRejected = verification.reason === "identity_not_matched";
      matched = verification.status === "matched";
      if (verification.status === "unavailable") {
        console.error(
          `[Face++ face-login] Provider unavailable (${verification.code ?? "unknown"}).`
        );
      }
    } else if (!referenceImage) {
      console.info("[Face++ face-login] Compare not run: saved account photo unavailable.");
    }
  } else {
    // The isolated route-test harness explicitly opts into this path; production
    // face sign-in is blocked above unless Face++ is configured and enabled.
    await matchLocally();
  }

  if (facePlusPlusUnavailable) {
    return fail(
      "Face++ could not complete verification. Use your password or scan your badge and try face sign-in again later.",
      503,
      { facePlusPlus: { status: "unavailable" } }
    );
  }

  if (!matched) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      {
        method: FACE_LOGIN_METHOD,
        reason: facePlusPlusBlinkRejected
          ? "blink_not_verified"
          : facePlusPlusPoseRejected
            ? "face_pose_not_verified"
            : facePlusPlusFaceRejected
              ? "face_not_detected"
              : facePlusPlusIdentityRejected
                ? "identity_not_matched"
                : "no_match",
      },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    if (facePlusPlusBlinkRejected) {
      return fail(
        "Face++ did not verify an open, closed, open eye sequence. Please capture the blink again.",
        401,
        facePlusPlusResponded ? { facePlusPlus: { status: "responded" } } : undefined
      );
    }
    if (facePlusPlusPoseRejected) {
      return fail(
        "Face++ could not confirm the straight-on and turned-head poses. Follow the prompts and try again.",
        401,
        facePlusPlusResponded ? { facePlusPlus: { status: "responded" } } : undefined
      );
    }
    if (facePlusPlusFaceRejected) {
      return fail(
        "Face++ could not find exactly one clear face in every frame. Center your face and retake the scan.",
        401,
        facePlusPlusResponded ? { facePlusPlus: { status: "responded" } } : undefined
      );
    }
    if (facePlusPlusIdentityRejected) {
      return fail(
        "Face++ compared the live face with the saved account photo but did not find a match. Retake the front-facing photo in good lighting.",
        401,
        facePlusPlusResponded ? { facePlusPlus: { status: "responded" } } : undefined
      );
    }
    return fail(
      UNRECOGNISED,
      401,
      facePlusPlusResponded ? { facePlusPlus: { status: "responded" } } : undefined
    );
  }

  if (!user.is_active) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: FACE_LOGIN_METHOD, reason: "deactivated" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(deactivatedMessage(user.deactivation_reason), 403, {
      deactivated: true,
      deactivation_reason: user.deactivation_reason ?? null,
      deactivated_at: user.deactivated_at ?? null,
    });
  }

  /*
   * ID verification, and it sits here for the same reason the deactivation check
   * above does: *after* the face has matched.
   *
   * Placed before the match it would be an oracle — an account waiting on a
   * document review would answer differently from a cleared one, which tells
   * anyone scanning barcodes which accounts exist and what state they are in.
   * After the match it is only reachable by the account's own holder.
   */
  const idGate = await getIdGate(user);
  if (idGate.required && !idGate.cleared) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: FACE_LOGIN_METHOD, reason: "id_unverified" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(idGate.message ?? "This account is not cleared to sign in yet.", 403, {
      id_unverified: true,
      verification_status: idGate.status,
    });
  }

  /*
   * Enrolled but disabled, or a row that lost its vector.
   *
   * Only reachable after a match succeeded, so it is not an oracle — it tells the
   * account's own holder something they need to know, and an admin, rather than
   * silently signing someone in against a face the cafe has since withdrawn.
   */
  if (!user.face_enabled || !hasFaceSamples) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    return fail(
      "Face sign-in is not available on this account. Ask an administrator, or sign in with your password.",
      403
    );
  }

  await recordLoginAttempt(key, FACE_LOGIN_METHOD, true);

  const session = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: "staff" as const,
  };

  const minutes = await getSessionMinutes();
  const token = await signSession(session, minutes);
  await setSessionCookie(token, minutes, user.id, db());

  /*
   * Open the duty window as part of signing in.
   *
   * Without this, a member of staff who signed in with their face would be asked
   * for it again by /verify seconds later — two camera prompts in five minutes
   * for the same act of proving who they are, which is how a feature gets
   * switched off by people who find it tiresome rather than unsafe.
   *
   * Harmless when duty verification is off: the column it writes is only read by
   * the gate, and the gate is inert. `is_active` was checked above, so this can
   * never reopen access to a deactivated account.
   */
  await recordFaceVerification(user.id);

  await audit(
    session,
    "LOGIN",
    "user",
    user.id,
    { method: FACE_LOGIN_METHOD },
    { ip: clientIp(req), outcome: "success" }
  );

  const hadPreviousSession = await hasActiveSession(
    user.session_token,
    user.session_last_active_at
  );

  return ok({
    user: session,
    session_conflict: hadPreviousSession,
    facePlusPlus: facePlusPlus === "enabled" ? { status: "passed" } : undefined,
  });
});

/**
 * One refusal for every failure.
 *
 * Exported nowhere and used for unknown account, malformed vector and
 * unrecognised face alike. The single most valuable property of this endpoint is
 * that these three are indistinguishable from the outside — an attacker who can
 * tell them apart can enumerate the roster, or test photographs against it one at
 * a time without ever tripping a threshold.
 *
 * Wording is deliberately not the same as verify-face's: that one is an already
 * authenticated member of staff being asked to confirm, and "that was not you" is
 * useful to them. Here the caller may not be who they claim, so it says nothing
 * about faces at all.
 */
const UNRECOGNISED = "Unrecognised barcode, username or face";
