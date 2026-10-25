import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { getSession, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { checkLoginThrottle, tooManyAttempts, recordLoginAttempt, userKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Re-check the signed-in user's own password without disturbing the session.
 *
 * Used by the flows that hand control back to someone who has been away from the
 * till — re-activating an account is one of those. The point is to prove the
 * person at the keyboard is still the admin who signed in, rather than whoever
 * wandered up to an unlocked screen.
 *
 * Deliberately not `/api/auth/login`. Logging in again to prove who you are would
 * mint a new session token, overwrite the current one, log the current tab out
 * and fire the "signed in elsewhere" popup — so verifying identity would break
 * the very session it is meant to protect. This reads the password, compares it,
 * and leaves everything else alone.
 *
 * The response is a flat 401 either way. A wrong password and a passwordless
 * account must be indistinguishable, or the answer becomes an oracle for which
 * admin accounts exist.
 */
export const POST = handler(async (req: Request) => {
  const session = await getSession();
  if (!session) return fail("Not signed in", 401);

  const { password } = await readBody(req);
  if (!password) return fail("Enter your password to confirm", 400);

  /*
   * Throttled on the same key as sign-in, so confirming cannot be used to grind
   * through an admin password any faster than signing in can. Counted through
   * recordFaceAttempt because that is the generic per-subject failure counter
   * this codebase already keeps for exactly this shape of check.
   */
  const key = userKey(session.username);
  const throttle = await checkLoginThrottle(key, "admin_password");
  if (throttle.blocked) return tooManyAttempts(throttle.retryAfterSeconds);

  const { data: user } = await db()
    .from("users")
    .select("id, password_hash, is_active")
    .eq("id", session.id)
    .maybeSingle();

  const matches =
    !!user?.password_hash && user.is_active !== false && verifyPassword(String(password), user.password_hash);

  if (!matches) {
    await recordLoginAttempt(key, "admin_password", false);
    await audit(
      { id: session.id, username: session.username, fullName: session.fullName, role: session.role },
      "REAUTH_FAILED",
      "user",
      session.id,
      { method: "confirm_password" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail("That password is not correct", 401);
  }

  await recordLoginAttempt(key, "admin_password", true);
  return ok({ ok: true });
});