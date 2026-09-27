import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { verifyPassword, signSession, setSessionCookie, deactivatedMessage } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSessionMinutes } from "@/lib/settings";
import {
  checkLoginThrottle,
  tooManyAttempts,
  tokenKey,
  userKey,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

export const POST = handler(async (req: Request) => {
  const { token, password } = await readBody(req);

  if (!token || !password) return fail("Staff code and password are required");

  const clean = String(token).trim();

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select("*")
    .eq("qr_token", clean)
    .eq("role", "staff")
    .maybeSingle();

  // A bad URL / key / network failure returns data=null exactly like an
  // unknown token does, so surface it instead of a misleading message.
  if (lookupError) {
    console.error("staff login lookup failed:", lookupError.message);
    return fail(
      `Cannot query the database (${lookupError.message}). Check .env.local.`,
      503
    );
  }

  // A known account is throttled on that account; an unknown code is throttled
  // on a hash of the code itself, so brute-forcing codes never writes a usable
  // credential into the log.
  const key = user ? userKey(user.username) : tokenKey(clean);
  const throttle = await checkLoginThrottle(key, "staff_qr");
  if (throttle.blocked) return tooManyAttempts(throttle.retryAfterSeconds);

  const logAttempt = async (success: boolean) => {
    await db().from("login_attempts").insert({
      // The same key the throttle counts, so a success clears the failures.
      username: key,
      method: "staff_qr",
      success,
    });
  };

  if (!user) {
    await logAttempt(false);
    await audit(null, "LOGIN_FAILED", "user", null, {
      method: "staff_qr",
      reason: "unknown_token",
      token: clean,
    }, { critical: false });
    return fail("Unrecognized staff credential", 401);
  }

  if (!verifyPassword(password, user.password_hash)) {
    await logAttempt(false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: "staff_qr", reason: "bad_password" },
      { critical: false }
    );
    return fail("Incorrect password", 401);
  }

  // Same ordering as the admin route: the credential has to verify before the
  // account status is revealed, and the reason an admin recorded is reported.
  if (!user.is_active) {
    await logAttempt(false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: "staff_qr", reason: "deactivated" },
      { critical: false }
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
    role: "staff" as const,
  };

  // Session lifetime comes from settings.session_timeout_minutes.
  const minutes = await getSessionMinutes();
  const token2 = await signSession(session, minutes);
  await setSessionCookie(token2, minutes);

  await audit(session, "LOGIN", "user", user.id, { method: "staff_qr" });

  return ok({ user: session });
});
