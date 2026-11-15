"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui";
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { bucketHistoryPoints, type Grouping } from "./bucketHistory";
import { CHART_COLORS, CHART_SERIES_MOTION } from "./theme";
import { formatPeso, formatPesoCompact } from "@/lib/format";
import type { HistoryGranularity, InventoryHistory } from "@/lib/inventory-history";

export type { Grouping };

function formatDay(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatDayShort(day: string): string {
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The reconstructed value of the stock on hand, over the selected period.
 *
 * Historical price is not a thing CafeTrack stores, so this is an estimate at
 * today's prices and the chart says so out loud. What the figures *are*
 * built from is real: each item's on-hand quantity is rebuilt from the
 * `qty_before`/`qty_after` recorded on every movement line, so a restock
 * raises the line and a checkout or a waste log lowers it.
 */
/**
 * A small Auto/Daily/Weekly/Monthly control for the trend.
 *
 * Lives in the chart's header so the setting is next to the chart it
 * re-buckets. It does not refetch anything: it only picks how the already
 * fetched series is grouped on screen.
 */
function GroupingControl({
  value,
  onChange,
}: {
  value: Grouping;
  onChange: (grouping: Grouping) => void;
}) {
  const options: { value: Grouping; label: string }[] = [
    { value: "auto", label: "Auto" },
    { value: "daily", label: "Daily" },
    { value: "weekly", label: "Weekly" },
    { value: "monthly", label: "Monthly" },
  ];
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border border-cream-200 bg-cream-100 p-0.5"
      role="group"
      aria-label="Chart grouping"
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${
              active
                ? "bg-white text-cocoa-800 shadow-sm"
                : "text-cocoa-500 hover:text-cocoa-800"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function InventoryValueTrendChart({
  data,
  loading,
  error,
  grouping,
  onGroupingChange,
}: {
  data: InventoryHistory | null;
  loading: boolean;
  error: string | null;
  grouping: Grouping;
  onGroupingChange?: (grouping: Grouping) => void;
}) {
  const bucketed = useMemo(() => {
    if (!data) {
      return { points: [], effective: "day" as HistoryGranularity };
    }
    return bucketHistoryPoints(data.points, grouping, data.granularity);
  }, [data, grouping]);

  const points = bucketed.points;
  const valuation = data?.valuation;
  const coverage = data?.coverage;
  const requested = data?.requested;
  const completeness = coverage?.completeness;

  const emptyMessage =
    valuation && valuation.itemsInScope === 0
      ? "There are no items in this category to value."
      : valuation && valuation.pricedItems === 0
        ? `All ${valuation.unpricedItems} item${valuation.unpricedItems === 1 ? " has" : "s have"} no recorded unit price — add prices to see the value history.`
        : "No recorded movements to reconstruct the stock value from.";

  const notes = (
    <div className="space-y-1">
      <p>
        On-hand quantities are reconstructed from recorded inventory movements.
      </p>
      <p>
        Historical values use each item&apos;s current unit price. They are
        estimates at today&apos;s prices, not historical valuations.
      </p>
      {valuation && valuation.unverifiableItems > 0 && (
        <p>
          {valuation.unverifiableItems} item
          {valuation.unverifiableItems === 1 ? " has" : "s have"} no recorded
          movement. Their historical quantities cannot be verified.
        </p>
      )}
      {valuation && valuation.unpricedItems > 0 && (
        <p>
          {valuation.unpricedItems} item
          {valuation.unpricedItems === 1 ? " is" : "s are"} excluded from
          inventory valuation because they have no recorded unit price.
        </p>
      )}
      {valuation && valuation.divergentItems > 0 && (
        <p>
          {valuation.divergentItems} item
          {valuation.divergentItems === 1 ? " has" : "s have"} differences
          between their latest recorded movement and current database quantity.
          These differences may indicate manual stock corrections.
        </p>
      )}
      {coverage && completeness !== "complete" && (
        <p className="font-semibold text-ochre-700">
          {completeness === "truncated"
            ? coverage.stopReason === "transaction-rows"
              ? `Movement history is incomplete. The scan reached the limit of ${coverage.transactionCap.toLocaleString("en-PH")} transactions, so earlier movements were not read. Historical stock levels before the earliest available movement cannot be verified.`
              : `Movement history is incomplete. Only the most recent ${coverage.cap.toLocaleString("en-PH")} movements were scanned. Historical stock levels before the earliest available movement cannot be verified.`
            : coverage.stopReason === "transaction-rows"
              ? `Movement history could not be verified in full. The scan reached its limit of ${coverage.transactionCap.toLocaleString("en-PH")} transactions and the follow-up check could not confirm whether older movements exist.`
              : "Movement history could not be verified in full. The scan reached its limit and the follow-up check could not confirm whether older movements exist."}
          {requested?.rangeShortened && requested.effectiveFrom && (
            <span className="block text-ochre-800">
              The requested range was shortened to start on{" "}
              {formatDay(requested.effectiveFrom)} because movement history
              before that date could not be verified.
            </span>
          )}
          {coverage.historyFrom && (
            <span className="block text-ochre-800">
              Coverage: {formatDay(coverage.historyFrom.slice(0, 10))} –{" "}
              {coverage.historyTo
                ? formatDay(coverage.historyTo.slice(0, 10))
                : "present"}
            </span>
          )}
        </p>
      )}
    </div>
  );

  return (
    <ChartCard
      title="Inventory value over time"
      description="On-hand quantities reconstructed from recorded movements, valued at current unit prices."
      badge={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onGroupingChange && (
            <GroupingControl value={grouping} onChange={onGroupingChange} />
          )}
          {coverage && completeness !== "complete" && (
            <Badge tone="amber" variant="tag">
              {completeness === "truncated" ? "Incomplete history" : "History unverified"}
            </Badge>
          )}
        </div>
      }
      loading={loading}
      error={error}
      isEmpty={!loading && !error && points.length === 0}
      emptyMessage={error ? "" : emptyMessage}
      height={280}
      notes={notes}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 520, height: 280 }}
      >
        <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid
            stroke={CHART_COLORS.grid}
            strokeDasharray="3 4"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval="preserveStartEnd"
            minTickGap={8}
          />
          <YAxis
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickFormatter={(value: number) => formatPesoCompact(value)}
            width={76}
          />
          <Tooltip
            cursor={{ stroke: CHART_COLORS.grid }}
            content={
              <ChartTooltip
                titleFromPayload={(payload) => {
                  const point = payload?.[0]?.payload as
                    | { periodFrom?: string; periodTo?: string; day?: string }
                    | undefined;
                  if (!point) return null;
                  const from = point.periodFrom ?? point.day;
                  const to = point.periodTo ?? point.day;
                  if (!from || !to) return null;
                  return from === to
                    ? formatDay(from)
                    : `${formatDayShort(from)} – ${formatDayShort(to)}`;
                }}
                formatValue={(value) => formatPeso(Math.round(value))}
                extraFromPayload={(payload) => {
                  const point = payload?.[0]?.payload as
                    | { minCents?: number; maxCents?: number }
                    | undefined;
                  if (
                    !point ||
                    point.minCents === undefined ||
                    point.maxCents === undefined ||
                    point.minCents === point.maxCents
                  ) {
                    return null;
                  }
                  return `Range in this period: ${formatPeso(point.minCents)} – ${formatPeso(point.maxCents)}`;
                }}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="valueCents"
            name="Inventory value"
            stroke={CHART_COLORS.primary}
            strokeWidth={2}
            fill={CHART_COLORS.primary}
            fillOpacity={0.14}
            dot={false}
            activeDot={{ r: 4 }}
            {...CHART_SERIES_MOTION}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
