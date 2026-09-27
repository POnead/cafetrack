"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { CupMark } from "./CafeIllustration";
import {
  BellIcon,
  BoxIcon,
  CartIcon,
  ChartIcon,
  CloseIcon,
  CogIcon,
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
    ],
  },
  {
    title: "Inventory Management",
    items: [
      { href: "/items", label: "All Items", icon: BoxIcon },
      { href: "/alerts", label: "Alerts", icon: BellIcon },
    ],
  },
  {
    title: "User Management",
    items: [
      { href: "/users", label: "Staff Accounts", icon: UsersIcon },
      { href: "/settings", label: "Settings", icon: CogIcon },
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
    ],
  },
  { title: "Inventory", items: [{ href: "/alerts", label: "Alerts", icon: BellIcon }] },
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
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <>
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
        className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col bg-cocoa-700 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* ---- brand + user ---- */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream-100 text-sm font-bold text-cocoa-700">
            {initials(user.fullName) || <CupMark className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-cream-50">
              {user.fullName}
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-cream-300/60">
              {user.role}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close menu"
            className="-mr-1 rounded-lg p-2 text-cream-100/70 transition-colors hover:bg-white/10 hover:text-cream-50 lg:hidden"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* ---- nav ---- */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {groups.map((group) => (
            <div key={group.title} className="mb-4">
              <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-cream-300/50">
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
                      className={`flex min-h-[44px] items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors lg:min-h-0 lg:py-2 ${
                        active
                          ? "bg-cream-300 font-semibold text-cocoa-900"
                          : "text-cream-100/75 hover:bg-white/10 hover:text-cream-50"
                      }`}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* ---- footer ---- */}
        <div className="border-t border-white/10 p-3">
          <button
            onClick={logout}
            className="flex min-h-[44px] w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-cream-100/75 transition-colors hover:bg-white/10 hover:text-cream-50 lg:min-h-0 lg:py-2"
          >
            <LogOutIcon className="h-4 w-4 shrink-0" />
            Log out
          </button>
        </div>
      </aside>
    </>
  );
}
