"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard, ChartLegend } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { CHART_COLORS, CHART_SERIES_MOTION } from "./theme";
import { formatPeso } from "@/lib/format";
import type { ValueTrendDatum } from "./types";

/**
 * Checkout value against waste cost, over the selected period.
 *
 * The figures are what the reports page has always shown: the quantity
 * moved multiplied by the item's current unit price. CafeTrack keeps no
 * price history, so these are estimates at today's prices rather than
 * receipts — the note under the chart says so, exactly as the page's own
 * summary cards already do.
 *
 * When nothing has a price there is no curve. The old chart drew an
 * illustrative shape and labelled it as such; a shape that is not data is
 * still a shape, so this one says there is nothing to draw instead.
 */
export function ValueTrendChart({
  points,
  periodLabel,
  unpricedLines = 0,
}: {
  points: ValueTrendDatum[];
  periodLabel: string;
  unpricedLines?: number;
}) {
  const hasValues = points.some(
    (point) => point.revenueCents > 0 || point.lossCents > 0
  );
  const isEmpty = points.length === 0 || !hasValues;

  const totalRevenue = points.reduce((sum, point) => sum + point.revenueCents, 0);
  const totalLoss = points.reduce((sum, point) => sum + point.lossCents, 0);

  return (
    <ChartCard
      title="Checkout value and waste cost over time"
      description={`Both estimates use each item's current unit price · ${periodLabel}`}
      isEmpty={isEmpty}
      emptyMessage={
        unpricedLines > 0
          ? "No priced checkout or waste activity in this date range. Add item prices to see monetary history."
          : "No checkout or waste activity in this date range."
      }
      height={280}
      legend={
        hasValues ? (
          <ChartLegend
            items={[
              {
                color: CHART_COLORS.revenue,
                label: "Checkout value",
                value: formatPeso(totalRevenue),
              },
              {
                color: CHART_COLORS.waste,
                label: "Waste cost",
                value: formatPeso(totalLoss),
              },
            ]}
          />
        ) : null
      }
      notes={
        unpricedLines > 0 ? (
          <>
            Estimates use each item&apos;s current unit price — they are not
            historical sales receipts. {unpricedLines} unpriced movement{" "}
            {unpricedLines === 1 ? "line is" : "lines are"} excluded.
          </>
        ) : (
          <>
            Estimates use each item&apos;s current unit price — they are not
            historical sales receipts.
          </>
        )
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 480, height: 280 }}
      >
        <ComposedChart
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
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickFormatter={(value: number) => formatPeso(value).replace(".00", "")}
            width={72}
          />
          <Tooltip
            cursor={{ stroke: CHART_COLORS.grid }}
            content={
              <ChartTooltip
                formatValue={(value) => formatPeso(Math.round(value))}
                formatLabel={(label) => String(label ?? "")}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="revenueCents"
            name="Checkout value"
            stroke={CHART_COLORS.revenue}
            strokeWidth={2}
            fill={CHART_COLORS.revenue}
            fillOpacity={0.14}
            dot={false}
            activeDot={{ r: 4 }}
            {...CHART_SERIES_MOTION}
          />
          <Line
            type="monotone"
            dataKey="lossCents"
            name="Waste cost"
            stroke={CHART_COLORS.waste}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            {...CHART_SERIES_MOTION}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
