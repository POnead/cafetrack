import { handler, ok } from "@/lib/api";
import { getSession, clearSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const POST = handler(async () => {
  const session = await getSession();
  if (session) {
    await audit(session, "LOGOUT", "user", session.id, {}, { critical: false });
  }
  await clearSessionCookie();
  return ok({ ok: true });
});
