"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartCard, ChartLegend } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { CHART_COLORS, formatCount } from "./theme";
import type { StatusDatum } from "./types";

/**
 * How the stock is spread across the three stock states.
 *
 * The states come from `stockStatus()` in `@/lib/status` — the same function
 * the inventory table, the alerts and the dashboard use — so a chart can
 * never decide for itself what "low stock" means. The thresholds are the
 * item's own reorder threshold and zero, and they are not restated here.
 */
export function StockStatusDonutChart({
  status,
}: {
  status: StatusDatum[];
}) {
  const total = status.reduce((sum, entry) => sum + entry.count, 0);
  const isEmpty = total === 0;

  const legend = status
    .filter((entry) => entry.count > 0)
    .map((entry) => ({
      color: entry.color,
      label: entry.label,
      value: `${formatCount(entry.count)} · ${total ? ((entry.count / total) * 100).toFixed(1) : "0"}%`,
    }));

  return (
    <ChartCard
      title="Inventory status distribution"
      description="Every item in the current snapshot, by stock state."
      isEmpty={isEmpty}
      emptyMessage="There are no items to classify."
      legend={legend.length > 0 ? <ChartLegend items={legend} /> : undefined}
      height={240}
      notes={
        <>
          Stock status follows the rule the rest of CafeTrack uses: out of
          stock at zero, low stock at or below the item&apos;s own reorder
          threshold.
        </>
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 420, height: 240 }}
      >
        <PieChart>
          <Pie
            data={status}
            dataKey="count"
            nameKey="label"
            name="Items"
            cx="50%"
            cy="50%"
            innerRadius="52%"
            outerRadius="78%"
            startAngle={90}
            endAngle={-270}
            stroke="#FFFFFF"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {status.map((entry) => (
              <Cell
                key={entry.key}
                fill={entry.color}
                name={entry.label}
              />
            ))}
          </Pie>
          <Tooltip
            content={
              <ChartTooltip
                formatValue={(value) =>
                  `${formatCount(value)} items${
                    total ? ` · ${((value / total) * 100).toFixed(1)}%` : ""
                  }`
                }
              />
            }
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
