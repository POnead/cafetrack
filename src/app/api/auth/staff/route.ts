import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { verifyPassword, signSession, setSessionCookie, deactivatedMessage } from "@/lib/auth";
import { newStep2Nonce, signStep2Ticket } from "@/lib/auth/step2-ticket";
import { audit } from "@/lib/audit";
import { dispatchSoon } from "@/lib/email";
import { getSessionMinutes } from "@/lib/settings";
import { getIdGate } from "@/lib/id-gate";
import {
  checkLoginThrottle,
  tooManyAttempts,
  tokenKey,
  userKey,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * True only on the throwaway test server, never in production.
 *
 * Two-step sign-in makes the enrolled-face check mandatory, and a test has no
 * enrolled face to present. Fifteen suites use POST /api/auth/staff as
 * their login helper and would all fail at the door without an escape, so a
 * legacy test suite can explicitly opt in to CAFETRACK_DISABLE_STEP2 and this
 * route behaves exactly as it did before.
 *
 * The `NODE_ENV` check is the one that matters. The env var is the convenience;
 * being unable to turn step two off on a real deployment is the requirement.
 * Same shape as CAFETRACK_DISABLE_EMAIL, which dev-test.mjs also sets.
 */
function bypassStepTwo(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.CAFETRACK_DISABLE_STEP2 === "1"
  );
}

/**
 * Record a rejected sign-in and, if anyone is listening by email, tell them.
 *
 * Wrapped in a helper because this file has three rejection paths (unknown
 * code, wrong password, deactivated account) and the notification should read
 * the same for all of them. Never allowed to change the response: a person who
 * typed the wrong code must get the same 401 whether or not mail is configured.
 */
async function recordRejection(
  req: Request,
  actor: Parameters<typeof audit>[0],
  reason: string,
  token: string | null
) {
  await audit(
    actor,
    "LOGIN_FAILED",
    "user",
    actor?.id ?? null,
    {
      method: "staff",
      reason,
      // The raw code never goes into the email. An unrecognised one is hashed in
      // login_attempts precisely so it cannot be recovered, and repeating it in
      // cleartext mail would undo that.
      ...(token ? { token } : {}),
    },
    { critical: false, ip: clientIp(req), outcome: "failed" }
  );

  try {
    await db().rpc("enqueue_failed_login_alert", {
      p_username: actor?.username ?? "unknown",
      p_method: "staff",
      p_reason: reason,
    });
    dispatchSoon();
  } catch (e: any) {
    console.error("failed-login notification failed:", e?.message || e);
  }
}

export const POST = handler(async (req: Request) => {
  const body = await readBody(req);
  const { username, token, password } = body;

  // Accept either a scanned barcode token OR a typed username — never both.
  const input = String(username ?? token ?? "").trim();
  const pwd = String(password ?? "").trim();

  if (!input || !pwd) {
    return fail("Username or barcode and password are required");
  }

  // Look up by qr_token first (barcode scan), then by username (manual entry).
  // A scan always starts with "CT-STF-", so there is no ambiguity between
  // the two fields even though both are accepted here.
  const { data: user, error: lookupError } = await db()
    .from("users")
    .select("*")
    .eq("role", "staff")
    .or(`qr_token.eq.${input},username.eq.${input}`)
    .maybeSingle();

  if (lookupError) {
    console.error("staff login lookup failed:", lookupError.message);
    return fail(
      `Cannot query the database (${lookupError.message}). Check .env.local.`,
      503
    );
  }

  const method = user?.qr_token === input ? "staff_qr" : "staff";
  const key = user ? userKey(user.username) : tokenKey(input);
  const throttle = await checkLoginThrottle(key, method);
  if (throttle.blocked) return tooManyAttempts(throttle.retryAfterSeconds);

  const logAttempt = async (success: boolean) => {
    await db().from("login_attempts").insert({
      username: key,
      method,
      success,
    });
  };

  if (!user) {
    await logAttempt(false);
    await recordRejection(req, null, "unknown_credential", input);
    return fail("Unrecognized username or barcode", 401);
  }

  if (!verifyPassword(pwd, user.password_hash)) {
    await logAttempt(false);
    await recordRejection(
      req,
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "bad_password",
      null
    );
    return fail("Incorrect password", 401);
  }

  if (!user.is_active) {
    await logAttempt(false);
    await recordRejection(
      req,
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "deactivated",
      null
    );
    return fail(deactivatedMessage(user.deactivation_reason), 403, {
      deactivated: true,
      deactivation_reason: user.deactivation_reason ?? null,
      deactivated_at: user.deactivated_at ?? null,
    });
  }

  /*
   * ID verification, after the password.
   *
   * Same ordering reason as the deactivation check above: this route is reached
   * only by someone who already knows the credential, so naming the reason is
   * safe and useful, and a wrong guess still gets the generic 401 rather than
   * learning that an account is waiting on a document review.
   *
   * Recorded as a failed attempt so the throttle counts it. Otherwise someone
   * repeatedly trying an unverified barcode would never trip the limit, and
   * could use the endpoint to test which codes belong to unverified accounts.
   */
  const gate = await getIdGate(user);
  if (gate.required && !gate.cleared) {
    await logAttempt(false);
    await recordRejection(
      req,
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "id_unverified",
      null
    );
    return fail(gate.message ?? "This account is not cleared to sign in yet.", 403, {
      id_unverified: true,
      verification_status: gate.status,
    });
  }

  /*
   * Step one of a two-step sign-in. The password is proven; the session is not
   * minted yet.
   *
   * This is the whole point of the change, so it is worth being explicit about
   * what went wrong before. Signing a session here made step two advisory: the
   * cookie was already in the browser while the face-check panel was still on
   * screen, so any request made during that window - including one the panel
   * never made - walked straight past the check that was supposed to be the
   * second factor.
   *
   * So nothing session-shaped is written here. What comes back is a ticket,
   * signed with a key the session code does not hold (see lib/auth/step2-ticket),
   * which /api/auth/staff/confirm exchanges for a real session once a face or an
   * ID card has matched. The ticket cannot be used as a session cookie, which is
   * what makes "the second step is mandatory" true rather than aspirational.
   */
  await logAttempt(true);

  /*
   * Explicit test bypass only. See bypassStepTwo() for why this exists and what
   * it costs.
   *
   * Double-gated on purpose: scripts/dev-test.mjs only sets the flag for an
   * explicitly requested legacy test mode, and this branch refuses to run in
   * production even if it somehow is. Fifteen existing
   * suites use this endpoint as their login helper and have no face and no card
   * to present at a second step, so without this the mandatory step two would
   * not be a feature but an outage.
   */
  if (bypassStepTwo()) {
    const session = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: "staff" as const,
    };

    const minutes = await getSessionMinutes();
    const token = await signSession(session, minutes);
    await setSessionCookie(token, minutes, user.id, db());

    await audit(session, "LOGIN", "user", user.id, { method }, {
      ip: clientIp(req),
      outcome: "success",
    });

    return ok({
      user: session,
      session_conflict: Boolean(user.session_token),
      step2_bypassed: true,
    });
  }

  /*
   * Password accepted; step two still owed. Audited as its own thing rather than
   * folded into the eventual LOGIN, because an account that types a correct
   * password and then walks away is worth being able to count.
   */
  await audit(
    { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
    "LOGIN_PASSWORD_OK",
    "user",
    user.id,
    { method },
    { critical: false, ip: clientIp(req), outcome: "partial" }
  );

  const nonce = newStep2Nonce();

  const { error: nonceError } = await db()
    .from("users")
    .update({ step2_nonce: nonce })
    .eq("id", user.id);

  if (nonceError) {
    console.error("staff login nonce write failed:", nonceError.message);
    return fail(`Cannot query the database (${nonceError.message}). Check .env.local.`, 503);
  }

  const ticket = await signStep2Ticket({
    userId: user.id,
    username: user.username,
    nonce,
  });

  return ok({
    step2_required: true,
    ticket,
    ticket_seconds: 300,
    full_name: user.full_name,
  });
});
