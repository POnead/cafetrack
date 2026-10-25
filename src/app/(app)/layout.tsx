import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getSessionMinutes } from "@/lib/settings";
import { AppShell } from "@/components/AppShell";

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
  if (!session) redirect("/login");

  // The idle window is admin-configurable, so the browser is told what it is
  // rather than hardcoding 15 minutes on both sides. settings.ts caches this
  // in-process for a minute, so it is not a query per navigation.
  const sessionMinutes = await getSessionMinutes();

  return (
    <AppShell user={session} idleLimitMs={sessionMinutes * 60 * 1000}>
      {children}
    </AppShell>
  );
}