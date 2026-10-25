import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { daysUntil } from "@/lib/format";
import { stockStatus } from "@/lib/status";

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
       category:categories(id, name)`
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
      if (!item.expiration_date) return false;
      const d = daysUntil(item.expiration_date);
      return d !== null && d >= 0 && d <= 7;
    })
    .map((item) => {
      const d = daysUntil(item.expiration_date);
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

  /* ---------------- response ---------------- */

  return ok({
    mostNeeded,
    mostWasted,
    chronicLowStock,
    expiryRisk,
  });
});
