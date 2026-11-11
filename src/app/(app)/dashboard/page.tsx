"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Stat, ViewPill, Badge, Spinner, Empty } from "@/components/ui";
import { BaristaArt } from "@/components/BrandArt";
import { LiveRegion } from "@/components/LiveRegion";
import { fmtQty, fmtDate, fmtDateTime, daysUntil } from "@/lib/format";
import { stockStatus } from "@/lib/status";
import { useLiveRefresh } from "@/lib/use-live-refresh";
import type { DutyActivityCounts, DutyRosterEntry } from "@/lib/duty-roster";

type Item = {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  low_stock_threshold: number;
  expiration_date: string | null;
  batches?: {
    id: string;
    batch_code: string;
    remaining_quantity: number;
    expiration_date: string | null;
  }[];
  category: { name: string } | null;
};

type ExpiringBatchRow = {
  id: string;
  name: string;
  batchCode: string | null;
  quantity: number;
  unit: string;
  days: number;
};

type Txn = {
  id: string;
  type: string;
  actor_name: string;
  created_at: string;
  transaction_items: { sku: string; item_name: string; quantity: number }[];
};


type SnapshotItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  category: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
};

type Analytics = {
  mostNeeded: { thisMonth: { name: string; qty: number }[] };
  soonestExpiry: {
    sku: string;
    name: string;
    unit: string;
    quantity: number;
    expiration_date: string;
    daysUntilExpiry: number | null;
  }[];
  snapshot: { items: SnapshotItem[]; total: number };
};

type DutyDashboard = {
  visible: boolean;
  day: string;
  staff?: DutyRosterEntry[];
  activity?: DutyActivityCounts;
};

/** How often a live refresh may re-run the analytics aggregation. */
const ANALYTICS_MIN_INTERVAL_MS = 15_000;
const DASHBOARD_CARD_ROW_LIMIT = 8;

/** The filter key with every field empty, i.e. what the first load already fetches. */

export default function DashboardPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [dutyDashboard, setDutyDashboard] = useState<DutyDashboard | null>(null);
  const [dutyError, setDutyError] = useState<string | null>(null);
  const dutyInFlight = useRef(false);

  const analyticsInFlight = useRef(false);
  const lastAnalyticsAt = useRef(0);

  const loadAnalytics = useCallback(async (force = false) => {
    if (analyticsInFlight.current) return;

    // A live refresh can fire every few seconds when the event stream is down.
    // Re-running the 13-month aggregation that often would turn a disconnect
    // into a database problem, so the snapshot refreshes on a slower clock than
    // the stat pills. Filter changes pass force=true and always go through.
    if (!force && Date.now() - lastAnalyticsAt.current < ANALYTICS_MIN_INTERVAL_MS)
      return;

    analyticsInFlight.current = true;
    try {
      const res = await fetch("/api/analytics");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load analytics");

      setAnalytics(data);
      lastAnalyticsAt.current = Date.now();
    } catch {
      // The dashboard is still useful from items + transactions alone; a failed
      // analytics call must not replace the page with an error.
    } finally {
      analyticsInFlight.current = false;
    }
  }, []);

  const loadDutyDashboard = useCallback(async () => {
    if (dutyInFlight.current) return;
    dutyInFlight.current = true;
    try {
      const response = await fetch("/api/dashboard/duty", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load today's staff activity.");
      setDutyDashboard(data);
      setDutyError(null);
    } catch (e) {
      setDutyError(
        e instanceof Error ? e.message : "Could not load today's staff activity."
      );
    } finally {
      dutyInFlight.current = false;
    }
  }, []);

  async function load(force = false) {
    // Nothing on this page is time-critical to the millisecond, and a forgotten
    // background tab has no reason to keep asking — whether the trigger was a
    // poll or an event. The first load is forced, so a hidden tab still
    // populates when the owner comes back to it.
    if (!force && document.hidden) return;

    // Skip while a load is still in flight so a slow response cannot land late
    // and overwrite fresher data. Both mechanisms funnel through here, so an
    // event arriving during a poll is dropped — the poll already has the answer
    // the event was announcing.
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
      void loadDutyDashboard();

      // Keep the analytics cards on the same beat as the stat pills, subject to
      // the throttle in loadAnalytics.
      void loadAnalytics();
    } catch (e: any) {
      setError(e.message || "Could not load the dashboard");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  // First paint, then stay current.
  //
  // `useLiveRefresh` owns both the event subscription and the poll that backs it
  // up, so this page carries no timers of its own — one hook rather than two
  // independent refresh paths that could disagree about how fresh the figures
  // are.
  const { status: liveStatus } = useLiveRefresh(load);

  useEffect(() => {
    load(true);
    void loadDutyDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const low = items.filter(
      (i) => Number(i.quantity) > 0 && Number(i.quantity) <= Number(i.low_stock_threshold)
    );
    const out = items.filter((i) => Number(i.quantity) <= 0);
    const expired = items.filter((i) => {
      const activeBatches = (i.batches ?? []).filter(
        (batch) => Number(batch.remaining_quantity) > 0
      );
      if (activeBatches.length > 0) {
        return activeBatches.some((batch) => {
          const days = daysUntil(batch.expiration_date);
          return days !== null && days < 0;
        });
      }
      const d = daysUntil(i.expiration_date);
      return d !== null && d < 0;
    });
    return { total: items.length, low, out, expired };
  }, [items]);

  /* Top 4 items by total quantity checked out */
  const inDemand = useMemo(() => {
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
      .slice(0, DASHBOARD_CARD_ROW_LIMIT);
  }, [txns]);

  /*
   * Prefer the analytics endpoint's "this month" figure, which walks the whole
   * 13-month window, and fall back to the movements this page has while that
   * request is in flight or if it failed.
   */
  const demandRows =
    analytics && analytics.mostNeeded.thisMonth.length > 0
      ? analytics.mostNeeded.thisMonth.slice(0, DASHBOARD_CARD_ROW_LIMIT)
      : inDemand;

  /* Top 4 items by quantity on hand */
  const topStock = useMemo(
    () =>
      [...items]
        .sort((a, b) => Number(b.quantity) - Number(a.quantity))
      .slice(0, DASHBOARD_CARD_ROW_LIMIT),
    [items]
  );

  /* Soonest expiries, including already-expired */
  // An unparseable date sorts last rather than being treated as 0 days, which
  // would put it at the top of "soonest expiring" wearing an "Expired" label.
  const expiring = useMemo<ExpiringBatchRow[]>(
    () =>
      items
        .flatMap((item): ExpiringBatchRow[] => {
          const batches = (item.batches ?? []).filter(
            (batch) => Number(batch.remaining_quantity) > 0 && batch.expiration_date
          );
          if (batches.length > 0) {
            return batches.map((batch) => ({
              id: `${item.id}-${batch.id}`,
              name: item.name,
              batchCode: batch.batch_code,
              quantity: batch.remaining_quantity,
              unit: item.unit,
              days: daysUntil(batch.expiration_date) ?? Number.POSITIVE_INFINITY,
            }));
          }
          return Number(item.quantity) > 0 && item.expiration_date
            ? [{
                id: item.id,
                name: item.name,
                batchCode: null,
                quantity: item.quantity,
                unit: item.unit,
                days: daysUntil(item.expiration_date) ?? Number.POSITIVE_INFINITY,
              }]
            : [];
        })
        .sort((a, b) => a.days - b.days)
        .slice(0, DASHBOARD_CARD_ROW_LIMIT),
    [items]
  );

  const recent = txns.slice(0, DASHBOARD_CARD_ROW_LIMIT);
  const myActivity = dutyDashboard?.activity;
  const myActivityTotal = myActivity
    ? myActivity.checkout + myActivity.restock + myActivity.waste
    : 0;
  const myActivityRows = myActivity
    ? [
        { key: "checkout", label: "Checkout", count: myActivity.checkout, color: "bg-cream-500" },
        { key: "restock", label: "Restock", count: myActivity.restock, color: "bg-sage-500" },
        { key: "waste", label: "Log waste", count: myActivity.waste, color: "bg-terracotta-500" },
      ]
    : [];
  const maxActivityCount = Math.max(...myActivityRows.map((activity) => activity.count), 0);
  const myTopItems = useMemo(() => {
    if (!dutyDashboard?.day) return [];
    const totals = new Map<string, number>();
    for (const transaction of txns) {
      if (
          cafeDayKeyFormatter.format(new Date(transaction.created_at)) !==
          dutyDashboard.day
      ) {
          continue;
      }
      for (const item of transaction.transaction_items ?? []) {
        totals.set(
          item.item_name,
          (totals.get(item.item_name) ?? 0) + Number(item.quantity)
        );
      }
    }
    return [...totals.entries()]
      .map(([name, quantity]) => ({ name, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 4);
  }, [dutyDashboard?.day, txns]);

  if (loading) return <Spinner />;

  return (
    <div className="h-full min-h-0 lg:overflow-hidden">
      <div className="space-y-6 lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:gap-4 lg:space-y-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between lg:shrink-0">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-cocoa-900 sm:text-3xl">
              Inventory Dashboard
            </h1>
            <p className="mt-1 text-sm text-cocoa-400">
              Merrylane Cafe Foodhub
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/checkout"
              className="btn-ghost border-cream-300 bg-cream-50 shadow-sm transition-all hover:-translate-y-0.5 hover:border-cream-400 hover:bg-white hover:shadow-warm"
            >
              Open Checkout
            </Link>
            <Link
              href="/items"
              className="btn-ghost border-cream-300 bg-cream-50 shadow-sm transition-all hover:-translate-y-0.5 hover:border-cream-400 hover:bg-white hover:shadow-warm"
            >
              Manage Items
            </Link>
            <Link
              href="/alerts"
              className="btn-ghost border-cream-300 bg-cream-50 shadow-sm transition-all hover:-translate-y-0.5 hover:border-cream-400 hover:bg-white hover:shadow-warm"
            >
              View Alerts
            </Link>
          </div>
        </div>

        {/*
          Announced, never shown as an alert. When the event stream is down the
          figures are still correct — the poll is running — so the honest thing
          is to say so quietly rather than put a red banner over a page that is
          working. A sighted user gets the same information from the badge.
        */}
        <LiveRegion
          message={
            liveStatus === "live"
              ? null
              : "Live updates disconnected. Figures are still refreshing every few seconds."
          }
        />

        {liveStatus !== "live" && (
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 text-[11px] text-cocoa-500"
            title={
              liveStatus === "connecting"
                ? "Connecting to live updates"
                : "Live updates unavailable — refreshing every few seconds instead"
            }
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                liveStatus === "connecting" ? "bg-amber-500" : "bg-cocoa-300"
              }`}
              aria-hidden="true"
            />
            {liveStatus === "connecting" ? "Connecting…" : "Refreshing every few seconds"}
          </span>
        )}

        {error && (
          <div className="shrink-0 rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
            {error}
          </div>
        )}

        {/* ---- stat pills ---- */}
        <div className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Total Items" value={stats.total} />
          <Stat label="Low Stocks" value={stats.low.length} tone="warn" />
          <Stat label="Out of Stock" value={stats.out.length} tone="danger" />
          <Stat label="Items with expired batches" value={stats.expired.length} tone="danger" />
        </div>

        {/* ---- illustration + card grid ---- */}
        <div className="grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          {/* Show the duty roster in the illustration card only when staff have signed in today. */}
          <div
            className={`card flex min-h-[20rem] flex-col !p-0 lg:min-h-0 ${
              myActivityTotal > 0 ? "lg:self-start" : ""
            }`}
          >
            {myActivityTotal > 0 ? (
              <>
                <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
                  <h2 className="text-sm font-bold text-cocoa-800">My activity today</h2>
                  <p className="mt-0.5 text-xs text-cocoa-400">
                    {dutyDashboard?.day ? formatCafeDay(dutyDashboard.day) : "Today"}
                  </p>
                </div>
                <div className="flex flex-1 flex-col gap-6 px-4 py-5 sm:px-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
                  <div className="space-y-4">
                    <div className="flex items-end justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50/70 px-3.5 py-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-cocoa-500">
                          Recorded movements
                        </p>
                        <p className="mt-0.5 text-[10px] text-cocoa-400">
                          Checkout, restock, and waste today
                        </p>
                      </div>
                      <strong className="text-2xl leading-none tabular-nums text-cocoa-800">
                        {myActivityTotal}
                      </strong>
                    </div>
                    <ul className="flex flex-col gap-5">
                      {myActivityRows.map((activity) => (
                        <li key={activity.key}>
                          <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                            <span className="font-medium text-cocoa-700">{activity.label}</span>
                            <span className="font-bold tabular-nums text-cocoa-900">
                              {activity.count}
                            </span>
                          </div>
                          <div
                            role="progressbar"
                            aria-label={`${activity.label}: ${activity.count}`}
                            aria-valuemin={0}
                            aria-valuemax={maxActivityCount}
                            aria-valuenow={activity.count}
                            className="h-2.5 overflow-hidden rounded-full bg-cream-100"
                          >
                            <div
                              className={`h-full rounded-full transition-[width] duration-300 ${activity.color}`}
                              style={{
                                width: `${maxActivityCount > 0 ? (activity.count / maxActivityCount) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <section className="hidden rounded-xl border border-cream-200 bg-cream-50/70 p-3.5 lg:block">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="text-xs font-bold text-cocoa-700">Items moved today</h3>
                      <span className="text-[10px] text-cocoa-400">Top 4</span>
                    </div>
                    {myTopItems.length > 0 ? (
                      <ul className="divide-y divide-cream-200/80">
                        {myTopItems.map((item) => (
                          <li key={item.name} className="flex items-center justify-between gap-2 py-2 first:pt-1">
                            <span className="min-w-0 truncate text-[11px] text-cocoa-600">
                              {item.name}
                            </span>
                            <span className="shrink-0 text-[11px] font-semibold tabular-nums text-cocoa-800">
                              {fmtQty(item.quantity)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs leading-relaxed text-cocoa-400">
                        Item totals will appear here after today&apos;s movements.
                      </p>
                    )}
                  </section>
                </div>
              </>
            ) : dutyDashboard?.visible && (dutyDashboard.staff?.length ?? 0) > 0 ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-cream-200 bg-cream-50 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-bold text-cocoa-800">Staff on duty today</h2>
                    <p className="mt-0.5 text-xs text-cocoa-400">
                      {formatCafeDay(dutyDashboard.day)}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-cream-200 px-2.5 py-1 text-xs font-semibold text-cocoa-700">
                    {dutyDashboard.staff?.length ?? 0}{" "}
                    {dutyDashboard.staff?.length === 1 ? "staff member" : "staff members"}
                  </span>
                </div>
                <ul className="divide-y divide-cream-100 overflow-y-auto px-4 py-1">
                  {dutyDashboard.staff?.map((staff) => (
                    <DutyRosterRow key={staff.id} staff={staff} />
                  ))}
                </ul>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-8">
                <div className="script-logo-dark text-4xl">CafeTrack</div>
                {/* White card, so the illustration's own white background is
                    invisible. No white panel needed here. */}
                <BaristaArt
                  className="max-w-[260px]"
                  sizes="260px"
                  preload
                />
                <p className="text-center text-xs text-cocoa-400">
                  Live stock monitoring for Merrylane Cafe Foodhub
                </p>
                {dutyError && (
                  <p role="alert" className="text-center text-xs text-terracotta-700">
                    {dutyError}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 2x2 cards */}
          <div className="grid gap-5 sm:grid-cols-2 lg:min-h-0 lg:grid-rows-2">
            {/* In-Demand Items */}
            <MiniCard title="In-Demand Items" href="/reports">
              {demandRows.length === 0 ? (
                <Empty>No checkout activity yet.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th !px-0 !py-1.5">Item Name</th>
                      <th className="th !px-0 !py-1.5 text-right">Total Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {demandRows.map((d) => (
                      <tr key={d.name}>
                        <td className="td !px-0 !py-1.5 text-cocoa-800">{d.name}</td>
                        <td className="td !px-0 !py-1.5 text-right tabular-nums">
                          {d.qty}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </MiniCard>

            {/* Stock */}
            <MiniCard title="Stock" href="/items">
              {topStock.length === 0 ? (
                <Empty>No items yet.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th !px-0 !py-1.5">Item Name</th>
                      <th className="th !px-0 !py-1.5 text-right">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topStock.map((i) => (
                      <tr key={i.id}>
                        <td className="td !px-0 !py-1.5 text-cocoa-800">{i.name}</td>
                        <td className="td !px-0 !py-1.5 text-right tabular-nums">
                          {fmtQty(i.quantity, i.unit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </MiniCard>

            {/* Expiring Soon */}
            <MiniCard title="Batch Expiry" href="/alerts">
              {expiring.length === 0 ? (
                <Empty>Nothing expiring soon.</Empty>
              ) : (
                <div className="pr-1">
                  <table className="w-full">
                    <thead>
                      <tr>
                        <th className="th !px-0 !py-1.5">Item / Batch</th>
                        <th className="th !px-0 !py-1.5 text-right">Expiry</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expiring.map((i) => (
                        <tr key={i.id}>
                          <td className="td !px-0 !py-1.5 text-cocoa-800">
                            <div>{i.name}</div>
                            {i.batchCode && (
                              <div className="break-all text-[10px] text-cocoa-400">
                                {i.batchCode} · {fmtQty(i.quantity, i.unit)}
                              </div>
                            )}
                          </td>
                          <td
                            className={`td !px-0 !py-1.5 text-right font-semibold tabular-nums ${
                              i.days < 0 ? "text-terracotta-700" : "text-ochre-700"
                            }`}
                          >
                            {i.days < 0 ? "Expired" : `${i.days} Days`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </MiniCard>

            {/* Recent Activity */}
            <MiniCard title="Recent Activity" href="/audit">
              {recent.length === 0 ? (
                <Empty>No activity yet.</Empty>
              ) : (
                <ul className="space-y-2.5">
                  {recent.map((t) => (
                    <li key={t.id} className="flex items-start gap-2.5">
                      <TxnDot type={t.type} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs font-bold text-cocoa-700">
                            {TXN_LABEL[t.type] ?? t.type}
                          </span>
                          <span className="truncate text-xs text-cocoa-400">
                            {t.transaction_items
                              ?.map((i) => `${i.item_name} x${i.quantity}`)
                              .join(", ")}
                          </span>
                        </div>
                        <div className="text-[10px] text-cocoa-300">
                          {t.actor_name} · {fmtDateTime(t.created_at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </MiniCard>
          </div>
        </div>

      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const TXN_LABEL: Record<string, string> = {
  checkout: "Check Out",
  restock: "Restocked",
  waste: "Waste",
};

/* Movement dots on the Recent Activity card.
 *
 * Warm palette steps so they sit with the cocoa/cream around them, and so
 * they agree with the Audit trail and the checkout badges for the same three
 * movements (ochre/sage/terracotta). The 500 step is used rather than the 700
 * the text tones use because nothing is written on top of these — a dot wants
 * to read as a dot, not as a dark blob. */
const TXN_DOT: Record<string, string> = {
  checkout: "bg-cream-500",
  restock: "bg-sage-500",
  waste: "bg-terracotta-500",
};

function TxnDot({ type }: { type: string }) {
  return (
    <span
      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${TXN_DOT[type] ?? "bg-cocoa-300"}`}
    />
  );
}

function formatCafeDay(day: string): string {
  const date = new Date(`${day}T12:00:00+08:00`);
  return new Intl.DateTimeFormat("en-PH", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Manila",
  }).format(date);
}

const cafeDayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatCafeTime(timestamp: string | null): string {
  if (!timestamp) return "Sign-in time unavailable";
  return new Intl.DateTimeFormat("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  }).format(new Date(timestamp));
}

function DutyRosterRow({ staff }: { staff: DutyRosterEntry }) {
  const activities = [
    { key: "checkout", label: "Checkout", count: staff.checkout, color: "bg-cream-500" },
    { key: "restock", label: "Restock", count: staff.restock, color: "bg-sage-500" },
    { key: "waste", label: "Waste log", count: staff.waste, color: "bg-terracotta-500" },
  ];
  const total = activities.reduce((sum, activity) => sum + activity.count, 0);

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-cocoa-800">{staff.name}</p>
          <p className="text-xs text-cocoa-400">Signed in at {formatCafeTime(staff.signedInAt)}</p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
            staff.faceReset
              ? "bg-ochre-50 text-ochre-800"
              : staff.faceVerified
              ? "bg-sage-50 text-sage-700"
              : "bg-cream-100 text-cocoa-500"
          }`}
        >
          {staff.faceReset
            ? "Face verification reset"
            : staff.faceVerified
            ? "Face verified"
            : "Face check not recorded"}
        </span>
      </div>
      <div
        className="mt-2 flex h-2 overflow-hidden rounded-full bg-cream-100"
        role="img"
        aria-label={`${staff.name}: ${staff.checkout} checkouts, ${staff.restock} restocks, ${staff.waste} waste logs today`}
      >
        {total > 0 &&
          activities.map(
            (activity) =>
              activity.count > 0 && (
                <span
                  key={activity.key}
                  className={activity.color}
                  style={{ width: `${(activity.count / total) * 100}%` }}
                />
              )
          )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-cocoa-500">
        {activities.map((activity) => (
          <span key={activity.key}>
            {activity.label}: <strong className="font-semibold text-cocoa-700">{activity.count}</strong>
          </span>
        ))}
        {total === 0 && <span>No inventory activity yet</span>}
      </div>
    </li>
  );
}

function MiniCard({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card flex min-h-0 flex-col !p-0 lg:overflow-hidden">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
        <h2 className="text-sm font-bold text-cocoa-800">{title}</h2>
      </div>
      <div className="px-4 py-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
        {children}
      </div>
      <div className="flex shrink-0 justify-center px-4 pb-3.5">
        <ViewPill href={href} />
      </div>
    </div>
  );
}
