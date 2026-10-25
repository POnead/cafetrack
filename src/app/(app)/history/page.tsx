"use client";

import { useEffect, useState } from "react";
import {
  Card,
  Badge,
  Empty,
  Spinner,
  Toast,
  DataCard,
  DataField,
} from "@/components/ui";
import { fmtQty, fmtDateTime, fmtDate } from "@/lib/format";

type Txn = {
  id: string;
  type: string;
  actor_name: string;
  note: string | null;
  created_at: string;
  transaction_items: { sku: string; item_name: string; quantity: number; expiration_date: string | null }[] | null;
};

const TYPE_BADGE: Record<string, { tone: "blue" | "green" | "amber"; label: string }> = {
  checkout: { tone: "blue", label: "Checkout" },
  restock: { tone: "green", label: "Restock" },
  waste: { tone: "amber", label: "Log Waste" },
};

const PAGE_SIZE = 50;

export default function HistoryPage() {
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: "info" | "error" | "success" } | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");

  async function load(reset = false) {
    const p = reset ? 0 : page;
    if (reset) {
      setLoading(true);
      setPage(0);
    }
    try {
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(p * PAGE_SIZE),
      });
      if (typeFilter) qs.set("type", typeFilter);
      if (search.trim()) qs.set("staff", search.trim());

      const res = await fetch(`/api/transactions?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load history");

      const newTxns: Txn[] = data.transactions ?? [];
      if (reset) {
        setTxns(newTxns);
      } else {
        setTxns((prev) => [...prev, ...newTxns]);
      }
      setHasMore(newTxns.length === PAGE_SIZE);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, search]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="deco-title text-3xl">History</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          All checkout, restock, and waste transactions with staff and notes.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="hist-type">
              Type
            </label>
            <select
              id="hist-type"
              className="input"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="">All types</option>
              <option value="checkout">Checkout</option>
              <option value="restock">Restock</option>
              <option value="waste">Log Waste</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="hist-search">
              Staff
            </label>
            <input
              id="hist-search"
              className="input"
              placeholder="Search by staff name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="btn-ghost" onClick={() => load(true)}>
            Reload
          </button>
        </div>
      </Card>

      {/* Transaction list */}
      <Card className="!p-0">
        <div className="flex items-center justify-between border-b border-cream-200 bg-cream-50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-cocoa-800">Transactions</h2>
          <span className="text-[11px] text-cocoa-400">{txns.length} shown</span>
        </div>

        {loading ? (
          <div className="p-8">
            <Spinner />
          </div>
        ) : txns.length === 0 ? (
          <Empty>No transactions found.</Empty>
        ) : (
          <>
            <div className="space-y-2.5 p-3 lg:hidden">
              {txns.map((t) => {
                const badge = TYPE_BADGE[t.type] ?? { tone: "blue" as const, label: t.type };
                return (
                  <DataCard key={t.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-cocoa-800">
                          {(t.transaction_items ?? []).map((li) => li.item_name).join(", ") || "—"}
                        </div>
                        <div className="font-mono text-xs text-cocoa-400">
                          {(t.transaction_items ?? []).map((li) => li.sku).join(", ")}
                        </div>
                      </div>
                      <Badge tone={badge.tone} variant="tag">
                        {badge.label}
                      </Badge>
                    </div>
                    <DataField label="Staff">{t.actor_name}</DataField>
                    <DataField label="Date">{fmtDateTime(t.created_at)}</DataField>
                    {t.note && <DataField label="Note">{t.note}</DataField>}
                    <div className="mt-1 space-y-1">
                      {(t.transaction_items ?? []).map((li, i) => (
                        <div key={i} className="flex items-center justify-between text-xs text-cocoa-500">
                          <span className="truncate">
                            {li.item_name}
                            {li.expiration_date && (
                              <span className="ml-1 rounded bg-cream-100 px-1.5 py-0.5 text-[10px] font-medium text-cocoa-600">
                                exp {fmtDate(li.expiration_date)}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums">{fmtQty(Number(li.quantity))}</span>
                        </div>
                      ))}
                    </div>
                  </DataCard>
                );
              })}
            </div>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-100/60">
                    <th className="th">Type</th>
                    <th className="th">Items</th>
                    <th className="th">Staff</th>
                    <th className="th">Note</th>
                    <th className="th">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {txns.map((t) => {
                    const badge = TYPE_BADGE[t.type] ?? { tone: "blue" as const, label: t.type };
                    return (
                      <tr key={t.id} className="transition-colors hover:bg-cream-50">
                        <td className="td">
                          <Badge tone={badge.tone} variant="tag">
                            {badge.label}
                          </Badge>
                        </td>
                        <td className="td">
                          <div className="max-w-[200px]">
                            {(t.transaction_items ?? []).map((li, i) => (
                              <div key={i} className="truncate text-xs">
                                {li.item_name} ({fmtQty(Number(li.quantity))})
                                {li.expiration_date && (
                                  <span className="ml-1 text-cocoa-400">exp {fmtDate(li.expiration_date)}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="td text-cocoa-700">{t.actor_name}</td>
                        <td className="td max-w-[200px] truncate text-cocoa-500">
                          {t.note || "—"}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-cocoa-500">
                          {fmtDateTime(t.created_at)}
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

      {hasMore && !loading && (
        <div className="flex justify-center">
          <button className="btn-ghost" onClick={() => load(false)}>
            Load more
          </button>
        </div>
      )}

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
