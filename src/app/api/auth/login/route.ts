import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  hasActiveSession,
  deactivatedMessage,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { dispatchSoon } from "@/lib/email";
import { getSessionMinutes } from "@/lib/settings";
import { checkLoginThrottle, tooManyAttempts, userKey, recordLoginAttempt } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Columns sign-in actually needs.
 *
 * `select("*")` pulled `face_embedding`, `face_image` and the ID document
 * images — hundreds of kilobytes of biometrics and base64 per password check,
 * to compare one hash. Data the route does not need is data it should not load.
 */
const LOGIN_COLUMNS =
  "id, username, password_hash, full_name, role, is_active, " +
  "deactivation_reason, deactivated_at, session_token, session_last_active_at";

/**
 * Record a rejected admin sign-in and queue the email, without ever changing
 * what the caller is told. A person who mistyped must get the same generic 401
 * whether or not mail is set up, so every notification path is best-effort.
 *
 * The unknown-username case passes only the throttle key, never a real
 * credential — there is no user to name.
 */
async function recordRejection(
  req: Request,
  actor: { id: string; username: string; fullName: string; role: "admin" },
  reason: string
) {
  await audit(actor, "LOGIN_FAILED", "user", actor.id, {
    method: "admin_password",
    reason,
  }, { critical: false, ip: clientIp(req), outcome: "failed" });

  try {
    await db().rpc("enqueue_failed_login_alert", {
      p_username: actor.username,
      p_method: "admin_password",
      p_reason: reason,
    });
    dispatchSoon();
  } catch (e: any) {
    console.error("failed-login notification failed:", e?.message || e);
  }
}

/** The no-such-user variant: nothing to audit against, only to notify about. */
async function notifyRejection(_key: string, method: string, reason: string) {
  try {
    await db().rpc("enqueue_failed_login_alert", {
      p_username: "unknown",
      p_method: method,
      p_reason: reason,
    });
    dispatchSoon();
  } catch (e: any) {
    console.error("failed-login notification failed:", e?.message || e);
  }
}

export const POST = handler(async (req: Request) => {
  const { username, password } = await readBody(req);

  if (!username || !password) return fail("Username and password are required");

  const normalizedUsername = String(username).trim();
  const normalizedPassword = String(password);
  if (!normalizedUsername || !normalizedPassword) return fail("Username and password are required");

  // Throttled before any password work — that is the whole point of the check.
  const key = userKey(normalizedUsername);
  const throttle = await checkLoginThrottle(key, "admin_password");
  if (throttle.blocked) return tooManyAttempts(throttle.retryAfterSeconds);

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select(LOGIN_COLUMNS)
    .eq("username", normalizedUsername)
    .eq("role", "admin")
    .maybeSingle();

  // A bad URL / key / network failure returns data=null exactly like "no such
  // user" does. Log the detail; do not hand the caller a connection string or a
  // host name, which is what putting `lookupError.message` in the response did.
  if (lookupError) {
    console.error("admin login lookup failed:", lookupError.message);
    return fail("Cannot reach the database. Check the server configuration.", 503);
  }

  const logAttempt = async (success: boolean) => {
    // recordLoginAttempt is the same writer the throttle reads, and it swallows
    // its own failure: a broken counter must not turn a wrong password into a 500.
    await recordLoginAttempt(key, "admin_password", success);
  };

  if (!user) {
    await logAttempt(false);
    await notifyRejection(key, "admin_password", "unknown_user");
    return fail("Invalid credentials", 401);
  }

  if (!verifyPassword(normalizedPassword, user.password_hash)) {
    await logAttempt(false);
    await recordRejection(
      req,
      { id: user.id, username: user.username, fullName: user.full_name, role: "admin" },
      "bad_password"
    );
    return fail("Invalid credentials", 401);
  }

  // Checked after the password, so a wrong guess still gets the generic
  // message and this cannot be used to probe for usernames. Someone who knows
  // their own password deserves to know the account was switched off, and why.
  if (!user.is_active) {
    await logAttempt(false);
    await recordRejection(
      req,
      { id: user.id, username: user.username, fullName: user.full_name, role: "admin" },
      "deactivated"
    );
    return fail(deactivatedMessage(user.deactivation_reason), 403, {
      deactivated: true,
      deactivation_reason: user.deactivation_reason ?? null,
      deactivated_at: user.deactivated_at ?? null,
    });
  }

  await logAttempt(true);

  const session = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: "admin" as const,
  };

  // Session lifetime comes from settings.session_timeout_minutes.
  const minutes = await getSessionMinutes();
  const token = await signSession(session, minutes);
  await setSessionCookie(token, minutes, user.id, db());

  await audit(session, "LOGIN", "user", user.id, { method: "admin_password" }, {
    ip: clientIp(req),
    outcome: "success",
  });

  // Check if there was a previous session — notify client to show the conflict popup.
  const hadPreviousSession = await hasActiveSession(
    user.session_token,
    user.session_last_active_at
  );

  return ok({ user: session, session_conflict: hadPreviousSession });
});
