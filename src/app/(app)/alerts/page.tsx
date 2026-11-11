"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { fmtDateTime, fmtQty } from "@/lib/format";
import { alertTypeStatus, stockStatus } from "@/lib/status";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import { alertSeenStorageKey } from "@/lib/alert-read-state";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

type AlertRow = {
  id: string;
  type: string;
  message: string;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  resolved_reason: string | null;
  created_at: string;
  updated_at: string;
  item: {
    sku: string;
    name: string;
    unit: string;
    quantity: number;
    low_stock_threshold: number;
    supplier: {
      id: string;
      name: string;
      contact_name: string | null;
      phone: string | null;
      email: string | null;
    } | null;
  } | null;
};

type DateFilter = "all" | "today";
type StatusFilter = "open" | "resolved" | "all";

/** Alert kind, using the shared wording so it matches the detail page. */
function TypeBadge({ type }: { type: string }) {
  const status = alertTypeStatus(type);
  return (
    <Badge tone={status.tone} variant="tag">
      {status.label}
    </Badge>
  );
}

function ResolutionBadge({ resolved }: { resolved: boolean }) {
  return (
    <Badge tone={resolved ? "green" : "slate"} variant="tag">
      {resolved ? "Resolved" : "Open"}
    </Badge>
  );
}

/** Current stock band for the item behind an alert. */
function StockBadge({ item }: { item: AlertRow["item"] }) {
  if (!item) return <span className="text-cocoa-200">—</span>;

  const status = stockStatus(item.quantity, item.low_stock_threshold);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-semibold tabular-nums text-cocoa-800">
        {fmtQty(item.quantity, item.unit)}
      </span>
      <Badge tone={status.tone} variant="tag">
        {status.label}
      </Badge>
    </div>
  );
}

function localDateKey(value: string | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  // Today by default: the page answers "what needs attention now", not "every
  // alert this cafe has ever had". Older days are one click away.
  const [dateFilter, setDateFilter] = useState<DateFilter>("today");
  // Open by default so the list agrees with the stat cards above it. Resolved
  // alerts are still one click away, which is how an owner checks that a
  // recurring stockout was actually handled.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [seenError, setSeenError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [resolvingAlert, setResolvingAlert] = useState<AlertRow | null>(null);
  const [resolveReason, setResolveReason] = useState("");
  const [savingResolution, setSavingResolution] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const requestId = useRef(0);
  const refreshInProgress = useRef(false);
  /**
   * The server timestamp of the last "seen" write made by this mount.
   *
   * The badge reads the account's stored `alerts_seen_at`; a timestamp kept
   * only in this browser never cleared it. This ref is what the old
   * localStorage comparison should have been: it makes the first load mark
   * alerts seen (so an account whose column is still null stops reporting
   * every alert it has ever had), while the 8s live refresh only writes again
   * when an alert is actually newer.
   */
  const lastMarkedSeenAt = useRef<string | null>(null);
  // Recompute is an admin action (the API rejects staff with 403), so the button
  // is hidden rather than left visible and failing. Staff still get the full
  // read-only alert list — the /alerts link is in their nav on purpose.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (alive) {
          setIsAdmin(d?.user?.role === "admin");
          setUserId(d?.user?.id ?? null);
        }
      })
      .catch(() => {
        /* a failed session read just leaves the button hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    const currentRequestId = ++requestId.current;

    try {
      const loadedAlerts: AlertRow[] = [];
      const pageSize = 500;
      let offset = 0;
      while (true) {
        const res = await fetch(
          `/api/alerts?status=all&limit=${pageSize}&offset=${offset}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load alerts");
        if (currentRequestId !== requestId.current) return;

        const page: AlertRow[] = data.alerts ?? [];
        loadedAlerts.push(...page);
        if (page.length < pageSize) break;
        offset += page.length;
      }

      setAlerts(loadedAlerts);
      setError(null);

      const storageKey = alertSeenStorageKey(userId);
      const latestAlertAt = loadedAlerts.reduce(
        (latest, alert) =>
          Date.parse(alert.updated_at) > latest
            ? Date.parse(alert.updated_at)
            : latest,
        0
      );
      const lastMarkedAt = lastMarkedSeenAt.current;
      if (
        currentRequestId === requestId.current &&
        (!lastMarkedAt || latestAlertAt > Date.parse(lastMarkedAt))
      ) {
        try {
          const seenResponse = await fetch("/api/alerts", { method: "PATCH" });
          const seenData = await seenResponse.json();
          if (!seenResponse.ok) {
            throw new Error(seenData.error || "Could not mark alerts as seen");
          }
          if (currentRequestId !== requestId.current) return;
          // Kept for the legacy path (an older database without the column)
          // and so a refresh does not fall back to a stale value.
          if (seenData.seenAt) {
            lastMarkedSeenAt.current = seenData.seenAt;
            window.localStorage.setItem(storageKey, seenData.seenAt);
          }
          setSeenError(null);
          window.dispatchEvent(new Event("cafetrack:alerts-seen"));
        } catch (e: any) {
          if (currentRequestId === requestId.current) {
            setSeenError(e.message || "Could not mark alerts as seen");
          }
        }
      }
    } catch (e: any) {
      if (currentRequestId === requestId.current) {
        setError(e.message || "Could not load alerts");
      }
    } finally {
      if (currentRequestId === requestId.current) setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshAlerts = useCallback(async () => {
    if (loading || refreshInProgress.current) return;
    refreshInProgress.current = true;
    try {
      await load();
    } finally {
      refreshInProgress.current = false;
    }
  }, [load, loading]);

  // An alert can open or escalate at any moment — a restock runs out of shelf
  // life, a delivery arrives already expired, the till draws the last of an
  // item. Subscribing means the list moves now rather than up to 8s later.
  useLiveRefresh(load);
  const pullToRefresh = usePullToRefresh(refreshAlerts);

  const today = localDateKey(new Date());
  const datedAlerts =
    dateFilter === "today"
      ? alerts.filter((alert) => localDateKey(alert.updated_at) === today)
      : alerts;
  // The stat cards describe open alerts for the chosen day even when the list
  // below is showing resolved history, so "Out of Stock 0" beside a resolved
  // row does not read as a contradiction.
  const openAlerts = datedAlerts.filter((a) => !a.resolved);
  const visibleAlerts =
    statusFilter === "all"
      ? datedAlerts
      : statusFilter === "resolved"
        ? datedAlerts.filter((a) => a.resolved)
        : openAlerts;
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

  async function resolveFromList() {
    if (!resolvingAlert) return;
    const reason = resolveReason.trim();
    if (!reason) {
      setToast({ msg: "Enter a reason before resolving this alert", tone: "error" });
      return;
    }

    setSavingResolution(true);
    try {
      const res = await fetch(`/api/alerts/${resolvingAlert.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: true, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not resolve alert");

      setResolvingAlert(null);
      setResolveReason("");
      setToast({ msg: "Alert resolved with reason saved", tone: "success" });
      await load();
    } catch (e: any) {
      setToast({ msg: e.message || "Could not resolve alert", tone: "error" });
    } finally {
      setSavingResolution(false);
    }
  }

  return (
    <div className="space-y-5" data-pull-to-refresh {...pullToRefresh.handlers}>
      {pullToRefresh.indicator}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Alerts</h1>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <button
              className="btn-ghost"
              onClick={recompute}
              disabled={recomputing}
            >
              {recomputing ? "Recomputing..." : "Recompute"}
            </button>
          )}
          {isAdmin && (
            <Link href="/items" className="btn-primary">
              Manage items
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold text-cocoa-400">Date</span>
          {([
            ["today", "Today"],
            ["all", "All dates"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDateFilter(key)}
              aria-pressed={dateFilter === key}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                dateFilter === key
                  ? "bg-cream-300 text-cocoa-800"
                  : "border border-cream-300 bg-white text-cocoa-600 hover:bg-cream-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold text-cocoa-400">Status</span>
          {([
            ["open", "Not resolved"],
            ["resolved", "Resolved"],
            ["all", "All"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              aria-pressed={statusFilter === key}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                statusFilter === key
                  ? "bg-cream-300 text-cocoa-800"
                  : "border border-cream-300 bg-white text-cocoa-600 hover:bg-cream-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Out of Stock" value={counts.out} tone="danger" />
        <Stat label="Low Stock" value={counts.low} tone="warn" />
        <Stat label="Expired" value={counts.expired} tone="danger" />
        <Stat label="Expiring Soon" value={counts.soon} tone="warn" />
      </div>

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}
      {seenError && (
        <div className="rounded-xl bg-ochre-50 px-3.5 py-2.5 text-sm text-ochre-800">
          Alerts loaded, but could not mark them as seen: {seenError}
        </div>
      )}

      <Card className="!p-0">
        <div>
          {loading ? (
            <Spinner label="Loading alerts..." />
          ) : (
            <>
          {visibleAlerts.length === 0 && (
            <Empty>
              {statusFilter === "resolved"
                ? dateFilter === "today"
                  ? "No alerts were resolved today."
                  : "No resolved alerts yet."
                : statusFilter === "open"
                  ? dateFilter === "today"
                    ? "No open alerts today — nothing needs attention."
                    : "No open alerts."
                  : dateFilter === "today"
                    ? "No alerts today."
                    : "No alerts yet."}
            </Empty>
          )}

          {visibleAlerts.length > 0 && (
            <div className="space-y-2.5 px-3 pb-3 lg:hidden">
              {visibleAlerts.map((a) => (
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
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <TypeBadge type={a.type} />
                      <ResolutionBadge resolved={a.resolved} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <StockBadge item={a.item} />
                  </div>

                  {a.item?.supplier && (
                    <DataField label="Supplier">
                      <span className="text-xs text-cocoa-600">
                        {a.item.supplier.name}
                        {a.item.supplier.phone && ` · ${a.item.supplier.phone}`}
                      </span>
                    </DataField>
                  )}

                  <DataField label="Message">{a.message}</DataField>
                  <DataField label="Updated">
                    <span className="text-xs text-cocoa-400">
                      {fmtDateTime(a.updated_at)}
                    </span>
                    <span className="block text-xs text-cocoa-400">
                      Raised {fmtDateTime(a.created_at)}
                      {a.resolved && a.resolved_by && ` · by ${a.resolved_by}`}
                    </span>
                  </DataField>
                  {a.resolved && a.resolved_reason && (
                    <DataField label="Resolution reason">
                      {a.resolved_reason}
                    </DataField>
                  )}

                  <div className="flex gap-2">
                    <Link
                      href={`/alerts/${a.id}`}
                      className="btn-ghost min-h-[40px] flex-1 !py-1.5 text-sm"
                    >
                      View
                    </Link>
                    {isAdmin && !a.resolved && (
                      <button
                        type="button"
                        className="btn-primary min-h-[40px] flex-1 !py-1.5 text-sm"
                        onClick={() => setResolvingAlert(a)}
                      >
                        Mark resolved
                      </button>
                    )}
                  </div>
                </DataCard>
              ))}
            </div>
          )}

          {visibleAlerts.length > 0 && (
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-100/60">
                    <th className="th">Alert status</th>
                    <th className="th">Item</th>
                    <th className="th">Current Stock</th>
                    <th className="th">Message</th>
                    <th className="th">Updated / Raised</th>
                    <th className="th text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleAlerts.map((a) => (
                    <tr
                      key={a.id}
                      className="transition-colors hover:bg-cream-50"
                    >
                      <td className="td">
                        <div className="flex flex-wrap gap-1.5">
                          <TypeBadge type={a.type} />
                          <ResolutionBadge resolved={a.resolved} />
                        </div>
                      </td>
                      <td className="td">
                        <div className="font-semibold text-cocoa-800">
                          {a.item?.name ?? "Deleted item"}
                        </div>
                        <div className="font-mono text-xs text-cocoa-400">
                          {a.item?.sku ?? "—"}
                        </div>
                        {/* Who to call. The alert is actionable only if the
                            next step has a phone number attached to it. */}
                        {a.item?.supplier && (
                          <div className="mt-0.5 text-xs text-cocoa-500">
                            {a.item.supplier.contact_name ||
                              a.item.supplier.name}
                            {a.item.supplier.phone && (
                              <a
                                href={`tel:${a.item.supplier.phone}`}
                                className="ml-1 text-ochre-700 underline"
                              >
                                {a.item.supplier.phone}
                              </a>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="td">
                        <StockBadge item={a.item} />
                      </td>
                      <td className="td text-cocoa-600">{a.message}</td>
                      <td className="td text-xs text-cocoa-400">
                        <div>{fmtDateTime(a.updated_at)}</div>
                        <div className="mt-0.5">Raised {fmtDateTime(a.created_at)}</div>
                        {a.resolved && a.resolved_by && (
                          <div>by {a.resolved_by}</div>
                        )}
                        {a.resolved && a.resolved_reason && (
                          <div className="mt-1 max-w-xs whitespace-normal text-cocoa-600">
                            {a.resolved_reason}
                          </div>
                        )}
                      </td>
                      <td className="td text-right">
                        <div className="flex justify-end gap-1.5">
                          <Link
                            href={`/alerts/${a.id}`}
                            className="btn-ghost !px-3 !py-1 text-xs"
                          >
                            View
                          </Link>
                          {isAdmin && !a.resolved && (
                            <button
                              type="button"
                              className="btn-primary !px-3 !py-1 text-xs"
                              onClick={() => setResolvingAlert(a)}
                            >
                              Resolve
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
            </>
          )}
        </div>
      </Card>

      {resolvingAlert && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-cocoa-950/50 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingResolution) {
              setResolvingAlert(null);
              setResolveReason("");
            }
          }}
        >
          <div
            className="card w-full max-w-lg space-y-4 p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="resolve-alert-title"
          >
            <div>
              <h2
                id="resolve-alert-title"
                className="text-lg font-bold text-cocoa-900"
              >
                Resolve {resolvingAlert.item?.name ?? "alert"}
              </h2>
              <p className="mt-1 text-sm text-cocoa-500">
                Add a note explaining how this alert was handled. It will be
                saved in the alert history.
              </p>
            </div>
            <textarea
              autoFocus
              rows={4}
              maxLength={1000}
              value={resolveReason}
              onChange={(event) => setResolveReason(event.target.value)}
              placeholder="Describe how the issue was resolved"
              className="input min-h-28 w-full resize-y"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={savingResolution}
                onClick={() => {
                  setResolvingAlert(null);
                  setResolveReason("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={savingResolution || !resolveReason.trim()}
                onClick={resolveFromList}
              >
                {savingResolution ? "Saving..." : "Save and resolve"}
              </button>
            </div>
          </div>
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
