"use client";

/**
 * The tooltip every chart on the reports page uses.
 *
 * Recharts hands its own props to the element given as `content`, so the
 * chart only has to say how a value should be written; the box, the swatches
 * and the rows are the same everywhere.
 */
export type ChartTooltipProps = {
  active?: boolean;
  payload?: ReadonlyArray<{
    name?: string | number;
    value?: number | string | Array<number | string>;
    color?: string;
    dataKey?: string | number;
    payload?: unknown;
  }>;
  label?: string | number;
  /** Writes one value. The default writes the number as it is. */
  formatValue?: (value: number, name: string) => string;
  /** Writes the heading. The default writes the label as it is. */
  formatLabel?: (label: string | number | undefined) => string;
  /** A heading to use instead of the chart's own label. */
  title?: string;
  /** A heading computed from the payload, preferred over `title`. */
  titleFromPayload?: (payload: ChartTooltipProps["payload"]) => string | null;
  /** Extra lines under the values. */
  extra?: string | null;
  /** Extra lines computed from the payload, preferred over `extra`. */
  extraFromPayload?: (payload: ChartTooltipProps["payload"]) => string | null;
};

export function ChartTooltip({
  active,
  payload,
  label,
  formatValue,
  formatLabel,
  title,
  titleFromPayload,
  extra,
  extraFromPayload,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const heading = titleFromPayload?.(payload) ?? title ?? formatLabel?.(label) ?? label;
  const extraLines = extraFromPayload?.(payload) ?? extra;

  return (
    <div className="rounded-lg border border-cream-200 bg-white px-3 py-2 shadow-warm">
      {heading !== undefined && heading !== null && heading !== "" && (
        <p className="mb-1 text-[11px] font-semibold text-cocoa-800">{heading}</p>
      )}
      {payload.map((entry, index) => {
        const numeric =
          typeof entry.value === "number"
            ? entry.value
            : Number(Array.isArray(entry.value) ? entry.value[0] : entry.value);
        const name = String(entry.name ?? entry.dataKey ?? "");
        const shown = Number.isFinite(numeric)
          ? formatValue
            ? formatValue(numeric, name)
            : numeric.toLocaleString("en-PH")
          : "—";
        return (
          <div
            key={`${name}-${index}`}
            className="flex items-center justify-between gap-3 text-xs"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-cocoa-500">
              {entry.color && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{name}</span>
            </span>
            <span className="shrink-0 font-semibold tabular-nums text-cocoa-800">
              {shown}
            </span>
          </div>
        );
      })}
      {extraLines && (
        <p className="mt-1 border-t border-cream-200 pt-1 text-[10px] text-cocoa-400">
          {extraLines}
        </p>
      )}
    </div>
  );
}
