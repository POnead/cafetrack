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
/* Mobile data cards                                                   */
/*                                                                     */
/* The wide tables are unusable on a phone, so every list renders a    */
/* stacked card below `lg` and the table above it. These two keep the   */
/* six call sites rendering the same shape instead of six near-copies.  */
/* ------------------------------------------------------------------ */

/** One record as a card. `lg:hidden` — the table takes over from there. */
export function DataCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card space-y-2.5 p-4 lg:hidden ${className}`}>
      {children}
    </div>
  );
}

/** A label/value line inside a DataCard. */
export function DataField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-cocoa-400">
        {label}
      </span>
      <span className="min-w-0 break-words text-right text-cocoa-700">
        {children}
      </span>
    </div>
  );
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
  //
  // The warm tones' 700 steps, not their 500s: white on sage-500 is only
  // ~3.7:1 and on terracotta-500 ~4.5:1, both short of the 4.5:1 this 14px
  // bold text needs. At 700 they land at 6.5:1, 8.1:1 and 5.5:1.
  const toneClass = {
    default: "bg-cream-300 text-cocoa-900",
    warn: "bg-ochre-700 text-white",
    danger: "bg-terracotta-700 text-white",
    good: "bg-sage-700 text-white",
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
  variant = "label",
  dot = true,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  /**
   * `label` is the original pill, used for plain category words where the
   * shape is the point (user roles, audit actions).
   * `tag` is the outline status tag used for every status / type / stock
   * badge, so In Stock / Low Stock / Out of Stock read as one scale and sit
   * naturally in the warm palette. See `.badge-tag` in globals.css.
   */
  variant?: "label" | "tag";
  /**
   * Leading dot on tags. It inherits the text colour via `bg-current`, so the
   * state is still readable without relying on hue alone.
   */
  dot?: boolean;
}) {
  const label = {
    slate: "bg-cocoa-50 text-cocoa-600",
    green: "bg-sage-50 text-sage-700",
    amber: "bg-ochre-50 text-ochre-700",
    red: "bg-terracotta-50 text-terracotta-700",
    blue: "bg-cream-200 text-cocoa-700",
  };

  // Outline only: no fill, just a tinted border and warm text. Reads as a
  // printed label rather than a status light.
  const tag = {
    slate: "bg-transparent text-cocoa-600 border-cocoa-200",
    green: "bg-transparent text-sage-700 border-sage-500/40",
    amber: "bg-transparent text-ochre-700 border-ochre-500/40",
    red: "bg-transparent text-terracotta-700 border-terracotta-500/40",
    blue: "bg-transparent text-cocoa-700 border-cream-400",
  };

  const isTag = variant === "tag";

  return (
    <span className={`${isTag ? "badge-tag" : "badge"} ${(isTag ? tag : label)[tone]}`}>
      {isTag && dot && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          aria-hidden="true"
        />
      )}
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

  // 700 steps again — the toast is white text on a solid fill, the same
  // contrast constraint as the Stat pill above.
  const tones = {
    info: "bg-cocoa-700",
    error: "bg-terracotta-700",
    success: "bg-sage-700",
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
