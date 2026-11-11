import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  clearSessionCache,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import { resolveAuthSecret } from "@/lib/secret";
import { sendPasswordRecoveryCode } from "@/lib/email";
import {
  ADMIN_LOGIN_THROTTLE_KEY,
  ADMIN_LOGIN_THROTTLE_METHOD,
  checkLoginThrottle,
  clearLoginThrottle,
  recordLoginAttempt,
  tooManyAttempts,
  userKey,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

const CODE_LIFETIME_MS = 10 * 60_000;
const RESEND_DELAY_MS = 60_000;
const MAX_CODE_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_METHOD = "admin_recovery_request";
const VERIFY_METHOD = "admin_recovery_verify";
const GENERIC_REQUEST_MESSAGE =
  "If the admin account is eligible and has a recovery email configured, check that inbox for a recovery code. Any existing code remains valid until its original expiry.";

function digest(value: string): string {
  return createHmac("sha256", resolveAuthSecret()).update(value).digest("hex");
}

function matchesDigest(value: string, expected: string): boolean {
  const actualBytes = Buffer.from(value, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function codeDigest(challengeId: string, code: string): string {
  return digest(`admin-recovery-code:${challengeId}:${code}`);
}

function tokenDigest(token: string): string {
  return digest(`admin-recovery-token:${token}`);
}

function resendAvailability(createdAt: string, now: Date) {
  const availableAt = Date.parse(createdAt) + RESEND_DELAY_MS;
  return {
    resend_available_at: new Date(availableAt).toISOString(),
    resend_after_seconds: Math.max(
      0,
      Math.ceil((availableAt - now.getTime()) / 1000)
    ),
  };
}

async function auditRecoveryFailure(
  req: Request,
  adminId: string | null,
  reason: string,
  extra: Record<string, unknown> = {}
) {
  await audit(
    null,
    "ADMIN_PASSWORD_RESET_CODE_FAILED",
    "user",
    adminId,
    {
      method: "admin_email_code",
      reason,
      ...extra,
    },
    { critical: false, ip: clientIp(req), outcome: "failed" }
  );
}

export const POST = handler(async (req: Request) => {
  const body = await readBody(req);
  const action = String(body.action ?? "");
  const now = new Date();

  if (action === "request") {
    const username = String(body.username ?? "").trim();
    if (!username || username.length > 80) {
      return fail("Enter the admin username", 400);
    }

    const throttleKey = userKey(username);
    const throttle = await checkLoginThrottle(throttleKey, REQUEST_METHOD);
    const fallbackChallengeId = randomUUID();
    let { data: admin, error: adminError } = await db()
      .from("users")
      .select("id, username, full_name, recovery_email")
      .eq("username", username)
      .eq("role", "admin")
      .eq("is_active", true)
      .maybeSingle();

    // Older databases may not have applied the additive per-admin email
    // migration yet. Keep recovery working there through the legacy owner email
    // rather than failing before SMTP is reached.
    if (
      adminError &&
      /recovery_email/i.test(adminError.message) &&
      /(column|schema cache|could not find|does not exist)/i.test(adminError.message)
    ) {
      const legacyLookup = await db()
        .from("users")
        .select("id, username, full_name")
        .eq("username", username)
        .eq("role", "admin")
        .eq("is_active", true)
        .maybeSingle();
      admin = legacyLookup.data
        ? { ...legacyLookup.data, recovery_email: null }
        : null;
      adminError = legacyLookup.error;
    }

    if (adminError) {
      console.error("admin password recovery lookup failed:", adminError.message);
      await auditRecoveryFailure(req, admin?.id ?? null, "lookup_failed", {
        error: adminError.message,
      });
      return fail("Password recovery is temporarily unavailable", 503);
    }

    let recoveryEmail = String(admin?.recovery_email ?? "").trim();
    if (admin && !recoveryEmail) {
      const { data: recoverySetting, error: settingError } = await db()
        .from("settings")
        .select("value")
        .eq("key", "password_recovery_email")
        .maybeSingle();

      if (settingError) {
        console.error("admin recovery email lookup failed:", settingError.message);
        await auditRecoveryFailure(req, admin?.id ?? null, "recovery_email_lookup_failed", {
          error: settingError.message,
        });
        return fail("Password recovery is temporarily unavailable", 503);
      }

      recoveryEmail = String(recoverySetting?.value ?? "").trim();
    }
    if (!admin || !recoveryEmail) {
      if (!throttle.blocked) {
        await recordLoginAttempt(throttleKey, REQUEST_METHOD, false);
      }
      await auditRecoveryFailure(req, admin?.id ?? null, "missing_recovery_email", {
        username,
      });
      return ok({ challenge_id: fallbackChallengeId, message: GENERIC_REQUEST_MESSAGE });
    }

    const { error: cleanupError } = await db()
      .from("admin_password_reset_codes")
      .delete()
      .lt("expires_at", now.toISOString());
    if (cleanupError) {
      console.error("expired admin recovery codes could not be removed:", cleanupError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    const { data: recent, error: recentError } = await db()
      .from("admin_password_reset_codes")
      .select("id, created_at, expires_at, used_at, attempts")
      .eq("admin_id", admin.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentError) {
      console.error("admin password recovery challenge lookup failed:", recentError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    const recentCreatedAt = recent?.created_at ? Date.parse(recent.created_at) : 0;
    const recentExpiresAt = recent?.expires_at ? Date.parse(recent.expires_at) : 0;
    if (
      recent &&
      !recent.used_at &&
      Number.isFinite(recentCreatedAt) &&
      Number.isFinite(recentExpiresAt) &&
      recentExpiresAt > now.getTime() &&
      recent.attempts < MAX_CODE_ATTEMPTS
    ) {
      await recordLoginAttempt(throttleKey, REQUEST_METHOD, true);
      return ok({
        challenge_id: recent.id,
        expires_at: recent.expires_at,
        ...resendAvailability(recent.created_at, now),
        message: GENERIC_REQUEST_MESSAGE,
      });
    }

    if (throttle.blocked) {
      return ok({ challenge_id: fallbackChallengeId, message: GENERIC_REQUEST_MESSAGE });
    }

    const code = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS).toISOString();
    const { error: invalidateError } = await db()
      .from("admin_password_reset_codes")
      .update({ used_at: now.toISOString() })
      .eq("admin_id", admin.id)
      .is("used_at", null);
    if (invalidateError) {
      console.error("previous admin recovery codes could not be invalidated:", invalidateError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    const { data: challenge, error: insertError } = await db()
      .from("admin_password_reset_codes")
      .insert({
        id: fallbackChallengeId,
        admin_id: admin.id,
        code_hash: codeDigest(fallbackChallengeId, code),
        attempts: 0,
        expires_at: expiresAt,
      })
      .select("id, created_at, expires_at")
      .single();

    if (insertError || !challenge) {
      console.error("admin password recovery challenge could not be created:", insertError?.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    try {
      await sendPasswordRecoveryCode(recoveryEmail, code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("admin password recovery email could not be sent:", message);
      await db()
        .from("admin_password_reset_codes")
        .update({ used_at: now.toISOString() })
        .eq("id", challenge.id);
      await recordLoginAttempt(throttleKey, REQUEST_METHOD, false);
      await auditRecoveryFailure(req, admin.id, "smtp_send_failed", {
        error: message,
        recipient: recoveryEmail,
      });
      return fail(
        "We couldn't send the recovery code. Check the admin's recovery email in Staff Accounts and verify the sending account in Settings → Email, then try again.",
        503
      );
    }

    await recordLoginAttempt(throttleKey, REQUEST_METHOD, true);
    await audit(
      null,
      "ADMIN_PASSWORD_RESET_CODE_SENT",
      "user",
      admin.id,
      { method: "admin_email_code" },
      { critical: false, ip: clientIp(req), outcome: "success" }
    );

    return ok({
      challenge_id: challenge.id,
      expires_at: challenge.expires_at,
      ...resendAvailability(challenge.created_at, now),
      message: GENERIC_REQUEST_MESSAGE,
    });
  }

  if (action === "verify") {
    const challengeId = String(body.challenge_id ?? "");
    const code = String(body.code ?? "").trim();
    if (!UUID.test(challengeId) || !/^\d{6}$/.test(code)) {
      return fail("That code is incorrect or expired", 400);
    }

    const throttleKey = `recovery:${challengeId}`;
    const throttle = await checkLoginThrottle(throttleKey, VERIFY_METHOD);
    if (throttle.blocked) {
      return tooManyAttempts(throttle.retryAfterSeconds, "recovery code attempts");
    }

    const { data: challenge, error } = await db()
      .from("admin_password_reset_codes")
      .select("id, admin_id, code_hash, attempts, expires_at, used_at")
      .eq("id", challengeId)
      .maybeSingle();

    if (error) {
      console.error("admin password recovery code lookup failed:", error.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    const validChallenge =
      challenge &&
      !challenge.used_at &&
      Date.parse(challenge.expires_at) > Date.now() &&
      challenge.attempts < MAX_CODE_ATTEMPTS;
    if (!validChallenge) {
      await recordLoginAttempt(throttleKey, VERIFY_METHOD, false);
      return fail("That code is incorrect or expired", 400);
    }

    const expectedHash = codeDigest(challengeId, code);
    if (!matchesDigest(expectedHash, challenge.code_hash)) {
      const { error: attemptError } = await db()
        .from("admin_password_reset_codes")
        .update({ attempts: challenge.attempts + 1 })
        .eq("id", challengeId);
      if (attemptError) {
        console.error("admin recovery attempt could not be recorded:", attemptError.message);
        return fail("Password recovery is temporarily unavailable", 503);
      }
      await recordLoginAttempt(throttleKey, VERIFY_METHOD, false);
      return fail("That code is incorrect or expired", 400);
    }

    const resetToken = randomBytes(32).toString("hex");
    const { error: verifyError } = await db()
      .from("admin_password_reset_codes")
      .update({
        verified_at: new Date().toISOString(),
        reset_token_hash: tokenDigest(resetToken),
      })
      .eq("id", challengeId);

    if (verifyError) {
      console.error("admin password recovery code could not be verified:", verifyError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    await recordLoginAttempt(throttleKey, VERIFY_METHOD, true);
    return ok({ reset_token: resetToken });
  }

  if (action === "reset") {
    const challengeId = String(body.challenge_id ?? "");
    const resetToken = String(body.reset_token ?? "");
    const password = String(body.password ?? "");
    const confirmPassword = String(body.confirm_password ?? "");

    if (!UUID.test(challengeId) || !/^[0-9a-f]{64}$/i.test(resetToken)) {
      return fail("This reset link is invalid or expired", 400);
    }
    if (password.length < 8) return fail("Password must be at least 8 characters");
    if (password !== confirmPassword) return fail("Passwords do not match");

    const { data: challenge, error: challengeError } = await db()
      .from("admin_password_reset_codes")
      .select("id, admin_id, reset_token_hash, verified_at, expires_at, used_at")
      .eq("id", challengeId)
      .maybeSingle();

    if (challengeError) {
      console.error("admin password reset lookup failed:", challengeError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }

    const valid =
      challenge &&
      challenge.verified_at &&
      !challenge.used_at &&
      Date.parse(challenge.expires_at) > Date.now() &&
      challenge.reset_token_hash &&
      matchesDigest(tokenDigest(resetToken), challenge.reset_token_hash);
    if (!valid) return fail("This reset link is invalid or expired", 400);

    const { data: admin, error: userError } = await db()
      .from("users")
      .select("id, username, full_name, password_hash")
      .eq("id", challenge.admin_id)
      .eq("role", "admin")
      .eq("is_active", true)
      .maybeSingle();

    if (userError) {
      console.error("admin password reset account lookup failed:", userError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }
    if (!admin) return fail("This reset link is invalid or expired", 400);
    if (verifyPassword(password, admin.password_hash)) {
      return fail("New password must be different from your current password", 400);
    }

    const { data: claimed, error: claimError } = await db()
      .from("admin_password_reset_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", challengeId)
      .eq("reset_token_hash", challenge.reset_token_hash)
      .is("used_at", null)
      .select("id")
      .maybeSingle();

    if (claimError) {
      console.error("admin password reset token could not be claimed:", claimError.message);
      return fail("Password recovery is temporarily unavailable", 503);
    }
    if (!claimed) return fail("This reset link is invalid or expired", 400);

    const { data: updatedAdmin, error: updateError } = await db()
      .from("users")
      .update({
        password_hash: hashPassword(password),
        session_token: null,
        session_last_active_at: null,
      })
      .eq("id", admin.id)
      .eq("role", "admin")
      .eq("is_active", true)
      .select("id")
      .maybeSingle();

    if (updateError || !updatedAdmin) {
      console.error(
        "admin password reset could not be saved:",
        updateError?.message ?? "No active admin row was updated"
      );
      return fail("Could not save the new password. Request another recovery code.");
    }

    // Both unconditionally: `recordLoginAttempt(..., true)` stops the
    // consecutive-failure streak, and `clearLoginThrottle` wipes the throttle
    // history so the new password starts with a clean lockout. They are two
    // different records; short-circuiting one into the other meant the lockout
    // could survive a full password reset.
    await recordLoginAttempt(
      ADMIN_LOGIN_THROTTLE_KEY,
      ADMIN_LOGIN_THROTTLE_METHOD,
      true
    );
    const loginThrottleCleared = await clearLoginThrottle(
      ADMIN_LOGIN_THROTTLE_KEY,
      ADMIN_LOGIN_THROTTLE_METHOD
    );
    clearSessionCache();
    await clearSessionCookie(admin.id, db());
    await audit(
      null,
      "ADMIN_PASSWORD_RESET",
      "user",
      admin.id,
      { method: "admin_email_code" },
      { critical: false, ip: clientIp(req), outcome: "success" }
    );

    return ok({
      ok: true,
      login_throttle_cleared: loginThrottleCleared,
      message: loginThrottleCleared
        ? "Password updated. Sign in now with your new password."
        : "Password updated, but we couldn't clear the sign-in lockout. Wait for the lockout to expire before signing in with your new password.",
    });
  }

  return fail("Unknown password recovery action", 400);
});
