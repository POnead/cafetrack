/**
 * Historical inventory reconstruction for the Reports page.
 *
 * CafeTrack stores the *current* unit price on the item and the on-hand
 * quantity on the item too. It does not keep a price history and it does not
 * keep a stock snapshot per day. What it does keep is the movement ledger:
 * `transaction_items` records `qty_before` and `qty_after` for every line, so
 * the on-hand quantity of every item at any point in time can be rebuilt from
 * the movements that produced it.
 *
 * That rebuild is what this module does. It answers one question — "what was
 * on hand, and what was it worth, on a given day" — and it is deliberately
 * explicit about the two things it cannot know:
 *
 *   - the *price* of a past day. There is no price history, so a past value is
 *     an estimate at today's prices, not a historical valuation. The caller
 *     has to say so on screen.
 *   - the *quantity* of an item that never moved, or whose movements fell
 *     outside the scanned window. There is no record to rebuild it from, so
 *     the current quantity is used and the item is counted as unverifiable.
 *
 * Nothing here writes to the database and nothing here changes how movements
 * are processed. It is a read-only reconstruction over records that already
 * exist.
 */
import { db, usingLocalDb } from "./supabase";
import { memoize } from "./ttl-cache";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type HistoryGranularity = "day" | "week" | "month" | "quarter";

export type HistoryPoint = {
  /** The day this point measures (YYYY-MM-DD). */
  day: string;
  /** Axis label. */
  label: string;
  /** First day of the period this point covers. */
  periodFrom: string;
  /** Last day of the period this point covers. */
  periodTo: string;
  /** Reconstructed on-hand value at the end of the period. */
  valueCents: number;
  /** Lowest daily value inside the period. */
  minCents: number;
  /** Highest daily value inside the period. */
  maxCents: number;
};

export type HistoryCoverage = {
  /** Earliest movement actually scanned (ISO timestamp), or null if none. */
  historyFrom: string | null;
  /** Latest movement actually scanned (ISO timestamp), or null if none. */
  historyTo: string | null;
  /** Movement lines read out of the ledger. */
  movementsScanned: number;
  /** Transactions read out of the ledger. */
  transactionsScanned: number;
  /** The scan cap that was applied. */
  cap: number;
  /** True when the ledger holds more movements than the cap allows. */
  truncated: boolean;
};

export type HistoryValuation = {
  /** Items in the requested category, or the whole inventory without one. */
  itemsInScope: number;
  /** Items that carry a unit price and are therefore valued. */
  pricedItems: number;
  /** Items excluded from the valuation because they have no unit price. */
  unpricedItems: number;
  /** Items whose historical quantity could not be verified from movements. */
  unverifiableItems: number;
  /** Items whose latest movement disagrees with the current quantity. */
  divergentItems: number;
};

export type InventoryHistory = {
  points: HistoryPoint[];
  /** The granularity actually used to fit the series into the point budget. */
  granularity: HistoryGranularity;
  coverage: HistoryCoverage;
  valuation: HistoryValuation;
  requested: { from: string; to: string; category: string | null };
};

/**
 * A request the caller got wrong.
 *
 * A distinct type rather than a plain Error so the route can answer 400
 * instead of letting a bad request become a 500.
 */
export class HistoryRequestError extends Error {}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/**
 * How many movements one scan may read.
 *
 * The same ceiling the analytics endpoint uses, and for the same reason: a
 * scan that walks an unbounded ledger is a scan that can take the request
 * down. The limit is detected rather than assumed — see the probe below — so
 * a truncated history is always reported as truncated.
 */
const SCAN_CAP = 50_000;

/** Rows per page while paging the ledger. */
const PAGE_SIZE = 500;

/**
 * How many points a series may hold.
 *
 * A point per day is right for a week or a month and unreadable for a decade,
 * so the timeline is coarsened until it fits. The first and last day of the
 * requested range are always kept as points of their own, and so is the day
 * with the largest change, so reducing the timeline never hides the
 * boundaries or the biggest move.
 */
const MAX_POINTS = 400;

/** The longest range a request may ask for: ten years. */
export const MAX_RANGE_DAYS = 3653;

/* ------------------------------------------------------------------ */
/* Raw scan                                                            */
/* ------------------------------------------------------------------ */

type RawMovement = {
  sku: string;
  /** Epoch milliseconds of the movement. */
  at: number;
  qtyBefore: number;
  qtyAfter: number;
};

type RawItem = {
  sku: string;
  name: string;
  /** Current on-hand quantity — the fallback for items that never moved. */
  quantity: number;
  /** Current unit price in pesos; null when the item has no price. */
  unitPrice: number | null;
  categoryId: string | null;
};

type RawScan = {
  items: RawItem[];
  movements: RawMovement[];
  transactionsScanned: number;
  movementsScanned: number;
  historyFrom: string | null;
  historyTo: string | null;
  truncated: boolean;
};

/**
 * Which database this process is talking to.
 *
 * The memo cache is a process-wide map keyed by string, so two configurations
 * sharing a key would share an answer — a local PGlite scan handed to a
 * Supabase reader, or a throwaway test database's scan handed to the live
 * one. The key therefore names the backend, the database directory and the
 * Supabase project, so a scan can only ever be reused by the configuration
 * that produced it.
 */
function dbScope(): string {
  const dir = (process.env.CAFETRACK_DB_DIR ?? "").trim() || "default";
  if (usingLocalDb) return `local:${dir}`;
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  return `supabase:${dir}:${url}`;
}

/**
 * Read the items and the movement ledger.
 *
 * The scan is the expensive part and its answer does not depend on the
 * request, so it is memoised. The filtered series built from it is not
 * memoised: it depends on the requested range and category, and caching that
 * per user would hand one person's filtered answer to another.
 */
async function scanRaw(): Promise<RawScan> {
  const itemResult = await db()
    .from("items")
    .select(`sku, name, quantity, unit_price, category_id`)
    .eq("item_status", "active")
    .order("name", { ascending: true });

  if (itemResult.error) throw new Error(itemResult.error.message);

  const items: RawItem[] = (itemResult.data ?? []).map((row: any) => ({
    sku: String(row.sku),
    name: String(row.name ?? row.sku),
    quantity: Number(row.quantity ?? 0),
    unitPrice:
      row.unit_price === null || row.unit_price === undefined
        ? null
        : Number(row.unit_price),
    categoryId: row.category_id ? String(row.category_id) : null,
  }));

  /*
   * The ledger is read newest-first.
   *
   * Newest-first rather than oldest-first because the recent end is what the
   * reports page asks about: a truncated scan should still describe this
   * week accurately and lose the distant past, rather than describe the
   * distant past accurately and lose the present. It also matches the
   * analytics endpoint's ordering, and — like that endpoint — the second
   * sort key is the row id, so rows with the same timestamp come back in a
   * stable order and paging cannot show one row twice and skip another.
   */
  const txns: any[] = [];
  let offset = 0;
  let truncated = false;

  while (txns.length < SCAN_CAP) {
    const { data, error } = await db()
      .from("transactions")
      .select(
        `id, created_at, transaction_items(sku, quantity, qty_before, qty_after)`
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(error.message);

    const page = (data ?? []) as any[];
    txns.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  if (txns.length >= SCAN_CAP) {
    /*
     * The loop ended on the cap rather than on a short page, so there may or
     * may not be one more row. A single probe settles it — reading the whole
     * tail would be the walk this cap exists to avoid.
     */
    const { data: probe, error: probeError } = await db()
      .from("transactions")
      .select("id")
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(SCAN_CAP, SCAN_CAP);

    if (probeError) throw new Error(probeError.message);
    truncated = ((probe ?? []) as any[]).length > 0;
  }

  const movements: RawMovement[] = [];
  let earliest: number | null = null;
  let latest: number | null = null;

  for (const txn of txns) {
    const at = new Date(txn.created_at).getTime();
    if (!Number.isFinite(at)) continue;

    if (earliest === null || at < earliest) earliest = at;
    if (latest === null || at > latest) latest = at;

    for (const line of txn.transaction_items ?? []) {
      const qtyBefore = Number(line.qty_before);
      const qtyAfter = Number(line.qty_after);
      if (!Number.isFinite(qtyBefore) || !Number.isFinite(qtyAfter)) continue;
      movements.push({
        sku: String(line.sku ?? ""),
        at,
        qtyBefore,
        qtyAfter,
      });
    }
  }

  return {
    items,
    movements,
    transactionsScanned: txns.length,
    movementsScanned: movements.length,
    historyFrom: earliest === null ? null : new Date(earliest).toISOString(),
    historyTo: latest === null ? null : new Date(latest).toISOString(),
    truncated,
  };
}

/** The memoised scan. Keyed by database configuration, never by user. */
function rawScan(): Promise<RawScan> {
  return memoize(`inventory:history:raw:${dbScope()}`, 15_000, scanRaw);
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD for an instant, in UTC — the same day the ledger APIs use. */
function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Epoch ms of the start of a UTC day. */
function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** Epoch ms of the end of a UTC day. */
function dayEnd(day: string): number {
  return Date.parse(`${day}T23:59:59.999Z`);
}

/**
 * A YYYY-MM-DD string that names a real calendar day.
 *
 * The shape check alone is not enough: Postgres would roll 2026-02-30 over
 * into March rather than refusing it, so the value is round-tripped through
 * a Date and compared with the input. The same test the transaction API
 * applies to its own `from`/`to`.
 */
export function isCalendarDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    new Date(parsed.getTime()).toISOString().slice(0, 10) === value
  );
}

/** Today, as a UTC calendar day. */
export function todayUtcDay(): string {
  return utcDay(Date.now());
}

/** How many days from `from` to `to`, inclusive. Negative when reversed. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;
}

/* ------------------------------------------------------------------ */
/* Buckets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The first day of the period a day belongs to.
 *
 * Weeks start on Monday, matching the reports page's own week grouping, so
 * the two never disagree about where a week begins.
 */
function periodStart(day: string, granularity: HistoryGranularity): string {
  const at = dayStart(day);
  const date = new Date(at);
  if (granularity === "week") {
    const offset = (date.getUTCDay() + 6) % 7;
    return utcDay(at - offset * DAY_MS);
  }
  if (granularity === "month") {
    return utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
  if (granularity === "quarter") {
    return utcDay(
      Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1)
    );
  }
  return day;
}

/** A short axis label for a period. */
function periodLabel(day: string, granularity: HistoryGranularity): string {
  const date = new Date(dayStart(day));
  if (granularity === "month") {
    return date.toLocaleDateString("en-PH", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  if (granularity === "quarter") {
    const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
    return `Q${quarter} ${date.getUTCFullYear()}`;
  }
  return date.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/* ------------------------------------------------------------------ */
/* Reconstruction                                                      */
/* ------------------------------------------------------------------ */

type SkuHistory = {
  sku: string;
  /** Current on-hand quantity from `items`. */
  quantity: number;
  unitPrice: number | null;
  /** Movements for this SKU, oldest first. */
  steps: { at: number; qtyAfter: number }[];
  /** `qty_before` of the earliest scanned movement for this SKU. */
  firstBefore: number | null;
  /** `qty_after` of the latest scanned movement for this SKU. */
  lastAfter: number | null;
};

/**
 * Group the scanned movements into a per-SKU timeline.
 *
 * The rule the reconstruction follows, in one place:
 *
 *   - before a SKU's first recorded movement, the balance is that movement's
 *     `qty_before` — the true on-hand quantity just before it, held constant
 *     backwards. Today's quantity is never used to backfill a SKU that has
 *     movement history, because today's quantity says nothing about last
 *     Tuesday;
 *   - on or after a movement, the balance is the `qty_after` of the latest
 *     movement that has happened;
 *   - after a SKU's last movement, the balance is that movement's
 *     `qty_after`;
 *   - a SKU with no recorded movement has no history to rebuild, so the
 *     current quantity is used and the SKU is counted as unverifiable.
 */
function buildTimelines(scan: RawScan): Map<string, SkuHistory> {
  const timelines = new Map<string, SkuHistory>();

  for (const item of scan.items) {
    timelines.set(item.sku, {
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      steps: [],
      firstBefore: null,
      lastAfter: null,
    });
  }

  /*
   * The scan is newest-first, so the first movement seen for a SKU is its
   * newest one. The oldest is tracked separately — it is the one whose
   * `qty_before` is the baseline for every earlier day.
   */
  const earliestAt = new Map<string, number>();
  const earliestBefore = new Map<string, number>();

  for (const movement of scan.movements) {
    const timeline = timelines.get(movement.sku);
    // A movement for an item that is no longer active is left out of the
    // valuation: the snapshot the report shows does not include it either.
    if (!timeline) continue;

    timeline.steps.push({ at: movement.at, qtyAfter: movement.qtyAfter });

    const known = earliestAt.get(movement.sku);
    if (known === undefined || movement.at < known) {
      earliestAt.set(movement.sku, movement.at);
      earliestBefore.set(movement.sku, movement.qtyBefore);
    }
  }

  for (const timeline of timelines.values()) {
    timeline.steps.sort((a, b) => a.at - b.at);
    if (timeline.steps.length > 0) {
      timeline.firstBefore = earliestBefore.get(timeline.sku) ?? null;
      timeline.lastAfter = timeline.steps[timeline.steps.length - 1].qtyAfter;
    }
  }

  return timelines;
}

/* ------------------------------------------------------------------ */
/* Series                                                              */
/* ------------------------------------------------------------------ */

/**
 * Build the historical series for one range and category.
 *
 * `from` may be null, which means "as far back as the scanned history
 * reaches" — the caller decides what the floor is.
 */
export async function buildInventoryHistory(input: {
  from: string | null;
  to: string;
  category: string | null;
}): Promise<InventoryHistory> {
  const scan = await rawScan();

  const earliestHistory = scan.historyFrom
    ? utcDay(new Date(scan.historyFrom).getTime())
    : null;

  const to = input.to;
  let from = input.from ?? earliestHistory ?? to;
  if (from > to) {
    // The requested range starts after the range ends. That can only happen
    // when `from` was derived rather than supplied, and the honest answer is
    // the single day that was asked about.
    from = to;
  }

  const dayCount = daysBetween(from, to);
  if (dayCount > MAX_RANGE_DAYS) {
    throw new HistoryRequestError(
      "Choose a date range of ten years or less for the inventory history"
    );
  }

  const days: string[] = [];
  for (let at = dayStart(from); at <= dayStart(to); at += DAY_MS) {
    days.push(utcDay(at));
  }
  if (days.length === 0) days.push(from);

  /* ---- items in scope ---- */

  const scoped = scan.items.filter(
    (item) => !input.category || item.categoryId === input.category
  );

  const timelines = buildTimelines(scan);

  const valued = scoped.filter((item) => item.unitPrice !== null);
  const unpricedItems = scoped.length - valued.length;
  const unverifiableItems = scoped.filter(
    (item) => (timelines.get(item.sku)?.steps.length ?? 0) === 0
  ).length;
  const divergentItems = scoped.filter((item) => {
    const timeline = timelines.get(item.sku);
    if (!timeline || timeline.steps.length === 0) return false;
    const last = timeline.steps[timeline.steps.length - 1].qtyAfter;
    return Math.abs(last - item.quantity) > 0.0005;
  }).length;

  /* ---- daily values ---- */

  /*
   * One walk per valued item over the days, advancing a pointer into that
   * item's movement timeline.
   *
   * The pointer carries the balance: it starts at the first movement's
   * `qty_before` (so every day before the first movement reads that true
   * balance) and is replaced by each movement's `qty_after` as the days pass
   * it (so every day on or after a movement reads the latest applicable
   * `qty_after`). A movement after the last day of the range is never
   * applied, and the balance after the last movement stays that movement's
   * `qty_after` rather than today's quantity.
   */
  const dayEnds = days.map((day) => dayEnd(day));
  const seriesPerItem: number[][] = [];

  for (const item of valued) {
    const timeline = timelines.get(item.sku);
    const series: number[] = [];
    let index = 0;
    let current: number;

    if (!timeline || timeline.steps.length === 0) {
      // No recorded movement: the current quantity is the only number there
      // is. It is counted as unverifiable above and disclosed on screen.
      current = item.quantity;
    } else {
      current = timeline.firstBefore ?? item.quantity;
    }

    for (const endOfDay of dayEnds) {
      if (timeline) {
        while (
          index < timeline.steps.length &&
          timeline.steps[index].at <= endOfDay
        ) {
          current = timeline.steps[index].qtyAfter;
          index += 1;
        }
      }
      series.push(current);
    }
    seriesPerItem.push(series);
  }

  const daily: { day: string; valueCents: number }[] = [];
  for (let d = 0; d < days.length; d += 1) {
    let total = 0;
    for (let i = 0; i < seriesPerItem.length; i += 1) {
      const quantity = seriesPerItem[i][d];
      if (!Number.isFinite(quantity)) continue;
      total += quantity * (valued[i].unitPrice as number);
    }
    daily.push({ day: days[d], valueCents: Math.round(total * 100) });
  }

  /* ---- fit the series into the point budget ---- */

  /*
   * Nothing can be valued when no item in scope carries a price — a flat
   * zero line would read as "this stock is worth nothing" rather than "this
   * stock has no price yet", so an empty series is returned instead and the
   * interface says which of the two it is.
   */
  const granularity = chooseGranularity(days.length);
  const points = valued.length === 0 ? [] : buildPoints(daily, granularity);

  return {
    points,
    granularity,
    coverage: {
      historyFrom: scan.historyFrom,
      historyTo: scan.historyTo,
      movementsScanned: scan.movementsScanned,
      transactionsScanned: scan.transactionsScanned,
      cap: SCAN_CAP,
      truncated: scan.truncated,
    },
    valuation: {
      itemsInScope: scoped.length,
      pricedItems: valued.length,
      unpricedItems,
      unverifiableItems,
      divergentItems,
    },
    requested: { from, to, category: input.category },
  };
}

/** The finest granularity whose point count fits the budget. */
function chooseGranularity(dayCount: number): HistoryGranularity {
  if (dayCount <= MAX_POINTS) return "day";
  if (dayCount <= MAX_POINTS * 7) return "week";
  if (dayCount <= MAX_POINTS * 31) return "month";
  return "quarter";
}

/**
 * Turn the daily series into points.
 *
 * A period's value is the balance at the end of the period, never an
 * average: an average is a number no stock level ever had. The minimum and
 * maximum inside the period are kept alongside it, so a spike that a period
 * view smooths over still shows in the tooltip.
 *
 * The first and last day of the range are always points of their own, and so
 * is the day with the largest change, so that reducing the timeline keeps
 * the boundaries and the biggest move.
 */
function buildPoints(
  daily: { day: string; valueCents: number }[],
  granularity: HistoryGranularity
): HistoryPoint[] {
  if (daily.length === 0) return [];

  const buckets = new Map<string, { day: string; valueCents: number }[]>();
  for (const entry of daily) {
    const key = periodStart(entry.day, granularity);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  const points: HistoryPoint[] = [];
  for (const [, bucket] of buckets) {
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    let min = first.valueCents;
    let max = first.valueCents;
    for (const entry of bucket) {
      if (entry.valueCents < min) min = entry.valueCents;
      if (entry.valueCents > max) max = entry.valueCents;
    }
    points.push({
      day: last.day,
      label: periodLabel(last.day, granularity),
      periodFrom: first.day,
      periodTo: last.day,
      valueCents: last.valueCents,
      minCents: min,
      maxCents: max,
    });
  }

  /* The start of the range, kept even when the first period is longer. */
  const startValue = daily[0].valueCents;
  if (points.length === 0 || points[0].day !== daily[0].day) {
    points.unshift({
      day: daily[0].day,
      label: periodLabel(daily[0].day, granularity),
      periodFrom: daily[0].day,
      periodTo: daily[0].day,
      valueCents: startValue,
      minCents: startValue,
      maxCents: startValue,
    });
  }

  /* The biggest change in the range, kept even if its period is longer. */
  let biggest: { day: string; valueCents: number } | null = null;
  let biggestChange = 0;
  for (let i = 1; i < daily.length; i += 1) {
    const change = Math.abs(daily[i].valueCents - daily[i - 1].valueCents);
    if (change > biggestChange) {
      biggestChange = change;
      biggest = daily[i];
    }
  }
  if (biggest) {
    const known = points.some((point) => point.day === biggest?.day);
    if (!known) {
      const inserted: HistoryPoint = {
        day: biggest.day,
        label: periodLabel(biggest.day, granularity),
        periodFrom: biggest.day,
        periodTo: biggest.day,
        valueCents: biggest.valueCents,
        minCents: biggest.valueCents,
        maxCents: biggest.valueCents,
      };
      const at = points.findIndex((point) => point.day > biggest!.day);
      if (at === -1) points.push(inserted);
      else points.splice(at, 0, inserted);
    }
  }

  return points;
}
