"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { MenuIcon } from "@/components/icons";
import type { SessionUser } from "@/lib/auth";

/**
 * The client half of the signed-in frame.
 *
 * The session is read on the server — see src/app/(app)/layout.tsx — so this
 * component never waits on a request before it can render. It arrives with the
 * person already known, which is what removed the full-screen "Loading..."
 * that used to sit in front of every page.
 *
 * What is left here is the part that genuinely needs the browser: the mobile
 * drawer, and the idle timeout that signs someone out when a till is left
 * unattended.
 */

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function AppShell({
  user,
  idleLimitMs,
  children,
}: {
  user: SessionUser;
  /** settings.session_timeout_minutes, resolved on the server. */
  idleLimitMs: number;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const router = useRouter();

  /*
   * Idle timeout — sign out after the configured window of nothing happening.
   *
   * The dependency list is deliberately [idleLimitMs] and not [user]: the server
   * re-renders this layout on every navigation, which hands down a fresh
   * `user` object each time, and depending on it here tore down and rebuilt
   * five window listeners and a timer on every single page change. The timeout
   * does not read `user` — it only needs to know how long the window is.
   */
  useEffect(() => {
    const PING_EVERY_MS = 60_000;

    let last = Date.now();
    let pingedAt = 0;

    /*
     * The duty check runs out mid-shift, not at sign-in, so something has to
     * notice. /api/auth/me already answers "is a face owed" from the database —
     * the same read the routes enforce with — so this ping is where it gets
     * honoured. Without it the first sign the window had closed was a 403 on a
     * scan, which reads as a broken till rather than as a camera prompt.
     *
     * The pathname guard matters because replace() while already on /verify
     * would re-run that page's own status load on every ping.
     */
    const honourFace = (payload: any) => {
      if (payload?.face?.required && window.location.pathname !== "/verify") {
        router.replace("/verify");
      }
    };

    const bump = () => {
      const now = Date.now();
      last = now;
      if (now - pingedAt < PING_EVERY_MS) return;
      pingedAt = now;
      // Sliding session: the server re-issues the cookie once the token is past
      // half-life. Swallowed here because the next navigation re-reads the
      // session server-side and is the thing that actually redirects.
      fetch("/api/auth/me")
        .then((r) => r.json())
        .then(honourFace)
        .catch(() => {});
    };

    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    // One check on mount, so a page loaded after the window closed sends the
    // person to the camera without waiting for a click. It also counts as
    // activity, which is what loading a page is.
    bump();

    const timer = setInterval(() => {
      if (Date.now() - last > idleLimitMs) {
        fetch("/api/auth/logout", { method: "POST" }).finally(() => {
          router.replace("/login");
        });
      }
    }, 30000);

    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(timer);
    };
  }, [idleLimitMs, router]);

  // A stable identity for the drawer's close handler. Nav re-registers a
  // keydown listener whenever this changes, so handing it a fresh arrow on
  // every render meant re-adding that listener on every render too.
  const closeNav = useCallback(() => setNavOpen(false), []);

  return (
    // h-[100dvh] rather than h-screen: on a phone 100vh is taller than the
    // visible area, so the bottom of the page ends up below the fold and
    // cannot be scrolled to.
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-cream-100 lg:flex-row">
      <Nav user={user} open={navOpen} onClose={closeNav} />

      {/* min-h-0 here is the one that actually matters. This wrapper is a
          flex-1 child of the h-[100dvh] shell, so its default min-height:auto
          lets it grow to fit its content instead of shrinking — which means
          <main> never gets a bounded height and overflow-y-auto has nothing to
          scroll. Measured: without it scrollHeight == clientHeight. min-h-0 on
          <main> alone is not enough; the constraint has to start here. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Mobile-only bar. Above lg the sidebar carries the brand already. */}
        <header className="flex items-center gap-3 border-b border-cream-200 bg-white px-4 py-2.5 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
            className="-ml-1.5 rounded-lg p-2 text-cocoa-600 transition-[background-color,color,transform] duration-150 ease-out hover:bg-cream-100 active:scale-[0.97] active:bg-cream-200"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <div className="script-logo-dark flex-1 truncate text-xl">
            CafeTrack
          </div>
          <div
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-200 text-xs font-bold text-cocoa-700"
          >
            {initials(user.fullName)}
          </div>
        </header>

        {/* min-h-0 is load-bearing. A flex item defaults to min-height:auto, so
            without it <main> refuses to shrink below its content height, grows
            past the viewport instead, and overflow-y-auto has nothing to
            scroll — the page reads as frozen. */}
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}