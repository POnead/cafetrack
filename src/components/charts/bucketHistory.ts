import type { HistoryPoint } from "@/lib/inventory-history";

export type Grouping = "auto" | "daily" | "weekly" | "monthly";
export type HistoryGranularity = "day" | "week" | "month" | "quarter";

const DAY_MS = 86_400_000;
const ORDER: Record<HistoryGranularity, number> = {
  day: 0,
  week: 1,
  month: 2,
  quarter: 3,
};

function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * The first day of the period a day belongs to.
 *
 * The same convention the server uses, so client-side regrouping and the
 * server's own bucketing agree: weeks start on Monday.
 */
function periodStart(day: string, granularity: "week" | "month"): string {
  const at = dayStart(day);
  const date = new Date(at);
  if (granularity === "week") {
    const offset = (date.getUTCDay() + 6) % 7;
    return utcDay(at - offset * DAY_MS);
  }
  return utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function periodLabel(day: string, granularity: "week" | "month"): string {
  const date = new Date(dayStart(day));
  if (granularity === "month") {
    return date.toLocaleDateString("en-PH", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return date.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Re-bucket the series to the requested grouping.
 *
 * The grouping filter is applied client-side, which is what makes changing
 * it free of any network request. The server coarsens its series when a
 * range is long enough that a point every day would not fit; when that has
 * happened the coarser server granularity is kept instead of pretending to
 * be able to recover a daily series that was never returned.
 */
export function bucketHistoryPoints(
  points: HistoryPoint[],
  grouping: Grouping,
  granularity: HistoryGranularity
): { points: HistoryPoint[]; effective: HistoryGranularity } {
  if (grouping === "auto") {
    return { points, effective: granularity };
  }

  const target: HistoryGranularity =
    grouping === "daily" ? "day" : grouping === "weekly" ? "week" : "month";

  if (ORDER[granularity] <= ORDER[target]) {
    // The server series is at least as fine as the requested grouping:
    // regroup it, keeping each period's end value and its min/max.
    return { points: regroup(points, target as "week" | "month"), effective: target };
  }
  return { points, effective: granularity };
}

function regroup(
  points: HistoryPoint[],
  granularity: "week" | "month"
): HistoryPoint[] {
  const buckets = new Map<string, HistoryPoint[]>();
  for (const point of points) {
    const key = periodStart(point.day, granularity);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  return [...buckets.values()].map((bucket) => {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    let minCents = Infinity;
    let maxCents = -Infinity;
    for (const point of bucket) {
      if (point.valueCents < minCents) minCents = point.valueCents;
      if (point.valueCents > maxCents) maxCents = point.valueCents;
    }
    return {
      day: last.day,
      label: periodLabel(last.day, granularity),
      periodFrom: first.periodFrom,
      periodTo: last.periodTo,
      valueCents: last.valueCents,
      minCents,
      maxCents,
    };
  });
}
