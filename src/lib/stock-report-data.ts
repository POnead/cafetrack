import { db } from "./supabase";
import { fmtQty, fmtDate, daysUntil } from "./format";
import { stockStatus } from "./status";
import {
  isCalendarDayString,
  isValidTimeZone,
  localDayBoundsIso,
} from "./zoned-time";
import type { PdfReport } from "./report-pdf";
import {
  isMissingTransactionNoteColumn,
  TRANSACTION_NOTE_SCHEMA_WARNING,
} from "./transaction-note-schema";

export type StockReportFilters = {
  from: string;
  to: string;
  staff: string;
  type: string;
  categoryId: string;
  /**
   * IANA timezone the calendar-day filters mean. Each day boundary is
   * resolved per date in this zone — a day is not a fixed span of hours.
   * Empty means UTC, matching the pre-existing behavior.
   */
  tz: string;
};

const MOVEMENT_LABEL: Record<string, string> = {
  checkout: "Checked out",
  restock: "Restocked",
  waste: "Logged as waste",
};

/**
 * A filter the caller got wrong. A distinct type so the routes can answer
 * 400 rather than silently substituting something the caller did not ask for.
 */
export class StockReportFilterError extends Error {}

/*
 * Safety caps on the export builders.
 *
 * A report must not read the whole world into memory on an ordinary request.
 * These caps bound both builders; exceeding them truncates honestly and the
 * report says so. The caps are positive integers and may be lowered for
 * tests via CAFETRACK_EXPORT_ITEM_CAP / CAFETRACK_EXPORT_MOVEMENT_CAP —
 * never removed, never raised past the documented maxima.
 */
export const DEFAULT_ITEM_EXPORT_CAP = 10_000;
export const DEFAULT_MOVEMENT_EXPORT_CAP = 5_000;
const MAX_EXPORT_CAP = 100_000;

function exportCap(
  name: "CAFETRACK_EXPORT_ITEM_CAP" | "CAFETRACK_EXPORT_MOVEMENT_CAP",
  fallback: number
): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Zero, negative, non-finite, non-integer and implausibly large values all
  // fall back to the documented default — configuration cannot remove the
  // safety limits.
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_EXPORT_CAP
  ) {
    return fallback;
  }
  return parsed;
}

export function itemExportCap(): number {
  return exportCap("CAFETRACK_EXPORT_ITEM_CAP", DEFAULT_ITEM_EXPORT_CAP);
}

export function movementExportCap(): number {
  return exportCap("CAFETRACK_EXPORT_MOVEMENT_CAP", DEFAULT_MOVEMENT_EXPORT_CAP);
}

export function parseStockReportFilters(input: unknown): StockReportFilters {
  const outer = (input ?? {}) as Record<string, unknown>;
  const body =
    outer.filters && typeof outer.filters === "object"
      ? (outer.filters as Record<string, unknown>)
      : outer;
  const day = (value: unknown) =>
    typeof value === "string" && isCalendarDayString(value) ? value : "";
  const movementType =
    typeof body.type === "string" && ["checkout", "restock", "waste"].includes(body.type)
      ? body.type
      : "";

  /*
   * The timezone must be a zone Intl recognises. Invalid or missing input
   * does NOT fall back to UTC silently — a wrong report in the wrong zone is
   * worse than a 400 that names the problem.
   */
  const tzRaw =
    typeof body.tz === "string" && body.tz.trim() ? body.tz.trim() : "";
  if (tzRaw && !isValidTimeZone(tzRaw)) {
    throw new StockReportFilterError("That timezone is not recognised");
  }

  return {
    from: day(body.from),
    to: day(body.to),
    staff: typeof body.staff === "string" ? body.staff.trim() : "",
    type: movementType,
    categoryId: typeof body.category_id === "string" ? body.category_id.trim() : "",
    tz: tzRaw,
  };
}

/** Whether a capped section is known-complete, known-truncated, or unverified. */
export type ExportCompleteness = "complete" | "truncated" | "unknown";

export async function buildStockReportData(
  filters: StockReportFilters
): Promise<PdfReport> {
  const itemCap = itemExportCap();
  const movementCap = movementExportCap();
  const [itemFetch, movementResult] = await Promise.all([
    fetchItems(itemCap),
    fetchMovements(filters, movementCap),
  ]);
  const movements = movementResult.transactions;

  const itemCompleteness = itemFetch.completeness;
  const movementCompleteness = movementResult.movementsCompleteness;

  const completenessWarnings: string[] = [];
  if (itemCompleteness === "truncated") {
    completenessWarnings.push(
      `The report includes the first ${itemCap.toLocaleString("en-PH")} catalogue items (ordered by name). Additional items exist and were not included.`
    );
  } else if (itemCompleteness === "unknown") {
    completenessWarnings.push(
      `The report includes the first ${itemCap.toLocaleString("en-PH")} catalogue items (ordered by name); whether more exist could not be verified.`
    );
  }
  if (movementCompleteness === "truncated") {
    completenessWarnings.push(
      `The report includes the ${movementCap.toLocaleString("en-PH")} newest matching transactions. Additional transactions exist and were not included.`
    );
  } else if (movementCompleteness === "unknown") {
    completenessWarnings.push(
      `The report includes the ${movementCap.toLocaleString("en-PH")} newest matching transactions; whether more exist could not be verified.`
    );
  }

  const categoryName = filters.categoryId
    ? (await db()
        .from("categories")
        .select("name")
        .eq("id", filters.categoryId)
        .maybeSingle()).data?.name
    : "";
  let staffName = filters.staff;
  if (/^[0-9a-f-]{36}$/i.test(filters.staff)) {
    const staffResult = await db()
      .from("users")
      .select("full_name")
      .eq("id", filters.staff)
      .maybeSingle();
    if (staffResult.error) throw new Error(staffResult.error.message);
    staffName = staffResult.data?.full_name ?? filters.staff;
  }

  const allItems = (itemFetch.rows ?? []) as any[];
  const items = categoryName
    ? allItems.filter((item) => item.category?.name === categoryName)
    : allItems;
  const itemsBySku = new Map(allItems.map((item) => [item.sku, item]));
  const inWindow = movements.filter((transaction) =>
    categoryName
      ? (transaction.transaction_items ?? []).some(
          (line: any) => itemsBySku.get(line.sku)?.category?.name === categoryName
        )
      : true
  );
  const categoryLine = (line: any) =>
    !categoryName || itemsBySku.get(line.sku)?.category?.name === categoryName;

  const topMovers = (() => {
    const tally = new Map<string, { name: string; qty: number }>();
    for (const transaction of inWindow) {
      if (transaction.type !== "checkout") continue;
      for (const line of transaction.transaction_items ?? []) {
        if (!categoryLine(line)) continue;
        const current = tally.get(line.sku) ?? { name: line.item_name, qty: 0 };
        current.qty += Number(line.quantity);
        tally.set(line.sku, current);
      }
    }

    return [...tally.entries()]
      .map(([sku, value]) => ({ sku, name: value.name, total: value.qty, qty: fmtQty(value.qty) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map(({ sku, name, qty }) => ({ sku, name, qty }));
  })();

  const soonestExpiry = items
    .filter((item) => item.expiration_date)
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      category: item.category?.name ?? "—",
      location: item.location?.name ?? "—",
      quantity: fmtQty(item.quantity, item.unit),
      expiry: fmtDate(item.expiration_date),
      days: daysUntil(item.expiration_date),
    }))
    .sort(
      (a, b) =>
        (a.days ?? Number.POSITIVE_INFINITY) -
        (b.days ?? Number.POSITIVE_INFINITY)
    )
    .slice(0, 10);

  const movementSummary = (["checkout", "restock", "waste"] as const).map((type) => {
    const rows = inWindow.filter((transaction) => transaction.type === type);
    const qty = rows.reduce(
      (sum, transaction) =>
        sum +
        (transaction.transaction_items ?? []).reduce(
          (itemSum: number, line: any) => itemSum + Number(line.quantity),
          0
        ),
      0
    );
    return { label: MOVEMENT_LABEL[type], count: rows.length, qty: fmtQty(qty) };
  });

  const warnings = [
    ...(movementResult.transactionNotesAvailable ? [] : [TRANSACTION_NOTE_SCHEMA_WARNING]),
    ...completenessWarnings,
  ];

  return {
    businessName: await businessName(),
    generated: new Date().toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: filters.tz || "UTC",
    }),
    filterDescription: describeFilters(filters, categoryName, staffName),
    warnings,
    completeness: {
      items: itemCompleteness,
      movements: movementCompleteness,
      itemsScanned: items.length,
      movementsScanned: movements.length,
      itemCap,
      movementCap,
    },
    tiles: [
      { label: "Items tracked", value: items.length },
      {
        label: "Low stock",
        value: items.filter(
          (item) => stockStatus(item.quantity, item.low_stock_threshold).key === "low"
        ).length,
      },
      {
        label: "Out of stock",
        value: items.filter(
          (item) => stockStatus(item.quantity, item.low_stock_threshold).key === "out"
        ).length,
      },
      { label: "Transactions", value: inWindow.length },
    ],
    items: items.map((item) => {
      const status = stockStatus(item.quantity, item.low_stock_threshold);
      const days = daysUntil(item.expiration_date);
      return {
        sku: item.sku,
        name: item.name,
        category: item.category?.name ?? "—",
        location: item.location?.name ?? "—",
        quantity: fmtQty(item.quantity, item.unit),
        threshold: fmtQty(item.low_stock_threshold, item.unit),
        expiry: item.expiration_date ? fmtDate(item.expiration_date) : "—",
        expired: days !== null && days < 0,
        status: status.label,
        tone: status.key as "out" | "low" | "ok",
      };
    }),
    topMovers,
    soonestExpiry,
    movementSummary,
    waste: wasteByItem(inWindow),
    movementLines: inWindow.flatMap((transaction) =>
      (transaction.transaction_items ?? [])
        .filter((line: any) => categoryLine(line))
        .map((line: any) => ({
          date: new Date(transaction.created_at).toLocaleString("en-PH", {
            dateStyle: "short",
            timeStyle: "short",
            timeZone: filters.tz || "UTC",
          }),
          actorName: transaction.actor_name,
          label: MOVEMENT_LABEL[transaction.type] ?? transaction.type,
          sku: line.sku,
          itemName: line.item_name,
          category: itemsBySku.get(line.sku)?.category?.name ?? "Uncategorized",
          quantity: fmtQty(line.quantity),
          note: [transaction.note, line.note].filter(Boolean).join("\n") || "—",
        }))
    ),
  };
}

/*
 * The shared shape of the bounded paging loops the export builders use:
 * read pages newest-first, stop AT the cap, and when the cap lands exactly
 * on a page boundary ask whether one more matching row exists — so the
 * builder can say "additional records exist" honestly. It never reports an
 * exact count of omitted rows unless one was counted.
 */

async function hasAnyMatchingTransactionRow(
  filters: StockReportFilters,
  offset: number
): Promise<ExportCompleteness> {
  let query = db()
    .from("transactions")
    .select("id")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset);

  if (filters.type) query = query.eq("type", filters.type);
  const zone = filters.tz || "UTC";
  if (filters.from) {
    const bounds = localDayBoundsIso(filters.from, zone);
    if (bounds) query = query.gte("created_at", bounds.fromAt);
  }
  if (filters.to) {
    const bounds = localDayBoundsIso(filters.to, zone);
    if (bounds) query = query.lt("created_at", bounds.before);
  }
  if (filters.staff) {
    query = /^[0-9a-f-]{36}$/i.test(filters.staff)
      ? query.eq("actor_id", filters.staff)
      : query.eq("actor_name", filters.staff);
  }

  const result = await query;
  if (result.error) return "unknown"; // cannot verify: disclose as unverified
  return (result.data?.length ?? 0) > 0 ? "truncated" : "complete";
}

async function hasAnyMoreItems(offset: number): Promise<ExportCompleteness> {
  const result = await db()
    .from("items")
    .select("id")
    .eq("item_status", "active")
    .range(offset, offset);

  if (result.error) return "unknown"; // cannot verify: disclose as unverified
  return (result.data?.length ?? 0) > 0 ? "truncated" : "complete";
}

async function fetchItems(
  cap: number
): Promise<{ rows: any[]; completeness: ExportCompleteness }> {
  const all: any[] = [];
  const pageSize = 500;
  let offset = 0;

  while (all.length < cap) {
    const take = Math.min(pageSize, cap - all.length);
    const itemResult = await db()
      .from("items")
      .select(
        `sku, name, unit, quantity, low_stock_threshold, expiration_date,
         category:categories(id, name),
         location:locations(id, name)`
      )
      .eq("item_status", "active")
      .order("name", { ascending: true })
      // A stable second key: equal names may come back in any order between
      // two requests, which would reshuffle pages and could show one row twice.
      .order("sku", { ascending: true })
      .range(offset, offset + take - 1);

    if (itemResult.error) throw new Error(itemResult.error.message);

    const page = (itemResult.data ?? []) as any[];
    if (page.length === 0) break;
    all.push(...page);
    offset += page.length;
    if (page.length < take) break; // the catalogue ended
  }

  const completeness =
    all.length >= cap ? await hasAnyMoreItems(offset) : "complete";

  return { rows: all, completeness };
}

async function fetchMovements(
  filters: StockReportFilters,
  cap: number
): Promise<{
  transactions: any[];
  transactionNotesAvailable: boolean;
  movementsCompleteness: ExportCompleteness;
}> {
  const all: any[] = [];
  const pageSize = 500;
  let offset = 0;
  let transactionNoteAvailable = true;
  let itemNoteAvailable = true;

  while (all.length < cap) {
    // Stop AT the cap: read at most the remaining budget this iteration. A
    // short read means the ledger ended — not the cap; only an exactly-full
    // last iteration leaves `all.length === cap`, when the probe decides.
    const take = Math.min(pageSize, cap - all.length);
    const selections: { transactionNote: boolean; itemNote: boolean }[] = [
      { transactionNote: transactionNoteAvailable, itemNote: itemNoteAvailable },
      { transactionNote: false, itemNote: itemNoteAvailable },
      { transactionNote: transactionNoteAvailable, itemNote: false },
      { transactionNote: false, itemNote: false },
    ];
    const triedSelections = new Set<string>();
    let data: any[] | null = null;
    let error: { message: string } | null = null;

    for (const selection of selections) {
      const selectionKey = `${selection.transactionNote}:${selection.itemNote}`;
      if (triedSelections.has(selectionKey)) continue;
      triedSelections.add(selectionKey);

      let query = db()
        .from("transactions")
        .select(
          `${selection.transactionNote ? "id, type, actor_id, actor_name, note, created_at" : "id, type, actor_id, actor_name, created_at"},
           transaction_items(id, sku, item_name, quantity${selection.itemNote ? ", note" : ""})`
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + take - 1);

      if (filters.type) query = query.eq("type", filters.type);
      const zone = filters.tz || "UTC";
      if (filters.from) {
        const bounds = localDayBoundsIso(filters.from, zone);
        // A day the calendar does not have is ignored rather than passed to
        // Postgres, matching the route's own lenient parse.
        if (bounds) query = query.gte("created_at", bounds.fromAt);
      }
      if (filters.to) {
        const bounds = localDayBoundsIso(filters.to, zone);
        if (bounds) query = query.lt("created_at", bounds.before);
      }
      if (filters.staff) {
        query = /^[0-9a-f-]{36}$/i.test(filters.staff)
          ? query.eq("actor_id", filters.staff)
          : query.eq("actor_name", filters.staff);
      }

      const result = await query;
      if (!result.error) {
        data = result.data;
        transactionNoteAvailable = selection.transactionNote;
        itemNoteAvailable = selection.itemNote;
        error = null;
        break;
      }

      error = result.error;
      if (!isMissingTransactionNoteColumn(result.error)) break;
    }

    if (error) throw new Error(error.message);

    const page = (data ?? []) as any[];
    all.push(...page);
    offset += page.length;
    if (page.length < take) {
      // The ledger ended inside the remaining budget — a short read is the
      // end of the matching ledger, never the cap boundary.
      return {
        transactions: all,
        transactionNotesAvailable: transactionNoteAvailable && itemNoteAvailable,
        movementsCompleteness: "complete" as ExportCompleteness,
      };
    }
  }

  // The cap landed exactly at a page boundary: ask whether one more matching
  // row exists, and disclose uncertainty honestly if the probe cannot tell.
  return {
    transactions: all,
    transactionNotesAvailable: transactionNoteAvailable && itemNoteAvailable,
    movementsCompleteness: await hasAnyMatchingTransactionRow(filters, offset),
  };
}

function wasteByItem(movements: any[]) {
  const tally = new Map<string, { sku: string; name: string; qty: number; count: number }>();
  for (const transaction of movements) {
    if (transaction.type !== "waste") continue;
    for (const line of transaction.transaction_items ?? []) {
      const current = tally.get(line.sku) ?? {
        sku: line.sku,
        name: line.item_name,
        qty: 0,
        count: 0,
      };
      current.qty += Number(line.quantity);
      current.count += 1;
      tally.set(line.sku, current);
    }
  }
  return [...tally.values()]
    .map((value) => ({ ...value, qty: fmtQty(value.qty) }))
    .sort((a, b) => Number(b.qty) - Number(a.qty))
    .slice(0, 10);
}

async function businessName(): Promise<string> {
  const { data } = await db()
    .from("settings")
    .select("value")
    .eq("key", "business_name")
    .maybeSingle();
  return data?.value || "CafeTrack";
}

function describeFilters(
  filters: StockReportFilters,
  categoryName: string,
  staffName: string
) {
  const movementLabel: Record<string, string> = {
    checkout: "checked out",
    restock: "restocked",
    waste: "waste",
  };
  return [
    filters.from || filters.to
      ? `Dates: ${filters.from || "beginning"} to ${filters.to || "today"}`
      : "All dates",
    filters.tz ? `Timezone: ${filters.tz}` : null,
    staffName ? `Staff: ${staffName}` : null,
    filters.type ? `Movement: ${movementLabel[filters.type]}` : null,
    categoryName ? `Category: ${categoryName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
