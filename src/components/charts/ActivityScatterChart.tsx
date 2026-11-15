"use client";

import { useState } from "react";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartCard } from "./ChartCard";
import { ChartTooltip } from "./ChartTooltip";
import { CHART_COLORS, CHART_SERIES_MOTION } from "./theme";
import type { ScatterDatum } from "./types";

/**
 * Checkout events against waste events, one point per item.
 *
 * The counts are event counts, not quantities: an item checked out three
 * times contributes three, even if three units went with it. Each event
 * counts once per item per transaction, which is the rule the reports page
 * has always used — a line that appears twice in one transaction is one
 * event, not two.
 *
 * A point above the line is an item that has been wasted about as often as
 * it has been checked out; below the line, an item that moves out of the
 * door faster than it is written off.
 */
export function ActivityScatterChart({
  points,
  periodLabel,
}: {
  points: ScatterDatum[];
  periodLabel: string;
}) {
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const selected = points.find((point) => point.sku === selectedSku) ?? null;

  const maxCheckout = Math.max(...points.map((p) => p.checkoutEvents), 1);
  const maxWaste = Math.max(...points.map((p) => p.wasteEvents), 1);
  const midCheckout = maxCheckout / 2;
  const midWaste = maxWaste / 2;

  return (
    <ChartCard
      title="Checkout against waste"
      description={`One point per item · event counts, not quantities · ${periodLabel}`}
      isEmpty={points.length === 0}
      emptyMessage="There is no item activity to compare in this date range."
      height={300}
      footer={
        selected ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate font-semibold text-cocoa-800">
              {selected.name}{" "}
              <span className="font-normal text-cocoa-400">({selected.sku})</span>
            </span>
            <span className="shrink-0 tabular-nums text-cocoa-600">
              {selected.checkoutEvents} checkout · {selected.wasteEvents} waste
            </span>
          </div>
        ) : null
      }
      notes={
        <>
          Each event counts once per item per transaction, so items sharing a
          point overlap. Select a point to see the item behind it.
        </>
      }
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 520, height: 300 }}
      >
        <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 0 }}>
          <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 4" />
          <XAxis
            type="number"
            dataKey="checkoutEvents"
            name="Checkout events"
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            label={{
              value: "Checkout events",
              position: "insideBottom",
              offset: -12,
              fill: CHART_COLORS.axis,
              fontSize: 10,
            }}
          />
          <YAxis
            type="number"
            dataKey="wasteEvents"
            name="Waste events"
            tick={{ fill: CHART_COLORS.axis, fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.grid }}
            label={{
              value: "Waste events",
              angle: -90,
              position: "insideLeft",
              offset: 14,
              fill: CHART_COLORS.axis,
              fontSize: 10,
            }}
          />
          <ReferenceLine
            x={midCheckout}
            stroke={CHART_COLORS.neutral}
            strokeDasharray="4 4"
            strokeOpacity={0.65}
          />
          <ReferenceLine
            y={midWaste}
            stroke={CHART_COLORS.neutral}
            strokeDasharray="4 4"
            strokeOpacity={0.65}
          />
          <Tooltip
            cursor={{ strokeDasharray: "3 3", stroke: CHART_COLORS.neutral }}
            content={
              <ChartTooltip
                formatValue={(value) => `${value} events`}
                formatLabel={() => ""}
              />
            }
          />
          <Scatter
            data={points}
            name="Item"
            fill={CHART_COLORS.revenue}
            {...CHART_SERIES_MOTION}
            shape={(props) => {
              const point = props.payload as ScatterDatum | undefined;
              const wasteLeads =
                point !== undefined && point.wasteEvents > point.checkoutEvents;
              const isSelected = point !== undefined && point.sku === selectedSku;
              return (
                <circle
                  cx={props.cx}
                  cy={props.cy}
                  r={isSelected ? 6 : 4}
                  fill={wasteLeads ? CHART_COLORS.waste : CHART_COLORS.revenue}
                  fillOpacity={0.85}
                  stroke="#FFFFFF"
                  strokeWidth={1.5}
                  role="button"
                  tabIndex={0}
                  aria-label={
                    point
                      ? `${point.name}: ${point.checkoutEvents} checkout events, ${point.wasteEvents} waste events`
                      : undefined
                  }
                  className="cursor-pointer outline-none focus:stroke-cocoa-800"
                  onClick={() => point && setSelectedSku(point.sku)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (point) setSelectedSku(point.sku);
                    }
                  }}
                />
              );
            }}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
