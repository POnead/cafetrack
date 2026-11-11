import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DbFacade } from "./supabase";
import { resolveAuthSecret } from "./secret";
import type { SessionRole } from "./session-policy";

/*
 * The signing key, resolved on first use rather than at import time.
 *
 * It used to be a module-level `const`, which meant `next build` failed while
 * collecting route data on any machine that had not been given the runtime
 * secret — a build artifact should not need a production secret to compile, and
 * the error it produced ("Failed to collect page data for /api/analytics") did
 * not name the variable. Resolving lazily keeps the fail-fast behaviour where it
 * belongs: in production, the first sign-in attempt refuses to mint a session
 * with an unset or placeholder key.
 */
let secretBytes: Uint8Array | null = null;

function secret(): Uint8Array {
  if (!secretBytes) {
    secretBytes = new TextEncoder().encode(resolveAuthSecret());
  }
  return secretBytes;
}

export const COOKIE_NAME = "cafetrack_session";

/**
 * Fallback session lifetime. The live value is role-specific and read by the
 * route handlers, which then pass it in here — auth.ts deliberately does not
 * import settings statically because settings -> supabase -> local-db -> auth
 * would be an import cycle.
 */
export const SESSION_MINUTES = 15;

export type Role = SessionRole;

export async function sessionIdleLimitMs(role: Role): Promise<number> {
  const { getRoleIdleMinutes } = await import("./settings");
  return (await getRoleIdleMinutes(role)) * 60_000;
}

export type SessionUser = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  baseRole?: Role;
};

/* ---------------- password hashing (scrypt, no deps) ---------------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(password, salt, 64);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ---------------- JWT session ---------------- */

export async function signSession(
  user: SessionUser,
  minutes: number = SESSION_MINUTES
): Promise<string> {
  const baseRole = user.baseRole ?? user.role;
  return await new SignJWT({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: baseRole,
    baseRole,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${minutes}m`)
    .sign(secret());
}

export async function readSessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      id: String(payload.id),
      username: String(payload.username),
      fullName: String(payload.fullName),
      role: payload.role as Role,
      baseRole: (payload.baseRole as Role | undefined) ?? (payload.role as Role),
    };
  } catch {
    return null;
  }
}

export async function hasActiveSession(
  token: string | null | undefined,
  lastActiveAt: string | Date | null | undefined
): Promise<boolean> {
  if (!token || !lastActiveAt) return false;
  const user = await readSessionToken(token);
  if (!user) return false;

  const lastActive = timestampMilliseconds(lastActiveAt);
  const idleFor = Date.now() - lastActive;
  return (
    Number.isFinite(lastActive) &&
    idleFor >= 0 &&
    idleFor < (await sessionIdleLimitMs(user.role))
  );
}

function timestampMilliseconds(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

// Next 15 made `cookies()` async. Every caller of this (getSession, and the
// helpers above) is already async, so awaiting here propagates cleanly rather
// than needing a sync accessor that can no longer exist.
export async function getSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_NAME)?.value ?? null;
}

/*
 * Short-lived memo for the revocation check below.
 *
 * `getSession()` runs on every navigation and every API call, and the only
 * reason it touches the database is to answer "has this token been superseded
 * or the account switched off?". A cafe re-reads the same row a dozen times a
 * minute per tab, so the answer is cached for a few seconds. Five seconds is
 * deliberately short: it is long enough to collapse a burst of requests, and
 * short enough that a logout or deactivation is felt almost immediately. The
 * cache is per process, which is fine because it only ever caches a *stricter*
 * answer (invalid), never an authorisation decision.
 */
const SESSION_CHECK_TTL_MS = 5_000;
const SESSION_CACHE_MAX = 5_000;
const sessionChecks = new Map<
  string,
  { at: number; ok: boolean; role: Role; fullName: string }
>();

function sessionCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Drop memoised revocation answers — call after any login, logout or rotation. */
export function clearSessionCache(): void {
  sessionChecks.clear();
}

function rememberSessionCheck(
  key: string,
  ok: boolean,
  role: Role,
  fullName: string
): void {
  if (sessionChecks.size >= SESSION_CACHE_MAX) sessionChecks.clear();
  sessionChecks.set(key, { at: Date.now(), ok, role, fullName });
}

export async function getSession(): Promise<SessionUser | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const user = await readSessionToken(token);
  if (!user) return null;

  /*
   * FR-16: a token is only live while it is still the token recorded on the
   * account. Signing in elsewhere overwrites `session_token`; signing out clears
   * it. Both must invalidate the old JWT even though its signature is still
   * valid — a signed cookie is not a revocation list.
   *
   * This previously only rejected a token when the column held a *different*
   * non-null value, so a cleared column (logout) left every already-issued copy
   * usable until expiry. It now requires equality: no recorded token, no session.
   */
  const key = sessionCacheKey(token);
  const cached = sessionChecks.get(key);
  if (cached && Date.now() - cached.at < SESSION_CHECK_TTL_MS) {
    return cached.ok
      ? { ...user, role: cached.role, fullName: cached.fullName }
      : null;
  }

  try {
    const { db } = await import("@/lib/supabase");
    const { data: row, error } = await db()
      .from("users")
      .select("session_token, is_active, session_last_active_at, role, position, full_name")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      // Infrastructure failure, not an authentication decision. Log it so the
      // failure is visible, then fall back to JWT expiry for transient outages.
      // A missing idle-tracking column is different: enforcement is impossible
      // until the migration is applied, so refuse the session instead.
      console.error("session revocation check failed:", error.message);
      if (error.message.includes("session_last_active_at")) return null;
      return user;
    }

    let effectiveRole: Role = row?.role === "admin" ? "admin" : "staff";
    if (row?.role === "staff" && row.position) {
      try {
        const { getPositionAccess } = await import("./staff-positions");
        if (await getPositionAccess(String(row.position)) === "admin") {
          effectiveRole = "admin";
        }
      } catch (error) {
        console.error(
          "staff position access could not be resolved:",
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const lastActive = timestampMilliseconds(row?.session_last_active_at);
    const idleFor = Date.now() - lastActive;
    const ok =
      Boolean(row) &&
      row.is_active !== false &&
      row.session_token === token &&
      Number.isFinite(lastActive) &&
      idleFor >= 0 &&
      idleFor < (await sessionIdleLimitMs(effectiveRole));

    const fullName =
      typeof row?.full_name === "string" && row.full_name.trim()
        ? row.full_name
        : "Admin";
    rememberSessionCheck(key, ok, effectiveRole, fullName);
    return ok
      ? {
          ...user,
          role: effectiveRole,
          fullName,
          baseRole: row?.role === "admin" ? "admin" : "staff",
        }
      : null;
  } catch (e) {
    console.error(
      "session revocation check threw:",
      e instanceof Error ? e.message : String(e)
    );
    return user;
  }
}

/** Seconds of life left on a token; 0 when it is invalid or already expired. */
export async function sessionSecondsLeft(token: string): Promise<number> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.exp) return 0;
    return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
  } catch {
    return 0;
  }
}

/**
 * True once a session is past half its life. Re-issuing the cookie only from
 * that point on keeps the sliding session working without rewriting the
 * cookie on every activity ping.
 *
 * `minutes` must match the lifetime the token was signed with — the routes read
 * it from settings and hand it in.
 */
export async function needsRefresh(
  token: string,
  minutes: number = SESSION_MINUTES
): Promise<boolean> {
  return (await sessionSecondsLeft(token)) < (minutes * 60) / 2;
}

export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) throw new HttpError(401, "Not signed in");
  return s;
}

export async function requireAdmin(): Promise<SessionUser> {
  const s = await requireUser();
  if (s.role !== "admin") throw new HttpError(403, "Admin access required");
  return s;
}

/* ---------------- helpers ---------------- */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Next 15 made `cookies()` async, so both writers are async too. Every caller
// is a route handler that already awaits, so this adds no real cost — the
// cookie write has to happen before the response is returned either way.
export async function setSessionCookie(
  token: string,
  minutes: number = SESSION_MINUTES,
  userId?: string,
  dbClient?: DbFacade
) {
  const jar = await cookies();
  jar.set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" || process.env.CAFETRACK_DEV_HTTPS === "1",
    path: "/",
    maxAge: minutes * 60,
  });
  // Track the active session token on the user record so we can detect
  // when the same account is logged in elsewhere (FR-16) — and so a sliding
  // refresh does not invalidate itself, because the new token becomes the
  // recorded one. The memoised revocation answer must go with it.
  clearSessionCache();
  if (userId && dbClient) {
    try {
      await dbClient
        .from("users")
        .update({
          session_token: token,
          session_last_active_at: new Date().toISOString(),
        })
        .eq("id", userId);
    } catch (e) {
      console.error("Failed to set session_token:", e instanceof Error ? e.message : String(e));
    }
  }
}

export async function clearSessionCookie(userId?: string, dbClient?: DbFacade) {
  const jar = await cookies();
  jar.set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" || process.env.CAFETRACK_DEV_HTTPS === "1",
    path: "/",
    maxAge: 0,
  });
  clearSessionCache();
  // Clear the active session token on the user record (FR-16). Doing this is
  // what makes logout revoke the token rather than merely forget the cookie.
  if (userId && dbClient) {
    try {
      await dbClient
        .from("users")
        .update({ session_token: null, session_last_active_at: null })
        .eq("id", userId);
    } catch (e) {
      console.error("Failed to clear session_token:", e instanceof Error ? e.message : String(e));
    }
  }
}

export function newStaffToken(): string {
  // 128 bits of entropy. The old "CT-STF-" + five bytes (40 bits) was
  // enumerable offline: a badge token is a credential, and 2^40 is small
  // enough for a determined scanner. 32 hex characters stay QR-friendly.
  return "CT-STF-" + randomBytes(16).toString("hex").toUpperCase();
}

/**
 * Message shown when a deactivated account signs in with correct credentials.
 * The reason is recorded by an admin when the account is switched off.
 *
 * Shared by both sign-in routes so a reactivated-then-disabled account reads
 * the same either way. It is only ever returned *after* the password checks
 * out, so it cannot be used to discover which usernames exist.
 */
export function deactivatedMessage(reason: string | null | undefined): string {
  const why = (reason ?? "").trim();
  return why
    ? `This account was deactivated. Reason: ${why}`
    : "This account was deactivated. Ask an administrator to re-activate it.";
}
