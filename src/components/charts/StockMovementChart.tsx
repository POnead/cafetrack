"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard, ChartLegend } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { useIsNarrow } from "./use-narrow";
import { CHART_COLORS, formatQuantity } from "./theme";
import type { MovementDatum } from "./types";

/**
 * Stock in against stock out over the selected period.
 *
 * The classification is the one the database itself enforces. A restock
 * adds stock (`process_transaction` sets the new quantity to the old one plus
 * the received quantity); a checkout and a waste log both take stock out by
 * drawing down batches. So stock in is restock, and stock out is checkout
 * plus waste — each movement line counted once, in one series, never in
 * both.
 */
export function StockMovementChart({
  movement,
  periodLabel,
}: {
  movement: MovementDatum[];
  periodLabel: string;
}) {
  const narrow = useIsNarrow();

  const totals = movement.reduce(
    (sum, entry) => ({
      stockIn: sum.stockIn + entry.stockIn,
      stockOut: sum.stockOut + entry.stockOut,
    }),
    { stockIn: 0, stockOut: 0 }
  );

  return (
    <ChartCard
      title="Stock movement"
      description={`Units received against units taken out · ${periodLabel}`}
      isEmpty={movement.length === 0}
      emptyMessage="There are no movements to chart in this date range."
      height={280}
      legend={
        <ChartLegend
          items={[
            {
              color: CHART_COLORS.normal,
              label: "Stock in",
              value: formatQuantity(totals.stockIn),
            },
            {
              color: CHART_COLORS.stockOut,
              label: "Stock out",
              value: formatQuantity(totals.stockOut),
            },
          ]}
        />
      }
      notes={
        <>
          Stock in is recorded restocks. Stock out is recorded checkouts and
          waste logs, which both take stock off the shelf. Every movement line
          is counted once, in one series.
        </>
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 480, height: 280 }}
      >
        <BarChart
          data={movement}
          margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
          barGap={narrow ? 2 : 4}
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
            tickFormatter={(value: number) => formatQuantity(value)}
            allowDecimals={false}
            width={44}
          />
          <Tooltip
            cursor={{ fill: "#F6F1E8" }}
            content={
              <ChartTooltip formatValue={(value) => `${formatQuantity(value)} units`} />
            }
          />
          <Bar
            dataKey="stockIn"
            name="Stock in"
            fill={CHART_COLORS.normal}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
          <Bar
            dataKey="stockOut"
            name="Stock out"
            fill={CHART_COLORS.stockOut}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
