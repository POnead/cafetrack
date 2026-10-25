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

/**
 * 429 with the standard Retry-After header.
 *
 * `subject` names what is being throttled, because this is no longer only used by
 * sign-in and the old wording turned up on a face check as "Too many sign-in
 * attempts", which is both wrong and confusing next to a camera prompt.
 */
export function tooManyAttempts(retryAfterSeconds: number, subject = "sign-in attempts") {
  // Show seconds for short waits, minutes for long ones.
  if (retryAfterSeconds < 60) {
    return NextResponse.json(
      {
        error: `Too many ${subject}. Try again in ${retryAfterSeconds} second(s).`,
        retry_after_seconds: retryAfterSeconds,
      },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    {
      error: `Too many ${subject}. Try again in ${minutes} minute(s).`,
      retry_after_seconds: retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

/** Distinct method name for the duty check, so it has its own counter. */
export const FACE_VERIFY_METHOD = "face_verify";

/** Distinct method name for face sign-in, so it cannot spend the sign-in budget. */
export const FACE_LOGIN_METHOD = "face_login";

/**
 * Sign-in by ID card and face — its own bucket, deliberately.
 *
 * The obvious reason is kindness: someone who fumbles their badge five times
 * should not then be locked out of the other way in. They are the same person
 * trying the same thing, and a shared counter turns one bad minute into a
 * locked-out shift.
 *
 * The second is attacker-facing. Separate limits mean "five tries with a badge"
 * buys nothing against this endpoint, so walking a stolen ID card against a
 * roster costs the full twenty — and, more importantly, the card has to be
 * *recognised* to reach the face check at all, which a guessed number is not.
 */
export const ID_LOGIN_METHOD = "id_login";

/*
 * The second step of two-step sign-in.
 *
 * Its own budget rather than FACE_LOGIN_METHOD's or ID_LOGIN_METHOD's, and
 * deliberately so. Those two count attempts against a *credential* being guessed
 * — a barcode, a card fingerprint — where five failures means someone is grinding
 * one identifier. Here the password is already proven and the ticket is
 * unforgeable, so the thing being counted is a person fumbling a card or a
 * badly-lit photo of their own face. Sharing a bucket would let a legitimate
 * person's fifth wobble lock out the face route too, and a card route that was
 * being attacked would consume the face route's allowance.
 */
export const STEP2_METHOD = "staff_step2";

/*
 * Why face sign-in does NOT get an extra per-address throttle.
 *
 * The obvious worry with a face endpoint is that the identifier is presented
 * rather than guessed — an attacker scans `alice`, fails, scans `bob`, fails,
 * and every credential counter sits at one failure forever.
 *
 * That attack is already covered, by the counter this module already keeps:
 * `MAX_FAILURES_PER_METHOD` counts consecutive failures for a *method* across
 * every credential, so rotating identifiers still reaches the limit. The only
 * requirement is that face sign-in uses its own method name — FACE_LOGIN_METHOD
 * above — which keeps it from being starved by password failures and stops it
 * spending the sign-in budget.
 *
 * The tempting addition here is a second counter keyed on the caller's address.
 * It must not be added, and the reason is specific to how this app is deployed:
 * CafeTrack runs on the cafe's own machine, so every member of staff, every
 * phone on the Wi-Fi and every till arrives from 127.0.0.1 (see clientIp in
 * lib/api.ts). An address-keyed counter would therefore count the whole cafe as
 * one caller — so five unlucky wrong faces at the till would lock out every
 * member of staff on the floor at the same time, and a bored person could do it
 * on purpose.
 *
 * That is the exact failure this module's header describes and was written to
 * avoid ("a cafe's shared till lock a real person out permanently"), reintroduced
 * through the back door. The per-method limit is the right instrument here
 * because it is keyed on behaviour rather than on who is asking.
 */

/**
 * Record a duty-check attempt, so the throttle above can count it.
 *
 * The success row matters as much as the failure row. `checkLoginThrottle` walks
 * back from the newest row and stops at the first success, so a counter that only
 * ever sees failures keeps climbing — a barista who passed the check cleanly would
 * be locked out for failing to fail, and five good verifications in one shift
 * would do exactly that.
 *
 * Written to login_attempts rather than a table of its own: it is the same
 * ephemeral security counter with the same shape, and both database backends
 * already know how to read and write it.
 */
/**
 * Record one attempt against a throttle key, so `checkLoginThrottle` can count
 * it.
 *
 * The success row matters as much as the failure row. `checkLoginThrottle` walks
 * back from the newest row and stops at the first success, so a counter that only
 * ever sees failures keeps climbing — a barista who passed the check cleanly would
 * be locked out for failing to fail, and five good verifications in one shift
 * would do exactly that.
 *
 * `method` must be the string the reader scans with. Mixing the two is the easy
 * mistake here: a success written under one method is invisible to a check that
 * filters on another, so the counter keeps climbing on correct answers.
 *
 * Written to login_attempts rather than a table of its own: it is the same
 * ephemeral security counter with the same shape, and both database backends
 * already know how to read and write it.
 */
export async function recordLoginAttempt(
  key: string,
  method: string,
  success: boolean
): Promise<void> {
  try {
    await db().from("login_attempts").insert({ username: key, method, success });
  } catch {
    // Never let the counter's own failure answer the request. A missing counter
    // row is a weaker guarantee; a 500 here would be a broken sign-in.
  }
}

/**
 * A duty-check attempt, recorded under the face-check method.
 *
 * Thin wrapper, so a caller that is definitely doing a face check does not have
 * to repeat the method string — and cannot get it subtly wrong.
 */
export async function recordFaceAttempt(key: string, success: boolean): Promise<void> {
  await recordLoginAttempt(key, FACE_VERIFY_METHOD, success);
}
