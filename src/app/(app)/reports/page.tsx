"use client";

import { useEffect, useRef, useState } from "react";
import { Card, Badge, Empty, Spinner, Stat, Toast } from "@/components/ui";
import { fmtQty, fmtDate, daysUntil, toCsv } from "@/lib/format";
import { stockStatus } from "@/lib/status";

type Item = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  category: { name: string } | null;
  location: { name: string } | null;
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

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const [i, t] = await Promise.all([
        fetch("/api/items").then((r) => r.json()),
        fetch("/api/transactions?limit=200").then((r) => r.json()),
      ]);

      if (i.error) throw new Error(i.error);
      if (t.error) throw new Error(t.error);

      setItems(i.items ?? []);
      setTxns(t.transactions ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not build the report");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  /* ---------- derived ---------- */

  const low = items.filter(
    (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "low"
  );
  const out = items.filter(
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
    const rows = items.map((i) => {
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
            className="btn-primary"
            onClick={exportCsv}
            disabled={items.length === 0}
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Items tracked" value={items.length} />
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
                {items.length} items
              </span>
            </div>

            {items.length === 0 ? (
              <Empty>No items yet.</Empty>
            ) : (
              <div className="overflow-x-auto">
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
                    {items.map((i) => {
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
                            <Badge tone={status.tone} variant="solid">
                              {status.label}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
