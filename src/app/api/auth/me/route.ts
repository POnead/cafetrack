import { handler, ok, fail } from "@/lib/api";
import {
  getSession,
  getSessionToken,
  needsRefresh,
  signSession,
  setSessionCookie,
} from "@/lib/auth";
import { db } from "@/lib/supabase";
import { getSessionMinutes } from "@/lib/settings";
import { getFaceStatus } from "@/lib/face-gate";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const session = await getSession();
  if (!session) return fail("Not signed in", 401);

  // The idle window is admin-configurable, so the browser is told what it is
  // instead of hardcoding 15 minutes on both sides.
  const minutes = await getSessionMinutes();

  // Sliding session: re-issue the cookie only once the token is past
  // half-life. Re-signing on every call would rewrite the cookie on each
  // dashboard poll and activity ping for no benefit.
  //
  // The new token is deliberately passed with the user id and client: rotating
  // the cookie without updating `users.session_token` made the server's own
  // revocation check reject the fresh token on the very next request (the row
  // still named the old one), so every session died at half its configured
  // lifetime. Writing both together keeps the sliding window working.
  const token = await getSessionToken();
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
