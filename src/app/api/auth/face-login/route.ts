import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import {
  signSession,
  setSessionCookie,
  deactivatedMessage,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSessionMinutes, getFaceEngine, getFaceLoginEnabled, getFaceMatchThreshold, getFaceRequireProfileAngles } from "@/lib/settings";
import { PRIMARY_POSE, parseEmbedding, parseFaceFrames } from "@/lib/face";
import { evaluatePresentation } from "@/lib/face-samples";
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
  return ok({ enabled: await getFaceLoginEnabled() });
});

/**
 * Sign in with a face instead of a password.
 *
 *   POST { identifier: "CT-STF-…" | "username", embedding: [128 numbers] }
 *   ->   { user, session_conflict }
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
 *   3. The threshold comes from settings. Never from the request.
 *
 * Note what this endpoint does not do: it does not accept a photo. The browser
 * computes the embedding with the recognition model and sends 128 floats, so a
 * photograph of a staff member is never transmitted here. The one copy on disk
 * is the reference the admin enrolled.
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
   * A malformed vector is answered exactly like an unrecognised face.
   *
   * It is also a bad request rather than an identity failure, and it would be
   * reasonable to say so — but "that face could not be read" beside "that face
   * was not recognised" is a free signal that the submitted vector was well
   * formed, which is exactly the oracle rule 2 above exists to prevent.
   *
   * `face_frames` carries the whole presentation — one frame per angle. A bare
   * `embedding` is still one straight-on frame, so a page that was already open
   * when the angles shipped keeps working.
   */
  const legacy = parseEmbedding(body.embedding);
  const parsedFrames = parseFaceFrames(body.face_frames);
  const frames = parsedFrames.ok
    ? parsedFrames.frames
    : legacy
      ? [{ pose: PRIMARY_POSE, embedding: legacy }]
      : null;

  if (!frames) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    await audit(
      null,
      "LOGIN_FAILED",
      "user",
      null,
      { method: FACE_LOGIN_METHOD, reason: "malformed_embedding" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(UNRECOGNISED, 401);
  }

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select(
      "id, username, full_name, role, is_active, deactivation_reason, " +
      "deactivated_at, session_token, face_embedding, face_enabled, " +
      // For the ID gate. See getIdGate for why these two columns and no more.
      "verification_status, id_doc_front"
    )
    .eq("role", "staff")
    .or(`qr_token.eq.${identifier},username.eq.${identifier}`)
    .maybeSingle();

  if (lookupError) {
    console.error("face login lookup failed:", lookupError.message);
    return fail(
      `Cannot query the database (${lookupError.message}). Check .env.local.`,
      503
    );
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
  // Read the engine once: the threshold is calibrated per engine, so it has to be
  // the same engine the gallery is filtered to below.
  const engine = await getFaceEngine();
  const threshold = await getFaceMatchThreshold(engine);

  /*
   * Matched against every angle on the account, after the lookup and before
   * anything about the account's state is revealed — see the note above about
   * the oracle.
   */
  const presentation = await evaluatePresentation({
    userId: user.id,
    legacyEmbedding: user.face_embedding ?? null,
    frames,
    threshold,
    requireProfileAngles: await getFaceRequireProfileAngles(),
    engine,
  });

  if (!presentation.matched) {
    await recordLoginAttempt(key, FACE_LOGIN_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: FACE_LOGIN_METHOD, reason: "no_match" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(UNRECOGNISED, 401);
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
  if (!user.face_enabled || presentation.samples.length === 0) {
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

  const hadPreviousSession = Boolean(user.session_token);

  return ok({ user: session, session_conflict: hadPreviousSession });
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
