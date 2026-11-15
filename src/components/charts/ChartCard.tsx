"use client";

import type { ReactNode } from "react";
import { Card, Empty, Spinner } from "@/components/ui";

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
  children: ReactNode;
}) {
  return (
    <Card className="!p-0">
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
          <div style={{ height }}>{children}</div>
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
    </Card>
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
