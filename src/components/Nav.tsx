"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { CafeTrackBrand } from "@/components/CafeTrackBrand";
import { ConfirmDialog } from "@/components/ui";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { alertSeenStorageKey } from "@/lib/alert-read-state";
import {
  BellIcon,
  BoxIcon,
  CartIcon,
  ChartIcon,
  CloseIcon,
  CogIcon,
  CupMark,
  HomeIcon,
  LogOutIcon,
  ShieldIcon,
  UsersIcon,
  type IconProps,
} from "./icons";

type IconComponent = (props: IconProps) => JSX.Element;

type NavItem = { href: string; label: string; icon: IconComponent };
type NavGroup = { title: string; items: NavItem[] };

const ADMIN_NAV: NavGroup[] = [
  { title: "Dashboard", items: [{ href: "/dashboard", label: "Home", icon: HomeIcon }] },
  {
    title: "Operations",
    items: [
      { href: "/checkout", label: "Checkout & Restock", icon: CartIcon },
      { href: "/history", label: "History", icon: ChartIcon },
    ],
  },
  {
    title: "Inventory Management",
    items: [
      { href: "/items", label: "All Items", icon: BoxIcon },
      // FR-03: the approval queue. Admin-only for decisions — the API refuses a
      // staff decision with a 403 — but the page renders read-only for staff so
      // a barista can see their own submission is still waiting.
      { href: "/approvals", label: "Approvals", icon: BoxIcon },
      { href: "/alerts", label: "Alerts", icon: BellIcon },
    ],
  },
  {
    title: "User Management",
    items: [
      { href: "/users", label: "Staff Accounts", icon: UsersIcon },
      { href: "/settings", label: "Settings", icon: CogIcon },
      // FR-11.
      { href: "/email", label: "Email", icon: BellIcon },
    ],
  },
  {
    title: "Report & Analytics",
    items: [
      { href: "/reports", label: "Stock Report", icon: ChartIcon },
      { href: "/audit", label: "Audit Trail", icon: ShieldIcon },
    ],
  },
];

const STAFF_NAV: NavGroup[] = [
  { title: "Dashboard", items: [{ href: "/dashboard", label: "Home", icon: HomeIcon }] },
  {
    title: "Operations",
    items: [
      { href: "/checkout", label: "Checkout & Restock", icon: CartIcon },
      { href: "/history", label: "History", icon: ChartIcon },
    ],
  },
  // FR-03: staff can put new ingredients in. Whether their submission becomes
  // stock immediately or waits for an admin is decided per person by the
  // can_manage_items grant, which the server enforces — the link is here so the
  // page is reachable either way.
  //
  // One group, not two: Nav keys its groups by title, so two groups both called
  // "Inventory" produce a duplicate-key warning on every page.
  {
    title: "Inventory",
    items: [
      { href: "/items", label: "All Items", icon: BoxIcon },
      { href: "/alerts", label: "Alerts", icon: BellIcon },
    ],
  },
];

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function Nav({
  user,
  open,
  onClose,
}: {
  user: SessionUser;
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const groups = user.role === "admin" ? ADMIN_NAV : STAFF_NAV;
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [unreadAlertCount, setUnreadAlertCount] = useState(0);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);

  const requestSessionCheck = useCallback(() => {
    window.dispatchEvent(new Event("cafetrack:session-invalid"));
  }, []);

  const loadUnreadAlerts = useCallback(async () => {
    try {
      const storageKey = alertSeenStorageKey(user.id);
      let seenAt = window.localStorage.getItem(storageKey);
      if (!seenAt) {
        seenAt = new Date().toISOString();
        window.localStorage.setItem(storageKey, seenAt);
      }

      const params = new URLSearchParams({
        unread_count: "1",
        seen_at: seenAt,
      });
      const response = await fetch(`/api/alerts?${params}`);
      if (response.status === 401) {
        requestSessionCheck();
        return;
      }
      if (!response.ok) return;
      const data = await response.json();
      setUnreadAlertCount(Number(data.unreadCount) || 0);
    } catch {
      // Badge counts are best-effort; the live refresh retries on the next poll.
    }
  }, [requestSessionCheck, user.id]);

  const loadPendingApprovals = useCallback(async () => {
    if (user.role !== "admin") {
      setPendingApprovalCount(0);
      return;
    }

    try {
      const [itemsResponse, changesResponse, dutyResponse] = await Promise.all([
        fetch("/api/items?status=pending&limit=1"),
        fetch("/api/change-requests?pending_count=1"),
        fetch("/api/duty-bypass-requests?pending_count=1"),
      ]);
      if (
        itemsResponse.status === 401 ||
        changesResponse.status === 401 ||
        dutyResponse.status === 401
      ) {
        requestSessionCheck();
        return;
      }
      if (!itemsResponse.ok || !changesResponse.ok || !dutyResponse.ok) return;
      const [itemsData, changesData, dutyData] = await Promise.all([
        itemsResponse.json(),
        changesResponse.json(),
        dutyResponse.json(),
      ]);

      setPendingApprovalCount(
        (Number(itemsData.total) || 0) +
          (Number(changesData.pendingCount) || 0) +
          (Number(dutyData.pendingCount) || 0)
      );
    } catch {
      // Badge counts are best-effort; the live refresh retries on the next poll.
    }
  }, [requestSessionCheck, user.role]);

  const loadNavBadges = useCallback(async () => {
    await Promise.all([loadUnreadAlerts(), loadPendingApprovals()]);
  }, [loadPendingApprovals, loadUnreadAlerts]);

  useLiveRefresh(loadNavBadges);

  useEffect(() => {
    void loadNavBadges();
  }, [pathname, loadNavBadges]);

  useEffect(() => {
    const onAlertsSeen = () => void loadNavBadges();
    window.addEventListener("cafetrack:alerts-seen", onAlertsSeen);
    return () => window.removeEventListener("cafetrack:alerts-seen", onAlertsSeen);
  }, [loadNavBadges]);

  // Navigating should dismiss the drawer, otherwise the panel stays over the
  // page the person just asked for. Reached by tapping a link *or* by any other
  // route change (back button, an expired session redirect).
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Escape closes it for keyboard and tablet users. The backdrop handles taps.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // No body scroll lock here on purpose. The app shell is h-[100dvh]
  // overflow-hidden and scrolling happens inside <main>, so <body> never
  // scrolls anyway — locking it did nothing while adding a cleanup-ordering
  // dependency that could leave the page frozen.

  async function logout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError(null);

    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not log out.");
      setLogoutConfirmOpen(false);
      router.replace("/login");
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "Could not log out. Please try again."
      );
    } finally {
      setLogoutBusy(false);
    }
  }

  return (
    <>
      <ConfirmDialog
        open={logoutConfirmOpen}
        onCancel={() => {
          if (logoutBusy) return;
          setLogoutConfirmOpen(false);
          setLogoutError(null);
        }}
        onConfirm={logout}
        title="Log out?"
        message={
          logoutError ??
          `Are you sure you want to log out of your ${user.role} account?`
        }
        confirmLabel={logoutBusy ? "Logging out..." : "Log out"}
        tone="warning"
      />

      {/* Tap-to-close backdrop. lg:hidden because the sidebar is permanent there. */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`fixed inset-0 z-30 bg-cocoa-900/50 transition-opacity duration-200 lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      <aside
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-[#241811] text-cream-50 transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:z-auto lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
          <CafeTrackBrand onDark />
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-2 rounded-lg p-2 text-cream-100/70 transition-colors hover:bg-white/10 hover:text-cream-50 lg:hidden"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <nav className="sidebar-nav min-h-0 flex-1 overflow-hidden px-3 py-2">
          {groups.map((group) => (
            <div key={group.title} className="mb-2">
              <div className="px-3 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cream-300/40">
                {group.title}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(item.href + "/");
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      aria-label={
                        item.href === "/alerts" && unreadAlertCount > 0
                          ? `Alerts, ${unreadAlertCount} unread`
                          : item.href === "/approvals" && pendingApprovalCount > 0
                            ? `Approvals, ${pendingApprovalCount} awaiting review`
                            : undefined
                      }
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-[44px] items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.98] lg:min-h-0 lg:py-2 ${
                        active
                          ? "border-[#c8a274]/35 bg-[#38261c] font-semibold text-cream-50"
                          : "border-transparent text-cream-100/65 hover:bg-white/5 hover:text-cream-50"
                      }`}
                    >
                      <item.icon
                        className={`h-4 w-4 shrink-0 ${
                          active ? "text-cream-400" : "text-cream-100/65"
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                      {item.href === "/alerts" && unreadAlertCount > 0 && (
                        <span className="ml-auto min-w-5 rounded-full bg-terracotta-700 px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white">
                          {unreadAlertCount > 99 ? "99+" : unreadAlertCount}
                        </span>
                      )}
                      {item.href === "/approvals" && pendingApprovalCount > 0 && (
                        <span className="ml-auto min-w-5 rounded-full bg-terracotta-700 px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white">
                          {pendingApprovalCount > 99 ? "99+" : pendingApprovalCount}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#38261c] text-xs font-bold text-cream-300">
              {initials(user.fullName) || <CupMark className="h-5 w-5" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-cream-50">
                {user.fullName}
              </div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-cream-300/55">
                {user.role}
              </div>
            </div>
            <button
              onClick={() => {
                setLogoutError(null);
                setLogoutConfirmOpen(true);
              }}
              aria-label="Log out"
              title="Log out"
              className="rounded-lg p-2 text-cream-100/55 transition-colors hover:bg-white/10 hover:text-cream-50"
            >
              <LogOutIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
