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
import { CHART_COLORS, formatCount, CHART_SERIES_MOTION } from "./theme";
import type { HistogramDatum } from "./types";

/**
 * How the value of a transaction is spread.
 *
 * The bands and the counting are the ones the reports page has always used:
 * five bands across the range of transaction values, with each transaction
 * placed in the band its own value falls in. Checkout and waste are counted
 * separately because they are different events with different meanings.
 */
export function TransactionHistogramChart({
  bins,
}: {
  bins: HistogramDatum[];
}) {
  const narrow = useIsNarrow();

  return (
    <ChartCard
      title="Transaction value distribution"
      description="Estimated value per checkout or waste transaction."
      isEmpty={bins.length === 0}
      emptyMessage="There are no priced transactions in this date range."
      height={280}
      legend={
        <ChartLegend
          items={[
            { color: CHART_COLORS.revenue, label: "Checkout" },
            { color: CHART_COLORS.waste, label: "Waste" },
          ]}
        />
      }
      notes={
        <>
          Each transaction is placed in the band its own value falls in.
          Values use each item&apos;s current unit price.
        </>
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 480, height: 280 }}
      >
        <BarChart
          data={bins}
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
            tick={{ fill: CHART_COLORS.axis, fontSize: 9 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval={0}
            angle={narrow ? -35 : 0}
            textAnchor={narrow ? "end" : "middle"}
            height={narrow ? 56 : 32}
          />
          <YAxis
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickFormatter={(value: number) => formatCount(value)}
            allowDecimals={false}
            width={40}
          />
          <Tooltip
            cursor={{ fill: "#F6F1E8" }}
            content={
              <ChartTooltip
                formatValue={(value) => `${formatCount(value)} transactions`}
              />
            }
          />
          <Bar
            dataKey="checkoutCount"
            name="Checkout"
            fill={CHART_COLORS.revenue}
            radius={[4, 4, 0, 0]}
            maxBarSize={26}
            {...CHART_SERIES_MOTION}
          />
          <Bar
            dataKey="wasteCount"
            name="Waste"
            fill={CHART_COLORS.waste}
            radius={[4, 4, 0, 0]}
            maxBarSize={26}
            {...CHART_SERIES_MOTION}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
