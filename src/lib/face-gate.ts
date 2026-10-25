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
import { verificationRequired, nextVerificationAt } from "./face";
import { getFaceDutyHours, getFaceVerificationEnabled } from "./settings";

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
};

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
  const enabled = await getFaceVerificationEnabled();
  const dutyHours = await getFaceDutyHours();

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
    };
  }

  const verifiedAt = data.last_face_verified_at
    ? new Date(data.last_face_verified_at).toISOString()
    : null;

  return {
    required: verificationRequired({
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
      nextVerificationAt(data.last_face_verified_at, dutyHours)?.toISOString() ?? null,
  };
}

/**
 * Stamp a successful check.
 *
 * Returns the new timestamp so the caller can report it and audit it without
 * reading the row back. The window opens from here, which is why this is the only
 * place that writes the column outside an enrolment.
 */
export async function recordFaceVerification(userId: string): Promise<string> {
  const at = new Date().toISOString();
  await db().from("users").update({ last_face_verified_at: at }).eq("id", userId);
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
    throw new HttpError(
      403,
      "Confirm your face for this duty before you start work."
    );
  }
}
