"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, Badge, Empty, Spinner, Stat, Toast } from "@/components/ui";
import { fmtDate, fmtDateTime, fmtQty } from "@/lib/format";
import { alertTypeStatus, expiryStatus, stockStatus } from "@/lib/status";

type AlertRow = {
  id: string;
  type: string;
  message: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  item_id: string | null;
};

type Item = {
  id: string;
  sku: string;
  name: string;
  physical_form: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  updated_at: string;
  category: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
};

type HistoryRow = {
  id: string;
  type: string;
  message: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

export default function AlertDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ? String(params.id) : "";

  const [alert, setAlert] = useState<AlertRow | null>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/alerts/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load this alert");

      setAlert(data.alert ?? null);
      setItem(data.item ?? null);
      setHistory(data.history ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load this alert");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function setResolved(resolved: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/alerts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update the alert");

      setToast({
        msg: resolved ? "Alert resolved" : "Alert re-opened",
        tone: "success",
      });
      await load();
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;

  if (error || !alert) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card className="space-y-2">
          <Empty>{error || "That alert no longer exists."}</Empty>
        </Card>
      </div>
    );
  }

  const kind = alertTypeStatus(alert.type);
  const stock = item ? stockStatus(item.quantity, item.low_stock_threshold) : null;
  const expiry = item ? expiryStatus(item.expiration_date) : null;
  const openCount = history.filter((h) => !h.resolved).length;

  return (
    <div className="space-y-5">
      <BackLink />

      {/* ---------- the alert itself ---------- */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={kind.tone} variant="tag">
                {kind.label}
              </Badge>
              <Badge tone={alert.resolved ? "green" : "slate"} variant="tag">
                {alert.resolved ? "Resolved" : "Open"}
              </Badge>
            </div>
            <h1 className="text-lg font-bold text-cocoa-900">{alert.message}</h1>
            <p className="text-sm text-cocoa-500">
              Raised {fmtDateTime(alert.created_at)}
              {alert.resolved && alert.resolved_at && (
                <>
                  {" · resolved "}
                  {fmtDateTime(alert.resolved_at)}
                  {alert.resolved_by ? ` by ${alert.resolved_by}` : ""}
                </>
              )}
            </p>
          </div>

          <button
            className={
              alert.resolved
                ? "btn-primary !px-4 !py-2 text-sm"
                : "btn-danger !px-4 !py-2 text-sm"
            }
            disabled={busy}
            onClick={() => setResolved(!alert.resolved)}
          >
            {busy ? "Saving..." : alert.resolved ? "Re-open alert" : "Resolve alert"}
          </button>
        </div>

        <p className="border-t border-cream-100 pt-3 text-xs text-cocoa-400">
          Resolving only closes this alert — stock levels are untouched, so use
          Checkout &amp; Restock for the actual movement. An alert re-opens by
          itself if the condition comes back.
        </p>
      </Card>

      {/* ---------- the item behind it ---------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-3">
          <h2 className="text-sm font-bold text-cocoa-800">Item</h2>

          {item ? (
            <>
              <div>
                <div className="text-base font-semibold text-cocoa-900">
                  {item.name}
                </div>
                <div className="font-mono text-xs text-cocoa-400">{item.sku}</div>
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <Field label="Category" value={item.category?.name ?? "Uncategorized"} />
                <Field label="Location" value={item.location?.name ?? "—"} />
                <Field label="Physical form" value={item.physical_form} />
                <Field label="Counts in" value={item.unit} />
              </dl>

              <Link href="/items" className="btn-ghost !px-3 !py-1.5 text-xs">
                Open inventory
              </Link>
            </>
          ) : (
            <Empty>This item has since been deleted.</Empty>
          )}
        </Card>

        <Card className="space-y-3">
          <h2 className="text-sm font-bold text-cocoa-800">Stock &amp; expiry</h2>

          {item ? (
            <>
              <div className="flex flex-wrap gap-2">
                {stock && (
                  <Badge tone={stock.tone} variant="tag">
                    {stock.label}
                  </Badge>
                )}
                {expiry && expiry.key !== "none" && (
                  <Badge tone={expiry.tone} variant="tag">
                    {expiry.label}
                  </Badge>
                )}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Stat
                  label="On hand"
                  value={fmtQty(item.quantity, item.unit)}
                  tone={stock?.key === "out" ? "danger" : undefined}
                />
                <Stat
                  label="Low-stock threshold"
                  value={fmtQty(item.low_stock_threshold, item.unit)}
                />
                <Stat
                  label="Expiry date"
                  value={item.expiration_date ? fmtDate(item.expiration_date) : "—"}
                  hint={
                    expiry?.days === null || expiry?.days === undefined
                      ? "no date recorded"
                      : expiry.days < 0
                      ? `${Math.abs(expiry.days)} day(s) ago`
                      : `in ${expiry.days} day(s)`
                  }
                />
                <Stat label="Open alerts for this item" value={openCount} />
              </div>
            </>
          ) : (
            <Empty>No stock information available.</Empty>
          )}
        </Card>
      </div>

      {/* ---------- every alert raised for this item ---------- */}
      <Card className="!p-0">
        <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
          <h2 className="text-sm font-bold text-cocoa-800">
            Alert history for this item
          </h2>
        </div>

        {history.length === 0 ? (
          <Empty>No other alerts recorded for this item.</Empty>
        ) : (
          <ul className="divide-y divide-cream-100">
            {history.map((h) => {
              const hk = alertTypeStatus(h.type);
              const isCurrent = h.id === alert.id;
              return (
                <li
                  key={h.id}
                  className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 ${
                    isCurrent ? "bg-cream-50" : ""
                  }`}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={hk.tone} variant="tag">
                        {hk.label}
                      </Badge>
                      <Badge tone={h.resolved ? "green" : "slate"} variant="tag">
                        {h.resolved ? "Resolved" : "Open"}
                      </Badge>
                      {isCurrent && (
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-cocoa-400">
                          this alert
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-cocoa-700">{h.message}</div>
                    <div className="text-[11px] text-cocoa-400">
                      Raised {fmtDateTime(h.created_at)}
                      {h.resolved && h.resolved_at && (
                        <>
                          {" · resolved "}
                          {fmtDateTime(h.resolved_at)}
                          {h.resolved_by ? ` by ${h.resolved_by}` : ""}
                        </>
                      )}
                    </div>
                  </div>

                  {!isCurrent && (
                    <Link
                      href={`/alerts/${h.id}`}
                      className="btn-ghost !px-3 !py-1 text-xs"
                    >
                      View
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BackLink() {
  return (
    <Link
      href="/alerts"
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-cocoa-500 transition-colors hover:text-cocoa-700"
    >
      ← Back to alerts
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">
        {label}
      </dt>
      <dd className="capitalize text-cocoa-700">{value}</dd>
    </div>
  );
}
