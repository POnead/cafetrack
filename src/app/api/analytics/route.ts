import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { daysUntil } from "@/lib/format";
import { stockStatus } from "@/lib/status";

/**
 * An item's `date` column, as a calendar day.
 *
 * The two database backends disagree about the type: Supabase's PostgREST
 * returns "2026-10-30", while PGlite hands back a JS Date. `daysUntil` reads a
 * leading "YYYY-MM-DD" and treats anything else as unknown, so passing a Date
 * straight through silently produced null for every item in local mode - and
 * then `expiryRisk` filtered every row out because it only keeps `d >= 0`.
 *
 * Normalising here means both backends compute the same answer.
 */
function dayOf(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const day = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export const runtime = "nodejs";

/**
 * Analytics dashboard data.
 *
 * One endpoint that assembles every derived view the dashboard needs:
 *   - most needed items (by checkout volume) — this month, last month, this year, last year
 *   - most wasted items (by waste volume + expiry waste) — this month, last month, this year, last year
 *   - chronically low stock items (frequently below threshold)
 *   - expiry risk (items expiring soon with high stock)
 *
 * All computation happens here rather than in the browser because the same
 * numbers appear on multiple pages; computing them in one place keeps them
 * consistent and means a change to a formula is a one-line edit rather than
 * a hunt through client code.
 *
 * No price/cost data is included — the cafe only needs demand, waste and
 * stock-health analytics.
 */
export const GET = handler(async (req: Request) => {
  await requireUser();

  /*
   * Snapshot filters, read here because they change what the stock table shows
   * rather than how the movement aggregates are computed.
   *
   * `from`/`to` bound the *expiry* date, not the movement history. That is the
   * date a stock snapshot actually has: an item's on-hand quantity is current,
   * and the only date attached to the row is when it goes off. Bounding
   * created_at would silently drop items that have sat on the shelf longer than
   * the window, which is the opposite of what a stock check wants.
   */
  const { searchParams } = new URL(req.url);
  const categoryId = searchParams.get("category");
  const locationId = searchParams.get("location");
  const isoDay = (v: string | null) =>
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const expiryFrom = isoDay(searchParams.get("from"));
  const expiryTo = isoDay(searchParams.get("to"));

  const now = new Date();

  // Window boundaries for the query filter. We fetch 13 months so both
  // monthly (this month / last month) and yearly (this year / last year)
  // views have complete data.
  const thirteenMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);

  // Month boundaries
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1); // exclusive

  // Year boundaries
  const thisYearStart = new Date(now.getFullYear(), 0, 1);
  const lastYearStart = new Date(now.getFullYear() - 1, 0, 1);
  const lastYearEnd = new Date(now.getFullYear(), 0, 1); // exclusive

  /* ---------------- fetch ---------------- */

  const { data: items, error: itemsError } = await db()
    .from("items")
    .select(
      `id, sku, name, unit, quantity, low_stock_threshold, expiration_date,
       category_id, location_id, updated_at,
       category:categories(id, name), location:locations(id, name)`
    )
    .eq("item_status", "active")
    .order("name", { ascending: true });

  if (itemsError) return fail(itemsError.message, 500);

  // Paginate through all transactions in the 13-month window. The loop is
  // here so a full year of data cannot silently truncate the analytics.
  const allTxns: any[] = [];
  const PAGE = 500;
  const CAP = 20000;
  let offset = 0;

  while (allTxns.length < CAP) {
    const { data, error } = await db()
      .from("transactions")
      .select(
        `id, type, created_at,
         transaction_items(sku, item_name, quantity)`
      )
      .gte("created_at", thirteenMonthsAgo.toISOString())
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) return fail(error.message, 500);

    const page = (data ?? []) as any[];
    allTxns.push(...page);
    if (page.length < PAGE) break;
    offset += page.length;
  }

  const allItems = (items ?? []) as any[];

  /* ---------------- aggregate transactions ---------------- */

  // Per-SKU tallies for each time window
  const checkoutThisMonth = new Map<string, { name: string; qty: number }>();
  const checkoutLastMonth = new Map<string, { name: string; qty: number }>();
  const checkoutThisYear = new Map<string, { name: string; qty: number }>();
  const checkoutLastYear = new Map<string, { name: string; qty: number }>();

  const wasteThisMonth = new Map<string, { name: string; qty: number }>();
  const wasteLastMonth = new Map<string, { name: string; qty: number }>();
  const wasteThisYear = new Map<string, { name: string; qty: number }>();
  const wasteLastYear = new Map<string, { name: string; qty: number }>();

  // Restock tallies (for demand forecasting)
  const restockThisMonth = new Map<string, { name: string; qty: number }>();
  const restockThisYear = new Map<string, { name: string; qty: number }>();

  // Low-stock event tally: each time a checkout pushed an item below threshold
  const lowStockEvents = new Map<string, { name: string; count: number }>();

  // Expiry waste: waste events where the item had an expiration date
  const expiryWasteThisMonth = new Map<string, { name: string; qty: number }>();
  const wasteLastYear2 = new Map<string, { name: string; qty: number }>();

  for (const txn of allTxns) {
    const created = new Date(txn.created_at);

    // Determine which time windows this transaction falls into
    const inThisMonth = created >= thisMonthStart;
    const inLastMonth = created >= lastMonthStart && created < lastMonthEnd;
    const inThisYear = created >= thisYearStart;
    const inLastYear = created >= lastYearStart && created < lastYearEnd;

    for (const line of txn.transaction_items ?? []) {
      const sku = line.sku;
      const qty = Number(line.quantity);
      const name = line.item_name;

      if (txn.type === "checkout") {
        if (inThisMonth) {
          const cur = checkoutThisMonth.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          checkoutThisMonth.set(sku, cur);
        }
        if (inLastMonth) {
          const cur = checkoutLastMonth.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          checkoutLastMonth.set(sku, cur);
        }
        if (inThisYear) {
          const cur = checkoutThisYear.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          checkoutThisYear.set(sku, cur);
        }
        if (inLastYear) {
          const cur = checkoutLastYear.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          checkoutLastYear.set(sku, cur);
        }
      } else if (txn.type === "waste") {
        if (inThisMonth) {
          const cur = wasteThisMonth.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          wasteThisMonth.set(sku, cur);
        }
        if (inLastMonth) {
          const cur = wasteLastMonth.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          wasteLastMonth.set(sku, cur);
        }
        if (inThisYear) {
          const cur = wasteThisYear.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          wasteThisYear.set(sku, cur);
        }
        if (inLastYear) {
          const cur = wasteLastYear2.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          wasteLastYear2.set(sku, cur);
        }
      } else if (txn.type === "restock") {
        if (inThisMonth) {
          const cur = restockThisMonth.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          restockThisMonth.set(sku, cur);
        }
        if (inThisYear) {
          const cur = restockThisYear.get(sku) ?? { name, qty: 0 };
          cur.qty += qty;
          restockThisYear.set(sku, cur);
        }
      }
    }
  }

  /* ---------------- most needed items (by checkout volume) ---------------- */

  const toSortedArray = (m: Map<string, { name: string; qty: number }>) =>
    Array.from(m.values()).sort((a, b) => b.qty - a.qty);

  const mostNeeded = {
    thisMonth: toSortedArray(checkoutThisMonth).slice(0, 10),
    lastMonth: toSortedArray(checkoutLastMonth).slice(0, 10),
    thisYear: toSortedArray(checkoutThisYear).slice(0, 10),
    lastYear: toSortedArray(checkoutLastYear).slice(0, 10),
  };

  /* ---------------- most wasted items (by waste volume) ---------------- */

  const mostWasted = {
    thisMonth: toSortedArray(wasteThisMonth).slice(0, 10),
    lastMonth: toSortedArray(wasteLastMonth).slice(0, 10),
    thisYear: toSortedArray(wasteThisYear).slice(0, 10),
    lastYear: toSortedArray(wasteLastYear2).slice(0, 10),
  };

  /* ---------------- chronically low stock items ----------------
   * An item is "chronically low" if it is currently below its threshold AND
   * has been restocked multiple times (indicating recurring shortages).
   * We count restocks in the last 13 months as a proxy for how often the
   * item runs out.
   * ---------------------------------------------------------------- */

  const restockCountBySku = new Map<string, number>();
  for (const txn of allTxns) {
    if (txn.type !== "restock") continue;
    for (const line of txn.transaction_items ?? []) {
      restockCountBySku.set(
        line.sku,
        (restockCountBySku.get(line.sku) ?? 0) + 1
      );
    }
  }

  const chronicLowStock = allItems
    .filter((item) => {
      const status = stockStatus(item.quantity, item.low_stock_threshold);
      if (status.key !== "low" && status.key !== "out") return false;
      const restocks = restockCountBySku.get(item.sku) ?? 0;
      return restocks >= 2; // Restocked 2+ times in 13 months
    })
    .map((item) => ({
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      currentQty: Number(item.quantity),
      threshold: Number(item.low_stock_threshold),
      restockCount: restockCountBySku.get(item.sku) ?? 0,
      avgDailyUsage: Math.round((checkoutThisYear.get(item.sku)?.qty ?? 0) / 365 * 100) / 100,
    }))
    .sort((a, b) => b.restockCount - a.restockCount);

  /* ---------------- expiry risk ---------------- */

  const expiryRisk = allItems
    .filter((item) => {
      const d = daysUntil(dayOf(item.expiration_date));
      return d !== null && d >= 0 && d <= 7;
    })
    .map((item) => {
      const d = daysUntil(dayOf(item.expiration_date));
      const qty = Number(item.quantity);
      const threshold = Number(item.low_stock_threshold);
      const highStock = qty > threshold;

      let riskLevel: string;
      if (d !== null && d <= 2 && highStock) {
        riskLevel = "high";
      } else if (d !== null && d <= 4 && highStock) {
        riskLevel = "medium";
      } else {
        riskLevel = "low";
      }

      return {
        sku: item.sku,
        name: item.name,
        quantity: qty,
        unit: item.unit,
        daysUntilExpiry: d,
        riskLevel,
      };
    })
    .sort((a, b) => (a.daysUntilExpiry ?? 0) - (b.daysUntilExpiry ?? 0));

  /* ---------------- soonest expiry ---------------- */

  /*
   * Every dated item, soonest first, including ones already expired.
   *
   * The dashboard's "Expiring Soon" card used to answer this in the browser from
   * whatever items that page happened to fetch; this is the same question asked
   * of the whole active inventory, so a paged item list cannot truncate it.
   */
  const soonestExpiry = allItems
    .filter((item) => Boolean(item.expiration_date))
    .map((item) => {
      const expiry = dayOf(item.expiration_date);
      return {
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        quantity: Number(item.quantity),
        expiration_date: expiry,
        daysUntilExpiry: daysUntil(expiry),
        category: item.category?.name ?? null,
        location: item.location?.name ?? null,
      };
    })
    .sort((a, b) =>
      (a.daysUntilExpiry ?? Number.POSITIVE_INFINITY) -
      (b.daysUntilExpiry ?? Number.POSITIVE_INFINITY)
    )
    .slice(0, 10);

  /* ---------------- stock snapshot ---------------- */

  /*
   * The current stock list, filtered server-side by category, location and an
   * expiry window. Kept out of the dashboard's item fetch so the same snapshot
   * can be asked for by any client without pulling the whole inventory and
   * filtering it in the browser.
   *
   * An unparseable or unknown id simply matches nothing, which is the honest
   * answer to "show me that category" when the category has been deleted.
   */
  const snapshotItems = allItems
    .filter((item) => {
      if (categoryId && item.category_id !== categoryId) return false;
      if (locationId && item.location_id !== locationId) return false;

      // A window only makes sense for rows that have a date; undated items are
      // not in any expiry range.
      if (expiryFrom || expiryTo) {
        const expiry = dayOf(item.expiration_date);
        if (!expiry) return false;
        if (expiryFrom && expiry < expiryFrom) return false;
        if (expiryTo && expiry > expiryTo) return false;
      }

      return true;
    })
    .map((item) => ({
      id: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      quantity: Number(item.quantity),
      low_stock_threshold: Number(item.low_stock_threshold),
      expiration_date: dayOf(item.expiration_date),
      updated_at: item.updated_at,
      category: item.category ?? null,
      location: item.location ?? null,
    }));

  /* ---------------- response ---------------- */

  return ok({
    mostNeeded,
    mostWasted,
    chronicLowStock,
    expiryRisk,
    soonestExpiry,
    snapshot: {
      items: snapshotItems,
      total: snapshotItems.length,
      filters: {
        category: categoryId,
        location: locationId,
        from: expiryFrom,
        to: expiryTo,
      },
    },
  });
});
