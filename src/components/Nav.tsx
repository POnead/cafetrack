"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { SessionUser } from "@/lib/auth";
import { CupMark } from "./CafeIllustration";
import {
  BellIcon,
  BoxIcon,
  CartIcon,
  ChartIcon,
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

export function Nav({ user }: { user: SessionUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const groups = user.role === "admin" ? ADMIN_NAV : STAFF_NAV;

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col bg-cocoa-700">
      {/* ---- brand + user ---- */}
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-5">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-cream-100 text-sm font-bold text-cocoa-700">
          {initials(user.fullName) || <CupMark className="h-5 w-5" />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-cream-50">
            {user.fullName}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-cream-300/60">
            {user.role}
          </div>
        </div>
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
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
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
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium text-cream-100/75 transition-colors hover:bg-white/10 hover:text-cream-50"
        >
          <LogOutIcon className="h-4 w-4 shrink-0" />
          Log out
        </button>
      </div>
    </aside>
  );
}
