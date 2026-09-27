import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "./supabase";

/**
 * Brute-force throttling for the sign-in routes, built on the login_attempts
 * table they have always written and never read.
 *
 * The counters are *consecutive* failures: the walk stops at the most recent
 * success, so signing in successfully clears your own counter. A running total
 * would let a café's shared till lock a real person out permanently, and would
 * also make the test suite lock itself out on re-runs.
 *
 * Two limits, because either one alone is beatable:
 *   - per credential, so one account cannot be hammered;
 *   - per method, so cycling through many codes is throttled as well.
 *
 * Call this before verifying any password, and do not record blocked attempts:
 * logging them would push the window forward and each lockout would last
 * forever.
 */

/** Consecutive failures for one credential before it is locked out. */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Consecutive failures across a whole method, whichever credential they used. */
export const MAX_FAILURES_PER_METHOD = 20;

/** How far back a failure still counts. */
export const WINDOW_MINUTES = 15;

/** Recent rows to read — comfortably more than either limit. */
const SCAN_ROWS = 40;

const WINDOW_MS = WINDOW_MINUTES * 60_000;

export type Throttle = { blocked: boolean; retryAfterSeconds: number };

const ALLOWED: Throttle = { blocked: false, retryAfterSeconds: 0 };

/** Stable, non-secret key for a presented staff barcode. */
export function tokenKey(token: string): string {
  const digest = createHash("sha256").update(token).digest("hex");
  return `staff:${digest.slice(0, 12)}`;
}

/** Stable key for a known account. */
export function userKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

export async function checkLoginThrottle(
  key: string,
  method: string
): Promise<Throttle> {
  const { data, error } = await db()
    .from("login_attempts")
    .select("username, success, created_at")
    .eq("method", method)
    .order("created_at", { ascending: false })
    .limit(SCAN_ROWS);

  // Never lock anyone out because the check itself failed.
  if (error || !Array.isArray(data)) return ALLOWED;

  const now = Date.now();
  const rows = (
    data as { username: string | null; success: boolean; created_at: string }[]
  )
    .map((r) => ({
      username: r.username,
      success: r.success,
      at: new Date(r.created_at).getTime(),
    }))
    .filter((r) => Number.isFinite(r.at) && now - r.at < WINDOW_MS);

  // Newest first. For this key, count back to its own last success.
  const keyStamps: number[] = [];
  for (const row of rows) {
    if (row.username !== key) continue;
    if (row.success) break;
    keyStamps.push(row.at);
  }

  // For the method, count back to any success at all.
  const methodStamps: number[] = [];
  for (const row of rows) {
    if (row.success) break;
    methodStamps.push(row.at);
  }

  const useKey = keyStamps.length >= MAX_CONSECUTIVE_FAILURES;
  const useMethod = !useKey && methodStamps.length >= MAX_FAILURES_PER_METHOD;
  if (!useKey && !useMethod) return ALLOWED;

  const stamps = useKey ? keyStamps : methodStamps;
  const oldestCounted = stamps[stamps.length - 1] ?? now;

  // The lockout lifts once the oldest counted failure leaves the window.
  return {
    blocked: true,
    retryAfterSeconds: Math.max(60, Math.ceil((oldestCounted + WINDOW_MS - now) / 1000)),
  };
}

/** 429 with the standard Retry-After header. */
export function tooManyAttempts(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    {
      error: `Too many sign-in attempts. Try again in ${minutes} minute(s).`,
      retry_after_seconds: retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}
