import { handler, ok, fail } from "@/lib/api";
import {
  getSession,
  getSessionToken,
  needsRefresh,
  signSession,
  setSessionCookie,
} from "@/lib/auth";
import { getSessionMinutes } from "@/lib/settings";

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
  const token = getSessionToken();
  if (token && (await needsRefresh(token, minutes))) {
    setSessionCookie(await signSession(session, minutes), minutes);
  }

  return ok({ user: session, sessionMinutes: minutes });
});
