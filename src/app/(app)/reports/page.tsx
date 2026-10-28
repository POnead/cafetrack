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

const TRANSACTION_PAGE_SIZE = 500;

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
  transaction_items: { sku: string; item_name: string; quantity: number }[] | null;
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

  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailSending, setEmailSending] = useState(false);

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
      const loadAllTransactions = async () => {
        const all: Txn[] = [];
        let offset = 0;

        while (true) {
          const qs = new URLSearchParams({
            limit: String(TRANSACTION_PAGE_SIZE),
            offset: String(offset),
          });
          if (rangeParams.from) qs.set("from", rangeParams.from);
          if (rangeParams.to) qs.set("to", rangeParams.to);
          if (staff) qs.set("staff", staff);
          if (typeFilter) qs.set("type", typeFilter);

          const response = await fetch(`/api/transactions?${qs}`);
          const data = await response.json();
          if (!response.ok || data.error) {
            throw new Error(data.error || "Could not load report transactions");
          }

          const page: Txn[] = data.transactions ?? [];
          all.push(...page);
          if (page.length < TRANSACTION_PAGE_SIZE) return all;
          offset += page.length;
        }
      };

      const [i, transactionRows, c] = await Promise.all([
        fetch("/api/items").then((r) => r.json()),
        loadAllTransactions(),
        // Advisory: the report still works if the reference list fails.
        fetch("/api/refs/categories")
          .then((r) => r.json())
          .catch(() => ({ items: [] })),
      ]);
      setCategories(c.items ?? []);
      if (i.error) throw new Error(i.error);

      setItems(i.items ?? []);
      setTxns(transactionRows);

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

  const itemsBySku = useMemo(
    () => new Map(items.map((item) => [item.sku, item])),
    [items]
  );

  // Apply category filtering to movement lines as well as the stock snapshot.
  // Transactions do not snapshot category, so historical lines use the item's
  // current category; deleted items cannot be assigned to a category.
  const filteredTransactions = useMemo(() => {
    if (!catFilter) return txns;
    return txns
      .map((transaction) => ({
        ...transaction,
      transaction_items: (transaction.transaction_items ?? []).filter(
          (line) => itemsBySku.get(line.sku)?.category?.id === catFilter
        ),
      }))
      .filter((transaction) => transaction.transaction_items.length > 0);
  }, [txns, catFilter, itemsBySku]);

  // Keep staff choices based on the loaded date/type window, even while a
  // category filter is active.
  const staffNames = useMemo(
    () => [...new Set(txns.map((t) => t.actor_name).filter(Boolean))].sort(),
    [txns]
  );

  /*
   * Everything below here walks the whole transaction snapshot. With "all time"
   * selected that is every movement the cafe has ever made, so these are all
   * memoised: without it, typing one character into the email-recipient field
   * re-ran four full passes over the array on every keystroke.
   */
  const low = useMemo(
    () =>
      shownItems.filter(
        (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "low"
      ),
    [shownItems]
  );
  const out = useMemo(
    () =>
      shownItems.filter(
        (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "out"
      ),
    [shownItems]
  );

  const movement = useMemo(
    () =>
      (["checkout", "restock", "waste"] as const).map((type) => {
        const rows = filteredTransactions.filter((t) => t.type === type);
        const qty = rows.reduce(
          (n, t) =>
            n + (t.transaction_items ?? []).reduce((m, li) => m + Number(li.quantity), 0),
          0
        );
        return { type, count: rows.length, qty };
      }),
    [filteredTransactions]
  );

  const topMovers = useMemo(() => {
    const tally = new Map<string, { name: string; qty: number }>();
    for (const t of filteredTransactions) {
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
  }, [filteredTransactions]);

  /*
   * The expiry work queue, ranked the way the alert is ranked: fewest days
   * first, with already-expired rows at the top rather than hidden at the
   * bottom. Ten is enough to act on in one pass; the full list is still in the
   * stock table below and in the CSV. An unparseable date sorts last instead of
   * pretending to be "0 days".
   */
  const soonestExpiry = useMemo(
    () =>
      shownItems
        .filter((i) => i.expiration_date)
        .map((i) => ({ ...i, days: daysUntil(i.expiration_date) }))
        .sort(
          (a, b) =>
            (a.days ?? Number.POSITIVE_INFINITY) -
            (b.days ?? Number.POSITIVE_INFINITY)
        )
        .slice(0, 10),
    [shownItems]
  );

  // Waste tracking: total waste quantity and top wasted items
  const wasteTotal = movement.find((m) => m.type === "waste")?.qty ?? 0;
  const wasteCount = movement.find((m) => m.type === "waste")?.count ?? 0;
  const wasteByItem = useMemo(() => {
    const tally = new Map<string, { name: string; qty: number; count: number }>();
    for (const t of filteredTransactions) {
      if (t.type !== "waste") continue;
      for (const li of t.transaction_items ?? []) {
        const cur = tally.get(li.sku) ?? { name: li.item_name, qty: 0, count: 0 };
        cur.qty += Number(li.quantity);
        cur.count += 1;
        tally.set(li.sku, cur);
      }
    }
    return [...tally.entries()]
      .map(([sku, v]) => ({ sku, ...v }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  }, [filteredTransactions]);
  const wasteByCategory = useMemo(() => {
    const tally = new Map<string, number>();
    for (const t of filteredTransactions) {
      if (t.type !== "waste") continue;
      for (const li of t.transaction_items ?? []) {
        const item = itemsBySku.get(li.sku);
        const cat = item?.category?.name ?? "Uncategorized";
        tally.set(cat, (tally.get(cat) ?? 0) + Number(li.quantity));
      }
    }
    return [...tally.entries()]
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty);
  }, [filteredTransactions, itemsBySku]);

  const filterDescription = useMemo(
    () =>
      [
        rangeParams.from || rangeParams.to
          ? `Dates: ${rangeParams.from || "beginning"} to ${rangeParams.to || "today"}`
          : "All dates",
        staff ? `Staff: ${staff}` : null,
        typeFilter ? `Movement: ${MOVEMENT_LABEL[typeFilter] ?? typeFilter}` : null,
        catFilter
          ? `Category: ${categories.find((category) => category.id === catFilter)?.name ?? "selected category"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    [rangeParams.from, rangeParams.to, staff, typeFilter, catFilter, categories]
  );

  function exportCsv() {
    const stockRows: Record<string, unknown>[] = shownItems.map((i) => {
      const d = daysUntil(i.expiration_date);
      return {
        Record: "Stock snapshot",
        Date: "",
        Staff: "",
        Movement: "",
        SKU: i.sku,
        Item: i.name,
        Category: i.category?.name ?? "",
        Location: i.location?.name ?? "",
        Quantity: Number(i.quantity),
        Unit: i.unit,
        Threshold: Number(i.low_stock_threshold),
        Expiry: i.expiration_date ?? "",
        Status: stockStatus(i.quantity, i.low_stock_threshold).label,
        "Days to expiry": d === null ? "" : d,
        Note: "",
      };
    });

    const movementRows: Record<string, unknown>[] = filteredTransactions.flatMap(
      (transaction) =>
        (transaction.transaction_items ?? []).map((line) => {
          const item = itemsBySku.get(line.sku);
          return {
            Record: "Movement",
            Date: transaction.created_at,
            Staff: transaction.actor_name,
            Movement: MOVEMENT_LABEL[transaction.type] ?? transaction.type,
            SKU: line.sku,
            Item: line.item_name,
            Category: item?.category?.name ?? "Uncategorized",
            Location: item?.location?.name ?? "",
            Quantity: Number(line.quantity),
            Unit: item?.unit ?? "",
            Threshold: "",
            Expiry: "",
            Status: "",
            "Days to expiry": "",
            Note: transaction.note ?? "",
          };
        })
    );
    const rows = [...stockRows, ...movementRows];

    const topMoverRows: Record<string, unknown>[] = topMovers.map((m) => {
      const item = itemsBySku.get(m.sku);
      return {
        Record: "Most checked out",
        Date: "",
        Staff: "",
        Movement: "Checked out",
        SKU: m.sku,
        Item: m.name,
        Category: item?.category?.name ?? "",
        Location: item?.location?.name ?? "",
        Quantity: Number(m.qty),
        Unit: item?.unit ?? "",
        Threshold: "",
        Expiry: "",
        Status: "",
        "Days to expiry": "",
        Note: "",
      };
    });

    const expiryRows: Record<string, unknown>[] = soonestExpiry.map((i) => ({
      Record: "Soonest expiry",
      Date: "",
      Staff: "",
      Movement: "",
      SKU: i.sku,
      Item: i.name,
      Category: i.category?.name ?? "",
      Location: i.location?.name ?? "",
      Quantity: Number(i.quantity),
      Unit: i.unit,
      Threshold: Number(i.low_stock_threshold),
      Expiry: i.expiration_date ?? "",
      Status: stockStatus(i.quantity, i.low_stock_threshold).label,
      "Days to expiry": i.days ?? "",
      Note: "",
    }));

    const allRows = [...rows, ...topMoverRows, ...expiryRows];

    const csv = toCsv(allRows, [
      "Record",
      "Date",
      "Staff",
      "Movement",
      "SKU",
      "Item",
      "Category",
      "Location",
      "Quantity",
      "Unit",
      "Threshold",
      "Expiry",
      "Status",
      "Days to expiry",
      "Note",
    ]);

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cafetrack-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    setToast({
      msg: `Exported ${stockRows.length} stock rows and ${movementRows.length} movement rows, plus ${topMoverRows.length} ranked items and ${expiryRows.length} expiry rows`,
      tone: "success",
    });
  }

  /**
   * Download the report as a PDF (FR-09).
   *
   * Fetched rather than printed: "Export PDF" that opens a print dialog is not an
   * export. The server builds the file — see src/app/api/report-export — so the
   * PDF carries the same filtered rows and the same snapshot the page is showing,
   * rather than a second rendering of them assembled here.
   *
   * The filters go in the body, including the category. Everything else is a
   * query parameter the report route already understands.
   */
  async function exportPdf() {
    setExportingPdf(true);
    setExportError(null);
    try {
      const res = await fetch("/api/report-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: rangeParams.from,
          to: rangeParams.to,
          staff,
          type: typeFilter,
          category_id: catFilter,
        }),
      });

      if (!res.ok) {
        // A failed export is an error, not a silent no-op: the person pressed
        // the button expecting a file.
        const data = await res.json().catch(() => ({ error: null }));
        throw new Error(data.error || `Export failed (${res.status})`);
      }

      const blob = await res.blob();

      // The server names the file in Content-Disposition; reusing it means the
      // download is called what the server called it rather than something this
      // function invented.
      const disposition = res.headers.get("content-disposition") ?? "";
      const named = /filename="([^"]+)"/.exec(disposition);
      const name = named?.[1] ?? `cafetrack-report-${new Date().toISOString().slice(0, 10)}.pdf`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);

      setToast({ msg: `Downloaded ${name}`, tone: "success" });
    } catch (e: any) {
      setExportError(e.message || "Could not export the report");
      setToast({ msg: e.message || "Export failed", tone: "error" });
    } finally {
      setExportingPdf(false);
    }
  }

  async function sendEmailReport() {
    if (!emailTo.trim()) return;
    setEmailSending(true);
    try {
      const res = await fetch("/api/email/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: emailTo.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send the report");
      setToast({ msg: `Report emailed to ${emailTo.trim()}`, tone: "success" });
      setEmailModalOpen(false);
      setEmailTo("");
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setEmailSending(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Stock Report</h1>
          <p className="mt-1 text-sm text-cocoa-500">
            Current stock and all matching movement history.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={load}>
            Reload
          </button>
          <button
            className="btn-ghost"
            onClick={() => setEmailModalOpen(true)}
            disabled={items.length === 0}
          >
            Email this report
          </button>
          <button
            className="btn-ghost"
            onClick={exportPdf}
            disabled={items.length === 0 || exportingPdf}
          >
            {exportingPdf ? "Preparing PDF..." : "Export PDF"}
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
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      {exportError && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {exportError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Items tracked" value={shownItems.length} />
        <Stat label="Low Stock" value={low.length} tone="warn" />
        <Stat label="Out of Stock" value={out.length} tone="danger" />
        <Stat label="Movements in report" value={filteredTransactions.length} />
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

          {/* ---------- soonest expiries ---------- */}
          <Card className="!p-0">
            <div className="flex items-center justify-between border-b border-cream-200 bg-cream-50 px-4 py-2.5">
              <h2 className="text-sm font-bold text-cocoa-800">
                Soonest Expiries
              </h2>
              <span className="text-[11px] text-cocoa-400">
                {soonestExpiry.length} shown
              </span>
            </div>
            {soonestExpiry.length === 0 ? (
              <Empty>No dated items match this report.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-100/60">
                      <th className="th">Item</th>
                      <th className="th hidden md:table-cell">Category</th>
                      <th className="th hidden md:table-cell">Location</th>
                      <th className="th text-right">On hand</th>
                      <th className="th">Expiry</th>
                      <th className="th text-right">Days left</th>
                    </tr>
                  </thead>
                  <tbody>
                    {soonestExpiry.map((i) => (
                      <tr key={i.id} className="transition-colors hover:bg-cream-50">
                        <td className="td">
                          <div className="font-medium text-cocoa-800">{i.name}</div>
                          <div className="font-mono text-[11px] text-cocoa-300">
                            {i.sku}
                          </div>
                        </td>
                        <td className="td hidden text-cocoa-500 md:table-cell">
                          {i.category?.name ?? "Uncategorized"}
                        </td>
                        <td className="td hidden text-cocoa-500 md:table-cell">
                          {i.location?.name ?? "—"}
                        </td>
                        <td className="td text-right tabular-nums">
                          {fmtQty(i.quantity, i.unit)}
                        </td>
                        <td className="td whitespace-nowrap text-xs text-cocoa-500">
                          {i.expiration_date ? fmtDate(i.expiration_date) : "—"}
                        </td>
                        <td
                          className={`td text-right font-semibold tabular-nums ${
                            i.days !== null && i.days < 0
                              ? "text-terracotta-700"
                              : "text-ochre-700"
                          }`}
                        >
                          {i.days === null
                            ? "—"
                            : i.days < 0
                              ? "Expired"
                              : `${i.days} days`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

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
                                <span className="text-terracotta-700"> (expired)</span>
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
                                  <span className="text-terracotta-700">
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

          {/* ---------- waste tracking ---------- */}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="!p-0">
              <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
                <h2 className="text-sm font-bold text-cocoa-800">
                  Waste Summary
                </h2>
              </div>
              <div className="space-y-3 p-4">
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Total Waste" value={fmtQty(wasteTotal)} tone="danger" />
                  <Stat label="Waste Events" value={wasteCount} tone="warn" />
                </div>
                {wasteByCategory.length > 0 && (
                  <div>
                    <div className="label">Waste by Category</div>
                    <table className="w-full">
                      <thead>
                        <tr className="bg-cream-100/60">
                          <th className="th">Category</th>
                          <th className="th text-right">Quantity</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wasteByCategory.map((w) => (
                          <tr key={w.name}>
                            <td className="td text-cocoa-700">{w.name}</td>
                            <td className="td text-right tabular-nums">
                              {fmtQty(w.qty)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>

            <Card className="!p-0">
              <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
                <h2 className="text-sm font-bold text-cocoa-800">
                  Most Wasted Items
                </h2>
              </div>
              {wasteByItem.length === 0 ? (
                <Empty>No waste recorded yet.</Empty>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="bg-cream-100/60">
                      <th className="th">Item</th>
                      <th className="th">SKU</th>
                      <th className="th text-right">Total Waste</th>
                      <th className="th text-right">Events</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wasteByItem.map((w) => (
                      <tr key={w.sku}>
                        <td className="td text-cocoa-700">{w.name}</td>
                        <td className="td font-mono text-xs text-cocoa-400">
                          {w.sku}
                        </td>
                        <td className="td text-right tabular-nums">
                          {fmtQty(w.qty)}
                        </td>
                        <td className="td text-right tabular-nums">{w.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </>
      )}

      {/* ---------- email report modal ---------- */}
      {emailModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="card w-full max-w-md space-y-4 p-6">
            <h2 className="text-lg font-bold text-cocoa-800">
              Email this report
            </h2>
            <p className="text-sm text-cocoa-500">
              Sends the current stock report to the email address below.
            </p>
            <div>
              <label className="label" htmlFor="email-to">
                Email address
              </label>
              <input
                id="email-to"
                className="input"
                type="email"
                placeholder="owner@example.com"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                autoFocus
              />
            </div>
            {toast && (
              <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
                {toast.msg}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="btn-ghost"
                onClick={() => {
                  setEmailModalOpen(false);
                  setEmailTo("");
                }}
                disabled={emailSending}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={sendEmailReport}
                disabled={emailSending || !emailTo.trim()}
              >
                {emailSending ? "Sending..." : "Send report"}
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
