/**
 * Whether a signed-in staff member still owes a face check.
 *
 * One function reads the user's face state and answers it, and both the session
 * endpoint and the verify endpoint go through it. That is deliberate: the gate is
 * a decision made in two different places — "should this person be held at the
 * verify screen" and "is this person allowed past it" — and if those two read the
 * row separately they will eventually disagree, which is exactly the shape of bug
 * where a staff member is shown the camera and then told they had already passed.
 *
 * Everything unanswerable resolves to "must verify", in lib/face.ts.
 */
import { db } from "./supabase";
import { HttpError } from "./auth";
import { DUTY_REQUIRED_MESSAGE, verificationRequired, nextVerificationAt } from "./face";
import { getFaceLoginSettings } from "./settings";

export type FaceStatus = {
  /** Does this person have to pass a check before using the app right now? */
  required: boolean;
  /** Whether the feature is switched on at all, for the UI to explain itself. */
  enabled: boolean;
  /** Whether this account has a reference photo enrolled. */
  enrolled: boolean;
  /** Hours one check covers. Shown so nobody wonders why they were let through. */
  dutyHours: number;
  /** When they last passed, or null if never. */
  verifiedAt: string | null;
  /** When they are next due, or null if they are not currently due. */
  nextDueAt: string | null;
  /** Approved face-check bypass, active only through the end of today. */
  bypassedUntil: string | null;
};

async function activeDutyBypass(userId: string): Promise<{
  requestId: string;
  until: string;
} | null> {
  const { data, error } = await db()
    .from("duty_bypass_requests")
    .select("id, approved_until")
    .eq("requested_by", userId)
    .eq("status", "approved")
    .gt("approved_until", new Date().toISOString())
    .order("approved_until", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("approved duty bypass lookup failed:", error.message);
    return null;
  }
  if (!data?.approved_until) return null;
  return {
    requestId: String(data.id),
    until: new Date(data.approved_until).toISOString(),
  };
}

/**
 * The status of a user, read fresh from the database.
 *
 * Never from the session cookie. A token is minted at sign-in and then only
 * slid, so a face verified thirty seconds ago — or enrolled by an admin while
 * someone was mid-shift — would still read as "not verified" from the payload.
 * The session carries who the person is; this answers what they still owe.
 *
 * A missing row is reported as "not required" rather than throwing. The caller
 * has already authenticated, so a row that is not there means it was deleted
 * mid-session, and refusing to answer would turn that into a redirect loop rather
 * than an ordinary signed-out state.
 */
export async function getFaceStatus(
  userId: string,
  role: string
): Promise<FaceStatus> {
  const { enabled, dutyHours } = await getFaceLoginSettings();

  const { data } = await db()
    .from("users")
    .select("face_enabled, last_face_verified_at")
    .eq("id", userId)
    .maybeSingle();

  if (!data) {
    return {
      required: false,
      enabled,
      enrolled: false,
      dutyHours,
      verifiedAt: null,
      nextDueAt: null,
      bypassedUntil: null,
    };
  }

  const bypass = await activeDutyBypass(userId);
  const verifiedAt = data.last_face_verified_at
    ? new Date(data.last_face_verified_at).toISOString()
    : null;

  return {
    required: !bypass && verificationRequired({
      enabled,
      role,
      faceEnabled: data.face_enabled === true,
      lastVerifiedAt: data.last_face_verified_at,
      hours: dutyHours,
    }),
    enabled,
    enrolled: data.face_enabled === true,
    dutyHours,
    verifiedAt,
    nextDueAt:
      bypass?.until ??
      nextVerificationAt(data.last_face_verified_at, dutyHours)?.toISOString() ??
      null,
    bypassedUntil: bypass?.until ?? null,
  };
}

/**
 * Stamp a successful check.
 *
 * Returns the new timestamp so the caller can report it and audit it without
 * reading the row back. The window opens from here, which is why this is the only
 * place that writes the column outside an enrolment.
 */
/**
 * Is this person already inside a duty window?
 *
 * The password route does not inspect face status. After it issues a normal
 * session, /api/auth/me uses this duty-window calculation to route staff to the
 * separate verification screen when needed. The same calculation also serves
 * duty-check compatibility paths and administrative overrides.
 *
 * `open` is false whenever the feature is off or the account has no enrolled
 * face: those accounts are not inside a window, they are simply not subject to
 * this check, and a caller about to mint a session must not treat the two as the
 * same thing. The settings are read here rather than passed in so a caller
 * cannot accidentally compare against an older cached value.
 */
export async function getDutyWindow(args: {
  userId?: string;
  role: string;
  faceEnabled: boolean | null;
  lastVerifiedAt: string | Date | null;
}, policy?: { enabled: boolean; dutyHours: number }): Promise<{
  open: boolean;
  enabled: boolean;
  dutyHours: number;
  /** When the open window closes, or null when it is not open. */
  until: string | null;
  bypassed: boolean;
  bypassRequestId: string | null;
}> {
  const { enabled, dutyHours } = policy ?? (await getFaceLoginSettings());

  const bypass = args.userId ? await activeDutyBypass(args.userId) : null;
  if (bypass) {
    return {
      open: true,
      enabled,
      dutyHours,
      until: bypass.until,
      bypassed: true,
      bypassRequestId: bypass.requestId,
    };
  }

  const open = Boolean(
    enabled &&
      args.faceEnabled === true &&
      !verificationRequired({
        enabled,
        role: args.role,
        faceEnabled: args.faceEnabled,
        lastVerifiedAt: args.lastVerifiedAt,
        hours: dutyHours,
      })
  );

  const last = args.lastVerifiedAt ? new Date(args.lastVerifiedAt) : null;
  const until =
    open && last && Number.isFinite(last.getTime())
      ? new Date(last.getTime() + dutyHours * 3_600_000).toISOString()
      : null;

  return { open, enabled, dutyHours, until, bypassed: false, bypassRequestId: null };
}

export async function recordFaceVerification(userId: string): Promise<string> {
  const at = new Date().toISOString();
  const { data, error } = await db()
    .from("users")
    .update({ last_face_verified_at: at })
    .eq("id", userId)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("Could not save staff face verification:", error.message);
    throw new HttpError(503, "Could not save your face check. Please try again.");
  }
  if (!data) {
    console.error(`Could not save staff face verification: user ${userId} was not found.`);
    throw new HttpError(404, "Your account could not be found. Please sign in again.");
  }

  return at;
}

/**
 * Refuse a staff member who has not passed the duty check yet.
 *
 * Throws an HttpError, or returns quietly. Shaped for the routes in this app,
 * which authenticate with `requireUser()` and then carry on with the returned
 * user.
 *
 * The redirect in the browser is a convenience, not a control. Nothing stops
 * someone calling `/api/transactions` straight from the console, and a feature
 * whose whole purpose is "prove who you are before you start work" cannot be the
 * one that only checks in the UI. So the same rule is enforced here, where a
 * request actually arrives.
 *
 * Only applied to routes that *move stock or change the catalogue*. Reading the
 * dashboard, viewing an alert or exporting a report stays open to a verified
 * session, because a person who cannot see today's figures is worse than the
 * thing being guarded, and none of those routes can move anything.
 */
export async function requireDutyVerified(user: {
  id: string;
  role: string;
}): Promise<void> {
  const status = await getFaceStatus(user.id, user.role);
  if (status.required) {
    // 403 rather than 401: the session is valid, this person just has not
    // looked at the camera yet. The client uses the message to send them to
    // /verify instead of showing a dead end.
    throw new HttpError(403, DUTY_REQUIRED_MESSAGE);
  }
}
