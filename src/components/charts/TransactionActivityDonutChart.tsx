"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { CHART_COLORS, formatCount } from "./theme";
import type { ActivitySlice } from "./types";

/**
 * How the recorded movements divide between the kinds of movement.
 *
 * The counts are transaction counts, not units: a restock of twelve cups is
 * one restock. The units behind each count are in the footer, because the
 * two numbers answer different questions and a reader should not have to
 * guess which one they are looking at.
 */
export function TransactionActivityDonutChart({
  activity,
}: {
  activity: ActivitySlice[];
}) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const total = activity.reduce((sum, entry) => sum + entry.count, 0);
  const selected =
    activity.find((entry) => entry.type === selectedType) ?? activity[0] ?? null;

  return (
    <ChartCard
      title="Transaction activity"
      description={`${formatCount(total)} recorded movements`}
      isEmpty={total === 0}
      emptyMessage="There are no movements to chart in this date range."
      height={240}
      footer={
        selected ? (
          <p className="text-xs text-cocoa-400">
            {selected.label}: {formatCount(selected.qty)} units
          </p>
        ) : null
      }
    >
      <div className="flex h-full flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <div className="relative h-36 w-36 shrink-0">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 144, height: 144 }}
          >
            <PieChart>
              <Pie
                data={activity}
                dataKey="count"
                nameKey="label"
                name="Transactions"
                cx="50%"
                cy="50%"
                innerRadius="54%"
                outerRadius="82%"
                startAngle={90}
                endAngle={-270}
                stroke="#FFFFFF"
                strokeWidth={2}
                isAnimationActive={false}
                onClick={(data) => setSelectedType(String(data.payload?.type ?? ""))}
              >
                {activity.map((entry) => (
                  <Cell
                    key={entry.type}
                    fill={entry.color}
                    stroke={entry.type === selected?.type ? "#4B3A2E" : "#FFFFFF"}
                    strokeWidth={2}
                  />
                ))}
              </Pie>
              <Tooltip
                content={
                  <ChartTooltip
                    formatValue={(value) =>
                      `${formatCount(value)} transactions${
                        total ? ` · ${((value / total) * 100).toFixed(1)}%` : ""
                      }`
                    }
                  />
                }
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-bold tabular-nums text-cocoa-800">
              {formatCount(total)}
            </span>
            <span className="text-[9px] uppercase tracking-wide text-cocoa-400">
              movements
            </span>
          </div>
        </div>

        <div className="w-full max-w-xs space-y-1">
          {activity.map((entry) => (
            <button
              key={entry.type}
              type="button"
              onClick={() => setSelectedType(entry.type)}
              aria-pressed={selected?.type === entry.type}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                selected?.type === entry.type ? "bg-cream-100" : "hover:bg-cream-50"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden="true"
                />
                <span className="truncate text-cocoa-600">{entry.label}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-semibold tabular-nums text-cocoa-800">
                  {formatCount(entry.count)}
                </span>
                <span className="text-[10px] text-cocoa-400">
                  {total ? `${((entry.count / total) * 100).toFixed(1)}%` : "0%"}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </ChartCard>
  );
}

/** The colour a kind of movement is drawn in. */
export const ACTIVITY_COLORS: Record<string, string> = {
  checkout: CHART_COLORS.revenue,
  restock: CHART_COLORS.normal,
  waste: CHART_COLORS.stockOut,
};
