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
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { useIsNarrow } from "./use-narrow";
import { CHART_COLORS, formatQuantity, truncateLabel } from "./theme";
import type { BarDatum } from "./types";

/**
 * A ranked horizontal bar chart.
 *
 * One component for every "top items by something" chart on the page, so
 * they all read the same way: the name down the side, the measure along the
 * bottom, the exact figure in the tooltip. `metric` names the measure, so
 * the chart always says what it is ranking by — the number of transactions
 * and the number of units are different things and the reader has to be told
 * which one they are looking at.
 */
export function TopItemsBarChart({
  title,
  description,
  metric,
  entries,
  color = CHART_COLORS.primary,
  emptyMessage = "There is nothing to rank yet.",
  notes,
  unitLabel = "units",
}: {
  title: string;
  description: string;
  /** What the bars are ranked by, written out under the title. */
  metric: string;
  entries: BarDatum[];
  color?: string;
  emptyMessage?: string;
  notes?: React.ReactNode;
  unitLabel?: string;
}) {
  const narrow = useIsNarrow();

  return (
    <ChartCard
      title={title}
      description={description}
      isEmpty={entries.length === 0}
      emptyMessage={emptyMessage}
      height={Math.max(200, Math.min(entries.length, 10) * 30 + 40)}
      notes={notes}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 480, height: 260 }}
      >
        <BarChart
          data={entries}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
          barCategoryGap="24%"
        >
          <CartesianGrid
            stroke={CHART_COLORS.grid}
            strokeDasharray="3 4"
            horizontal={false}
          />
          <XAxis
            type="number"
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickFormatter={(value: number) => formatQuantity(value)}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={narrow ? 92 : 132}
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            tickFormatter={(value: string) => truncateLabel(value, narrow ? 12 : 20)}
          />
          <Tooltip
            cursor={{ fill: "#F6F1E8" }}
            content={
              <ChartTooltip
                formatValue={(value) => `${formatQuantity(value)} ${unitLabel}`}
              />
            }
          />
          <Bar
            dataKey="value"
            name={metric}
            fill={color}
            radius={[0, 4, 4, 0]}
            maxBarSize={narrow ? 16 : 22}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
