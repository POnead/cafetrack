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
import { CHART_COLORS, formatQuantity, truncateLabel, CHART_SERIES_MOTION } from "./theme";
import type { CategoryDatum } from "./types";

/**
 * How much stock each category holds.
 *
 * The quantities are the items' own — a category of syrups is counted in
 * bottles and a category of powders in kilograms — so the bars are a ranking
 * of the categories, not a comparison of like with like. The note under the
 * chart says so, because a bar chart invites the reading it cannot support.
 */
export function StockByCategoryChart({
  categories,
}: {
  categories: CategoryDatum[];
}) {
  const narrow = useIsNarrow();

  return (
    <ChartCard
      title="Stock quantity by category"
      description="Quantity on hand for each category, largest first."
      isEmpty={categories.length === 0}
      emptyMessage="There are no categories to chart."
      height={280}
      notes={
        <>
          Quantities are counted in each item&apos;s own unit — pieces,
          litres, kilograms, cans — so the totals are not directly comparable
          physical quantities. The bar is a ranking.
        </>
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 480, height: 280 }}
      >
        <BarChart
          data={categories}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
          barCategoryGap={narrow ? "26%" : "18%"}
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
                formatValue={(value) => formatQuantity(value)}
                extra="Counted in each item's own unit."
              />
            }
          />
          <Bar
            dataKey="quantity"
            name="Quantity on hand"
            fill={CHART_COLORS.primary}
            radius={[0, 4, 4, 0]}
            maxBarSize={narrow ? 16 : 22}
            {...CHART_SERIES_MOTION}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
