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
  Modal,
} from "@/components/ui";
import { fmtQty, fmtDateTime, fmtDate } from "@/lib/format";
import { TRANSACTION_NOTE_SCHEMA_WARNING } from "@/lib/transaction-note-schema";

type TxnItem = {
  id?: string;
  sku: string;
  item_name: string;
  quantity: number;
  qty_before?: number;
  qty_after?: number;
  expiration_date: string | null;
  note: string | null;
  batch_allocations?: {
    batch_id: string;
    batch_code: string;
    expiration_date: string | null;
    quantity: number;
  }[];
};

type Txn = {
  id: string;
  type: string;
  actor_name: string;
  note: string | null;
  created_at: string;
  actor_id?: string | null;
  transaction_items: TxnItem[] | null;
};

const TYPE_BADGE: Record<string, { tone: "blue" | "green" | "amber"; label: string }> = {
  checkout: { tone: "blue", label: "Checkout" },
  restock: { tone: "green", label: "Restock" },
  waste: { tone: "amber", label: "Log Waste" },
};

const PAGE_SIZE = 50;

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDayBounds(day: string): { fromAt: string; before: string } | null {
  const start = new Date(`${day}T00:00:00`);
  if (Number.isNaN(start.getTime()) || localDateValue(start) !== day) return null;

  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { fromAt: start.toISOString(), before: end.toISOString() };
}

function wasteStockStatus(
  item: TxnItem,
  createdAt: string
): string {
  const transactionDay = createdAt.slice(0, 10);
  const allocations = item.batch_allocations ?? [];
  if (allocations.length > 0) {
    const statuses = allocations.map((batch) => {
      if (!batch.expiration_date) return "non-expiring";
      return batch.expiration_date.slice(0, 10) < transactionDay
        ? "expired"
        : "not expired";
    });
    const uniqueStatuses = [...new Set(statuses)];
    if (uniqueStatuses.length > 1) return "Mixed: expired and not expired";
    if (uniqueStatuses[0] === "non-expiring") return "Non-expiring item";
    return uniqueStatuses[0] === "expired" ? "Expired" : "Not expired";
  }

  if (!item.expiration_date) return "No expiry recorded";
  return item.expiration_date.slice(0, 10) < transactionDay
    ? "Expired"
    : "Not expired";
}

function wasteStockStatusTone(status: string): "red" | "green" | "amber" | "slate" {
  if (status === "Expired") return "red";
  if (status === "Not expired") return "green";
  if (status.startsWith("Mixed:")) return "amber";
  return "slate";
}

export default function HistoryPage() {
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: "info" | "error" | "success" } | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [search, setSearch] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [transactionNotesAvailable, setTransactionNotesAvailable] = useState(true);
  const [selectedTransaction, setSelectedTransaction] = useState<Txn | null>(null);
  // null until /api/auth/me answers. The server scopes staff to their own rows
  // either way, so the only thing this controls is which filters are offered.
  const [role, setRole] = useState<"admin" | "staff" | null>(null);
  const isAdmin = role === "admin";

  useEffect(() => {
    let active = true;

    async function loadRole() {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load your account");
        if (data?.user?.role !== "admin" && data?.user?.role !== "staff") {
          throw new Error("Could not determine your account role");
        }
        if (active) setRole(data.user.role);
      } catch (e: unknown) {
        if (active) {
          setError(e instanceof Error ? e.message : "Could not load your account");
          setLoading(false);
        }
      }
    }

    void loadRole();
    return () => {
      active = false;
    };
  }, []);

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
      const bounds = localDayBounds(selectedDate);
      if (!bounds) throw new Error("Choose a valid date to view history");
      qs.set("from_at", bounds.fromAt);
      qs.set("before", bounds.before);
      if (typeFilter) qs.set("type", typeFilter);
      if (search.trim()) qs.set("staff", search.trim());
      if (itemSearch.trim()) qs.set("item", itemSearch.trim());

      const res = await fetch(`/api/transactions?${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load history");

      const newTxns: Txn[] = data.transactions ?? [];
      setTransactionNotesAvailable(data.transactionNotesAvailable !== false);
      if (reset) {
        setTxns(newTxns);
      } else {
        setTxns((prev) => [...prev, ...newTxns]);
      }
      setHasMore(newTxns.length === PAGE_SIZE);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load history");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!role) return;
    if (!selectedDate) {
      setSelectedDate(localDateValue(new Date()));
      return;
    }
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, typeFilter, search, itemSearch, selectedDate]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="deco-title text-3xl">History</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          {isAdmin
            ? "All checkout, restock, and waste transactions for the selected date."
            : "Your checkout, restock, and waste transactions for the selected date."}
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}
      {!transactionNotesAvailable && (
        <div className="rounded-xl bg-ochre-50 px-3.5 py-2.5 text-sm text-ochre-800">
          {TRANSACTION_NOTE_SCHEMA_WARNING}
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="hist-date">
              Date
            </label>
            <input
              id="hist-date"
              type="date"
              className="input"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
          </div>
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
          {isAdmin ? (
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
          ) : role === "staff" ? (
            <div>
              <label className="label" htmlFor="hist-item">
                Item
              </label>
              <input
                id="hist-item"
                className="input"
                placeholder="Search by item name or SKU..."
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
              />
            </div>
          ) : null}
          <button className="btn-ghost" onClick={() => load(true)}>
            Reload
          </button>
          <button
            className="btn-ghost"
            onClick={() => setSelectedDate(localDateValue(new Date()))}
          >
            Today
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
                    <button
                      type="button"
                      className="btn-ghost mt-2 w-full text-xs"
                      onClick={() => setSelectedTransaction(t)}
                    >
                      View details
                    </button>
                    <div className="mt-1 space-y-1">
                      {(t.transaction_items ?? []).map((li, i) => (
                        <div key={i} className="text-xs text-cocoa-500">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate">
                              {li.item_name}
                              {li.expiration_date &&
                                !(
                                  t.type === "checkout" &&
                                  (li.batch_allocations ?? []).length > 0
                                ) && (
                                <span className="ml-1 rounded bg-cream-100 px-1.5 py-0.5 text-[10px] font-medium text-cocoa-600">
                                  exp {fmtDate(li.expiration_date)}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 tabular-nums">{fmtQty(Number(li.quantity))}</span>
                          </div>
                          {li.note && (
                            <div className="mt-0.5 space-y-0.5 pl-2 text-[11px] text-cocoa-400">
                              {li.note.split("\n").filter(Boolean).map((note, noteIndex) => (
                                <p key={`${i}-note-${noteIndex}`}>Item note: {note}</p>
                              ))}
                            </div>
                          )}
                          {(li.batch_allocations ?? []).length > 0 && (
                            <div className="mt-0.5 pl-2 text-[11px] text-cocoa-400">
                              {(li.batch_allocations ?? []).map((batch) => (
                                <div key={batch.batch_id}>
                                  {batch.batch_code}: {fmtQty(Number(batch.quantity))}
                                  {batch.expiration_date
                                    ? ` · exp ${fmtDate(batch.expiration_date)}`
                                    : ""}
                                </div>
                              ))}
                            </div>
                          )}
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
                    <th className="th text-right">Details</th>
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
                              <div key={i}>
                                <div className="truncate text-xs">
                                  {li.item_name} ({fmtQty(Number(li.quantity))})
                                  {li.expiration_date &&
                                    !(
                                      t.type === "checkout" &&
                                      (li.batch_allocations ?? []).length > 0
                                    ) && (
                                    <span className="ml-1 text-cocoa-400">exp {fmtDate(li.expiration_date)}</span>
                                  )}
                                </div>
                                {li.note && (
                                  <div className="space-y-0.5 pl-2 text-[11px] text-cocoa-400">
                                    {li.note.split("\n").filter(Boolean).map((note, noteIndex) => (
                                      <div key={`${i}-note-${noteIndex}`}>Item note: {note}</div>
                                    ))}
                                  </div>
                                )}
                                {(li.batch_allocations ?? []).length > 0 && (
                                  <div className="pl-2 text-[11px] text-cocoa-400">
                                    {(li.batch_allocations ?? []).map((batch) => (
                                      <div key={batch.batch_id}>
                                        {batch.batch_code}: {fmtQty(Number(batch.quantity))}
                                        {batch.expiration_date
                                          ? ` · exp ${fmtDate(batch.expiration_date)}`
                                          : ""}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="td text-cocoa-700">{t.actor_name}</td>
                        <td className="td max-w-[200px] whitespace-pre-line text-cocoa-500">
                          {t.note || "—"}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-cocoa-500">
                          {fmtDateTime(t.created_at)}
                        </td>
                        <td className="td text-right">
                          <button
                            type="button"
                            className="btn-ghost !px-2.5 !py-1.5 text-xs"
                            onClick={() => setSelectedTransaction(t)}
                          >
                            View details
                          </button>
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

      <Modal
        open={selectedTransaction !== null}
        onClose={() => setSelectedTransaction(null)}
        title="Transaction details"
        width="max-w-2xl"
        scrollable
      >
        {selectedTransaction && (() => {
          const transaction = selectedTransaction;
          const badge = TYPE_BADGE[transaction.type] ?? {
            tone: "blue" as const,
            label: transaction.type,
          };
          return (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <DataField label="Type">
                  <Badge tone={badge.tone} variant="tag">{badge.label}</Badge>
                </DataField>
                <DataField label="Date">{fmtDateTime(transaction.created_at)}</DataField>
                <DataField label="Staff">{transaction.actor_name}</DataField>
                <DataField label="Transaction ID">
                  <span className="break-all font-mono text-[11px]">{transaction.id}</span>
                </DataField>
              </div>

              {transaction.note && (
                <section className="rounded-xl border border-cream-200 bg-cream-50 p-3">
                  <h4 className="text-xs font-bold uppercase tracking-wide text-cocoa-500">
                    Transaction note
                  </h4>
                  <p className="mt-1 whitespace-pre-line text-sm text-cocoa-700">
                    {transaction.note}
                  </p>
                </section>
              )}

              <section>
                <h4 className="mb-2 text-sm font-bold text-cocoa-800">Items</h4>
                <div className="space-y-3">
                  {(transaction.transaction_items ?? []).map((item, index) => (
                    <article
                      key={item.id ?? `${item.sku}-${index}`}
                      className="rounded-xl border border-cream-200 p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h5 className="font-semibold text-cocoa-800">{item.item_name}</h5>
                          <p className="font-mono text-[11px] text-cocoa-400">{item.sku}</p>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Badge tone={badge.tone} variant="tag">{badge.label}</Badge>
                          {transaction.type === "waste" && (() => {
                            const status = wasteStockStatus(item, transaction.created_at);
                            return (
                              <Badge tone={wasteStockStatusTone(status)} variant="tag">
                                {status}
                              </Badge>
                            );
                          })()}
                        </div>
                      </div>

                      <dl className="mt-3 grid gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                        <div>
                          <dt className="text-cocoa-400">Quantity moved</dt>
                          <dd className="font-semibold text-cocoa-700">
                            {fmtQty(Number(item.quantity))}
                          </dd>
                        </div>
                        {item.qty_before !== undefined && (
                          <div>
                            <dt className="text-cocoa-400">Stock before</dt>
                            <dd className="font-semibold text-cocoa-700">
                              {fmtQty(Number(item.qty_before))}
                            </dd>
                          </div>
                        )}
                        {item.qty_after !== undefined && (
                          <div>
                            <dt className="text-cocoa-400">Stock after</dt>
                            <dd className="font-semibold text-cocoa-700">
                              {fmtQty(Number(item.qty_after))}
                            </dd>
                          </div>
                        )}
                        {item.expiration_date && (
                          <div>
                            <dt className="text-cocoa-400">Expiry</dt>
                            <dd className="font-semibold text-cocoa-700">
                              {fmtDate(item.expiration_date)}
                            </dd>
                          </div>
                        )}
                      </dl>

                      {item.note && (
                        <div className="mt-3 rounded-lg bg-ochre-50 px-3 py-2">
                          <h6 className="text-[11px] font-bold uppercase tracking-wide text-ochre-800">
                            {transaction.type === "waste" ? "Waste reason" : "Item note"}
                          </h6>
                          <p className="mt-1 whitespace-pre-line text-sm text-cocoa-700">
                            {item.note}
                          </p>
                        </div>
                      )}
                      {transaction.type === "waste" && !item.note && (
                        <div className="mt-3 rounded-lg border border-terracotta-200 bg-terracotta-50 px-3 py-2">
                          <h6 className="text-[11px] font-bold uppercase tracking-wide text-terracotta-700">
                            Waste reason
                          </h6>
                          <p className="mt-1 text-sm text-terracotta-700">
                            No reason was recorded for this transaction.
                          </p>
                        </div>
                      )}

                      {(item.batch_allocations ?? []).length > 0 && (
                        <div className="mt-3">
                          <h6 className="text-[11px] font-bold uppercase tracking-wide text-cocoa-500">
                            Batch details
                          </h6>
                          <div className="mt-1 divide-y divide-cream-200 rounded-lg border border-cream-200">
                            {(item.batch_allocations ?? []).map((batch) => (
                              <div
                                key={batch.batch_id}
                                className="flex flex-wrap justify-between gap-2 px-3 py-2 text-xs"
                              >
                                <span className="font-mono text-cocoa-700">{batch.batch_code}</span>
                                <span className="text-cocoa-600">
                                  {fmtQty(Number(batch.quantity))}
                                  {batch.expiration_date
                                    ? ` · expires ${fmtDate(batch.expiration_date)}`
                                    : " · no expiry"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            </div>
          );
        })()}
      </Modal>

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
