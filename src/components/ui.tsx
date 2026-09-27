"use client";

import { useEffect, useRef, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Card                                                               */
/* ------------------------------------------------------------------ */

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`card p-5 ${className}`}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Stat pill — label on the left, count badge on the right            */
/* ------------------------------------------------------------------ */

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "warn" | "danger" | "good";
}) {
  // Filled pill with white text so the three stock states read as one scale.
  // amber-600 rather than amber-500: white on amber-500 is only ~2:1 contrast.
  const toneClass = {
    default: "bg-cream-300 text-cocoa-900",
    warn: "bg-amber-600 text-white",
    danger: "bg-red-500 text-white",
    good: "bg-emerald-500 text-white",
  }[tone];

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-cream-200 bg-white px-4 py-3 shadow-warm">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-cocoa-700">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-cocoa-300">{hint}</div>}
      </div>
      <span
        className={`shrink-0 rounded-full px-3 py-0.5 text-sm font-bold tabular-nums ${toneClass}`}
      >
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                              */
/* ------------------------------------------------------------------ */

export type BadgeTone = "slate" | "green" | "amber" | "red" | "blue";

export function Badge({
  children,
  tone = "slate",
  variant = "soft",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  /**
   * `soft` keeps the original tinted look (used for roles, log actions).
   * `solid` is the filled pill used for status columns, so In Stock / Low Stock
   * / Out of Stock are distinguishable at a glance.
   */
  variant?: "soft" | "solid";
}) {
  const soft = {
    slate: "bg-cocoa-50 text-cocoa-600",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    red: "bg-red-50 text-red-700",
    blue: "bg-cream-200 text-cocoa-700",
  };

  const solid = {
    slate: "bg-cocoa-400 text-white",
    green: "bg-emerald-500 text-white",
    // amber-600 rather than amber-500: white text stays legible.
    amber: "bg-amber-600 text-white",
    red: "bg-red-500 text-white",
    blue: "bg-cocoa-700 text-cream-50",
  };

  return (
    <span className={`badge ${(variant === "solid" ? solid : soft)[tone]}`}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Empty + Spinner                                                    */
/* ------------------------------------------------------------------ */

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-cocoa-300">{children}</div>;
}

export function Spinner({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-cocoa-300">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-cream-200 border-t-cream-600" />
      {label}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Modal                                                              */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-cocoa-900/40 p-4 pt-16 backdrop-blur-[2px]">
      <div className={`w-full ${width} card overflow-hidden !p-0 shadow-warm-lg`}>
        <div className="flex items-center justify-between border-b border-cream-200 bg-cream-50 px-5 py-3.5">
          <h3 className="text-sm font-bold text-cocoa-800">{title}</h3>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-cocoa-300 transition-colors hover:bg-cream-200 hover:text-cocoa-600"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                              */
/* ------------------------------------------------------------------ */

export function Toast({
  message,
  tone = "info",
  onDone,
}: {
  message: string | null;
  tone?: "info" | "error" | "success";
  onDone: () => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!message) return;
    timer.current = setTimeout(onDone, 4000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [message, onDone]);

  if (!message) return null;

  const tones = {
    info: "bg-cocoa-700",
    error: "bg-red-600",
    success: "bg-emerald-600",
  };

  return (
    <div className="fixed bottom-5 left-1/2 z-[60] -translate-x-1/2">
      <div
        className={`${tones[tone]} rounded-full px-5 py-2.5 text-sm font-medium text-white shadow-warm-lg`}
      >
        {message}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small inline "view" pill used on dashboard cards                   */
/* ------------------------------------------------------------------ */

export function ViewPill({
  href,
  label = "view",
}: {
  href: string;
  label?: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex items-center justify-center rounded-full border border-cream-300 bg-cream-100 px-4 py-1 text-xs font-semibold text-cocoa-700 transition-colors hover:bg-cream-200"
    >
      {label}
    </a>
  );
}
