"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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
import { fmtDateTime } from "@/lib/format";
import { alertTypeStatus, stockStatus } from "@/lib/status";

type AlertRow = {
  id: string;
  type: string;
  message: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  item: {
    sku: string;
    name: string;
    unit: string;
    quantity: number;
    low_stock_threshold: number;
  } | null;
};

type Status = "open" | "resolved" | "all";

const TABS: { key: Status; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

/** Alert kind, using the shared wording so it matches the detail page. */
function TypeBadge({ type }: { type: string }) {
  const status = alertTypeStatus(type);
  return (
    <Badge tone={status.tone} variant="tag">
      {status.label}
    </Badge>
  );
}

/** Current stock band for the item behind an alert. */
function StockBadge({ item }: { item: AlertRow["item"] }) {
  if (!item) return <span className="text-cocoa-200">—</span>;

  const status = stockStatus(item.quantity, item.low_stock_threshold);
  return (
    <Badge tone={status.tone} variant="tag">
      {status.label}
    </Badge>
  );
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [status, setStatus] = useState<Status>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const res = await fetch(`/api/alerts?status=${status}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load alerts");
      setAlerts(data.alerts ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load alerts");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const openAlerts = alerts.filter((a) => !a.resolved);
  const counts = {
    out: openAlerts.filter((a) => a.type === "out_of_stock").length,
    low: openAlerts.filter((a) => a.type === "low_stock").length,
    expired: openAlerts.filter((a) => a.type === "expired").length,
    soon: openAlerts.filter((a) => a.type === "near_expiry").length,
  };

  async function recompute() {
    setRecomputing(true);
    try {
      const res = await fetch("/api/alerts", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not recompute alerts");

      await load();
      setToast({ msg: "Alerts recomputed from current stock", tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setRecomputing(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Alerts</h1>
          <p className="mt-1 text-sm text-cocoa-500">
            Stock and expiry warnings raised by the inventory monitor.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost"
            onClick={recompute}
            disabled={recomputing}
          >
            {recomputing ? "Recomputing..." : "Recompute"}
          </button>
          <Link href="/items" className="btn-primary">
            Manage items
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setLoading(true);
              setStatus(t.key);
            }}
            className={`rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
              status === t.key
                ? "bg-cocoa-700 text-cream-50"
                : "border border-cream-300 bg-white text-cocoa-600 hover:bg-cream-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {status === "open" && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Out of Stock" value={counts.out} tone="danger" />
          <Stat label="Low Stock" value={counts.low} tone="warn" />
          <Stat label="Expired" value={counts.expired} tone="danger" />
          <Stat label="Expiring Soon" value={counts.soon} tone="warn" />
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : (
        <Card className="!p-0">
          {alerts.length === 0 && (
            <Empty>Nothing to show — no alerts match this filter.</Empty>
          )}

          {alerts.length > 0 && (
            <div className="space-y-2.5 px-3 pb-3 lg:hidden">
              {alerts.map((a) => (
                <DataCard key={a.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-cocoa-800">
                        {a.item?.name ?? "Deleted item"}
                      </div>
                      <div className="font-mono text-xs text-cocoa-400">
                        {a.item?.sku ?? "—"}
                      </div>
                    </div>
                    <TypeBadge type={a.type} />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <StockBadge item={a.item} />
                  </div>

                  <DataField label="Message">{a.message}</DataField>
                  <DataField label="Raised">
                    <span className="text-xs text-cocoa-400">
                      {fmtDateTime(a.created_at)}
                      {a.resolved && a.resolved_by && ` · by ${a.resolved_by}`}
                    </span>
                  </DataField>

                  <Link
                    href={`/alerts/${a.id}`}
                    className="btn-ghost min-h-[40px] w-full !py-1.5 text-sm"
                  >
                    View alert
                  </Link>
                </DataCard>
              ))}
            </div>
          )}

          {alerts.length > 0 && (
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-100/60">
                    <th className="th">Alert</th>
                    <th className="th">Item</th>
                    <th className="th">Current Stock</th>
                    <th className="th">Message</th>
                    <th className="th">Raised</th>
                    <th className="th text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a) => (
                    <tr
                      key={a.id}
                      className="transition-colors hover:bg-cream-50"
                    >
                      <td className="td">
                        <TypeBadge type={a.type} />
                      </td>
                      <td className="td">
                        <div className="font-semibold text-cocoa-800">
                          {a.item?.name ?? "Deleted item"}
                        </div>
                        <div className="font-mono text-xs text-cocoa-400">
                          {a.item?.sku ?? "—"}
                        </div>
                      </td>
                      <td className="td">
                        <StockBadge item={a.item} />
                      </td>
                      <td className="td text-cocoa-600">{a.message}</td>
                      <td className="td text-xs text-cocoa-400">
                        {fmtDateTime(a.created_at)}
                        {a.resolved && a.resolved_by && (
                          <div>by {a.resolved_by}</div>
                        )}
                      </td>
                      <td className="td text-right">
                        <Link
                          href={`/alerts/${a.id}`}
                          className="btn-ghost !px-3 !py-1 text-xs"
                        >
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
