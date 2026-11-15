"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Card, Empty, Spinner } from "@/components/ui";

/**
 * Flip to true the first time the element enters the viewport. Charts mount
 * their SVG only then, which skips every off-screen animation — recharts
 * animates on mount, so mounting late means the bars and slices draw exactly
 * when you arrive at them, and a busy tab change no longer starts ten
 * chart engines at once. Fires once: the chart stays mounted afterwards.
 *
 * The ref is a callback, not a useRef, because the observed element only
 * exists once a chart leaves its loading state — a plain ref reads null on
 * the mount where data is still arriving and never attaches at all.
 */
function useChartInView<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!element) return;

    if (!("IntersectionObserver" in window)) {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setInView(true);
        observer.disconnect();
      },
      // A little head start so the draw is already under way as the card
      // scrolls into view, not after it lands.
      { rootMargin: "150px 0px 150px 0px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, inView };
}

/**
 * The shell every chart on the reports page sits in.
 *
 * One component so the cards cannot drift apart: same header, same padding,
 * same empty state, same error state, same disclosure strip. The charts
 * themselves only draw the chart.
 */
export function ChartCard({
  title,
  description,
  badge,
  legend,
  height = 260,
  loading = false,
  error = null,
  isEmpty = false,
  emptyMessage = "There is nothing to chart yet.",
  footer,
  notes,
  bare = false,
  children,
}: {
  title: string;
  description?: string;
  /** A short tag beside the title — "Daily", "Truncated", and so on. */
  badge?: ReactNode;
  /** The legend row, between the header and the chart. */
  legend?: ReactNode;
  /** Height of the chart area in pixels. */
  height?: number;
  loading?: boolean;
  /** An error message. When set, the chart is not drawn. */
  error?: string | null;
  /** True when there is nothing to draw. */
  isEmpty?: boolean;
  emptyMessage?: string;
  /** A strip under the chart — the detail of a selected point, say. */
  footer?: ReactNode;
  /** The disclosure strip under the chart. */
  notes?: ReactNode;
  /**
   * Render without the outer card. Used when the chart sits inside another
   * card (the Waste Summary panel) where a second border would be noise —
   * the sections are identical, only the wrapping <Card> is omitted.
   */
  bare?: boolean;
  children: ReactNode;
}) {
  const { ref: inViewRef, inView } = useChartInView<HTMLDivElement>();

  const body = (
    <>
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-cocoa-800">{title}</h2>
            {description && (
              <p className="mt-1 text-xs text-cocoa-400">{description}</p>
            )}
          </div>
          {badge}
        </div>
      </div>

      {legend && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3">{legend}</div>
      )}

      <div className="p-3 sm:p-4">
        {loading ? (
          <Spinner label="Loading chart..." />
        ) : error ? (
          <div
            role="alert"
            className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700"
          >
            {error}
          </div>
        ) : isEmpty ? (
          <div style={{ minHeight: height / 2 }}>
            <Empty>{emptyMessage}</Empty>
          </div>
        ) : (
          <div ref={inViewRef} style={{ height }} aria-hidden={!inView}>
            {inView ? children : null}
          </div>
        )}
      </div>

      {footer && (
        <div className="border-t border-cream-200 px-4 py-2.5">{footer}</div>
      )}

      {notes && (
        <div className="border-t border-cream-200 bg-cream-50 px-4 py-2 text-[10px] leading-relaxed text-cocoa-400">
          {notes}
        </div>
      )}
    </>
  );

  // `report-card-enter` plays the entrance animation once the Reports page's
  // reveal wrapper flips it visible — see globals.css and ReportReveal.
  return bare ? (
    <div className="report-card-enter">{body}</div>
  ) : (
    <Card className="!p-0 report-card-enter">{body}</Card>
  );
}

/**
 * A legend swatch and its label.
 *
 * Every chart draws its legend the same way: a dot in the series colour and
 * the series name, so a reader learns the shape once.
 */
export function ChartLegend({
  items,
}: {
  items: { color: string; label: string; value?: string }[];
}) {
  return (
    <>
      {items.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-1.5 text-[11px] text-cocoa-600"
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          {item.label}
          {item.value && (
            <span className="font-semibold tabular-nums text-cocoa-800">
              {item.value}
            </span>
          )}
        </span>
      ))}
    </>
  );
}
