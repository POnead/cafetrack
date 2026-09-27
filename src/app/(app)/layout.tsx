"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Nav } from "@/components/Nav";
import { MenuIcon } from "@/components/icons";
import type { SessionUser } from "@/lib/auth";

/** Used until /api/auth/me reports settings.session_timeout_minutes. */
const DEFAULT_IDLE_LIMIT_MS = 15 * 60 * 1000;

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [idleLimitMs, setIdleLimitMs] = useState(DEFAULT_IDLE_LIMIT_MS);
  const [navOpen, setNavOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;

    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (alive) {
          setUser(data.user);
          // The server signs the token for this many minutes, so the client
          // idle check has to use the same window.
          const minutes = Number(data.sessionMinutes);
          if (Number.isFinite(minutes) && minutes > 0) {
            setIdleLimitMs(minutes * 60 * 1000);
          }
          setChecked(true);
        }
      })
      .catch(() => {
        if (alive) router.replace("/login");
      });

    return () => {
      alive = false;
    };
  }, [router, pathname]);

  // Idle timeout — sign out after the configured window of nothing happening.
  // Activity pings are throttled: without this every mousemove fires a
  // request and the server rewrites the session cookie each time.
  useEffect(() => {
    if (!user) return;

    const PING_EVERY_MS = 60_000;

    let last = Date.now();
    let pingedAt = 0;

    const bump = () => {
      const now = Date.now();
      last = now;
      if (now - pingedAt < PING_EVERY_MS) return;
      pingedAt = now;
      fetch("/api/auth/me").catch(() => {});
    };

    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

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
  }, [user, router, idleLimitMs]);

  if (!checked || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-cream-100">
        <div className="flex items-center gap-2 text-sm text-cocoa-300">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-cream-200 border-t-cream-600" />
          Loading...
        </div>
      </div>
    );
  }

  return (
    // h-[100dvh] rather than h-screen: on a phone 100vh is taller than the
    // visible area, so the bottom of the page ends up below the fold and
    // cannot be scrolled to.
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-cream-100 lg:flex-row">
      <Nav user={user} open={navOpen} onClose={() => setNavOpen(false)} />

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
            className="-ml-1.5 rounded-lg p-2 text-cocoa-600 transition-colors hover:bg-cream-100 active:bg-cream-200"
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
