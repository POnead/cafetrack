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

/** The props a two-line axis tick receives from Recharts. */
type RankedTickProps = {
  x?: number | string;
  y?: number | string;
  payload?: { value?: string | number };
};

/**
 * A category-axis tick with the item's SKU under its name.
 *
 * The catalogue can hold two distinct items with the same name (the ledger
 * keeps both honestly), so the SKU is the identity on screen; the name is
 * the reading experience. Rows the catalogue no longer holds — deleted
 * items whose movements are still real — keep their historical name and are
 * tagged as archived.
 */
function makeRankedTick(entries: BarDatum[], width: number) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return function RankedTick(props: RankedTickProps) {
    const key = String(props.payload?.value ?? "");
    const entry = byKey.get(key);
    const x = Number(props.x ?? 0);
    const y = Number(props.y ?? 0);
    if (!entry) {
      return (
        <text x={x} y={y} textAnchor="end" fill={CHART_COLORS.axis} fontSize={11}>
          <tspan x={x} dy={4}>
            {truncateLabel(key, width)}
          </tspan>
        </text>
      );
    }
    const name = entry.archived
      ? `${entry.name} (archived)`
      : entry.name;
    return (
      <text
        x={x}
        y={y}
        textAnchor="end"
        fill={CHART_COLORS.axis}
        fontSize={11}
      >
        <tspan x={x} dy={-2}>
          {truncateLabel(name, width)}
        </tspan>
        {entry.sku && (
          <tspan x={x} dy={12} fontSize={9} fill={CHART_COLORS.axis} opacity={0.75}>
            {entry.sku}
          </tspan>
        )}
      </text>
    );
  };
}

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
  const tickWidth = narrow ? 96 : 152;

  return (
    <ChartCard
      title={title}
      description={description}
      isEmpty={entries.length === 0}
      emptyMessage={emptyMessage}
      height={Math.max(220, Math.min(entries.length, 10) * 36 + 40)}
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
            dataKey="key"
            width={tickWidth}
            tick={makeRankedTick(entries, narrow ? 12 : 19)}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: "#F6F1E8" }}
            content={
              <ChartTooltip
                titleFromPayload={(payload) => {
                  const datum = payload?.[0]?.payload as BarDatum | undefined;
                  if (!datum) return null;
                  return datum.archived ? `${datum.name} (archived)` : datum.name;
                }}
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
