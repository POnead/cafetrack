import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import {
  requireUser,
  verifyPassword,
  hashPassword,
  signSession,
  setSessionCookie,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { checkLoginThrottle, recordLoginAttempt, tooManyAttempts, userKey } from "@/lib/rate-limit";
import { getSessionMinutes } from "@/lib/settings";

export const runtime = "nodejs";

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const { current_password, password, confirm_password } = await readBody(req);
  const currentPassword = String(current_password ?? "");
  const newPassword = String(password ?? "");
  const confirmPassword = String(confirm_password ?? "");

  if (!currentPassword) return fail("Enter your current password");
  if (newPassword.length < 8) return fail("New password must be at least 8 characters");
  if (newPassword !== confirmPassword) return fail("Passwords do not match");

  const key = userKey(user.username);
  const accountRole = user.baseRole ?? user.role;
  const method = accountRole === "admin" ? "admin_password" : "staff_password";
  const throttle = await checkLoginThrottle(key, method);
  if (throttle.blocked) return tooManyAttempts(throttle.retryAfterSeconds);

  const { data: account, error: lookupError } = await db()
    .from("users")
    .select("password_hash, is_active, role")
    .eq("id", user.id)
    .maybeSingle();

  if (lookupError) {
    console.error("password change lookup failed:", lookupError.message);
    return fail("Could not verify the current password", 503);
  }

  if (
    !account ||
    account.role !== accountRole ||
    account.is_active === false ||
    !verifyPassword(currentPassword, account.password_hash)
  ) {
    await recordLoginAttempt(key, method, false);
    await audit(
      user,
      "PASSWORD_CHANGE_FAILED",
      "user",
      user.id,
      { method: "current_password" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail("Current password is not correct", 401);
  }

  await recordLoginAttempt(key, method, true);
  const { error: updateError } = await db()
    .from("users")
    .update({ password_hash: hashPassword(newPassword) })
    .eq("id", user.id);

  if (updateError) {
    console.error("password change could not be saved:", updateError.message);
    return fail("Could not save the new password", 500);
  }

  const minutes = await getSessionMinutes(accountRole);
  const token = await signSession({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: accountRole,
    baseRole: accountRole,
  }, minutes);
  await setSessionCookie(token, minutes, user.id, db());

  await audit(
    user,
    "PASSWORD_CHANGED",
    "user",
    user.id,
    { method: "current_password" },
    { ip: clientIp(req), outcome: "success" }
  );

  return ok({ ok: true, message: "Password changed" });
});
