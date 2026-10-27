import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { signSession, setSessionCookie, deactivatedMessage } from "@/lib/auth";
import { readStep2Ticket } from "@/lib/auth/step2-ticket";
import { audit } from "@/lib/audit";
import { getFaceEngine, getSessionMinutes, getFaceMatchThreshold } from "@/lib/settings";
import { PRIMARY_POSE, parseEmbedding, parseFaceFrames, matchPresentation } from "@/lib/face";
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
      "face_embedding, face_enabled, id_card_hash, verification_status, " +
      "session_token, step2_nonce"
    )
    .eq("id", ticket.userId)
    .eq("role", "staff")
    .maybeSingle();

  if (lookupError) {
    console.error("staff confirm lookup failed:", lookupError.message);
    return fail(`Cannot query the database (${lookupError.message}). Check .env.local.`, 503);
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

  const refuse = async (reason: string, auditIt: boolean) => {
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
    return fail(NO_MATCH, 401);
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
  const faceUsable = Boolean(user.face_enabled && frontalGallery.length > 0);
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

  const parsedFrames = parseFaceFrames(body.face_frames);
  const legacyFace = parseEmbedding(body.face_embedding);
  const frames = parsedFrames.ok
    ? parsedFrames.frames
    : legacyFace
      ? [{ pose: PRIMARY_POSE, embedding: legacyFace }]
      : null;

  /*
   * No face reading.
   *
   * A camera that showed no face is recorded separately from a face that failed
   * to match, but both receive the same generic refusal.
   */
  if (!frames) {
    return refuse("nothing_recognised", false);
  }

  /* ---- face -------------------------------------------------------------- */

  let matchedBy: "face" | null = null;

  if (faceUsable) {
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
    session_conflict: Boolean(user.session_token),
    matched_by: matchedBy,
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
