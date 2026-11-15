/**
 * Historical inventory reconstruction for the Reports page — the database
 * half.
 *
 * The reconstruction itself lives in `./inventory-history-core`, which has
 * no Next.js, database or auth imports and can be tested against synthetic
 * ledgers. This file holds the two things that need a connection and a
 * process-wide cache:
 *
 *   - which database this process is talking to, and the query shapes both
 *     adapters support;
 *   - the memoised scan, so a reports page that is opened by ten tabs at
 *     once does not walk the ledger ten times per reload.
 */
import { db, usingLocalDb } from "./supabase";
import { memoize } from "./ttl-cache";
import {
  buildHistoryFromScan,
  scanLedger,
  SCAN_CAP,
  type LedgerSource,
  type RawTxnRow,
  type RawScan,
  type InventoryHistory,
} from "./inventory-history-core";

export {
  isCalendarDay,
  todayUtcDay,
  daysBetween,
  MAX_RANGE_DAYS,
  HistoryRequestError,
  buildHistoryFromScan,
  scanLedger,
  SCAN_CAP,
  PAGE_SIZE,
} from "./inventory-history-core";
export type {
  RawMovement,
  RawItem,
  RawScan,
  RawTxnRow,
  LedgerSource,
  HistoryGranularity,
  HistoryPoint,
  HistoryCompleteness,
  HistoryCoverage,
  HistoryValuation,
  InventoryHistory,
} from "./inventory-history-core";

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

function defaultSource(): LedgerSource {
  return {
    async fetchItems() {
      const itemResult = await db()
        .from("items")
        .select(`sku, name, quantity, unit_price, category_id`)
        .eq("item_status", "active")
        .order("name", { ascending: true });

      if (itemResult.error) throw new Error(itemResult.error.message);

      return ((itemResult.data ?? []) as any[]).map((row) => ({
        sku: String(row.sku),
        name: String(row.name ?? row.sku),
        quantity: Number(row.quantity ?? 0),
        unitPrice:
          row.unit_price === null || row.unit_price === undefined
            ? null
            : Number(row.unit_price),
        categoryId: row.category_id ? String(row.category_id) : null,
      }));
    },

    async fetchTransactionPage(offset: number, limit: number) {
      const { data, error } = await db()
        .from("transactions")
        .select(
          `id, created_at, transaction_items(id, sku, quantity, qty_before, qty_after)`
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);

      if (error) throw new Error(error.message);
      return (data ?? []) as RawTxnRow[];
    },
  };
}

/** The memoised scan. Keyed by database configuration, never by user. */
function rawScan(): Promise<RawScan> {
  return memoize(`inventory:history:raw:${dbScope()}`, 15_000, () =>
    scanLedger(defaultSource())
  );
}

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
  return buildHistoryFromScan(scan, input);
}
