import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import {
  hashPassword,
  verifyPassword,
  signSession,
  setSessionCookie,
  deactivatedMessage,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSessionMinutes } from "@/lib/settings";

export const runtime = "nodejs";

export const POST = handler(async (req: Request) => {
  const { username, password } = await req.json();

  if (!username || !password) return fail("Username and password are required");

  const { data: user, error: lookupError } = await db()
    .from("users")
    .select("*")
    .eq("username", username)
    .eq("role", "admin")
    .maybeSingle();

  // A bad URL / key / network failure returns data=null exactly like "no such
  // user" does, so surface it instead of a misleading "Invalid credentials".
  if (lookupError) {
    console.error("admin login lookup failed:", lookupError.message);
    return fail(
      `Cannot query the database (${lookupError.message}). Check .env.local.`,
      503
    );
  }

  const logAttempt = async (success: boolean) => {
    await db().from("login_attempts").insert({
      username,
      method: "admin_password",
      success,
    });
  };

  if (!user) {
    await logAttempt(false);
    return fail("Invalid credentials", 401);
  }

  if (!verifyPassword(password, user.password_hash)) {
    await logAttempt(false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "admin" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: "admin_password" }
    );
    return fail("Invalid credentials", 401);
  }

  // Checked after the password, so a wrong guess still gets the generic
  // message and this cannot be used to probe for usernames. Someone who knows
  // their own password deserves to know the account was switched off, and why.
  if (!user.is_active) {
    await logAttempt(false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name, role: "admin" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: "admin_password", reason: "deactivated" }
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
  setSessionCookie(token, minutes);

  await audit(session, "LOGIN", "user", user.id, { method: "admin_password" });

  return ok({ user: session });
});
