"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";
import { CafeTrackBrand } from "@/components/CafeTrackBrand";
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
  const [sessionExit, setSessionExit] = useState<"conflict" | "expired" | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const isCheckout = pathname === "/checkout";

  useEffect(() => {
    let checking = false;
    let redirecting = false;
    let redirectTimer: number | undefined;

    const checkSession = async () => {
      if (checking || redirecting || document.visibilityState !== "visible") return;
      checking = true;

      try {
        const response = await fetch("/api/auth/me?session_check=1", {
          cache: "no-store",
        });

        if (response.status === 401) {
          const data = await response.json();
          redirecting = true;
          setSessionExit(data.session_conflict ? "conflict" : "expired");
          void fetch("/api/auth/logout", { method: "POST" }).catch((error) => {
            console.error("Could not clear the signed-out session cookie:", error);
          });
          redirectTimer = window.setTimeout(() => router.replace("/login"), 1200);
        } else if (!response.ok) {
          console.error(`Session check failed with status ${response.status}`);
        }
      } catch (error) {
        console.error("Could not check the current session:", error);
      } finally {
        checking = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkSession();
    };
    const onSessionInvalid = () => void checkSession();

    void checkSession();
    const timer = window.setInterval(() => void checkSession(), 15000);
    window.addEventListener("focus", checkSession);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("cafetrack:session-invalid", onSessionInvalid);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", checkSession);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("cafetrack:session-invalid", onSessionInvalid);
      if (redirectTimer !== undefined) window.clearTimeout(redirectTimer);
    };
  }, [router]);

  /*
   * Idle timeout — sign out after the role-specific window of nothing happening.
   * The dependency list deliberately excludes `user`: the timeout only needs the
   * idle limit, and the server hands down a fresh user object on each navigation.
   */
  useEffect(() => {
    const PING_EVERY_MS = 30_000;

    let last = Date.now();
    let pingedAt = 0;

    const bump = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      last = now;
      if (now - pingedAt < PING_EVERY_MS) return;
      pingedAt = now;
      // Only visible user activity extends the server-side idle window.
      fetch("/api/auth/me?activity=1", { cache: "no-store" })
        .then((response) => {
          if (response.status === 401) {
            window.dispatchEvent(new Event("cafetrack:session-invalid"));
            return null;
          }
          return response.ok ? response.json() : null;
        })
        .catch(() => {});
    };

    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    // One check on mount, so a page loaded after the window closed sends the
    // person to the camera without waiting for a click. It also counts as
    // activity, which is what loading a page is.
    bump();

    let endingSession = false;
    const timer = setInterval(() => {
      if (!endingSession && Date.now() - last >= idleLimitMs) {
        endingSession = true;
        void fetch("/api/auth/logout", { method: "POST" })
          .catch(() => undefined)
          .finally(() => router.replace("/login"));
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
    // Keep the signed-in shell pinned to the viewport so scroll gestures stay
    // inside the content panel rather than moving the header and sidebar.
    <div className="fixed inset-0 flex flex-col overflow-hidden overscroll-none bg-[#f6f1e8] lg:flex-row">
      <Nav user={user} open={navOpen} onClose={closeNav} />

      {/* min-h-0 is load-bearing here: without it, this flex child can grow to
          its content height instead of constraining the main scroll panel. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="z-20 flex shrink-0 items-center gap-3 border-b border-cream-200 bg-[#fffcf7]/95 px-4 py-2.5 shadow-[0_4px_18px_rgba(47,32,22,0.04)] backdrop-blur lg:px-7 lg:py-3.5">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
            className="-ml-1.5 rounded-lg p-2 text-cocoa-600 transition-[background-color,color,transform] duration-150 ease-out hover:bg-cream-100 active:scale-[0.97] active:bg-cream-200 lg:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <div className="flex-1 lg:hidden">
            <CafeTrackBrand compact />
          </div>
          <div
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-200 text-xs font-bold text-cocoa-700 lg:hidden"
          >
            {initials(user.fullName)}
          </div>
          <div className="hidden min-w-0 flex-1 lg:block">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-cocoa-400">
              {user.role === "admin" ? "Management workspace" : "Team workspace"}
            </div>
            <div className="mt-0.5 truncate text-sm font-semibold text-cocoa-800">
              CafeTrack inventory
            </div>
          </div>
          <div className="hidden items-center gap-3 lg:flex">
            <div className="text-right">
              <div className="max-w-48 truncate text-sm font-semibold text-cocoa-800">
                {user.fullName}
              </div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-cocoa-400">
                {user.role}
              </div>
            </div>
            <div
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cream-200 text-xs font-bold text-cocoa-700"
            >
              {initials(user.fullName)}
            </div>
          </div>
        </header>

        {/* This is the only scrollable content region; the header and sidebar
            stay fixed while overscroll is contained at its edges. */}
        <main
          className={`app-main min-h-0 flex-1 overflow-y-auto overscroll-y-contain ${
            isCheckout ? "lg:overflow-hidden" : ""
          }`}
        >
          <div
            className={`app-content mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7 ${
              isCheckout ? "lg:flex lg:h-full lg:min-h-0 lg:flex-col" : ""
            }`}
          >
            {children}
          </div>
        </main>
      </div>

      {sessionExit && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-cocoa-900/60 p-4 backdrop-blur-[3px]">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-ended-title"
            aria-describedby="session-ended-message"
            className="w-full max-w-md rounded-3xl border border-cream-200 bg-white p-7 text-center shadow-[0_24px_70px_rgba(61,43,31,0.28)]"
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-ochre-50">
              <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-ochre-200 border-t-ochre-700" />
            </div>
            <h2 id="session-ended-title" className="text-xl font-bold text-cocoa-800">
              {sessionExit === "conflict" ? "Signed in elsewhere" : "Session ended"}
            </h2>
            <p id="session-ended-message" className="mt-3 text-sm leading-6 text-cocoa-600">
              {sessionExit === "conflict"
                ? "This account was signed in on another browser or site. This session has been signed out."
                : "Your session is no longer active. Please sign in again."}
            </p>
            <p role="status" className="mt-5 text-xs font-semibold text-cocoa-500">
              Returning to sign in…
            </p>
          </div>
        </div>
      )}
    </div>
  );
}