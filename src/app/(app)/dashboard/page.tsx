"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Stat, ViewPill, Badge, Spinner, Empty } from "@/components/ui";
import { CafeIllustration } from "@/components/CafeIllustration";
import { fmtQty, fmtDateTime, daysUntil } from "@/lib/format";

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

export default function DashboardPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function load(force = false) {
    // A 2s poll is cheap, but a forgotten background tab has no reason to keep
    // asking. The first load is forced, so a hidden tab still populates.
    if (!force && document.hidden) return;

    // Skip while a poll is still in flight so a slow response cannot land
    // late and overwrite fresher data.
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
      setError(e.message || "Could not load the dashboard");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load(true);
    // Near-real-time refresh, skipped while the tab is hidden (see load).
    // Wrapped in an arrow so the interval cannot pass an argument into `force`.
    const timer = setInterval(() => load(), 2000);
    return () => clearInterval(timer);
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

        {error && (
          <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
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
            <CafeIllustration className="w-full max-w-xs" />
            <p className="text-center text-xs text-cocoa-400">
              Live stock monitoring for Merrylane Cafe Foodhub
            </p>
          </div>

          {/* 2x2 cards */}
          <div className="grid gap-5 sm:grid-cols-2">
            {/* In-Demand Items */}
            <MiniCard title="In-Demand Items" href="/reports">
              {inDemand.length === 0 ? (
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
                    {inDemand.map((d) => (
                      <tr key={d.sku}>
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
                            i.days < 0 ? "text-red-600" : "text-amber-700"
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

const TXN_DOT: Record<string, string> = {
  checkout: "bg-cream-500",
  restock: "bg-emerald-500",
  waste: "bg-red-500",
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
