import { db } from "./supabase";
import { fmtQty, fmtDate, daysUntil } from "./format";
import { stockStatus } from "./status";
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
};

const MOVEMENT_LABEL: Record<string, string> = {
  checkout: "Checked out",
  restock: "Restocked",
  waste: "Logged as waste",
};

export function parseStockReportFilters(input: unknown): StockReportFilters {
  const outer = (input ?? {}) as Record<string, unknown>;
  const body =
    outer.filters && typeof outer.filters === "object"
      ? (outer.filters as Record<string, unknown>)
      : outer;
  const day = (value: unknown) =>
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  const movementType =
    typeof body.type === "string" && ["checkout", "restock", "waste"].includes(body.type)
      ? body.type
      : "";

  return {
    from: day(body.from),
    to: day(body.to),
    staff: typeof body.staff === "string" ? body.staff.trim() : "",
    type: movementType,
    categoryId: typeof body.category_id === "string" ? body.category_id.trim() : "",
  };
}

export async function buildStockReportData(filters: StockReportFilters): Promise<PdfReport> {
  const [itemRows, movementResult] = await Promise.all([
    db()
      .from("items")
      .select(
        `sku, name, unit, quantity, low_stock_threshold, expiration_date,
         category:categories(id, name),
         location:locations(id, name)`
      )
      .eq("item_status", "active")
      .order("name", { ascending: true })
      .limit(500),
    fetchMovements(filters),
  ]);

  if (itemRows.error) throw new Error(itemRows.error.message);
  const movements = movementResult.transactions;

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

  const allItems = (itemRows.data ?? []) as any[];
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

  return {
    businessName: await businessName(),
    generated: new Date().toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    filterDescription: describeFilters(filters, categoryName, staffName),
    warnings: movementResult.transactionNotesAvailable
      ? []
      : [TRANSACTION_NOTE_SCHEMA_WARNING],
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

async function fetchMovements(
  filters: StockReportFilters
): Promise<{ transactions: any[]; transactionNotesAvailable: boolean }> {
  const all: any[] = [];
  const pageSize = 500;
  const cap = 5000;
  let offset = 0;
  let transactionNoteAvailable = true;
  let itemNoteAvailable = true;

  while (all.length < cap) {
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
        .range(offset, offset + pageSize - 1);

      if (filters.type) query = query.eq("type", filters.type);
      if (filters.from) query = query.gte("created_at", `${filters.from}T00:00:00.000Z`);
      if (filters.to) query = query.lte("created_at", `${filters.to}T23:59:59.999Z`);
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
    if (page.length < pageSize) {
      return {
        transactions: all,
        transactionNotesAvailable: transactionNoteAvailable && itemNoteAvailable,
      };
    }
    offset += page.length;
  }

  return {
    transactions: all,
    transactionNotesAvailable: transactionNoteAvailable && itemNoteAvailable,
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
    staffName ? `Staff: ${staffName}` : null,
    filters.type ? `Movement: ${movementLabel[filters.type]}` : null,
    categoryName ? `Category: ${categoryName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
