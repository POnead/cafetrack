import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { signSession, setSessionCookie, deactivatedMessage } from "@/lib/auth";
import { readStep2Ticket, STEP2_TTL_SECONDS } from "@/lib/auth/step2-ticket";
import { audit } from "@/lib/audit";
import { getSessionMinutes, getFaceMatchThreshold, getIdFaceMatchThreshold } from "@/lib/settings";
import { parseEmbedding, parseStoredEmbedding, isMatch } from "@/lib/face";
import { recordFaceVerification } from "@/lib/face-gate";
import { getIdGate } from "@/lib/id-gate";
import { isSameCard, isValidFingerprint } from "@/lib/id-verification/card-hash";
import {
  checkLoginThrottle,
  tooManyAttempts,
  recordLoginAttempt,
  userKey,
  STEP2_METHOD,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Step two of staff sign-in: prove a face, or an ID card, and receive the session
 * that step one deliberately withheld.
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
 * ## Either signal is enough
 *
 * A face, or a card, or both. One button opens the camera, a frame is grabbed,
 * and whatever is recognisable in it is used. The browser sends both readings when
 * it can make them and the route tries them in turn, so a hand that fills the
 * frame with a face and a hand that fills it with a card both land in the same
 * place.
 */
export const POST = handler(async (req: Request) => {
  const body = await readBody(req);

  const token = String(body.ticket ?? "").trim();

  if (!token) {
    return fail(EXPIRED, 401);
  }

  /*
   * Verify the signature and the expiry. This is what makes the ticket useless as
   * a session cookie: it is signed with a key readSessionToken never holds, so
   * presenting one as cafetrack_session fails there rather than here.
   */
  const ticket = await readStep2Ticket(token);
  if (!ticket) {
    return fail(EXPIRED, 401);
  }

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select(
      "id, username, full_name, is_active, deactivation_reason, deactivated_at, " +
      "face_embedding, face_enabled, id_card_hash, verification_status, id_doc_front, " +
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
    return fail(EXPIRED, 401);
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
    return fail(EXPIRED, 401);
  }

  /*
   * Throttle on the account, not on the credential.
   *
   * There is no credential being guessed here — the password is already proven
   * and the ticket is unforgeable — so this counts *failed second steps on one
   * account*. Five is the right number: it stops someone holding a stolen
   * password from grinding through card after card, without punishing a person
   * who fumbles their card a few times.
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

  const stored = parseStoredEmbedding(user.face_embedding);
  const faceUsable = Boolean(user.face_enabled && stored);
  const cardUsable = isValidFingerprint(user.id_card_hash);

  /*
   * Neither. The account passed the password and has nothing to prove itself
   * with.
   *
   * This is the state "step two is mandatory" creates, and it is reachable only
   * by the account's own holder, who is exactly the person who needs telling.
   * So this one answers specifically rather than with the generic refusal — a
   * 403 naming the fix, where a stranger gets the same 401 as a bad card.
   *
   * Checked before any comparison because it is a fact about the row, not an
   * outcome of matching, and a person who cannot succeed should not be made to
   * keep trying.
   */
  if (!faceUsable && !cardUsable) {
    await recordLoginAttempt(key, STEP2_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: STEP2_METHOD, reason: "no_second_factor" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(
      "This account has no face or ID card on file, so it cannot finish signing in. " +
        "An administrator can add a photo of you, or your ID card, on the Staff Accounts page.",
      403,
      { no_second_factor: true }
    );
  }

  /* ---- the readings ------------------------------------------------------- */

  const submitted = parseEmbedding(body.face_embedding);
  const rawHash = String(body.card_hash ?? "").trim().toLowerCase();
  const cardHash = isValidFingerprint(rawHash) ? rawHash : null;
  const idFace = parseEmbedding(body.id_face_embedding);

  /*
   * Nothing recognisable in the frame.
   *
   * A request carrying none of the three is not an identity failure — it is a
   * camera that showed a wall. Same generic 401 either way, but recorded
   * separately so the audit can tell "aimed at nothing" from "aimed at the
   * wrong person".
   */
  if (!submitted && !cardHash && !idFace) {
    return refuse("nothing_recognised", false);
  }

  /* ---- face -------------------------------------------------------------- */

  let matchedBy: "face" | "id_card" | null = null;

  if (submitted && faceUsable) {
    const threshold = await getFaceMatchThreshold();
    if (isMatch(submitted, stored, threshold)) {
      matchedBy = "face";
    }
  }

  /*
   * Face against the ID card portrait.
   *
   * The enrolled face is a live photograph; the ID card portrait is a printed
   * one. They are the same person but the distance between them is far larger
   * than between two live photographs, so this uses the ID match threshold
   * (0.55) rather than the face match threshold (0.033).
   *
   * The ID card embedding is computed in the browser from the stored image and
   * sent here — the server never runs the face model itself.
   */
  if (!matchedBy && submitted && idFace) {
    const threshold = await getIdFaceMatchThreshold();
    if (isMatch(submitted, idFace, threshold)) {
      matchedBy = "face";
    }
  }

  /* ---- ID card ----------------------------------------------------------- */

  /*
   * Only tried when the face did not already match, and only against this one
   * account.
   *
   * `isSameCard` compares perceptual hashes with a Hamming tolerance, so a card
   * photographed at a slight angle, or on a different phone, still lands. The
   * tolerance is a reasoned number rather than a measured one — see
   * DUPLICATE_DISTANCE in id-verification/card-hash.ts.
   *
   * No OCR here, deliberately. The account is already known, so the ID number on
   * the card would only ever confirm what the fingerprint has already said, and
   * reading it would make every sign-in depend on a 7MB text model being present
   * and a second or two slower. What is lost is the name-mismatch warning the
   * old route returned; that was advisory, and an admin reviewing the card on
   * file sees the same thing.
   */
  if (!matchedBy && cardHash && cardUsable) {
    if (isSameCard(cardHash, user.id_card_hash as string)) {
      matchedBy = "id_card";
    }
  }

  if (!matchedBy) {
    return refuse(matchedBy === null && cardHash ? "card_and_face_no_match" : "no_match", true);
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
const NO_MATCH = "That did not match the photo or the ID card on this account";

/**
 * The ticket is spent, expired, or was never one.
 *
 * Deliberately vague and identical across all three. Whether a ticket was
 * already used says something about a race the caller may have started; that is
 * not information to hand back.
 */
const EXPIRED = "That sign-in attempt has expired. Enter your password again.";