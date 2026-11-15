"use client";

import { useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { MONEY_SERIES } from "./theme";
import { formatPeso } from "@/lib/format";
import type { MoneySlice } from "./types";

/**
 * One total, split across the items that make it up.
 *
 * The figures are the ones the reports page has always calculated: the
 * quantity moved multiplied by the item's current unit price. Seven items
 * are shown by name and the rest are grouped, so the chart stays readable
 * instead of turning into a wheel of slices.
 *
 * The donut is a way in, not the only way: the list beside it carries the
 * exact figures, and picking either one shows what it is made of.
 */
export function ValueBreakdownChart({
  title,
  description,
  slices,
  totalCents,
  emptyMessage,
}: {
  title: string;
  description: string;
  slices: MoneySlice[];
  totalCents: number;
  emptyMessage: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const activeKey =
    selectedKey && slices.some((slice) => slice.key === selectedKey)
      ? selectedKey
      : slices[0]?.key ?? null;
  const active = slices.find((slice) => slice.key === activeKey) ?? null;

  const chartTotal = slices.reduce((sum, slice) => sum + slice.valueCents, 0);

  return (
    <ChartCard
      title={title}
      description={description}
      isEmpty={slices.length === 0}
      emptyMessage={emptyMessage}
      height={260}
      footer={
        active ? (
          <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="truncate text-sm font-semibold text-cocoa-800">
                {active.name}
              </h3>
              <span className="shrink-0 text-sm font-bold tabular-nums text-cocoa-800">
                {formatPeso(active.valueCents)}
              </span>
            </div>
            <div className="space-y-1.5">
              {active.items.map((item) => (
                <div
                  key={item.sku}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-cream-200/80 pt-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-cocoa-700">
                    {item.name}{" "}
                    <span className="text-cocoa-400">({item.sku})</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-cocoa-500">
                    {item.quantity.toLocaleString("en-PH")} ×{" "}
                    {formatPeso(Math.round(item.unitPrice * 100))}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-cocoa-800">
                    {formatPeso(item.valueCents)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null
      }
      notes={
        <>
          Values use each item&apos;s current unit price — they are estimates at
          today&apos;s prices, not historical sales receipts.
        </>
      }
    >
      <div className="grid h-full grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[minmax(140px,0.85fr)_minmax(0,1.15fr)] sm:gap-4">
        <div className="relative mx-auto h-full w-full max-w-[11rem]">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 160, height: 260 }}
          >
            <PieChart>
              <Pie
                data={slices}
                dataKey="valueCents"
                nameKey="name"
                name="Value"
                cx="50%"
                cy="50%"
                innerRadius="52%"
                outerRadius="80%"
                startAngle={90}
                endAngle={-270}
                stroke="#FFFFFF"
                strokeWidth={2}
                isAnimationActive={false}
                onClick={(data) => setSelectedKey(String(data.payload?.key ?? ""))}
              >
                {slices.map((slice, index) => (
                  <Cell
                    key={slice.key}
                    fill={MONEY_SERIES[index % MONEY_SERIES.length]}
                    stroke={slice.key === activeKey ? "#4B3A2E" : "#FFFFFF"}
                    strokeWidth={2}
                  />
                ))}
              </Pie>
              <Tooltip
                content={
                  <ChartTooltip
                    formatValue={(value) =>
                      `${formatPeso(Math.round(value))}${
                        chartTotal
                          ? ` · ${((value / chartTotal) * 100).toFixed(1)}%`
                          : ""
                      }`
                    }
                  />
                }
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-cocoa-400">
              Total
            </span>
            <span className="mt-0.5 max-w-[6.5rem] truncate text-sm font-bold tabular-nums text-cocoa-800">
              {formatPeso(totalCents)}
            </span>
          </div>
        </div>

        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-cocoa-400">
            Select a slice or an item
          </p>
          <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
            {slices.map((slice, index) => (
              <button
                key={slice.key}
                type="button"
                onClick={() => setSelectedKey(slice.key)}
                aria-pressed={activeKey === slice.key}
                className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors ${
                  activeKey === slice.key ? "bg-cream-100" : "hover:bg-cream-50"
                }`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: MONEY_SERIES[index % MONEY_SERIES.length] }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-cocoa-700">
                  {slice.name}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-cocoa-800">
                  {formatPeso(slice.valueCents)}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </ChartCard>
  );
}
