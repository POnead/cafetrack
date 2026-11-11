import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import {
  clearSessionCookie,
  verifyPassword,
  signSession,
  setSessionCookie,
  hasActiveSession,
  deactivatedMessage,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { dispatchSoon } from "@/lib/email";
import {
  getFaceLoginSettings,
  getSessionMinutes,
} from "@/lib/settings";
import { verificationRequired } from "@/lib/face";
import { newStep2Nonce, signStep2Ticket } from "@/lib/auth/step2-ticket";
import { getIdGate } from "@/lib/id-gate";
import {
  checkLoginThrottle,
  tooManyAttempts,
  tokenKey,
  userKey,
  recordLoginAttempt,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

const STAFF_LOGIN_METHOD = "staff_password";

/**
 * Record a rejected sign-in and, if anyone is listening by email, tell them.
 *
 * Wrapped in a helper because this file has three rejection paths (unknown
 * code, wrong password, deactivated account) and the notification should read
 * the same for all of them. Never allowed to change the response: a person who
 * typed the wrong code must get the same 401 whether or not mail is configured.
 *
 * `presented` is the credential the caller typed or scanned. It is reduced to a
 * short, non-reversible reference before it reaches the audit log: the log is
 * append-only and admin-readable, so a mistyped barcode must not be recoverable
 * from it as a cleartext staff code. The throttle already hashes the same value.
 */
async function recordRejection(
  req: Request,
  actor: Parameters<typeof audit>[0],
  reason: string,
  presented: string | null
) {
  await audit(
    actor,
    "LOGIN_FAILED",
    "user",
    actor?.id ?? null,
    {
      method: "staff",
      reason,
      ...(presented ? { credential_ref: tokenKey(presented) } : {}),
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

/**
 * Columns sign-in needs. `select("*")` also pulled `face_embedding`,
 * `face_image` and both ID document images — megabytes of biometrics and
 * base64 per password check. `has_id_doc` is computed in the query so the ID
 * gate can answer without transferring the document itself.
 */
const LOGIN_COLUMNS =
  "id, username, password_hash, full_name, role, qr_token, is_active, " +
  "deactivation_reason, deactivated_at, session_token, session_last_active_at, verification_status, " +
  "face_enabled, last_face_verified_at, id_doc_front is not null as has_id_doc";

/**
 * What `LOGIN_COLUMNS` returns. Spelled out so `getIdGate` and the session
 * minting get a checked shape instead of `Record<string, any>` — the computed
 * `has_id_doc` in particular is easy to forget when the select changes.
 */
type LoginUser = {
  id: string;
  username: string;
  password_hash: string;
  full_name: string;
  role: string;
  qr_token: string | null;
  is_active: boolean;
  deactivation_reason: string | null;
  deactivated_at: string | null;
  session_token: string | null;
  session_last_active_at: string | null;
  verification_status: string | null;
  face_enabled: boolean | null;
  last_face_verified_at: string | null;
  has_id_doc: boolean;
};

export const POST = handler(async (req: Request) => {
  const body = await readBody(req);
  const { username, token, password } = body;

  // Accept either a scanned barcode token OR a typed username — never both.
  const input = String(username ?? token ?? "").trim();
  // Passwords are not trimmed. Whitespace is a legal character in a password,
  // and silently trimming it made a correct password fail for anyone who chose
  // a leading or trailing space.
  const pwd = String(password ?? "");

  if (!input || !pwd) {
    return fail("Username or barcode and password are required");
  }

  const rejectUnknownCredential = async () => {
    await recordRejection(req, null, "unknown_credential", input);
    return fail("Unrecognized username or barcode", 401);
  };

  // The identifier is compared as a value, never interpolated into a PostgREST
  // filter grammar. It used to be spliced into `.or(qr_token.eq.${input},...)`,
  // where a comma or dot in the input becomes query syntax and can match a
  // different account than the one presented. Two exact lookups are also easier
  // to reason about: a barcode either matches a barcode or it does not.
  if (input.length > 64) {
    return rejectUnknownCredential();
  }

  let user: LoginUser | null = null;
  let lookupError: { message: string } | null = null;

  const byToken = await db()
    .from("users")
    .select(LOGIN_COLUMNS)
    .eq("role", "staff")
    .eq("qr_token", input)
    .maybeSingle();

  if (byToken.error) {
    lookupError = byToken.error;
  } else if (byToken.data) {
    user = byToken.data;
  } else {
    const byName = await db()
      .from("users")
      .select(LOGIN_COLUMNS)
      .eq("role", "staff")
      .eq("username", input)
      .maybeSingle();
    if (byName.error) lookupError = byName.error;
    else user = byName.data;
  }

  // Log the database's own message; never return it. It can contain the host,
  // the project ref or a file path, and this is an unauthenticated route.
  if (lookupError) {
    console.error("staff login lookup failed:", lookupError.message);
    return fail("Cannot reach the database. Check the server configuration.", 503);
  }

  if (!user) {
    return rejectUnknownCredential();
  }

  const key = userKey(user.username);
  const method = STAFF_LOGIN_METHOD;
  const throttle = await checkLoginThrottle(key, method, {
    includeMethodLimit: false,
  });
  if (throttle.blocked) return tooManyAttempts(throttle.retryAfterSeconds);

  const logAttempt = async (success: boolean) => {
    await recordLoginAttempt(key, method, success);
  };

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

  const { enabled: faceLoginEnabled, dutyHours } = await getFaceLoginSettings();
  const faceCheckDue =
    faceLoginEnabled &&
    (!user.face_enabled ||
      verificationRequired({
        enabled: true,
        role: user.role,
        faceEnabled: true,
        lastVerifiedAt: user.last_face_verified_at,
        hours: dutyHours,
      }));

  if (faceCheckDue) {
    // The browser may still carry a session from an earlier sign-in (or even a
    // different account). Do not leave it usable while this login is held at
    // the required face check.
    await clearSessionCookie(user.id, db());
    await logAttempt(true);
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
      return fail("Cannot reach the database. Try again in a moment.", 503);
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
  }

  // A current face verification covers password sign-ins until the configured
  // duty window expires; otherwise password sign-in finishes normally.
  await logAttempt(true);

  const session = {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: "staff" as const,
  };
  const minutes = await getSessionMinutes("staff");
  const sessionToken = await signSession(session, minutes);
  await setSessionCookie(sessionToken, minutes, user.id, db());

  await audit(session, "LOGIN", "user", user.id, { method }, {
    ip: clientIp(req),
    outcome: "success",
  });

  return ok({
    user: session,
    session_conflict: await hasActiveSession(
      user.session_token,
      user.session_last_active_at
    ),
  });
});
