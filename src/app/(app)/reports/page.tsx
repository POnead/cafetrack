"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  Badge,
  Empty,
  Spinner,
  Stat,
  Toast,
  DataCard,
  DataField,
} from "@/components/ui";
import { fmtQty, fmtDate, daysUntil, toCsv } from "@/lib/format";
import { stockStatus } from "@/lib/status";
import { printStockReport } from "@/lib/report-print";

type Item = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  // `id` is present in the /api/items embed and is what the category filter
  // matches on.
  category: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
};

type Txn = {
  id: string;
  type: string;
  actor_name: string;
  note: string | null;
  created_at: string;
  transaction_items: { sku: string; item_name: string; quantity: number }[];
};

const MOVEMENT_LABEL: Record<string, string> = {
  checkout: "Checked out",
  restock: "Restocked",
  waste: "Logged as waste",
};

/* Date-range presets. "all" and "custom" are not day counts. */
const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
type RangeKey = keyof typeof RANGE_DAYS | "all" | "custom";

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "custom", label: "Custom" },
];

/* Stock wording + tones come from @/lib/status so every page agrees. */

export default function ReportsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const inFlight = useRef(false);

  // Used as the heading on the printed/PDF report. Defaults to the product
  // name so the export still works if the settings read fails.
  const [businessName, setBusinessName] = useState("CafeTrack");

  /* ---------- filters ----------
   * The spec asks for reports filtered "by date range, item category, and
   * staff". Category filtering here is client-side over the snapshot; the date
   * range and staff are sent to the server because transactions are fetched
   * newest-first with a cap, so filtering after the fact would silently drop
   * rows that were never fetched.
   */
  const [range, setRange] = useState<RangeKey>("all");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [staff, setStaff] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);

  const rangeParams = useMemo(() => {
    if (range === "custom") {
      return { from: fromDay, to: toDay };
    }
    if (range === "all") return { from: "", to: "" };
    const days = RANGE_DAYS[range];
    const d = new Date();
    d.setDate(d.getDate() - days);
    return { from: d.toISOString().slice(0, 10), to: "" };
  }, [range, fromDay, toDay]);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      // Date range / staff / type are applied server-side: the transactions
      // endpoint caps at 500 newest-first, so filtering the returned page
      // client-side would quietly omit anything older.
      const qs = new URLSearchParams({ limit: "500" });
      if (rangeParams.from) qs.set("from", rangeParams.from);
      if (rangeParams.to) qs.set("to", rangeParams.to);
      if (staff) qs.set("staff", staff);
      if (typeFilter) qs.set("type", typeFilter);

      const [i, t, c] = await Promise.all([
        fetch("/api/items").then((r) => r.json()),
        fetch(`/api/transactions?${qs}`).then((r) => r.json()),
        // Advisory: the report still works if the reference list fails.
        fetch("/api/refs/categories")
          .then((r) => r.json())
          .catch(() => ({ items: [] })),
      ]);

      setCategories(c.items ?? []);

      if (i.error) throw new Error(i.error);
      if (t.error) throw new Error(t.error);

      setItems(i.items ?? []);
      setTxns(t.transactions ?? []);

      // Advisory only: a failure here must not take the whole report down.
      fetch("/api/settings")
        .then((r) => r.json())
        .then((s) => {
          if (s?.settings?.business_name) setBusinessName(s.settings.business_name);
        })
        .catch(() => {});

      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not build the report");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  // Reload whenever a filter changes. `load` is stable enough for this page and
  // the eslint rule is off throughout the codebase, matching the other pages.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeParams.from, rangeParams.to, staff, typeFilter]);

  /* ---------- derived ---------- */

  // Category filter is applied here, to the already-fetched snapshot, so it
  // affects the inventory table and the counts without a second request.
  const shownItems = useMemo(() => {
    if (!catFilter) return items;
    return items.filter((i) => i.category?.id === catFilter);
  }, [items, catFilter]);

  // Staff who actually appear in the loaded window, so the dropdown does not
  // offer someone with no matching transactions.
  const staffNames = useMemo(
    () => [...new Set(txns.map((t) => t.actor_name).filter(Boolean))].sort(),
    [txns]
  );

  const low = shownItems.filter(
    (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "low"
  );
  const out = shownItems.filter(
    (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "out"
  );

  const movement = (["checkout", "restock", "waste"] as const).map((type) => {
    const rows = txns.filter((t) => t.type === type);
    const qty = rows.reduce(
      (n, t) =>
        n + (t.transaction_items ?? []).reduce((m, li) => m + Number(li.quantity), 0),
      0
    );
    return { type, count: rows.length, qty };
  });

  const topMovers = (() => {
    const tally = new Map<string, { name: string; qty: number }>();
    for (const t of txns) {
      if (t.type !== "checkout") continue;
      for (const li of t.transaction_items ?? []) {
        const cur = tally.get(li.sku) ?? { name: li.item_name, qty: 0 };
        cur.qty += Number(li.quantity);
        tally.set(li.sku, cur);
      }
    }
    return [...tally.entries()]
      .map(([sku, v]) => ({ sku, ...v }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  })();

  function exportCsv() {
    const rows = shownItems.map((i) => {
      const d = daysUntil(i.expiration_date);
      return {
        SKU: i.sku,
        Item: i.name,
        Category: i.category?.name ?? "",
        Location: i.location?.name ?? "",
        "On hand": Number(i.quantity),
        Unit: i.unit,
        Threshold: Number(i.low_stock_threshold),
        Expiry: i.expiration_date ?? "",
        Status: stockStatus(i.quantity, i.low_stock_threshold).label,
        "Days to expiry": d === null ? "" : d,
      };
    });

    const csv = toCsv(rows, [
      "SKU",
      "Item",
      "Category",
      "Location",
      "On hand",
      "Unit",
      "Threshold",
      "Expiry",
      "Status",
      "Days to expiry",
    ]);

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cafetrack-stock-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    setToast({ msg: `Exported ${rows.length} rows`, tone: "success" });
  }

  function exportPdf() {
    printStockReport({
      businessName,
      items: shownItems,
      movement,
      topMovers,
      lowCount: low.length,
      outCount: out.length,
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Stock Report</h1>
          <p className="mt-1 text-sm text-cocoa-500">
            Pantry snapshot plus the last {txns.length} recorded movements.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={load}>
            Reload
          </button>
          <button
            className="btn-ghost"
            onClick={exportPdf}
            disabled={items.length === 0}
          >
            Export PDF
          </button>
          <button
            className="btn-primary"
            onClick={exportCsv}
            disabled={items.length === 0}
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters. Date range / staff / type change the transactions query;
          category narrows the inventory snapshot in place. */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="f-range">
              Date range
            </label>
            <select
              id="f-range"
              className="input"
              value={range}
              onChange={(e) => setRange(e.target.value as RangeKey)}
            >
              {RANGE_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {range === "custom" && (
            <>
              <div>
                <label className="label" htmlFor="f-from">
                  From
                </label>
                <input
                  id="f-from"
                  type="date"
                  className="input"
                  value={fromDay}
                  max={toDay || undefined}
                  onChange={(e) => setFromDay(e.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="f-to">
                  To
                </label>
                <input
                  id="f-to"
                  type="date"
                  className="input"
                  value={toDay}
                  min={fromDay || undefined}
                  onChange={(e) => setToDay(e.target.value)}
                />
              </div>
            </>
          )}

          <div>
            <label className="label" htmlFor="f-type">
              Movement
            </label>
            <select
              id="f-type"
              className="input"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">All movements</option>
              <option value="checkout">Checked out</option>
              <option value="restock">Restocked</option>
              <option value="waste">Waste</option>
            </select>
          </div>

          <div>
            <label className="label" htmlFor="f-staff">
              Staff
            </label>
            <select
              id="f-staff"
              className="input"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            >
              <option value="">Everyone</option>
              {staffNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="f-cat">
              Category
            </label>
            <select
              id="f-cat"
              className="input"
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {(rangeParams.from ||
            rangeParams.to ||
            staff ||
            typeFilter ||
            catFilter) && (
            <button
              className="btn-ghost"
              onClick={() => {
                setRange("all");
                setFromDay("");
                setToDay("");
                setStaff("");
                setTypeFilter("");
                setCatFilter("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {error && (
        <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Items tracked" value={shownItems.length} />
        <Stat label="Low Stock" value={low.length} tone="warn" />
        <Stat label="Out of Stock" value={out.length} tone="danger" />
        <Stat label="Movements loaded" value={txns.length} />
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="!p-0">
              <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
                <h2 className="text-sm font-bold text-cocoa-800">
                  Movement summary
                </h2>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-100/60">
                    <th className="th">Type</th>
                    <th className="th text-right">Transactions</th>
                    <th className="th text-right">Total quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {movement.map((m) => (
                    <tr key={m.type}>
                      <td className="td text-cocoa-700">
                        {MOVEMENT_LABEL[m.type] ?? m.type}
                      </td>
                      <td className="td text-right tabular-nums">{m.count}</td>
                      <td className="td text-right tabular-nums">
                        {fmtQty(m.qty)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="!p-0">
              <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
                <h2 className="text-sm font-bold text-cocoa-800">
                  Most checked out
                </h2>
              </div>
              {topMovers.length === 0 ? (
                <Empty>No checkout activity yet.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-100/60">
                      <th className="th">Item</th>
                      <th className="th">SKU</th>
                      <th className="th text-right">Total out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topMovers.map((m) => (
                      <tr key={m.sku}>
                        <td className="td text-cocoa-700">{m.name}</td>
                        <td className="td font-mono text-xs text-cocoa-400">
                          {m.sku}
                        </td>
                        <td className="td text-right tabular-nums">
                          {fmtQty(m.qty)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card className="!p-0">
            <div className="flex items-center justify-between border-b border-cream-200 bg-cream-50 px-4 py-2.5">
              <h2 className="text-sm font-bold text-cocoa-800">
                On hand by item
              </h2>
              <span className="text-[11px] text-cocoa-400">
                {shownItems.length} items
              </span>
            </div>

            {shownItems.length === 0 ? (
              <Empty>
                {items.length === 0 ? "No items yet." : "No items in this category."}
              </Empty>
            ) : (
              <>
                <div className="space-y-2.5 pb-3 lg:hidden">
                  {shownItems.map((i) => {
                    const status = stockStatus(i.quantity, i.low_stock_threshold);
                    const d = daysUntil(i.expiration_date);
                    return (
                      <DataCard key={i.id}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-semibold text-cocoa-800">
                              {i.name}
                            </div>
                            <div className="font-mono text-xs text-cocoa-400">
                              {i.sku}
                            </div>
                          </div>
                          <Badge tone={status.tone} variant="tag">
                            {status.label}
                          </Badge>
                        </div>

                        <DataField label="On hand">
                          {fmtQty(i.quantity, i.unit)}
                        </DataField>
                        <DataField label="Threshold">
                          {fmtQty(i.low_stock_threshold, i.unit)}
                        </DataField>
                        <DataField label="Category">
                          {i.category?.name ?? "—"}
                        </DataField>
                        <DataField label="Location">
                          {i.location?.name ?? "—"}
                        </DataField>
                        <DataField label="Expiry">
                          {i.expiration_date ? (
                            <span className="text-xs">
                              {fmtDate(i.expiration_date)}
                              {d !== null && d < 0 && (
                                <span className="text-red-600"> (expired)</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-cocoa-200">—</span>
                          )}
                        </DataField>
                      </DataCard>
                    );
                  })}
                </div>

                <div className="hidden overflow-x-auto lg:block">
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-100/60">
                      <th className="th">SKU</th>
                      <th className="th">Item</th>
                      <th className="th">Category</th>
                      <th className="th">Location</th>
                      <th className="th text-right">On hand</th>
                      <th className="th text-right">Threshold</th>
                      <th className="th">Expiry</th>
                      <th className="th">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownItems.map((i) => {
                      const status = stockStatus(i.quantity, i.low_stock_threshold);
                      const d = daysUntil(i.expiration_date);
                      return (
                        <tr
                          key={i.id}
                          className="transition-colors hover:bg-cream-50"
                        >
                          <td className="td font-mono text-xs text-cocoa-400">
                            {i.sku}
                          </td>
                          <td className="td font-semibold text-cocoa-800">
                            {i.name}
                          </td>
                          <td className="td text-cocoa-500">
                            {i.category?.name ?? "—"}
                          </td>
                          <td className="td text-cocoa-500">
                            {i.location?.name ?? "—"}
                          </td>
                          <td className="td text-right tabular-nums">
                            {fmtQty(i.quantity, i.unit)}
                          </td>
                          <td className="td text-right tabular-nums text-cocoa-500">
                            {fmtQty(i.low_stock_threshold, i.unit)}
                          </td>
                          <td className="td whitespace-nowrap text-xs text-cocoa-500">
                            {i.expiration_date ? (
                              <>
                                {fmtDate(i.expiration_date)}
                                {d !== null && d < 0 && (
                                  <span className="text-red-600">
                                    {" "}
                                    (expired)
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-cocoa-200">—</span>
                            )}
                          </td>
                          <td className="td">
                            <Badge tone={status.tone} variant="tag">
                              {status.label}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Card>
        </>
      )}

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
