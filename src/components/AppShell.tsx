"use client";

import Link from "next/link";
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

export function AppShell({
  user,
  idleLimitMs,
  children,
}: {
  user: SessionUser;
  /** Role-specific idle timeout, resolved on the server. */
  idleLimitMs: number;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const [sessionExit, setSessionExit] = useState<"conflict" | "expired" | null>(null);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  const [adminWarnings, setAdminWarnings] = useState<string[]>([]);
  const router = useRouter();
  const pathname = usePathname();
  const isCheckout = pathname === "/checkout";
  const isDashboard = pathname === "/dashboard";

  useEffect(() => {
    const updateTime = () => setCurrentTime(new Date());
    updateTime();
    const timer = window.setInterval(updateTime, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadAdminWarnings = useCallback(async () => {
    if (user.role !== "admin") {
      setAdminWarnings([]);
      return;
    }

    try {
      const [settingsResponse, emailResponse] = await Promise.all([
        fetch("/api/settings", { cache: "no-store" }),
        fetch("/api/email", { cache: "no-store" }),
      ]);

      const settingsData = settingsResponse.ok ? await settingsResponse.json() : null;
      const emailData = emailResponse.ok ? await emailResponse.json() : null;

      const warnings: string[] = [];
      const recoveryEmail = String(settingsData?.settings?.password_recovery_email ?? "").trim();
      if (!recoveryEmail) {
        warnings.push(
          "Owner email is missing. Add the recovery email in Settings → General so password reset codes can be sent."
        );
      }

      if (emailData?.status && !emailData.status.configured) {
        warnings.push(
          "SMTP is not configured. Add the sending account in Settings → Email so password reset emails and alerts can be delivered."
        );
      }

      setAdminWarnings(warnings);
    } catch {
      setAdminWarnings([]);
    }
  }, [user.role]);

  useEffect(() => {
    void loadAdminWarnings();
  }, [loadAdminWarnings, pathname]);

  useEffect(() => {
    if (user.role !== "admin") return;

    const onFocusRefresh = () => {
      void loadAdminWarnings();
    };
    const onViewRefresh = () => {
      if (document.visibilityState === "visible") void loadAdminWarnings();
    };
    const onSettingsUpdated = () => {
      void loadAdminWarnings();
    };

    window.addEventListener("focus", onFocusRefresh);
    document.addEventListener("visibilitychange", onViewRefresh);
    window.addEventListener("cafetrack:settings-updated", onSettingsUpdated);

    return () => {
      window.removeEventListener("focus", onFocusRefresh);
      document.removeEventListener("visibilitychange", onViewRefresh);
      window.removeEventListener("cafetrack:settings-updated", onSettingsUpdated);
    };
  }, [loadAdminWarnings, user.role]);

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
          redirectTimer = window.setTimeout(
            () =>
              router.replace(
                data.face_check_reset ? "/login?face_check_reset=1" : "/login"
              ),
            1200
          );
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
    const PING_EVERY_MS = 5_000;

    let last = Date.now();
    let pingedAt = 0;
    let activitySyncTimer: number | undefined;
    let idleTimer: number | undefined;
    let redirectingForFace = false;
    let endingSession = false;

    const endSession = () => {
      if (endingSession) return;
      endingSession = true;
      if (activitySyncTimer !== undefined) {
        window.clearTimeout(activitySyncTimer);
        activitySyncTimer = undefined;
      }
      void fetch("/api/auth/logout", { method: "POST" })
        .catch(() => undefined)
        .finally(() => router.replace("/login"));
    };

    const scheduleIdleLogout = () => {
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      const remaining = Math.max(0, idleLimitMs - (Date.now() - last));
      idleTimer = window.setTimeout(() => {
        idleTimer = undefined;
        if (Date.now() - last >= idleLimitMs) endSession();
        else scheduleIdleLogout();
      }, remaining);
    };

    const syncActivity = () => {
      if (endingSession || document.visibilityState !== "visible") return;
      pingedAt = Date.now();
      // Only visible user activity extends the server-side idle window.
      fetch("/api/auth/me?activity=1", { cache: "no-store" })
        .then(async (response) => {
          if (response.status === 401) {
            window.dispatchEvent(new Event("cafetrack:session-invalid"));
            return null;
          }
          if (!response.ok) return null;
          const data = await response.json();
          if (
            user.role === "staff" &&
            data.face?.required === true &&
            !redirectingForFace
          ) {
            redirectingForFace = true;
            if (data.face.verifiedAt === null) {
              void fetch("/api/auth/logout", { method: "POST" })
                .catch((error) => {
                  console.error("Could not clear the face-reset session:", error);
                })
                .finally(() => router.replace("/login?face_check_reset=1"));
            } else {
              router.replace("/verify");
            }
          }
          return data;
        })
        .catch(() => {});
    };

    const bump = () => {
      if (endingSession || document.visibilityState !== "visible") return;
      last = Date.now();
      scheduleIdleLogout();

      const wait = PING_EVERY_MS - (Date.now() - pingedAt);
      if (wait <= 0) {
        if (activitySyncTimer !== undefined) {
          window.clearTimeout(activitySyncTimer);
          activitySyncTimer = undefined;
        }
        syncActivity();
      } else if (activitySyncTimer === undefined) {
        // Keep a trailing sync so the server records the latest activity even
        // when the user stops interacting before the throttle window ends.
        activitySyncTimer = window.setTimeout(() => {
          activitySyncTimer = undefined;
          if (Date.now() - last < idleLimitMs) syncActivity();
        }, wait);
      }
    };

    const events = [
      "pointermove",
      "pointerdown",
      "pointerup",
      "keydown",
      "click",
      "input",
      "change",
      "focusin",
      "scroll",
      "wheel",
      "touchstart",
      "cafetrack:user-activity",
    ];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    // One check on mount, so a page loaded after the window closed sends the
    // person to the camera without waiting for a click. It also counts as
    // activity, which is what loading a page is.
    bump();

    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      if (idleTimer !== undefined) window.clearTimeout(idleTimer);
      if (activitySyncTimer !== undefined) window.clearTimeout(activitySyncTimer);
    };
  }, [idleLimitMs, router, user.role]);

  // A stable identity for the drawer's close handler. Nav re-registers a
  // keydown listener whenever this changes, so handing it a fresh arrow on
  // every render meant re-adding that listener on every render too.
  const closeNav = useCallback(() => setNavOpen(false), []);
  const currentDate = currentTime
    ? new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(currentTime)
    : "—";
  const currentClock = currentTime
    ? new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(currentTime)
    : "—";

  return (
    // Keep the signed-in shell pinned to the viewport so scroll gestures stay
    // inside the content panel rather than moving the header and sidebar.
    <div className="fixed inset-0 flex flex-col overflow-hidden overscroll-none bg-[#f6f1e8] lg:flex-row">
      <Nav user={user} open={navOpen} onClose={closeNav} />

      {/* min-h-0 is load-bearing here: without it, this flex child can grow to
          its content height instead of constraining the main scroll panel. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {adminWarnings.length > 0 && (
          <div className="pointer-events-none fixed right-4 top-4 z-[70] w-[min(30rem,calc(100vw-2rem))] space-y-2.5">
            {adminWarnings.map((warning, index) => (
              <div
                key={`${warning}-${index}`}
                role="alert"
                aria-live="assertive"
                className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-terracotta-200 bg-terracotta-50/95 px-4 py-3 text-sm text-terracotta-800 shadow-[0_16px_30px_rgba(83,33,18,0.14)] backdrop-blur"
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-terracotta-600 text-xs font-bold text-white">
                  !
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold leading-5">
                    {warning.startsWith("Owner email") ? "Owner email missing" : "Email setup missing"}
                  </p>
                  <p className="mt-1 leading-5 text-terracotta-700">{warning}</p>
                  <Link
                    href={
                      warning.startsWith("Owner email")
                        ? "/settings?tab=general&focus=password_recovery_email"
                        : "/settings?tab=email&focus=smtp_host"
                    }
                    className="mt-2 inline-flex font-semibold underline underline-offset-2"
                  >
                    {warning.startsWith("Owner email")
                      ? "Add it in Settings → General"
                      : "Fix it in Settings → Email"}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}

        <header className="z-20 flex shrink-0 items-center gap-3 border-b border-cream-200 bg-[#fffcf7]/95 px-4 py-2.5 shadow-[0_4px_18px_rgba(47,32,22,0.04)] backdrop-blur lg:px-7 lg:py-3.5">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
            aria-expanded={navOpen}
            className="-ml-1.5 rounded-lg p-2 text-cocoa-600 transition-[background-color,color,transform] duration-150 ease-out hover:bg-cream-100 active:scale-[0.97] active:bg-cream-200 lg:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 lg:hidden">
            <CafeTrackBrand compact />
          </div>
          <div className="hidden min-w-0 flex-1 lg:block">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-cocoa-400">
              {user.role === "admin" ? "Management workspace" : "Team workspace"}
            </div>
            <div className="mt-0.5 truncate text-sm font-semibold text-cocoa-800">
              CafeTrack inventory
            </div>
          </div>
          <time
            dateTime={currentTime?.toISOString()}
            aria-label={
              currentTime
                ? `Local date and time: ${currentDate}, ${currentClock}`
                : "Local date and time"
            }
            className="ml-auto shrink-0 text-right"
          >
            <span className="block text-[10px] font-semibold leading-tight text-cocoa-800 max-[360px]:text-[9px] sm:text-xs">
              {currentDate}
            </span>
            <span className="mt-0.5 block text-xs font-bold leading-tight text-cocoa-500">
              {currentClock}
            </span>
          </time>
        </header>

        {/* This is the only scrollable content region; the header and sidebar
            stay fixed while overscroll is contained at its edges. */}
        <main
          className={`app-main min-h-0 flex-1 overflow-y-auto overscroll-y-contain ${
            isCheckout || isDashboard ? "lg:overflow-hidden" : ""
          }`}
        >
          <div
            className={`app-content mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-7 ${
              isCheckout || isDashboard ? "lg:flex lg:h-full lg:min-h-0 lg:flex-col" : ""
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
              {sessionExit === "conflict"
                ? "Signed in elsewhere"
                : "Session ended"}
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