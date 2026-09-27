"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Nav } from "@/components/Nav";
import type { SessionUser } from "@/lib/auth";

/** Used until /api/auth/me reports settings.session_timeout_minutes. */
const DEFAULT_IDLE_LIMIT_MS = 15 * 60 * 1000;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [idleLimitMs, setIdleLimitMs] = useState(DEFAULT_IDLE_LIMIT_MS);
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
    <div className="flex h-screen overflow-hidden bg-cream-100">
      <Nav user={user} />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-7">{children}</div>
      </main>
    </div>
  );
}
