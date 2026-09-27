import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET || "dev-only-secret-change-me-please-32-chars-min"
);

export const COOKIE_NAME = "cafetrack_session";

/**
 * Fallback session lifetime. The live value lives in `settings` under
 * session_timeout_minutes and is read by the route handlers, which then pass it
 * in here — auth.ts deliberately does not import the settings module because
 * settings -> supabase -> local-db -> auth would be an import cycle.
 */
export const SESSION_MINUTES = 15;

export type Role = "admin" | "staff";

export type SessionUser = {
  id: string;
  username: string;
  fullName: string;
  role: Role;
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
  return await new SignJWT({
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${minutes}m`)
    .sign(SECRET);
}

export async function readSessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return {
      id: String(payload.id),
      username: String(payload.username),
      fullName: String(payload.fullName),
      role: payload.role as Role,
    };
  } catch {
    return null;
  }
}

export function getSessionToken(): string | null {
  return cookies().get(COOKIE_NAME)?.value ?? null;
}

export async function getSession(): Promise<SessionUser | null> {
  const token = getSessionToken();
  if (!token) return null;
  return readSessionToken(token);
}

/** Seconds of life left on a token; 0 when it is invalid or already expired. */
export async function sessionSecondsLeft(token: string): Promise<number> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
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

export function setSessionCookie(token: string, minutes: number = SESSION_MINUTES) {
  cookies().set({
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: minutes * 60,
  });
}

export function clearSessionCookie() {
  cookies().set({
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    path: "/",
    maxAge: 0,
  });
}

export function newStaffToken(): string {
  return "CT-STF-" + randomBytes(5).toString("hex").toUpperCase();
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
