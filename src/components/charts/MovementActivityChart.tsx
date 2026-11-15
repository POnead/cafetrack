"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard, ChartLegend } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { CHART_COLORS, formatCount } from "./theme";
import type { ActivitySlice } from "./types";

const MOVEMENT_ORDER = ["checkout", "restock", "waste"] as const;

export type MovementTransaction = {
  id: string;
  type: string;
  transaction_items: { sku: string; item_name: string }[] | null;
};

/**
 * How the movements break down, and which items keep turning up in them.
 *
 * The bars count transactions — one restock of a dozen items is one restock.
 * Picking a bar shows the items recorded most often for that kind of
 * movement, which is the frequency question, and not the quantity question:
 * an item checked out once with ten units counts once here and ten times in
 * the ranked quantity charts.
 *
 * Each item counts once per transaction for these purposes, the same rule
 * the reports page has always applied.
 */
export function MovementActivityChart({
  activity,
  transactions,
}: {
  activity: ActivitySlice[];
  transactions: MovementTransaction[];
}) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const rows = MOVEMENT_ORDER.map((type) =>
    activity.find((entry) => entry.type === type)
  ).filter((entry): entry is ActivitySlice => Boolean(entry));

  const activeType =
    selectedType && rows.some((entry) => entry.type === selectedType)
      ? selectedType
      : rows.find((entry) => entry.count > 0)?.type ?? null;

  const activeItems = useMemo(() => {
    if (!activeType) return [];
    const seenInTransaction = new Map<string, Set<string>>();
    const tally = new Map<string, { name: string; events: number }>();

    for (const transaction of transactions) {
      if (transaction.type !== activeType) continue;
      let seen = seenInTransaction.get(transaction.id);
      if (!seen) {
        seen = new Set<string>();
        seenInTransaction.set(transaction.id, seen);
      }
      for (const line of transaction.transaction_items ?? []) {
        // One event per item per transaction.
        if (seen.has(line.sku)) continue;
        seen.add(line.sku);
        const current = tally.get(line.sku) ?? {
          name: line.item_name,
          events: 0,
        };
        current.events += 1;
        tally.set(line.sku, current);
      }
    }

    return [...tally.entries()]
      .map(([sku, item]) => ({ sku, ...item }))
      .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name))
      .slice(0, 5);
  }, [activeType, transactions]);

  const selectedLabel = rows.find((row) => row.type === activeType)?.label ?? "";

  return (
    <ChartCard
      title="Transactions by activity"
      description="Select an activity to see the items recorded most often."
      isEmpty={rows.length === 0}
      emptyMessage="There are no movements to chart in this date range."
      height={220}
      legend={
        <ChartLegend
          items={rows.map((row) => ({
            color: row.color,
            label: row.label,
            value: formatCount(row.count),
          }))}
        />
      }
      footer={
        activeItems.length > 0 ? (
          <div className="rounded-xl border border-cream-200 bg-white p-3">
            <h3 className="mb-2 text-xs font-semibold text-cocoa-700">
              Most frequent items · {selectedLabel}
            </h3>
            <div className="space-y-1.5">
              {activeItems.map((item) => (
                <div
                  key={item.sku}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="min-w-0 truncate text-cocoa-600">{item.name}</span>
                  <span className="shrink-0 tabular-nums text-cocoa-500">
                    {item.events} {item.events === 1 ? "event" : "events"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-xl bg-cream-50 px-3 py-3 text-center text-xs text-cocoa-400">
            No item activity for this movement in this date range.
          </p>
        )
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 440, height: 220 }}
      >
        <BarChart
          data={rows}
          margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
          barCategoryGap="32%"
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
            interval={0}
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
            dataKey="count"
            name="Transactions"
            radius={[4, 4, 0, 0]}
            maxBarSize={72}
            isAnimationActive={false}
            onClick={(_data, index) => {
              const row = rows[index];
              if (row) setSelectedType(row.type);
            }}
          >
            {rows.map((row) => (
              <Cell
                key={row.type}
                fill={row.color}
                fillOpacity={activeType && row.type !== activeType ? 0.45 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
