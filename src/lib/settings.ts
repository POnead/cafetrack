/**
 * Read-only access to the `settings` key/value table.
 *
 * Values are cached in-process for a minute: every request that signs or
 * refreshes a session touches `session_timeout_minutes`, and hitting the DB
 * for it on each call would be wasteful.
 *
 * Deliberately independent of lib/auth.ts — auth.ts is imported by local-db.ts,
 * which is imported by supabase.ts, so importing this module from auth.ts
 * would close an import cycle. Routes read the value here and pass it in.
 */
import { db } from "./supabase";
import {
  DEFAULT_DUTY_HOURS,
  DEFAULT_FACE_ENGINE,
  DEFAULT_MATCH_THRESHOLD,
  MAX_DUTY_HOURS,
  MAX_MATCH_THRESHOLD,
  MIN_DUTY_HOURS,
  MIN_MATCH_THRESHOLD,
  type FaceEngine,
  parseEngine,
} from "./face";
import {
  DEFAULT_ID_MATCH_THRESHOLD,
  MAX_ID_MATCH_THRESHOLD,
  MIN_ID_MATCH_THRESHOLD,
} from "./id-verification/local";

const CACHE_TTL_MS = 60_000;

/** Matches the seeded schema defaults, used whenever the setting is unreadable. */
export const DEFAULT_SESSION_MINUTES = 15;
export const DEFAULT_EXPIRY_WARNING_DAYS = 7;

let cache: { at: number; values: Record<string, string> } | null = null;

async function readAll(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;

  try {
    const { data } = await db().from("settings").select("key, value");

    const values: Record<string, string> = {};
    for (const row of (data ?? []) as { key: string; value: string }[]) {
      values[row.key] = row.value;
    }

    cache = { at: Date.now(), values };
    return values;
  } catch {
    // A settings read must never be the reason sign-in fails — fall back to
    // defaults (or the last good read) and let the request carry on.
    return cache?.values ?? {};
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const values = await readAll();
  return values[key] ?? null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Session lifetime in minutes (settings.session_timeout_minutes). */
export async function getSessionMinutes(): Promise<number> {
  return clampInt(await getSetting("session_timeout_minutes"), DEFAULT_SESSION_MINUTES, 1, 480);
}

/** Days before expiry that an item starts warning (settings.expiry_warning_days). */
export async function getExpiryWarningDays(): Promise<number> {
  return clampInt(await getSetting("expiry_warning_days"), DEFAULT_EXPIRY_WARNING_DAYS, 1, 365);
}

/** Drop the cache — used by tests after writing a setting. */
export function clearSettingsCache() {
  cache = null;
}

/*
 * Duty face verification. See lib/face.ts for the matching side and for why the
 * window rolls rather than following a fixed shift grid.
 */

function clampFloat(raw: string | null, fallback: number, min: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  // Not rounded. `clampInt` above rounds because it is used for counts of days
  // and minutes; a threshold of 0.60 rounded is 1, which is a different value and
  // outside the range it lives in, so it cannot share that path.
  return Math.min(Math.max(n, min), max);
}

/**
 * An on/off switch.
 *
 * The table holds the strings "0" and "1" (see TOGGLES in api/settings/route.ts,
 * which refuses anything else on the way in). `true`, `yes` and `on` are also
 * accepted so a row edited by hand in the SQL editor does not read as "off" by
 * accident. Anything unrecognised is off: a check that cannot start is a smaller
 * problem than one that starts by itself.
 */
async function readToggle(key: string): Promise<boolean> {
  const raw = (await getSetting(key))?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Is duty verification switched on (settings.face_verification_enabled)?
 *
 * The master switch. While this is off nothing face-related loads, no camera is
 * asked for, and every staff member walks straight in.
 */
export async function getFaceVerificationEnabled(): Promise<boolean> {
  return readToggle("face_verification_enabled");
}

/**
 * May staff sign in with their face instead of a password
 * (settings.face_login_enabled)?
 *
 * Deliberately a *different* switch from duty verification, and the two must not
 * be folded together. They answer unrelated questions — "prove it is you at the
 * start of this shift" and "let this person in without typing a password" — and a
 * cafe may reasonably want the first, the second, both or neither. Folding them
 * together would mean that trialling face sign-in silently also switches every
 * member of staff over to duty checks, which is a far larger change than anyone
 * asking for face login has agreed to.
 *
 * Off by default. A sign-in method is the front door of the app, and nothing
 * about this one should be switched on without an admin deciding it.
 */
export async function getFaceLoginEnabled(): Promise<boolean> {
  return readToggle("face_login_enabled");
}

/**
 * How long one check covers (settings.face_duty_hours). Default 9 — roughly a
 * cafe duty, so nobody is asked twice in a shift.
 */
export async function getFaceDutyHours(): Promise<number> {
  return clampFloat(
    await getSetting("face_duty_hours"),
    DEFAULT_DUTY_HOURS,
    MIN_DUTY_HOURS,
    MAX_DUTY_HOURS
  );
}

/**
 * How close two embeddings must be to count as the same person
 * (settings.face_match_threshold). Lower is stricter.
 */
export async function getFaceMatchThreshold(): Promise<number> {
  return clampFloat(
    await getSetting("face_match_threshold"),
    DEFAULT_MATCH_THRESHOLD,
    MIN_MATCH_THRESHOLD,
    MAX_MATCH_THRESHOLD
  );
}

/**
 * Must a check present the turned-head angles too
 * (settings.face_require_profile_angles)?
 *
 * Only applies to an account that actually holds side samples — see
 * posesRequired in lib/face.ts. An account enrolled with a frontal photo alone is
 * checked on that photo whether this is on or off, because asking it to present
 * an angle it does not have would lock the person out of their own shift.
 *
 * On by default. It is the whole point of capturing the side angles: a still
 * photograph cannot produce a turned-head descriptor, so the turned frames are
 * the one part of this that resists a printed portrait held up at the till. This
 * is the switch to turn off if real staff are refused at the side angles — the
 * side descriptors are the least reliable thing the model produces.
 */
export async function getFaceRequireProfileAngles(): Promise<boolean> {
  return readToggle("face_require_profile_angles");
}

/**
 * Which face engine this cafe is using (settings.face_engine).
 *
 * 'legacy' or 'sface'. An unrecognised value reads as 'legacy' rather than
 * throwing: a typo in a settings row must not take sign-in down, and legacy is
 * the engine whose vectors every existing enrolment holds.
 *
 * See FaceEngine in lib/face.ts for why the two cannot be mixed.
 */
export async function getFaceEngine(): Promise<FaceEngine> {
  return parseEngine(await getSetting("face_engine")) ?? DEFAULT_FACE_ENGINE;
}

/**
 * The https address a staff phone can reach, or null when there isn't one
 * (settings.face_verify_public_url).
 *
 * Null is the normal case, and it is what the phone fallback checks before
 * offering a QR at all. The app runs on the register at `http://localhost:3100`,
 * which no phone can open, so a code in a QR has to point at a separate public
 * address reached through a tunnel.
 *
 * The https requirement is repeated here even though the settings route refuses
 * to store anything else. A QR is the one place where a wrong origin fails
 * silently — the page opens and the browser has quietly refused to provide a
 * camera, so the user sees a dead screen and no error. Failing closed here means
 * the UI says the fallback is not set up rather than sending them there.
 */
export async function getFaceVerifyPublicUrl(): Promise<string | null> {
  const raw = (await getSetting("face_verify_public_url"))?.trim();
  if (!raw) return null;
  if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(raw)) return null;
  return raw.replace(/\/+$/, "");
}

/*
 * ID verification. See lib/id-verification/ for what these actually drive.
 */

/**
 * Must a staff account have a verified ID before it can sign in
 * (settings.id_verification_required)?
 *
 * Off by default, for the same reason the other switches are: an account can be
 * verified whatever this says, but nothing is *required* until an admin turns it
 * on. Turning it on with staff already hired would lock every one of them out
 * until their documents were checked, which is a legitimate choice for a cafe
 * that wants the record complete and a bad surprise for one that does not.
 *
 * Seeded accounts are grandfathered to 'verified' in the schema, so a fresh
 * install is never locked out regardless of this switch.
 */
export async function getIdVerificationRequired(): Promise<boolean> {
  return readToggle("id_verification_required");
}

/**
 * Which engine reads the ID (settings.id_provider). Empty means "whatever is
 * configured" — the local checks plus any vendor whose credentials are present.
 *
 * A name that is not available is *not* an error. The orchestrator falls back to
 * the automatic choice, because a feature that stops working when a vendor key
 * expires is worse than one that quietly gets less thorough.
 */
export async function getIdProvider(): Promise<string> {
  return ((await getSetting("id_provider")) ?? "").trim().toLowerCase();
}

/**
 * How close the portrait printed on the card and the photo of the person must
 * be (settings.id_face_match_threshold). Lower is stricter.
 *
 * A separate setting from `face_match_threshold` and set far looser, because it
 * compares two genuinely different things. See DEFAULT_ID_MATCH_THRESHOLD in
 * lib/id-verification/local.ts for why that number is reasoned rather than
 * measured — which is also the reason this one is worth revisiting once there
 * are real cards to test against.
 */
export async function getIdFaceMatchThreshold(): Promise<number> {
  return clampFloat(
    await getSetting("id_face_match_threshold"),
    DEFAULT_ID_MATCH_THRESHOLD,
    MIN_ID_MATCH_THRESHOLD,
    MAX_ID_MATCH_THRESHOLD
  );
}
