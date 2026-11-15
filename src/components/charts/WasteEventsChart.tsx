"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { CHART_COLORS, CHART_SERIES_MOTION } from "./theme";
import type { WasteEventDatum } from "./types";

/**
 * Waste transactions over the selected period.
 *
 * Counts waste records, not item lines — the same definition as the Waste
 * Events KPI beside it, and deliberately not a sum of quantities: CafeTrack
 * records waste in pieces, kilograms and litres, and adding those together
 * into one "quantity" would be meaningless. Buckets with no waste stay on the
 * axis so a quiet week is drawn as a quiet week, not as a missing gap.
 *
 * Buckets come from the same loop as the movement and value charts, so the
 * grouping, the date attribution and the range and category filters all
 * match the rest of the report exactly.
 */
export function WasteEventsChart({
  points,
  periodLabel,
  bare = false,
}: {
  points: WasteEventDatum[];
  /** "daily" | "weekly" | "monthly" — from the shared grouping logic. */
  periodLabel: string;
  /** Render without the outer card (inside the Waste Summary panel). */
  bare?: boolean;
}) {
  const total = points.reduce((sum, point) => sum + point.events, 0);
  const isEmpty = points.length === 0 || total === 0;

  // The x-axis label is short on purpose; the tooltip spells the bucket out.
  const titleFromPayload = (
    payload: ReadonlyArray<{ payload?: unknown }> | undefined
  ) => {
    const key = (payload?.[0]?.payload as WasteEventDatum | undefined)?.key;
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) return null;
    if (periodLabel === "monthly") {
      return date.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
    }
    const formatted = date.toLocaleDateString("en-PH", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return periodLabel === "weekly" ? `Week of ${formatted}` : formatted;
  };

  return (
    <ChartCard
      bare={bare}
      title="Waste events over time"
      description={`Waste transactions, ${periodLabel}`}
      isEmpty={isEmpty}
      emptyMessage="No waste recorded in this date range."
      height={220}
      notes={
        <>
          One waste record counts once no matter how many items it lists —
          quantities are in mixed units and are never added together. Follows
          the selected date range and category filter.
        </>
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 520, height: 220 }}
      >
        <LineChart
          data={points}
          margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
        >
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
            allowDecimals={false}
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            width={36}
          />
          <Tooltip
            cursor={{ stroke: CHART_COLORS.grid }}
            content={
              <ChartTooltip
                titleFromPayload={titleFromPayload}
                formatValue={(value) => {
                  const events = Math.round(value);
                  return `${events} waste event${events === 1 ? "" : "s"}`;
                }}
              />
            }
          />
          <Line
            type="monotone"
            dataKey="events"
            name="Waste events"
            stroke={CHART_COLORS.waste}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            {...CHART_SERIES_MOTION}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
