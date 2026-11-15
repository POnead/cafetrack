/**
 * Historical inventory reconstruction for the Reports page — the pure part.
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
 *
 * This file is deliberately free of Next.js, the database and the app's auth
 * stack, so the reconstruction can be driven by synthetic ledgers in tests.
 * The package that actually talks to a database lives in
 * `inventory-history.ts`.
 */

import {
  dayKeyInZone,
  dayKeyWeekday,
  isCalendarDayString,
  isValidTimeZone,
  shiftDayKey,
  zonedDayEndUtc,
} from "./zoned-time";

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

export type HistoryCompleteness = "complete" | "truncated" | "unknown";

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
  /** True when more history was known to exist than the cap allows. */
  truncated: boolean;
  /**
   * Whether the scan saw the whole ledger.
   *
   *   - "complete": the ledger ended inside the cap, or the probe found
   *     nothing past it — nothing was missed.
   *   - "truncated": a movement line was left behind, or the probe found
   *     one past the cap — history is definitively incomplete.
   *   - "unknown": the cap was consumed exactly at a page boundary and the
   *     bounded probe could not establish whether more lines exist.
   *
   * Callers must treat "unknown" as unverified, not as complete.
   */
  completeness: HistoryCompleteness;
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
  requested: {
    /** The start the caller asked for — or the earliest coverage, when it asked for everything. */
    from: string;
    to: string;
    category: string | null;
    /** The timezone the day keys mean — "UTC" unless the caller named one. */
    timeZone: string;
    /**
     * The start the series actually covers. Equals `from` unless the scanned
     * history was incomplete and could not be verified further back — in
     * which case the series starts at the earliest available movement and
     * `rangeShortened` is true.
     */
    effectiveFrom: string;
    /**
     * True when the caller asked for a start earlier than the scanned
     * coverage and the series was shortened to what could be verified.
     */
    rangeShortened: boolean;
  };
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
 * How many movement lines one scan may read.
 *
 * The same ceiling the analytics endpoint uses, and for the same reason: a
 * scan that walks an unbounded ledger is a scan that can take the request
 * down. The limit is detected rather than assumed — see the probe below — so
 * a truncated history is always reported as truncated.
 */
export const SCAN_CAP = 50_000;

/**
 * How many transaction rows one scan may read.
 *
 * The line cap alone does not bound the walk: a ledger holding an enormous
 * number of transactions that carry no movement lines would be paged forever,
 * growing no reconstruction and never reaching the cap. 50,000 rows matches
 * the ten-year range ceiling the endpoint accepts (~14 movements a day for
 * ten years), so an ordinary ledger never feels it, while a pathological
 * line-free ledger costs at most 100 pages before this limit stops the
 * walk. The cap is a budget for rows examined, not a promise about what
 * remains — stopping at it is never reported as "complete" on its own: the
 * bounded probe below decides, and an undecidable answer is reported as
 * "unknown".
 */
export const MAX_TRANSACTION_ROWS = 50_000;

/** Rows per page while paging the ledger. */
export const PAGE_SIZE = 500;

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

export type RawMovement = {
  sku: string;
  /** Epoch milliseconds of the movement. */
  at: number;
  qtyBefore: number;
  qtyAfter: number;
};

export type RawItem = {
  sku: string;
  name: string;
  /** Current on-hand quantity — the fallback for items that never moved. */
  quantity: number;
  /** Current unit price in pesos; null when the item has no price. */
  unitPrice: number | null;
  categoryId: string | null;
};

export type RawScan = {
  items: RawItem[];
  movements: RawMovement[];
  transactionsScanned: number;
  movementsScanned: number;
  historyFrom: string | null;
  historyTo: string | null;
  truncated: boolean;
  completeness: HistoryCompleteness;
};

/** A transaction row as the scan reads it. */
export type RawTxnRow = {
  id: string;
  created_at: string;
  transaction_items: {
    id?: string;
    sku: string;
    quantity: number | string;
    qty_before: number | string;
    qty_after: number | string;
  }[] | null;
};

/**
 * The two reads the scan makes, behind one seam so the tests can drive the
 * scan with a synthetic ledger. Nothing about the real queries changes — the
 * database package implements exactly this shape.
 */
export type LedgerSource = {
  fetchItems(): Promise<RawItem[]>;
  fetchTransactionPage(offset: number, limit: number): Promise<RawTxnRow[]>;
};

/** Enough pages for the probe to decide "complete" on an ordinary ledger. */
const PROBE_PAGES = 4;

/**
 * Movement lines of one transaction, in a stable order.
 *
 * The order the database returns an embedded array in is unspecified, so the
 * lines are sorted by their id: the same ledger then reads back the same way
 * on every scan, which is what keeps a rebuilt history reproducible and
 * keeps the cap's trimming deterministic.
 */
function linesOf(transaction: RawTxnRow) {
  const lines = [...(transaction.transaction_items ?? [])];
  lines.sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
  return lines;
}

/**
 * Ask the ledger whether one more movement line exists past the cap.
 *
 * The probe reads at most PROBE_PAGES pages of transactions. It never
 * reports "complete" on the strength of an undecided answer: if the bounded
 * scan cannot find the line, but cannot rule it out either (every page was
 * full and none carried a line), the answer is "unknown".
 */
async function probeForNextLine(
  source: LedgerSource,
  offset: number
): Promise<HistoryCompleteness> {
  for (let page = 0; page < PROBE_PAGES; page += 1) {
    const rows = await source.fetchTransactionPage(
      offset + page * PAGE_SIZE,
      PAGE_SIZE
    );
    if (rows.length === 0) return "complete"; // the ledger ended
    for (const transaction of rows) {
      if (linesOf(transaction).length > 0) return "truncated";
    }
    if (rows.length < PAGE_SIZE) return "complete"; // the ledger ended
    // A full page of nothing but empty transactions tells us nothing: the
    // next page might hold the line, so the probe moves on.
  }
  return "unknown";
}

/**
 * Read the items and the movement ledger.
 *
 * The scan is the expensive part and its answer does not depend on the
 * request. The memoised entry point lives in the database package; this one
 * is the computation itself, driven by whatever source is given.
 */
export async function scanLedger(source: LedgerSource): Promise<RawScan> {
  const items = await source.fetchItems();

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
   *
   * The cap is on movement lines, not on transactions: a transaction with
   * thirty items is thirty lines, and counting it once would quietly hand
   * back thirty times more history than the cap promises. A separate cap
   * bounds rows examined — see MAX_TRANSACTION_ROWS.
   */
  const movements: RawMovement[] = [];
  let offset = 0;
  let scannedLines = 0;
  let transactionsScanned = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  let completeness: HistoryCompleteness | null = null;

  while (
    scannedLines < SCAN_CAP &&
    transactionsScanned < MAX_TRANSACTION_ROWS
  ) {
    const page = await source.fetchTransactionPage(offset, PAGE_SIZE);

    if (page.length === 0) {
      // The ledger ended inside the cap: nothing was missed.
      completeness = "complete";
      break;
    }

    let stopped = false;
    let transactionCapHit = false;
    let examinedOnThisPage = 0;
    for (const transaction of page) {
      if (transactionsScanned >= MAX_TRANSACTION_ROWS) {
        // The transaction budget is exhausted and more rows exist past this
        // one. `offset + examinedOnThisPage` is the first unexamined row, so
        // the probe starts exactly there — nothing is skipped or counted
        // twice.
        transactionCapHit = true;
        break;
      }
      examinedOnThisPage += 1;
      const at = new Date(transaction.created_at).getTime();
      if (!Number.isFinite(at)) {
        // An unreadable timestamp still yields the lines themselves: each
        // carries qty_before/qty_after, and only the date is lost. Skipping
        // the whole row would silently drop recorded movements.
        for (const line of linesOf(transaction)) {
          if (scannedLines >= SCAN_CAP) {
            stopped = true;
            break;
          }
          // Every row read consumes the budget, even one whose quantities
          // cannot be used — the cap is about rows, not about validity.
          scannedLines += 1;
          const qtyBefore = Number(line.qty_before);
          const qtyAfter = Number(line.qty_after);
          if (!Number.isFinite(qtyBefore) || !Number.isFinite(qtyAfter)) continue;
          movements.push({
            sku: String(line.sku ?? ""),
            at: Number.NaN,
            qtyBefore,
            qtyAfter,
          });
        }
        if (!stopped) transactionsScanned += 1;
        if (stopped) break;
        continue;
      }

      for (const line of linesOf(transaction)) {
        if (scannedLines >= SCAN_CAP) {
          // There is at least one more row recorded beyond the cap: the
          // history definitively does not reach the 50,000-row mark.
          stopped = true;
          break;
        }
        // Every row read consumes the budget, even one whose quantities
        // cannot be used — the cap is about rows, not about validity.
        scannedLines += 1;
        const qtyBefore = Number(line.qty_before);
        const qtyAfter = Number(line.qty_after);
        if (!Number.isFinite(qtyBefore) || !Number.isFinite(qtyAfter)) continue;
        movements.push({
          sku: String(line.sku ?? ""),
          at,
          qtyBefore,
          qtyAfter,
        });
        if (earliest === null || at < earliest) earliest = at;
        if (latest === null || at > latest) latest = at;
      }

      if (stopped) break;
      transactionsScanned += 1;
    }

    if (transactionCapHit) {
      /*
       * Stopped by the transaction budget mid-page. Whether the remainder of
       * the ledger holds a line is what the bounded probe decides — starting
       * at the first unexamined row, so nothing is skipped and nothing is
       * counted twice. A line there is a truncation; a ledger that has ended
       * is complete; an undecidable answer is reported as unknown, never as
       * complete.
       */
      completeness = await probeForNextLine(
        source,
        offset + examinedOnThisPage
      );
      break;
    }

    if (stopped) {
      completeness = "truncated";
      break;
    }
    if (page.length < PAGE_SIZE) {
      completeness = "complete";
      break;
    }
    offset += page.length;
  }

  if (completeness === null) {
    /*
     * The loop left on a page boundary — every fetched line was taken and
     * there was no line left to refuse, or the transaction budget was
     * exhausted exactly as a page completed. Whether anything exists past
     * that point is precisely what the probe is for.
     */
    completeness = await probeForNextLine(source, offset);
  }

  const usable = movements.filter((movement) => Number.isFinite(movement.at));
  return {
    items,
    // Lines whose timestamp could not be read are counted in movementsScanned
    // (they were scanned) but cannot carry a date, so they are not turned
    // into timeline steps.
    movements: usable,
    transactionsScanned,
    movementsScanned: scannedLines,
    historyFrom: earliest === null ? null : new Date(earliest).toISOString(),
    historyTo: latest === null ? null : new Date(latest).toISOString(),
    truncated: completeness === "truncated",
    completeness,
  };
}

/* ------------------------------------------------------------------ */
/* Dates — day keys are calendar facts; boundaries are zone facts       */
/* ------------------------------------------------------------------ */

/*
 * A day key (YYYY-MM-DD) is a calendar fact: 2026-11-15 is a Sunday in every
 * zone on Earth, so arithmetic on day keys is timezone-free. What is NOT
 * zone-free is which instant bounds a day — a local day is 24 hours long
 * here and 25 there, so every boundary is resolved per date in the request's
 * zone via zoned-time. Defaulting the zone to UTC reproduces the original
 * behavior byte for byte.
 */

/** Epoch ms of the last instant of `day` in `zone`. */
function dayEnd(day: string, zone: string): number {
  return zonedDayEndUtc(day, zone);
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
  return isCalendarDayString(value);
}

/** How many days from `from` to `to`, inclusive. Negative when reversed. */
export function daysBetween(from: string, to: string): number {
  // Day keys parse as UTC midnights, and two calendar dates differ by a
  // whole number of UTC days in every zone — this is zone-invariant.
  return (
    Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000
    ) + 1
  );
}

/* ------------------------------------------------------------------ */
/* Buckets — pure calendar math on day keys, no instants involved       */
/* ------------------------------------------------------------------ */

/**
 * The first day of the period a day belongs to.
 *
 * Weeks start on Monday, matching the reports page's own week grouping, so
 * the two never disagree about where a week begins.
 */
function periodStart(day: string, granularity: HistoryGranularity): string {
  if (granularity === "week") {
    const offset = (dayKeyWeekday(day) + 6) % 7;
    return shiftDayKey(day, -offset);
  }
  if (granularity === "month") {
    return `${day.slice(0, 7)}-01`;
  }
  if (granularity === "quarter") {
    const month = Number(day.slice(5, 7));
    const quarterStart = Math.floor((month - 1) / 3) * 3 + 1;
    return `${day.slice(0, 4)}-${String(quarterStart).padStart(2, "0")}-01`;
  }
  return day;
}

/** A short axis label for a period. */
function periodLabel(day: string, granularity: HistoryGranularity): string {
  const date = new Date(`${day}T00:00:00.000Z`);
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
 * The same computation with the scan already in hand.
 *
 * Split from the fetch so the series itself can be tested against synthetic
 * ledgers — the clamping rule in particular, which is the part of the plan
 * that is easiest to get quietly wrong.
 */
export function buildHistoryFromScan(
  scan: RawScan,
  input: {
    from: string | null;
    to: string;
    category: string | null;
    /**
     * IANA timezone (e.g. "Asia/Manila") the day keys mean. Day boundaries
     * are resolved per date in this zone, so a 1 November series is 25 hours
     * long where the zone falls back. Omit for UTC, which reproduces the
     * original behavior exactly.
     */
    tz?: string | null;
  }
): InventoryHistory {
  const zone = input.tz ?? "UTC";
  if (!isValidTimeZone(zone)) {
    throw new HistoryRequestError("That timezone is not recognised");
  }

  const earliestHistory = scan.historyFrom
    ? dayKeyInZone(Date.parse(scan.historyFrom), zone)
    : null;

  const to = input.to;
  let from = input.from ?? earliestHistory ?? to;
  if (from > to) {
    // The requested range starts after the range ends. That can only happen
    // when `from` was derived rather than supplied (movements timestamped
    // after `to`), and the honest answer is the single day that was asked
    // about.
    from = to;
  }

  /*
   * When the scan could not see all of the ledger, history before the
   * earliest scanned movement cannot be verified at all — so the series
   * starts there instead of being extrapolated backwards. The caller asked
   * for `from`; the answer covers `effectiveFrom`, and says so.
   */
  const verified = scan.completeness === "complete";
  const rangeShortened =
    !verified && earliestHistory !== null && from < earliestHistory;
  const effectiveFrom = rangeShortened ? (earliestHistory as string) : from;

  const dayCount = daysBetween(effectiveFrom, to);
  if (dayCount > MAX_RANGE_DAYS) {
    throw new HistoryRequestError(
      "Choose a date range of ten years or less for the inventory history"
    );
  }

  /*
   * The days are enumerated by calendar arithmetic, not by adding 86,400,000
   * ms at a time: a local day is not exactly DAY_MS long across a DST shift,
   * and fixed-stepping the epoch would drift a boundary into the wrong day.
   * The range is capped at ten years, so the list is bounded.
   */
  const days: string[] = [];
  let cursor = effectiveFrom;
  for (;;) {
    days.push(cursor);
    if (cursor >= to) break;
    cursor = shiftDayKey(cursor, 1);
    if (days.length > MAX_RANGE_DAYS + 1) {
      throw new HistoryRequestError(
        "Choose a date range of ten years or less for the inventory history"
      );
    }
  }

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
  const dayEnds = days.map((day) => dayEnd(day, zone));
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
      completeness: scan.completeness,
    },
    valuation: {
      itemsInScope: scoped.length,
      pricedItems: valued.length,
      unpricedItems,
      unverifiableItems,
      divergentItems,
    },
    requested: {
      from,
      to,
      category: input.category,
      timeZone: zone,
      effectiveFrom,
      rangeShortened,
    },
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
