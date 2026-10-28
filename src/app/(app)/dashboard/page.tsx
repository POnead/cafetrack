"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Stat, ViewPill, Badge, Spinner, Empty } from "@/components/ui";
import { BaristaArt } from "@/components/BrandArt";
import { LiveRegion } from "@/components/LiveRegion";
import { fmtQty, fmtDate, fmtDateTime, daysUntil } from "@/lib/format";
import { stockStatus } from "@/lib/status";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type Item = {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  low_stock_threshold: number;
  expiration_date: string | null;
  category: { name: string } | null;
};

type Txn = {
  id: string;
  type: string;
  actor_name: string;
  created_at: string;
  transaction_items: { sku: string; item_name: string; quantity: number }[];
};

type Ref = { id: string; name: string };

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

/** How often a live refresh may re-run the analytics aggregation. */
const ANALYTICS_MIN_INTERVAL_MS = 15_000;

/** The filter key with every field empty, i.e. what the first load already fetches. */
const NO_FILTERS = "|||";

export default function DashboardPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  /* Analytics: the two cards that cannot be computed from this page's own fetch.
     The snapshot is filtered server-side, so the same query answers "everything"
     and "just the chiller, just this week" without shipping the whole inventory
     to the browser first. */
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [locations, setLocations] = useState<Ref[]>([]);
  const [snapCategory, setSnapCategory] = useState("");
  const [snapLocation, setSnapLocation] = useState("");
  const [snapFrom, setSnapFrom] = useState("");
  const [snapTo, setSnapTo] = useState("");

  const filtersRef = useRef({ category: "", location: "", from: "", to: "" });
  filtersRef.current = {
    category: snapCategory,
    location: snapLocation,
    from: snapFrom,
    to: snapTo,
  };

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
      const f = filtersRef.current;
      const qs = new URLSearchParams();
      if (f.category) qs.set("category", f.category);
      if (f.location) qs.set("location", f.location);
      if (f.from) qs.set("from", f.from);
      if (f.to) qs.set("to", f.to);

      const res = await fetch(`/api/analytics${qs.size ? `?${qs}` : ""}`);
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

  // Reference lists for the snapshot filters. Fetched once; they change only
  // when an admin edits them on the settings page.
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/refs/categories").then((r) => r.json()),
      fetch("/api/refs/locations").then((r) => r.json()),
    ])
      .then(([c, l]) => {
        if (!alive) return;
        setCategories(c.items ?? []);
        setLocations(l.items ?? []);
      })
      .catch(() => {
        /* filters stay as text-less selects; the snapshot still loads */
      });
    return () => {
      alive = false;
    };
  }, []);

  /*
   * Filtering the snapshot is an explicit action, so it may bypass the throttle.
   *
   * The key comparison keeps this from firing on mount: `load()` already fetches
   * analytics once, and a bare dependency array would spend a second aggregation
   * answering "no filters" a moment later.
   */
  const appliedFilters = useRef(NO_FILTERS);
  useEffect(() => {
    const key = [snapCategory, snapLocation, snapFrom, snapTo].join("|");
    if (appliedFilters.current === key) return;
    appliedFilters.current = key;
    void loadAnalytics(true);
  }, [snapCategory, snapLocation, snapFrom, snapTo, loadAnalytics]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    const low = items.filter(
      (i) => Number(i.quantity) > 0 && Number(i.quantity) <= Number(i.low_stock_threshold)
    );
    const out = items.filter((i) => Number(i.quantity) <= 0);
    const expired = items.filter((i) => {
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
      .slice(0, 4);
  }, [txns]);

  /*
   * Prefer the analytics endpoint's "this month" figure, which walks the whole
   * 13-month window, and fall back to the movements this page has while that
   * request is in flight or if it failed.
   */
  const demandRows =
    analytics && analytics.mostNeeded.thisMonth.length > 0
      ? analytics.mostNeeded.thisMonth.slice(0, 4)
      : inDemand;

  /* Top 4 items by quantity on hand */
  const topStock = useMemo(
    () =>
      [...items]
        .sort((a, b) => Number(b.quantity) - Number(a.quantity))
        .slice(0, 4),
    [items]
  );

  /* Soonest expiries, including already-expired */
  // An unparseable date sorts last rather than being treated as 0 days, which
  // would put it at the top of "soonest expiring" wearing an "Expired" label.
  const expiring = useMemo(
    () =>
      items
        .filter((i) => i.expiration_date)
        .map((i) => ({ ...i, days: daysUntil(i.expiration_date) ?? Number.POSITIVE_INFINITY }))
        .sort((a, b) => a.days - b.days)
        .slice(0, 4),
    [items]
  );

  const recent = txns.slice(0, 4);

  if (loading) return <Spinner />;

  return (
    <div className="relative">
      {/* ---- decorative peach wave ---- */}
      <svg
        className="pointer-events-none absolute -top-7 left-1/2 h-[440px] w-screen -translate-x-1/2"
        viewBox="0 0 1200 440"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M0 0 L1200 0 L1200 150 C980 330 760 400 520 400 C300 400 120 280 0 160 Z"
          fill="#F5D5A8"
        />
      </svg>

      <div className="relative space-y-6">
        <h1 className="deco-title text-4xl">Inventory Dashboard</h1>

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
            className="inline-flex items-center gap-1.5 rounded-full bg-cream-100 px-2.5 py-1 text-[11px] text-cocoa-500"
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
          <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
            {error}
          </div>
        )}

        {/* ---- stat pills ---- */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Total Items" value={stats.total} />
          <Stat label="Low Stocks" value={stats.low.length} tone="warn" />
          <Stat label="Out of Stock" value={stats.out.length} tone="danger" />
          <Stat label="Expired items" value={stats.expired.length} tone="danger" />
        </div>

        {/* ---- illustration + card grid ---- */}
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
          {/* illustration panel */}
          <div className="card flex flex-col items-center justify-center gap-4 px-6 py-8">
            <div className="script-logo-dark text-4xl">CafeTrack</div>
            {/* White card, so the illustration's own white background is
                invisible. No white panel needed here. */}
            <BaristaArt className="max-w-[260px]" sizes="260px" />
            <p className="text-center text-xs text-cocoa-400">
              Live stock monitoring for Merrylane Cafe Foodhub
            </p>
          </div>

          {/* 2x2 cards */}
          <div className="grid gap-5 sm:grid-cols-2">
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
            <MiniCard title="Expiring Soon" href="/alerts">
              {expiring.length === 0 ? (
                <Empty>Nothing expiring soon.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th !px-0 !py-1.5">Item Name</th>
                      <th className="th !px-0 !py-1.5 text-right">Days left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expiring.map((i) => (
                      <tr key={i.id}>
                        <td className="td !px-0 !py-1.5 text-cocoa-800">{i.name}</td>
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

        {/* ---- stock snapshot ---- */}
        <div className="card space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-cocoa-800">
                Stock Snapshot
              </h2>
              <p className="mt-0.5 text-xs text-cocoa-400">
                Current on-hand quantities. Filter by category, location, or the
                window an item expires in.
              </p>
            </div>
            <button
              className="btn-ghost !px-3 !py-1.5 text-xs"
              onClick={() => {
                setSnapCategory("");
                setSnapLocation("");
                setSnapFrom("");
                setSnapTo("");
              }}
              disabled={!snapCategory && !snapLocation && !snapFrom && !snapTo}
            >
              Clear filters
            </button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="label" htmlFor="snap-category">
                Category
              </label>
              <select
                id="snap-category"
                className="input"
                value={snapCategory}
                onChange={(e) => setSnapCategory(e.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="snap-location">
                Location
              </label>
              <select
                id="snap-location"
                className="input"
                value={snapLocation}
                onChange={(e) => setSnapLocation(e.target.value)}
              >
                <option value="">All locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="snap-from">
                Expiry from
              </label>
              <input
                id="snap-from"
                type="date"
                className="input"
                value={snapFrom}
                max={snapTo || undefined}
                onChange={(e) => setSnapFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="snap-to">
                Expiry to
              </label>
              <input
                id="snap-to"
                type="date"
                className="input"
                value={snapTo}
                min={snapFrom || undefined}
                onChange={(e) => setSnapTo(e.target.value)}
              />
            </div>
          </div>

          {!analytics ? (
            <p className="text-xs text-cocoa-400">Loading stock snapshot…</p>
          ) : analytics.snapshot.items.length === 0 ? (
            <Empty>No stock matches these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Item</th>
                    <th className="th hidden md:table-cell">Category</th>
                    <th className="th hidden md:table-cell">Location</th>
                    <th className="th text-right">On hand</th>
                    <th className="th">Expiry</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.snapshot.items.map((item) => {
                    const status = stockStatus(
                      item.quantity,
                      item.low_stock_threshold
                    );
                    return (
                      <tr
                        key={item.id}
                        className="transition-colors hover:bg-cream-50"
                      >
                        <td className="td">
                          <div className="font-medium text-cocoa-800">
                            {item.name}
                          </div>
                          <div className="font-mono text-[11px] text-cocoa-300">
                            {item.sku}
                          </div>
                        </td>
                        <td className="td hidden text-cocoa-600 md:table-cell">
                          {item.category?.name ?? "Uncategorized"}
                        </td>
                        <td className="td hidden text-cocoa-600 md:table-cell">
                          {item.location?.name ?? "—"}
                        </td>
                        <td className="td text-right tabular-nums text-cocoa-800">
                          {fmtQty(item.quantity, item.unit)}
                        </td>
                        <td className="td text-cocoa-600">
                          {item.expiration_date
                            ? fmtDate(item.expiration_date)
                            : "—"}
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
          )}

          {analytics && (
            <p className="text-[11px] text-cocoa-300">
              {analytics.snapshot.total}{" "}
              {analytics.snapshot.total === 1 ? "item" : "items"} shown
              {snapFrom || snapTo ? ", limited to the expiry window" : ""}.
            </p>
          )}
        </div>

        {/* ---- shortcut strip ---- */}
        <div className="flex flex-wrap gap-2">
          <Link href="/checkout" className="btn-primary">
            Open Checkout
          </Link>
          <Link href="/items" className="btn-ghost">
            Manage Items
          </Link>
          <Link href="/alerts" className="btn-ghost">
            View Alerts
          </Link>
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
    <div className="card flex flex-col !p-0">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
        <h2 className="text-sm font-bold text-cocoa-800">{title}</h2>
      </div>
      <div className="flex-1 px-4 py-3">{children}</div>
      <div className="flex justify-center px-4 pb-3.5">
        <ViewPill href={href} />
      </div>
    </div>
  );
}
