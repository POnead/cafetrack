import { redirect } from "next/navigation";
import { getSession, getSessionToken, readSessionToken } from "@/lib/auth";
import { getFaceLoginSettings, getRoleIdleMinutes } from "@/lib/settings";
import { AppShell } from "@/components/AppShell";
import { getFaceStatus } from "@/lib/face-gate";
import { db } from "@/lib/supabase";

/**
 * The signed-in frame, resolved on the server.
 *
 * This used to be a client component that fetched /api/auth/me and rendered a
 * full-screen "Loading..." until the answer arrived, which meant every visit
 * paid: download ~185KB of JS, parse and hydrate the tree, make the request,
 * and only then start the page's own fetches. The two were serial, and the
 * static HTML that shipped for all 43 routes was a shell whose entire visible
 * content was the word "Loading...".
 *
 * Reading the session here instead collapses that. The cookie is already in the
 * request, so the check costs nothing on the wire, and it becomes part of the
 * same render that produces the page — no separate request, no waterfall.
 *
 * Two consequences worth knowing:
 *
 *   - Every route under (app) is now dynamic rather than prerendered. That is
 *     correct. Their output was never reusable — it depended on who was signed
 *     in, and no user was in it.
 *   - The session is re-read on every navigation, which is what the old
 *     `pathname` dependency was emulating. It now happens on the server, where
 *     it is a cookie lookup, instead of as a round trip the layout blocked on.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    const token = await getSessionToken();
    const tokenUser = token ? await readSessionToken(token) : null;
    if (token && tokenUser?.role === "staff") {
      const { data: row, error } = await db()
        .from("users")
        .select("session_token, role, face_enabled, last_face_verified_at")
        .eq("id", tokenUser.id)
        .maybeSingle();

      if (error) {
        console.error("face-reset redirect check failed:", error.message);
        throw new Error("Could not check the staff face-check status.");
      }

      if (row?.session_token === null && row.role === "staff" && row.face_enabled === true) {
        const facePolicy = await getFaceLoginSettings();
        if (facePolicy.enabled && !row.last_face_verified_at) {
          redirect("/login?face_check_reset=1");
        }
      }
    }
    redirect("/login");
  }

  if (session.role === "staff") {
    const face = await getFaceStatus(session.id, session.role);
    if (face.required) {
      if (face.verifiedAt === null) {
        redirect("/login?face_check_reset=1");
      }
      redirect("/verify");
    }
  }

  const idleMinutes = await getRoleIdleMinutes(session.role);

  return (
    <AppShell user={session} idleLimitMs={idleMinutes * 60 * 1000}>
      {children}
    </AppShell>
  );
}