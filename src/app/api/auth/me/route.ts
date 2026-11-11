import { handler, ok, fail } from "@/lib/api";
import {
  getSession,
  getSessionToken,
  hasActiveSession,
  needsRefresh,
  readSessionToken,
  signSession,
  setSessionCookie,
} from "@/lib/auth";
import { db } from "@/lib/supabase";
import { getFaceLoginSettings, getSessionMinutes } from "@/lib/settings";
import { getFaceStatus } from "@/lib/face-gate";

export const runtime = "nodejs";

export const GET = handler(async (req: Request) => {
  const session = await getSession();
  const search = new URL(req.url).searchParams;
  const sessionCheck = search.get("session_check") === "1";
  const loginCheck = sessionCheck && search.get("login_check") === "1";
  const userActivity = search.get("activity") === "1";
  if (!session) {
    if (sessionCheck) {
      const token = await getSessionToken();
      const tokenUser = token ? await readSessionToken(token) : null;
      if (token && tokenUser) {
        const { data: row, error } = await db()
          .from("users")
          .select(
            "session_token, is_active, session_last_active_at, role, face_enabled, last_face_verified_at"
          )
          .eq("id", tokenUser.id)
          .maybeSingle();

        if (error) {
          console.error("session conflict check failed:", error.message);
          return fail("Could not verify the current session", 503);
        }

        const sessionConflict =
          Boolean(row && row.is_active !== false && row.session_token !== token) &&
          await hasActiveSession(row?.session_token, row?.session_last_active_at);
        const facePolicy = row?.role === "staff" ? await getFaceLoginSettings() : null;
        const faceCheckReset = Boolean(
          !sessionConflict &&
            row?.role === "staff" &&
            row.session_token === null &&
            row.face_enabled === true &&
            !row.last_face_verified_at &&
            facePolicy?.enabled
        );
        const sessionState = {
          authenticated: false,
          session_conflict: sessionConflict,
          face_check_reset: faceCheckReset,
        };
        return loginCheck
          ? ok(sessionState)
          : fail("Not signed in", 401, sessionState);
      }
    }

    if (loginCheck) return ok({ authenticated: false });
    return fail("Not signed in", 401);
  }

  // The periodic browser check only needs to know whether this token is still
  // current. It must not extend an otherwise idle session.
  if (sessionCheck) return ok({ authenticated: true, user: session });

  const minutes = await getSessionMinutes(session.role);
  const token = await getSessionToken();

  if (userActivity && token) {
    const { data, error } = await db()
      .from("users")
      .update({ session_last_active_at: new Date().toISOString() })
      .eq("id", session.id)
      .eq("session_token", token)
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("session activity update failed:", error.message);
      return fail("Could not update session activity", 503);
    }
    if (!data) return fail("Not signed in", 401);
  }

  // Only visible user activity updates the persisted idle timestamp.
  // Session checks and background polls never count as activity.
  if (token && (await needsRefresh(token, minutes))) {
    await setSessionCookie(
      await signSession(session, minutes),
      minutes,
      session.id,
      db()
    );
  }

  /*
   * Whether this person still owes a face check, read fresh from the database.
   *
   * This is already polled on every route change and every activity ping, which
   * is why it belongs here rather than behind its own request: by the time a
   * nine-hour duty window runs out mid-shift, the next ping is what discovers it,
   * and a screen that had to ask separately would either be a stale guess or a
   * second poll for a number the browser is already fetching.
   *
   * See lib/face-gate.ts for why this is a database read rather than a field on
   * the session. Admins always get required: false without the query mattering —
   * it short-circuits inside verificationRequired.
   */
  const face = await getFaceStatus(session.id, session.role);

  return ok({ user: session, sessionMinutes: minutes, face });
});
