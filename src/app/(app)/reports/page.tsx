"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Card,
  Badge,
  Empty,
  Spinner,
  Stat,
  Toast,
  DataCard,
  DataField,
  Modal,
} from "@/components/ui";
import { fmtQty, fmtDate, daysUntil, toCsv } from "@/lib/format";
import { stockStatus } from "@/lib/status";
import { TRANSACTION_NOTE_SCHEMA_WARNING } from "@/lib/transaction-note-schema";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

const TRANSACTION_PAGE_SIZE = 500;

type Item = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  unit_price: number | null;
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
  actor_id: string | null;
  actor_name: string;
  note: string | null;
  created_at: string;
  transaction_items: {
    sku: string;
    item_name: string;
    quantity: number;
    note: string | null;
  }[] | null;
};

const MOVEMENT_LABEL: Record<string, string> = {
  checkout: "Checked out",
  restock: "Restocked",
  waste: "Logged as waste",
};

/* Date-range presets. */
type RangeKey = "today" | "week" | "year" | "custom";

const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "year", label: "This year" },
  { key: "custom", label: "Custom dates" },
];

/* Stock wording + tones come from @/lib/status so every page agrees. */

type FinancialItem = {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  valueCents: number;
  events: number;
};

type FinancialGroup = {
  key: string;
  name: string;
  valueCents: number;
  items: FinancialItem[];
};

const MONEY_COLORS = [
  "#8d6040",
  "#bd8c53",
  "#9b6f4a",
  "#8b3a24",
  "#c8a274",
  "#70482d",
  "#b8862f",
  "#a67642",
];
const MOVEMENT_COLORS: Record<string, string> = {
  checkout: "#8d6040",
  restock: "#bd8c53",
  waste: "#8b3a24",
};

type MovementSummary = {
  type: string;
  count: number;
  qty: number;
};

type MovementTransaction = {
  type: string;
  transaction_items: {
    sku: string;
    item_name: string;
    quantity: number;
  }[] | null;
};

type QuantityChartEntry = {
  key: string;
  name: string;
  quantity: number;
  quantityLabel: string;
  detail?: string;
  events?: number;
};

type TrendPoint = {
  key: string;
  label: string;
  revenueCents: number;
  lossCents: number;
};

type HistogramBin = {
  label: string;
  minCents: number;
  maxCents: number;
  checkoutCount: number;
  wasteCount: number;
};

type ScatterPoint = {
  sku: string;
  name: string;
  checkoutEvents: number;
  wasteEvents: number;
};

type ExpiryItem = Item & { days: number | null };

function localDayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPeso(cents: number) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function useReportReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setIsVisible(true);
        observer.disconnect();
      },
      { threshold: 0.12 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, isVisible };
}

function ReportReveal({ children }: { children: ReactNode }) {
  const { ref, isVisible } = useReportReveal<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={`report-reveal w-full${isVisible ? " is-visible" : ""}`}
    >
      {children}
    </div>
  );
}

function useAnimatedReportValue<T extends Element>(value: number) {
  const [displayValue, setDisplayValue] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const ref = useRef<T>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsVisible(true);
      return;
    }
    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setIsVisible(true);
        observer.disconnect();
      },
      { threshold: 0.15 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    if (hasAnimated.current) {
      setDisplayValue(value);
      return;
    }
    hasAnimated.current = true;
    let animationFrame = 0;
    let startedAt: number | null = null;
    const duration = 950;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayValue(value);
      return;
    }

    const animate = (timestamp: number) => {
      if (startedAt === null) startedAt = timestamp;
      const progress = Math.min((timestamp - startedAt) / duration, 1);
      const eased = 1 - (1 - progress) ** 4;
      setDisplayValue(value * eased);
      if (progress < 1) animationFrame = requestAnimationFrame(animate);
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [isVisible, value]);

  return { displayValue, ref };
}

function AnimatedReportValue({
  value,
  format,
  label,
}: {
  value: number;
  format: "number" | "peso-cents";
  label: string;
}) {
  const { displayValue, ref } = useAnimatedReportValue<HTMLSpanElement>(value);
  const accessibleValue =
    format === "peso-cents"
      ? formatPeso(value)
      : value.toLocaleString("en-PH");
  const display =
    format === "peso-cents"
      ? formatPeso(Math.round(displayValue))
      : Math.round(displayValue).toLocaleString("en-PH");

  return (
    <span ref={ref} aria-label={`${label}: ${accessibleValue}`} aria-live="off">
      {display}
    </span>
  );
}

type ReportMetric = {
  label: string;
  value: number;
  hint: string;
  icon: "items" | "low" | "out" | "movements";
  tone: "sage" | "ochre" | "terracotta" | "cocoa";
};

function ReportMetricCard({ metric }: { metric: ReportMetric }) {
  const toneClass = {
    sage: "text-cocoa-500",
    ochre: "text-ochre-700",
    terracotta: "text-rust-500",
    cocoa: "text-cocoa-500",
  }[metric.tone];

  return (
    <Card className="!p-4 sm:!p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-cocoa-400">{metric.label}</p>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`h-5 w-5 shrink-0 ${toneClass}`}
        >
          {metric.icon === "items" && (
            <>
              <path d="m12 2 9 5-9 5-9-5 9-5Z" />
              <path d="M3 7v10l9 5 9-5V7M12 12v10" />
              <path d="M7.5 4.5 16.5 9.5" />
            </>
          )}
          {metric.icon === "low" && (
            <>
              <path d="m12 3 10 18H2L12 3Z" />
              <path d="M12 9v5m0 3h.01" />
            </>
          )}
          {metric.icon === "out" && (
            <>
              <path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z" />
              <path d="M3 7l9 5 9-5M12 12v10m-3-7 6 3m0-3-6 3" />
            </>
          )}
          {metric.icon === "movements" && (
            <>
              <path d="M4 7h15l-3-3m4 13H5l3 3" />
              <path d="M19 7v4M5 17v-4" />
            </>
          )}
        </svg>
      </div>
      <p className="mt-1 text-3xl font-semibold leading-none tabular-nums text-cocoa-800">
        <AnimatedReportValue value={metric.value} format="number" label={metric.label} />
      </p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className={`text-[11px] ${toneClass}`}>{metric.hint}</p>
        <span className={`h-0.5 w-6 shrink-0 rounded-full ${metric.tone === "sage" ? "bg-cocoa-500" : metric.tone === "ochre" ? "bg-ochre-600" : metric.tone === "terracotta" ? "bg-rust-500" : "bg-cocoa-300"}`} />
      </div>
    </Card>
  );
}

function ReportPriceInsight({
  title,
  cents,
  missingLines,
  missingItems,
  kind,
  onAddPrices,
}: {
  title: string;
  cents: number;
  missingLines: number;
  missingItems: number;
  kind: "revenue" | "waste";
  onAddPrices: () => void;
}) {
  const unavailable = missingLines > 0 && cents === 0;
  const accent = kind === "revenue" ? "border-ochre-500" : "border-terracotta-500";
  const amountTone = kind === "revenue" ? "text-cocoa-600" : "text-rust-500";

  return (
    <Card className={`!border-l-4 !p-0 ${accent}`}>
      <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-cocoa-400"
          >
            {kind === "revenue" ? (
              <>
                <rect x="3" y="5" width="18" height="15" rx="2" />
                <path d="M3 9h18m-13 5h4m-2-2v4" />
              </>
            ) : (
              <>
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8m-8 4h8m-8 4h5m-1-11v2m0 9v2" />
              </>
            )}
          </svg>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-cocoa-800">{title}</h2>
            <p className="mt-0.5 text-[10px] text-cocoa-400">
              {kind === "revenue" ? "Checkout value" : "Recorded waste value"}
            </p>
          </div>
        </div>
        {missingItems > 0 && (
          <Badge tone="amber" variant="tag">
            {missingItems} {missingItems === 1 ? "item needs" : "items need"} price
          </Badge>
        )}
      </div>
      <div className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-cocoa-400">
          {unavailable ? "Value unavailable" : "Current estimate · priced items"}
        </p>
        <p className={`mt-1 text-3xl font-bold leading-tight tabular-nums sm:text-4xl ${unavailable ? "text-cocoa-400" : amountTone}`}>
          {unavailable ? "Not available" : (
            <AnimatedReportValue value={cents} format="peso-cents" label={title} />
          )}
        </p>
        {missingItems > 0 ? (
          <p className="mt-2 text-xs leading-relaxed text-ochre-700">
            {missingItems} {missingItems === 1 ? "item has" : "items have"} no price yet.
            {" "}{missingLines} {missingLines === 1 ? "movement line is" : "movement lines are"} excluded, so this is not the complete {kind === "revenue" ? "revenue" : "waste cost"} total.
          </p>
        ) : (
          <p className="mt-2 text-xs text-cocoa-400">
            {kind === "revenue"
              ? "Calculated from checkout quantities and current item prices."
              : "Calculated from waste quantities and current item prices."}
          </p>
        )}
      </div>
      {missingItems > 0 && (
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          <button
            type="button"
            onClick={onAddPrices}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-cream-300 bg-white px-3 text-xs font-semibold text-cocoa-600 transition-colors hover:bg-cream-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cocoa-500"
          >
            <span className="text-base leading-none" aria-hidden="true">+</span>
            Add missing item prices
          </button>
        </div>
      )}
    </Card>
  );
}

function ItemPriceEditor({
  open,
  items,
  onClose,
  onItemSaved,
  onComplete,
}: {
  open: boolean;
  items: Item[];
  onClose: () => void;
  onItemSaved: (updatedItem: Item) => void;
  onComplete: (savedCount: number, pendingCount: number) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const initializedOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      initializedOpen.current = false;
      return;
    }
    if (initializedOpen.current) return;
    initializedOpen.current = true;
    setDrafts(
      Object.fromEntries(
        items.map((item) => [item.id, item.unit_price == null ? "" : String(item.unit_price)])
      )
    );
    setSearch("");
    setError(null);
    setPendingIds([]);
  }, [open, items]);

  const changedItems = useMemo(
    () =>
      items.filter((item) => {
        if (pendingIds.includes(item.id)) return false;
        const draft = drafts[item.id] ?? (item.unit_price == null ? "" : String(item.unit_price));
        return draft !== (item.unit_price == null ? "" : String(item.unit_price));
      }),
    [items, drafts, pendingIds]
  );
  const filteredItems = items.filter((item) =>
    `${item.name} ${item.sku}`.toLowerCase().includes(search.trim().toLowerCase())
  );

  async function savePrices(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changedItems.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    let savedCount = 0;
    let pendingCount = 0;

    try {
      for (const item of changedItems) {
        const value = drafts[item.id]?.trim() ?? "";
        const unitPrice = value === "" ? null : Number(value);
        if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
          throw new Error(`Enter a valid non-negative price for ${item.name}.`);
        }

        const response = await fetch(`/api/items/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unit_price: unitPrice }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || `Could not save the price for ${item.name}.`);
        }
        if (data.pending_change) {
          pendingCount += 1;
          setPendingIds((current) => [...current, item.id]);
        } else if (data.item) {
          savedCount += 1;
          onItemSaved({
            ...item,
            unit_price: data.item.unit_price == null ? null : Number(data.item.unit_price),
          });
        } else {
          throw new Error(`The price for ${item.name} was not confirmed by the server.`);
        }
      }

      onComplete(savedCount, pendingCount);
      onClose();
    } catch (saveError) {
      const message =
        saveError instanceof Error ? saveError.message : "Could not save item prices.";
      setError(
        savedCount > 0
          ? `${message} ${savedCount} earlier price ${savedCount === 1 ? "change was" : "changes were"} saved successfully.`
          : message
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Add item prices"
      width="max-w-3xl"
      scrollable
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-cocoa-400">
            {changedItems.length} unsaved {changedItems.length === 1 ? "change" : "changes"}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" form="report-item-price-form" className="btn-primary" disabled={saving || changedItems.length === 0}>
              {saving ? "Saving prices..." : "Save prices"}
            </button>
          </div>
        </div>
      }
    >
      <form id="report-item-price-form" className="space-y-4" onSubmit={savePrices}>
        <div>
          <p className="text-sm text-cocoa-600">
            Enter a unit price in PHP. CafeTrack uses this same value as the current price/cost for checkout revenue and waste estimates.
          </p>
          <p className="mt-1 text-xs text-cocoa-400">
            Saving prices updates the item record. Staff without item-edit permission may need an admin to approve the changes.
          </p>
        </div>

        <div>
          <label className="label" htmlFor="report-price-search">Find an item</label>
          <input
            id="report-price-search"
            className="input w-full"
            type="search"
            placeholder="Search name or SKU"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-terracotta-50 px-3 py-2 text-sm text-terracotta-700">
            {error}
          </p>
        )}

        {pendingIds.length > 0 && (
          <p className="rounded-lg bg-ochre-50 px-3 py-2 text-sm text-ochre-700">
            {pendingIds.length} price {pendingIds.length === 1 ? "change was" : "changes were"} sent for admin approval. Insights update after approval.
          </p>
        )}

        <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-cream-200">
          {filteredItems.length === 0 ? (
            <p className="p-5 text-center text-sm text-cocoa-400">No items match that search.</p>
          ) : (
            <div className="divide-y divide-cream-200">
              {filteredItems.map((item) => {
                const missing = item.unit_price == null;
                const pending = pendingIds.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center sm:px-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-cocoa-800">{item.name}</p>
                      <p className="mt-0.5 truncate text-xs text-cocoa-400">
                        {item.sku} · {item.category?.name ?? "Uncategorized"} · {item.unit}
                      </p>
                    </div>
                    <div>
                      <label className="sr-only" htmlFor={`report-price-${item.id}`}>
                        Unit price in PHP for {item.name}
                      </label>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-cocoa-400">₱</span>
                        <input
                          id={`report-price-${item.id}`}
                          className="input w-full pl-8"
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          placeholder={missing ? "Price not set" : "Unit price"}
                          value={drafts[item.id] ?? (item.unit_price == null ? "" : String(item.unit_price))}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [item.id]: event.target.value }))
                          }
                          disabled={saving || pending}
                        />
                      </div>
                      {pending ? (
                        <p className="mt-1 text-[10px] text-ochre-700">Awaiting approval</p>
                      ) : missing ? (
                        <p className="mt-1 text-[10px] text-ochre-700">Price needed for insight</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}

function LineTrendChart({
  points,
  periodLabel,
  unpricedLines,
}: {
  points: TrendPoint[];
  periodLabel: string;
  unpricedLines: number;
}) {
  const chartId = useId().replaceAll(":", "");
  const width = 640;
  const height = 220;
  const left = 44;
  const right = 12;
  const top = 14;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(
    ...points.flatMap((point) => [point.revenueCents, point.lossCents]),
    1
  );
  const x = (index: number) =>
    left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value: number) => top + plotHeight - (value / maxValue) * plotHeight;
  const series = [
    { key: "revenueCents", label: "Checkout value", color: "#8d6040" },
    { key: "lossCents", label: "Waste cost", color: "#8b3a24" },
  ] as const;
  const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  const hasMonetaryValues = points.some(
    (point) => point.revenueCents > 0 || point.lossCents > 0
  );
  const showPriceEmptyState = unpricedLines > 0 && !hasMonetaryValues;
  const hasPartialPrices = unpricedLines > 0 && hasMonetaryValues;
  const revenuePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.revenueCents)}`)
    .join(" ");
  const revenueAreaPath = points.length
    ? `${revenuePath} L ${x(points.length - 1)} ${top + plotHeight} L ${x(0)} ${top + plotHeight} Z`
    : "";

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="relative border-b border-cream-200 bg-cream-50 px-4 py-3">
        <h2 className="text-sm font-bold text-cocoa-800">Value over time</h2>
        <p className="mt-1 text-xs text-cocoa-400">
          Revenue and waste cost · {periodLabel}
        </p>
        {(showPriceEmptyState || hasPartialPrices) && (
          <span className="absolute right-4 top-4 rounded-full bg-cream-200 px-2.5 py-1 text-[10px] font-medium text-cocoa-500">
            • {hasPartialPrices ? "Some prices missing" : "Awaiting prices"}
          </span>
        )}
      </div>
      {points.length === 0 && !showPriceEmptyState ? (
        <Empty>No priced checkout or waste activity in this date range.</Empty>
      ) : (
        <div className="relative p-3 sm:p-4">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
            {series.map((entry) => (
              <span key={entry.key} className="inline-flex items-center gap-1.5 text-[11px] text-cocoa-600">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                {entry.label}
              </span>
            ))}
          </div>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={`Line chart of checkout value and waste cost over time, grouped ${periodLabel}`}
          >
            <defs>
              <linearGradient id={`${chartId}-revenue`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#c9a477" />
                <stop offset="100%" stopColor="#8f6748" />
              </linearGradient>
              <linearGradient id={`${chartId}-revenue-area`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c9a477" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#c9a477" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`${chartId}-waste`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#d39a82" />
                <stop offset="100%" stopColor="#8b3a24" />
              </linearGradient>
            </defs>
            {[0, 0.5, 1].map((fraction) => {
              const gridY = top + plotHeight * fraction;
              return (
                <g key={fraction}>
                  <line
                    x1={left}
                    y1={gridY}
                    x2={width - right}
                    y2={gridY}
                    stroke="#eadfce"
                    strokeDasharray="3 4"
                  />
                  {!showPriceEmptyState && (
                    <text x={left - 5} y={gridY + 3} textAnchor="end" fill="#927f6e" fontSize="9">
                      {formatPeso(Math.round((maxValue * (1 - fraction)) / 100) * 100)}
                    </text>
                  )}
                </g>
              );
            })}
            {!showPriceEmptyState && series.map((entry) => {
              const path = points
                .map((point, index) => {
                  const value = point[entry.key];
                  return `${index === 0 ? "M" : "L"} ${x(index)} ${y(value)}`;
                })
                .join(" ");
              return (
                <g key={entry.key}>
                  {entry.key === "revenueCents" && (
                    <path
                      d={revenueAreaPath}
                      fill={`url(#${chartId}-revenue-area)`}
                      className="report-trend-area"
                    />
                  )}
                  <path
                    d={path}
                    fill="none"
                    stroke={`url(#${chartId}-${entry.key === "revenueCents" ? "revenue" : "waste"})`}
                    strokeWidth="2.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    pathLength="1"
                    className="report-trend-line"
                  />
                  {points.map((point, index) => (
                    <circle
                      key={point.key}
                      cx={x(index)}
                      cy={y(point[entry.key])}
                      r={points.length > 50 ? 1.8 : 3}
                      fill={`url(#${chartId}-${entry.key === "revenueCents" ? "revenue" : "waste"})`}
                      className="report-trend-dot"
                      style={{ animationDelay: `${Math.min(index * 12, 300)}ms` }}
                    >
                      <title>{`${point.label} · ${entry.label}: ${formatPeso(point[entry.key])}`}</title>
                    </circle>
                  ))}
                </g>
              );
            })}
            {!showPriceEmptyState && labelIndexes.map((index) => (
              <text
                key={points[index].key}
                x={x(index)}
                y={height - 10}
                textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                fill="#927f6e"
                fontSize="9"
              >
                {points[index].label}
              </text>
            ))}
            {showPriceEmptyState && (
              <>
                <path
                  d={`M ${left} ${top + plotHeight * 0.72} C ${left + plotWidth * 0.17} ${top + plotHeight * 0.78}, ${left + plotWidth * 0.19} ${top + plotHeight * 0.45}, ${left + plotWidth * 0.34} ${top + plotHeight * 0.58} S ${left + plotWidth * 0.5} ${top + plotHeight * 0.72}, ${left + plotWidth * 0.62} ${top + plotHeight * 0.42} S ${left + plotWidth * 0.82} ${top + plotHeight * 0.62}, ${width - right} ${top + plotHeight * 0.3}`}
                  fill="none"
                  stroke="#c8a274"
                  strokeWidth="2"
                  pathLength="1"
                  className="report-trend-line"
                />
                <path
                  d={`M ${left} ${top + plotHeight * 0.72} C ${left + plotWidth * 0.17} ${top + plotHeight * 0.78}, ${left + plotWidth * 0.19} ${top + plotHeight * 0.45}, ${left + plotWidth * 0.34} ${top + plotHeight * 0.58} S ${left + plotWidth * 0.5} ${top + plotHeight * 0.72}, ${left + plotWidth * 0.62} ${top + plotHeight * 0.42} S ${left + plotWidth * 0.82} ${top + plotHeight * 0.62}, ${width - right} ${top + plotHeight * 0.3} L ${width - right} ${top + plotHeight} L ${left} ${top + plotHeight} Z`}
                  fill="#c8a274"
                  fillOpacity="0.18"
                  className="report-trend-area"
                />
                <text x={left} y={height - 10} fill="#927f6e" fontSize="9">Illustrative trend only</text>
              </>
            )}
          </svg>
          {showPriceEmptyState && (
            <div className="pointer-events-none absolute inset-x-8 top-1/2 -translate-y-1/2 text-center">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="#c8a274"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="mx-auto mb-2 h-6 w-6"
              >
                <path d="M3 19h18M5 16l5-5 3 3 6-8" />
                <path d="M15 6h4v4" />
              </svg>
              <p className="text-sm font-semibold text-cocoa-700">
                Your next insight starts with a price
              </p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-cocoa-400">
                Add selling prices and item costs to see monetary history.
              </p>
              <p className="mt-3 text-[10px] text-cocoa-400">
                Illustrative curve only · no monetary values are available
              </p>
            </div>
          )}
          {hasPartialPrices && (
            <p className="mt-2 text-[10px] text-cocoa-400">
              Showing values for priced items; {unpricedLines} unpriced movement{" "}
              {unpricedLines === 1 ? "line is" : "lines are"} excluded.
            </p>
          )}
        </div>
      )}
    </Card>
    </ReportReveal>
  );
}

function TransactionHistogram({ bins }: { bins: HistogramBin[] }) {
  const maxCount = Math.max(
    ...bins.flatMap((bin) => [bin.checkoutCount, bin.wasteCount]),
    1
  );

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
        <h2 className="text-sm font-bold text-cocoa-800">Transaction value distribution</h2>
        <p className="mt-1 text-xs text-cocoa-400">
          Histogram of estimated value per checkout or waste transaction.
        </p>
      </div>
      {bins.length === 0 ? (
        <Empty>No priced transactions in this date range.</Empty>
      ) : (
        <div className="p-3 sm:p-4">
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-cocoa-600">
              <span className="h-2 w-2 rounded-sm bg-[#8d6040]" /> Checkout
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-cocoa-600">
              <span className="h-2 w-2 rounded-sm bg-[#8b3a24]" /> Waste
            </span>
          </div>
          <div
            className="grid grid-cols-[2rem_minmax(0,1fr)] gap-1"
            role="img"
            aria-label="Histogram showing checkout and waste transaction frequency across estimated transaction value ranges"
          >
            <div className="flex h-36 flex-col justify-between pb-5 text-right text-[9px] tabular-nums text-cocoa-400">
              <span>{maxCount}</span>
              <span>{Math.ceil(maxCount / 2)}</span>
              <span>0</span>
            </div>
            <div className="grid h-36 grid-cols-5 items-end gap-2 border-b border-l border-cream-300 px-2">
              {bins.map((bin, index) => (
                <div
                  key={bin.label}
                  className="flex h-full min-w-0 flex-col justify-end"
                  title={`${bin.label}: ${bin.checkoutCount} checkouts, ${bin.wasteCount} waste transactions`}
                >
                  <div className="flex h-[calc(100%-1.25rem)] items-end justify-center gap-1">
                    {[
                      { key: "checkout", count: bin.checkoutCount, color: "#8d6040" },
                      { key: "waste", count: bin.wasteCount, color: "#8b3a24" },
                    ].map((bar) => (
                      <div
                        key={bar.key}
                        className="report-bar-rise min-w-1 flex-1 max-w-5 rounded-t-sm"
                        style={{
                          height: `${bar.count > 0 ? Math.max((bar.count / maxCount) * 100, 4) : 0}%`,
                          backgroundImage: `linear-gradient(180deg, ${bar.key === "checkout" ? "#c9a477" : "#d39a82"}, ${bar.color})`,
                          animationDelay: `${index * 70}ms`,
                        }}
                      />
                    ))}
                  </div>
                  <span className="mt-1 truncate text-center text-[9px] text-cocoa-400">
                    {bin.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-2 text-right text-[10px] text-cocoa-400">
            X: transaction value (PHP) · Y: transaction count
          </p>
        </div>
      )}
    </Card>
    </ReportReveal>
  );
}

function ActivityScatterPlot({
  points,
  periodLabel,
}: {
  points: ScatterPoint[];
  periodLabel: string;
}) {
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const width = 640;
  const height = 280;
  const left = 48;
  const right = 14;
  const top = 18;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxCheckout = Math.max(...points.map((point) => point.checkoutEvents), 0);
  const maxWaste = Math.max(...points.map((point) => point.wasteEvents), 0);
  const maxX = Math.max(4, Math.ceil((maxCheckout * 1.1) / 4) * 4);
  const maxY = Math.max(3, Math.ceil((maxWaste * 1.1) / 3) * 3);
  const xStep = maxX / 4;
  const yStep = maxY / 3;
  const xTicks = Array.from({ length: Math.floor(maxX / xStep) + 1 }, (_, index) => index * xStep);
  const yTicks = Array.from({ length: Math.floor(maxY / yStep) + 1 }, (_, index) => index * yStep);
  const x = (value: number) => left + (value / maxX) * plotWidth;
  const y = (value: number) => top + plotHeight - (value / maxY) * plotHeight;
  const selected = points.find((point) => point.sku === selectedSku) ?? null;
  const midpointX = maxX / 2;
  const midpointY = maxY / 2;

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="flex items-start justify-between gap-3 border-b border-cream-200 bg-cream-50 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold text-cocoa-800">Checkout vs Waste</h2>
        <p className="mt-1 text-xs text-cocoa-400">
            Each point is an item · event counts, not quantities
        </p>
        </div>
        <Badge tone="slate" variant="tag" dot={false}>{periodLabel}</Badge>
      </div>
      {points.length === 0 ? (
        <Empty>No item activity to compare in this date range.</Empty>
      ) : (
        <div className="p-3 sm:p-4">
          <p className="mb-2 text-[10px] text-cocoa-400">Waste events</p>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={`Scatter plot of checkout and waste event counts per item, ${periodLabel}`}
          >
            {yTicks.map((tick) => (
              <g key={`y-${tick}`}>
                <line
                  x1={left}
                  y1={y(tick)}
                  x2={width - right}
                  y2={y(tick)}
                  stroke={tick === midpointY ? "#e5b184" : "#eadfce"}
                  strokeWidth={tick === midpointY ? 1.2 : 1}
                />
                <text x={left - 8} y={y(tick) + 3} textAnchor="end" fill="#927f6e" fontSize="10">
                  {tick}
                </text>
              </g>
            ))}
            {xTicks.map((tick) => (
              <g key={`x-${tick}`}>
                <line
                  x1={x(tick)}
                  y1={top}
                  x2={x(tick)}
                  y2={top + plotHeight}
                  stroke={tick === midpointX ? "#e5b184" : "#eadfce"}
                  strokeWidth={tick === midpointX ? 1.2 : 1}
                />
                <text x={x(tick)} y={height - 17} textAnchor="middle" fill="#927f6e" fontSize="10">
                  {tick}
                </text>
              </g>
            ))}
            <line
              x1={x(midpointX)}
              y1={top}
              x2={x(midpointX)}
              y2={top + plotHeight}
              stroke="#bd8c53"
              strokeDasharray="4 4"
              strokeOpacity="0.65"
            />
            <line
              x1={left}
              y1={y(midpointY)}
              x2={width - right}
              y2={y(midpointY)}
              stroke="#bd8c53"
              strokeDasharray="4 4"
              strokeOpacity="0.65"
            />
            {points.map((point, index) => (
              <circle
                key={point.sku}
                cx={x(point.checkoutEvents)}
                cy={y(point.wasteEvents)}
                r={point.sku === selectedSku ? 6 : 4}
                fill={point.sku === selectedSku ? "#8b3a24" : "#8d6040"}
                fillOpacity="0.8"
                stroke="white"
                strokeWidth="1.5"
                role="button"
                tabIndex={0}
                aria-label={`${point.name}: ${point.checkoutEvents} checkout events, ${point.wasteEvents} waste events`}
                onClick={() => setSelectedSku(point.sku)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedSku(point.sku);
                  }
                }}
                className="report-trend-dot cursor-pointer outline-none focus:stroke-cocoa-800"
                style={{ animationDelay: `${Math.min(index * 18, 360)}ms` }}
              >
                <title>{`${point.name} · checkout ${point.checkoutEvents}, waste ${point.wasteEvents}`}</title>
              </circle>
            ))}
            <text
              x={left + plotWidth / 2}
              y={height - 1}
              textAnchor="middle"
              fill="#786553"
              fontSize="10"
            >
              Checkout events
            </text>
          </svg>
          <p className="mt-1 text-[10px] text-cocoa-400">
            Each event counts once per item per transaction. Overlapping items may share a point.
          </p>
          {selected && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-cream-50 px-3 py-2.5 text-xs">
              <span className="min-w-0 truncate font-semibold text-cocoa-800">
                {selected.name} <span className="font-normal text-cocoa-400">({selected.sku})</span>
              </span>
              <span className="shrink-0 tabular-nums text-cocoa-600">
                {selected.checkoutEvents} checkout · {selected.wasteEvents} waste
              </span>
            </div>
          )}
        </div>
      )}
    </Card>
    </ReportReveal>
  );
}

function SoonestExpiries({ items }: { items: ExpiryItem[] }) {
  const expiredItems = items
    .filter((item) => item.days !== null && item.days < 0)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  const upcomingItems = items
    .filter((item) => item.days === null || item.days >= 0)
    .sort(
      (a, b) =>
        (a.days ?? Number.POSITIVE_INFINITY) -
        (b.days ?? Number.POSITIVE_INFINITY)
    );
  const maxUpcomingDays = Math.max(
    ...upcomingItems.map((item) => item.days ?? 0),
    300
  );
  const scaleMax = Math.ceil(maxUpcomingDays / 60) * 60;
  const ticks = Array.from({ length: scaleMax / 60 + 1 }, (_, index) => index * 60);
  const today = new Date();
  const asOfDate = today.toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const expiresToday = upcomingItems.filter((item) => item.days === 0).length;

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div>
          <h2 className="text-sm font-bold text-cocoa-800">Soonest Expiries</h2>
          <p className="mt-1 text-xs text-cocoa-400">
            See what needs attention first, then compare upcoming expiry dates.
          </p>
        </div>
        <Badge tone="slate" variant="tag" dot={false}>{items.length} dated items</Badge>
      </div>

      {items.length === 0 ? (
        <div className="p-4 sm:p-5">
          <Empty>No dated items match this report.</Empty>
        </div>
      ) : (
        <>
          {expiredItems.length > 0 && (
            <div className="grid gap-2 px-4 pt-4 sm:grid-cols-2 sm:px-5">
              {expiredItems.map((item) => (
                <div
                  key={item.id}
                  className="report-card-enter rounded-lg border border-terracotta-100 bg-terracotta-50 px-3 py-2.5"
                >
                  <p className="truncate text-xs font-semibold text-terracotta-800">{item.name}</p>
                  <p className="mt-1 text-[11px] text-terracotta-700">
                    Expired {Math.abs(item.days ?? 0)} {Math.abs(item.days ?? 0) === 1 ? "day" : "days"} ago
                    {" · "}{item.expiration_date ? fmtDate(item.expiration_date) : "Date unavailable"}
                  </p>
                  <p className="mt-1 truncate text-[10px] text-cocoa-500">
                    {fmtQty(item.quantity, item.unit)} · {item.location?.name ?? "No location"} · {item.sku}
                  </p>
                </div>
              ))}
            </div>
          )}

          {upcomingItems.length > 0 && (
            <div className="px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-[10px] font-semibold uppercase tracking-wide text-cocoa-600">
                  Upcoming expiry
                </h3>
                <p className="text-right text-[10px] text-cocoa-400">
                  Shorter bar = expires sooner · As of {asOfDate}
                </p>
              </div>
              <div
                className="mb-2 ml-[8.5rem] mr-[5.5rem] grid text-[9px] tabular-nums text-cocoa-400"
                style={{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }}
              >
                {ticks.map((tick) => <span key={tick}>{tick}</span>)}
              </div>
              <div className="space-y-3">
                {upcomingItems.map((item, index) => {
                  const days = item.days ?? 0;
                  const expiresToday = days === 0;
                  const percentage = Math.min((days / scaleMax) * 100, 100);
                  return (
                    <div
                      key={item.id}
                      className="report-card-enter grid grid-cols-[minmax(7rem,1.3fr)_minmax(4rem,4fr)_minmax(4.5rem,auto)] items-center gap-2 sm:grid-cols-[minmax(10rem,1.25fr)_minmax(6rem,4fr)_minmax(5.5rem,auto)] sm:gap-3"
                      style={{ animationDelay: `${index * 70}ms` }}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-cocoa-800">{item.name}</p>
                        <p className="truncate text-[9px] text-cocoa-400">
                          {fmtQty(item.quantity, item.unit)} · {item.category?.name ?? "Uncategorized"} · {item.location?.name ?? "—"}
                        </p>
                      </div>
                      <div className="relative h-2 overflow-hidden rounded-full bg-cream-200">
                        {ticks.map((tick) => (
                          <span
                            key={tick}
                            aria-hidden="true"
                            className="absolute inset-y-0 w-px bg-cream-400/70"
                            style={{ left: `${(tick / scaleMax) * 100}%` }}
                          />
                        ))}
                        <span
                          role="progressbar"
                          aria-label={`${item.name}: ${days} days until expiry`}
                          aria-valuemin={0}
                          aria-valuemax={scaleMax}
                          aria-valuenow={days}
                          className={`absolute inset-y-0 left-0 rounded-full ${
                            expiresToday
                              ? "report-bar-grow min-w-[3px] bg-rust-500"
                              : "report-bar-grow bg-ochre-500"
                          }`}
                          style={{
                            width: `${percentage}%`,
                            animationDelay: `${index * 70}ms`,
                          }}
                        />
                      </div>
                      <div className="text-right">
                        <p className={`text-[10px] font-semibold ${expiresToday ? "text-rust-500" : "text-ochre-700"}`}>
                          {expiresToday ? "Expires today" : `${days} days left`}
                        </p>
                        <p className="text-[9px] text-cocoa-400">
                          {item.expiration_date ? fmtDate(item.expiration_date) : "Date unavailable"}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <p className="border-t border-cream-200 bg-cream-50 px-4 py-2 text-[10px] text-cocoa-400 sm:px-5">
            {expiredItems.length} expired items · {expiresToday} expires today · Days left calculated as of {asOfDate}.
          </p>
        </>
      )}
    </Card>
    </ReportReveal>
  );
}

function QuantityBarChart({
  title,
  description,
  entries,
  emptyMessage,
  color = "#8d6040",
}: {
  title: string;
  description: string;
  entries: QuantityChartEntry[];
  emptyMessage: string;
  color?: string;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const maxQuantity = Math.max(...entries.map((entry) => entry.quantity), 1);
  const selected =
    entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
        <h2 className="text-sm font-bold text-cocoa-800">{title}</h2>
        <p className="mt-1 text-xs text-cocoa-400">{description}</p>
      </div>
      {entries.length === 0 ? (
        <Empty>{emptyMessage}</Empty>
      ) : (
        <div className="space-y-2 p-3 sm:p-4">
          {entries.map((entry, index) => {
            const isSelected = selected?.key === entry.key;
            const width =
              entry.quantity > 0
                ? Math.max((entry.quantity / maxQuantity) * 100, 4)
                : 0;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setSelectedKey(entry.key)}
                aria-pressed={isSelected}
                className={`block w-full rounded-lg p-2 text-left transition-colors ${
                  isSelected ? "bg-cream-100" : "hover:bg-cream-50"
                }`}
              >
                <span className="mb-1.5 flex min-w-0 items-center justify-between gap-2 text-xs">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 shrink-0 text-[10px] font-semibold tabular-nums text-cocoa-300">
                      {index + 1}
                    </span>
                    <span className="truncate font-medium text-cocoa-700">{entry.name}</span>
                  </span>
                  <span className="shrink-0 font-bold tabular-nums text-cocoa-800">
                    {entry.quantityLabel}
                  </span>
                </span>
                <span className="ml-6 block h-2 overflow-hidden rounded-full bg-cream-200">
                  <span
                  className="report-bar-grow block h-full rounded-full"
                  style={{
                    width: `${width}%`,
                    backgroundImage: `linear-gradient(90deg, #c8a274, ${color})`,
                    animationDelay: `${index * 70}ms`,
                  }}
                />
              </span>
              </button>
            );
          })}
          {selected && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white px-3 py-2.5 text-xs">
              <div className="min-w-0">
                <p className="truncate font-semibold text-cocoa-800">{selected.name}</p>
                {selected.detail && (
                  <p className="mt-0.5 truncate text-cocoa-400">{selected.detail}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 text-right tabular-nums">
                {selected.events !== undefined && (
                  <span className="text-cocoa-500">
                    {selected.events} {selected.events === 1 ? "event" : "events"}
                  </span>
                )}
                <span className="font-bold text-cocoa-800">{selected.quantityLabel}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
    </ReportReveal>
  );
}

function MovementChart({
  movement,
  transactions,
}: {
  movement: MovementSummary[];
  transactions: MovementTransaction[];
}) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const orderedTypes = ["checkout", "restock", "waste"];
  const rows = orderedTypes
    .map((type) => movement.find((entry) => entry.type === type))
    .filter((entry): entry is MovementSummary => Boolean(entry));
  const maxCount = Math.max(...rows.map((entry) => entry.count), 1);
  const activeType =
    selectedType && rows.some((entry) => entry.type === selectedType)
      ? selectedType
      : rows.find((entry) => entry.count > 0)?.type ?? null;
  const selectedLabel = activeType ? MOVEMENT_LABEL[activeType] ?? activeType : "";
  const itemEvents = new Map<string, { name: string; events: number }>();

  if (activeType) {
    for (const transaction of transactions) {
      if (transaction.type !== activeType) continue;
      const seenInTransaction = new Set<string>();
      for (const line of transaction.transaction_items ?? []) {
        if (seenInTransaction.has(line.sku)) continue;
        seenInTransaction.add(line.sku);
        const current = itemEvents.get(line.sku) ?? {
          name: line.item_name,
          events: 0,
        };
        current.events += 1;
        itemEvents.set(line.sku, current);
      }
    }
  }

  const activeItems = [...itemEvents.entries()]
    .map(([sku, item]) => ({ sku, ...item }))
    .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name))
    .slice(0, 5);

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
        <h2 className="text-sm font-bold text-cocoa-800">Transactions by activity</h2>
        <p className="mt-1 text-xs text-cocoa-400">
          Select an activity to see the items recorded most often.
        </p>
      </div>
      <div className="space-y-3 p-4">
        <div className="space-y-3">
          {rows.map((entry, index) => {
            const isSelected = entry.type === activeType;
            const width = entry.count > 0 ? Math.max((entry.count / maxCount) * 100, 4) : 0;
            return (
              <button
                key={entry.type}
                type="button"
                onClick={() => setSelectedType(entry.type)}
                aria-pressed={isSelected}
                className={`block w-full rounded-lg p-2 text-left transition-colors ${
                  isSelected ? "bg-cream-100" : "hover:bg-cream-50"
                }`}
              >
                <span className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-medium text-cocoa-700">
                    {MOVEMENT_LABEL[entry.type] ?? entry.type}
                  </span>
                  <span className="shrink-0 font-bold tabular-nums text-cocoa-800">
                    {entry.count} {entry.count === 1 ? "transaction" : "transactions"}
                  </span>
                </span>
                <span className="block h-2.5 overflow-hidden rounded-full bg-cream-200">
                  <span
                    className="report-bar-grow block h-full rounded-full"
                    style={{
                      width: `${width}%`,
                      backgroundColor: MOVEMENT_COLORS[entry.type] ?? "#8d6040",
                      animationDelay: `${index * 70}ms`,
                    }}
                  />
                </span>
              </button>
            );
          })}
        </div>

        {activeType && activeItems.length > 0 ? (
          <div className="rounded-xl border border-cream-200 bg-white p-3">
            <h3 className="mb-2 text-xs font-semibold text-cocoa-700">
              Most frequent items · {selectedLabel}
            </h3>
            <div className="space-y-1.5">
              {activeItems.map((item) => (
                <div key={item.sku} className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate text-cocoa-600">{item.name}</span>
                  <span className="shrink-0 tabular-nums text-cocoa-500">
                    {item.events} {item.events === 1 ? "time" : "times"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-xl bg-cream-50 px-3 py-3 text-center text-xs text-cocoa-400">
            No movement activity in this date range.
          </p>
        )}
      </div>
    </Card>
    </ReportReveal>
  );
}

function FinancialBreakdown({
  title,
  description,
  entries,
  totalCents,
}: {
  title: string;
  description: string;
  entries: FinancialItem[];
  totalCents: number;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const sortedEntries = [...entries]
    .filter((entry) => entry.valueCents > 0)
    .sort((a, b) => b.valueCents - a.valueCents);
  const leadingItems = sortedEntries.slice(0, 7);
  const otherItems = sortedEntries.slice(7);
  const chartGroups: FinancialGroup[] = [
    ...leadingItems.map((item) => ({
      key: item.sku,
      name: item.name,
      valueCents: item.valueCents,
      items: [item],
    })),
    ...(otherItems.length > 0
      ? [{
          key: "__other__",
          name: "Other items",
          valueCents: otherItems.reduce((sum, item) => sum + item.valueCents, 0),
          items: otherItems,
        }]
      : []),
  ];
  const totalChartCents = chartGroups.reduce((sum, group) => sum + group.valueCents, 0);
  const activeKey =
    selectedKey && chartGroups.some((group) => group.key === selectedKey)
      ? selectedKey
      : chartGroups[0]?.key;
  const activeGroup = chartGroups.find((group) => group.key === activeKey);

  let startAngle = -90;
  const slices = chartGroups.map((group, index) => {
    const sweep = totalChartCents > 0 ? (group.valueCents / totalChartCents) * 360 : 0;
    const endAngle = startAngle + sweep;
    const point = (angle: number) => {
      const radians = (angle * Math.PI) / 180;
      return { x: 50 + 44 * Math.cos(radians), y: 50 + 44 * Math.sin(radians) };
    };
    const start = point(startAngle);
    const end = point(endAngle);
    const path =
      sweep >= 359.99
        ? ""
        : `M 50 50 L ${start.x} ${start.y} A 44 44 0 ${sweep > 180 ? 1 : 0} 1 ${end.x} ${end.y} Z`;
    const slice = { group, color: MONEY_COLORS[index % MONEY_COLORS.length], path };
    startAngle = endAngle;
    return slice;
  });

  function selectSlice(key: string) {
    setSelectedKey(key);
  }

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
        <h2 className="text-sm font-bold text-cocoa-800">{title}</h2>
        <p className="mt-1 text-xs text-cocoa-400">{description}</p>
      </div>
      <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 p-3 sm:grid-cols-[minmax(130px,0.8fr)_minmax(0,1.2fr)] sm:gap-4 sm:p-4">
        <div className="mx-auto grid h-28 w-28 place-items-center sm:h-44 sm:w-44">
          <div className="relative h-full w-full">
            <svg
              viewBox="0 0 100 100"
              className="h-full w-full -rotate-90"
              role="group"
              aria-label={`${title} by item`}
            >
              {slices.length === 1 ? (
                <circle
                  cx="50"
                  cy="50"
                  r="44"
                  fill={slices[0].color}
                  role="button"
                  tabIndex={0}
                  aria-label={`${slices[0].group.name}: ${formatPeso(slices[0].group.valueCents)}`}
                  onClick={() => selectSlice(slices[0].group.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectSlice(slices[0].group.key);
                    }
                  }}
                  className="report-donut-slice cursor-pointer outline-none focus:opacity-70"
                />
              ) : (
                slices.map(({ group, color, path }, index) => (
                  <path
                    key={group.key}
                    d={path}
                    fill={color}
                    role="button"
                    tabIndex={0}
                    aria-label={`${group.name}: ${formatPeso(group.valueCents)}`}
                    onClick={() => selectSlice(group.key)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectSlice(group.key);
                      }
                    }}
                    className="report-donut-slice cursor-pointer outline-none transition-opacity hover:opacity-75 focus:opacity-75"
                    style={{ animationDelay: `${index * 70}ms` }}
                  />
                ))
              )}
              <circle cx="50" cy="50" r="26" fill="white" pointerEvents="none" />
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-cocoa-400">
                Total
              </span>
              <span className="mt-0.5 max-w-[6.5rem] truncate text-sm font-bold tabular-nums text-cocoa-800">
                {formatPeso(totalCents)}
              </span>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          {chartGroups.length === 0 ? (
            <p className="rounded-xl bg-cream-50 px-3 py-4 text-center text-sm text-cocoa-400">
              No priced items in this date range.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-cocoa-400">
                Select a chart slice or item
              </p>
              <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {chartGroups.map((group, index) => (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => selectSlice(group.key)}
                    aria-pressed={activeKey === group.key}
                    className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors ${
                      activeKey === group.key ? "bg-cream-100" : "hover:bg-cream-50"
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: MONEY_COLORS[index % MONEY_COLORS.length] }}
                    />
                    <span className="min-w-0 flex-1 truncate text-cocoa-700">{group.name}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-cocoa-800">
                      {formatPeso(group.valueCents)}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {activeGroup && (
        <div className="mx-4 mb-4 rounded-xl border border-cream-200 bg-cream-50/70 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="truncate text-sm font-semibold text-cocoa-800">{activeGroup.name}</h3>
            <span className="shrink-0 text-sm font-bold tabular-nums text-cocoa-800">
              {formatPeso(activeGroup.valueCents)}
            </span>
          </div>
          <div className="space-y-1.5">
            {activeGroup.items.map((item) => (
              <div
                key={item.sku}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-cream-200/80 pt-1.5 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-cocoa-700">
                  {item.name} <span className="text-cocoa-400">({item.sku})</span>
                </span>
                <span className="shrink-0 tabular-nums text-cocoa-500">
                  {item.quantity.toLocaleString("en-PH")} × {formatPeso(Math.round(item.unitPrice * 100))}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-cocoa-800">
                  {formatPeso(item.valueCents)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
    </ReportReveal>
  );
}

function MovementActivityDonut({ movement }: { movement: MovementSummary[] }) {
  const [selectedType, setSelectedType] = useState("checkout");
  const orderedTypes = ["checkout", "restock", "waste"];
  const rows = orderedTypes
    .map((type) => movement.find((entry) => entry.type === type))
    .filter((entry): entry is MovementSummary => Boolean(entry));
  const total = rows.reduce((sum, entry) => sum + entry.count, 0);
  const { displayValue: animatedTotal, ref: animatedTotalRef } =
    useAnimatedReportValue<SVGTextElement>(total);
  const selected = rows.find((entry) => entry.type === selectedType) ?? rows[0];
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <ReportReveal>
    <Card className="!p-0">
      <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
        <h2 className="text-sm font-bold text-cocoa-800">Transaction activity</h2>
        <p className="mt-1 text-xs text-cocoa-400">
          A breakdown of {total.toLocaleString("en-PH")} recorded movements
        </p>
      </div>
      <div className="flex flex-col items-center gap-4 p-4 sm:flex-row sm:justify-center">
        <svg
          viewBox="0 0 100 100"
          className="h-36 w-36 shrink-0"
          role="img"
          aria-label={`Donut chart showing ${total} movements`}
        >
          <circle cx="50" cy="50" r={radius} fill="none" stroke="#efe7dc" strokeWidth="10" />
          {rows.map((entry, index) => {
            const length = total > 0 ? (entry.count / total) * circumference : 0;
            const circle = (
              <circle
                key={entry.type}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={MOVEMENT_COLORS[entry.type] ?? "#8d6040"}
                strokeWidth={entry.type === selected?.type ? 12 : 10}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 50 50)"
                className="report-donut-slice"
                style={{ animationDelay: `${index * 90}ms` }}
              />
            );
            offset += length;
            return circle;
          })}
          <text ref={animatedTotalRef} x="50" y="47" textAnchor="middle" fill="#3d2b1f" fontSize="16" fontWeight="700">
            {Math.round(animatedTotal).toLocaleString("en-PH")}
          </text>
          <text x="50" y="58" textAnchor="middle" fill="#927f6e" fontSize="5">
            movements
          </text>
        </svg>
        <div className="w-full max-w-xs space-y-1">
          {rows.map((entry) => (
            <button
              key={entry.type}
              type="button"
              onClick={() => setSelectedType(entry.type)}
              aria-pressed={selected?.type === entry.type}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs ${
                selected?.type === entry.type ? "bg-cream-100" : "hover:bg-cream-50"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: MOVEMENT_COLORS[entry.type] ?? "#8d6040" }}
                />
                <span className="truncate text-cocoa-600">
                  {MOVEMENT_LABEL[entry.type] ?? entry.type}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block font-semibold tabular-nums text-cocoa-800">
                  {entry.count.toLocaleString("en-PH")}
                </span>
                <span className="text-[10px] text-cocoa-400">
                  {total ? `${((entry.count / total) * 100).toFixed(1)}%` : "0%"}
                </span>
              </span>
            </button>
          ))}
          {selected && (
            <p className="border-t border-cream-200 px-2.5 pt-2 text-[10px] text-cocoa-400">
              {MOVEMENT_LABEL[selected.type] ?? selected.type}: {fmtQty(selected.qty)} units
            </p>
          )}
        </div>
      </div>
    </Card>
    </ReportReveal>
  );
}

export default function ReportsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transactionNotesAvailable, setTransactionNotesAvailable] = useState(true);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const [reportPreviewOpen, setReportPreviewOpen] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [priceEditorOpen, setPriceEditorOpen] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailSending, setEmailSending] = useState(false);

  const loadSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);

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
  const [range, setRange] = useState<RangeKey>("week");
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [staff, setStaff] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [availableStaff, setAvailableStaff] = useState<{ id: string; name: string }[]>([]);

  const rangeParams = useMemo(() => {
    if (range === "custom") {
      return { from: fromDay, to: toDay };
    }
    const today = new Date();
    const to = localDayKey(today);
    if (range === "today") return { from: to, to };
    if (range === "week") {
      const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      return { from: localDayKey(monday), to };
    }
    if (range === "year") return { from: `${today.getFullYear()}-01-01`, to };
    return { from: fromDay, to: toDay };
  }, [range, fromDay, toDay]);

  async function load() {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const requestId = ++loadSequence.current;

    try {
      const loadAllTransactions = async () => {
        const all: Txn[] = [];
        let offset = 0;
        let notesAvailable = true;

        while (true) {
          const qs = new URLSearchParams({
            limit: String(TRANSACTION_PAGE_SIZE),
            offset: String(offset),
          });
          if (rangeParams.from) qs.set("from", rangeParams.from);
          if (rangeParams.to) qs.set("to", rangeParams.to);
          if (staff) qs.set("staff", staff);
          if (typeFilter) qs.set("type", typeFilter);

          const response = await fetch(`/api/transactions?${qs}`, {
            signal: controller.signal,
          });
          const data = await response.json();
          if (!response.ok || data.error) {
            throw new Error(data.error || "Could not load report transactions");
          }

          const page: Txn[] = data.transactions ?? [];
          if (data.transactionNotesAvailable === false) notesAvailable = false;
          all.push(...page);
          if (page.length < TRANSACTION_PAGE_SIZE) {
            return { transactions: all, notesAvailable };
          }
          offset += page.length;
        }
      };

      const [i, transactionRows, c] = await Promise.all([
        fetch("/api/items", { signal: controller.signal }).then((r) => r.json()),
        loadAllTransactions(),
        // Advisory: the report still works if the reference list fails.
        fetch("/api/refs/categories", { signal: controller.signal })
          .then((r) => r.json())
          .catch(() => ({ items: [] })),
      ]);
      if (requestId !== loadSequence.current) return;
      setCategories(c.items ?? []);
      if (i.error) throw new Error(i.error);

      setItems(i.items ?? []);
      setTxns(transactionRows.transactions);
      setTransactionNotesAvailable(transactionRows.notesAvailable);
      if (!staff) {
        const staffById = new Map<string, string>();
        for (const transaction of transactionRows.transactions) {
          if (transaction.actor_id && transaction.actor_name?.trim()) {
            staffById.set(transaction.actor_id, transaction.actor_name);
          }
        }
        setAvailableStaff(
          [...staffById].map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
      }

      // Advisory only: a failure here must not take the whole report down.
      fetch("/api/settings")
        .then((r) => r.json())
        .then((s) => {
          if (s?.settings?.business_name) setBusinessName(s.settings.business_name);
        })
        .catch(() => {});

      setError(null);
    } catch (e) {
      if (requestId !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : "Could not build the report");
    } finally {
      if (requestId === loadSequence.current) {
        loadController.current = null;
        setLoading(false);
      }
    }
  }

  // Reload whenever a filter changes. `load` is stable enough for this page and
  // the eslint rule is off throughout the codebase, matching the other pages.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeParams.from, rangeParams.to, staff, typeFilter]);
  const pullToRefresh = usePullToRefresh(load);

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

  const staffOptions = useMemo(() => {
    const optionsById = new Map(availableStaff.map((option) => [option.id, option]));
    for (const transaction of txns) {
      if (transaction.actor_id && transaction.actor_name?.trim()) {
        optionsById.set(transaction.actor_id, {
          id: transaction.actor_id,
          name: transaction.actor_name,
        });
      }
    }
    return [...optionsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [availableStaff, txns]);
  const selectedStaffName = staffOptions.find((option) => option.id === staff)?.name;

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
    const tally = new Map<string, { name: string; qty: number; events: number }>();
    for (const t of filteredTransactions) {
      if (t.type !== "checkout") continue;
      for (const li of t.transaction_items ?? []) {
        const cur = tally.get(li.sku) ?? {
          name: li.item_name,
          qty: 0,
          events: 0,
        };
        cur.qty += Number(li.quantity);
        cur.events += 1;
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
    const tally = new Map<string, { quantity: number; events: number }>();
    for (const t of filteredTransactions) {
      if (t.type !== "waste") continue;
      for (const li of t.transaction_items ?? []) {
        const item = itemsBySku.get(li.sku);
        const cat = item?.category?.name ?? "Uncategorized";
        const current = tally.get(cat) ?? { quantity: 0, events: 0 };
        current.quantity += Number(li.quantity);
        current.events += 1;
        tally.set(cat, current);
      }
    }
    return [...tally.entries()]
      .map(([name, totals]) => ({ name, ...totals }))
      .sort((a, b) => b.events - a.events);
  }, [filteredTransactions, itemsBySku]);

  const financialSummary = useMemo(() => {
    const revenue = new Map<string, FinancialItem>();
    const loss = new Map<string, FinancialItem>();
    const unpricedRevenueSkus = new Set<string>();
    const unpricedLossSkus = new Set<string>();
    let unpricedRevenueLines = 0;
    let unpricedLossLines = 0;

    for (const transaction of filteredTransactions) {
      const target =
        transaction.type === "checkout"
          ? revenue
          : transaction.type === "waste"
            ? loss
            : null;
      if (!target) continue;

      for (const line of transaction.transaction_items ?? []) {
        const quantity = Number(line.quantity);
        const item = itemsBySku.get(line.sku);
        if (!Number.isFinite(quantity) || quantity <= 0) continue;
        if (item?.unit_price == null || !Number.isFinite(Number(item.unit_price))) {
          if (transaction.type === "checkout") {
            unpricedRevenueLines += 1;
            unpricedRevenueSkus.add(line.sku);
          } else {
            unpricedLossLines += 1;
            unpricedLossSkus.add(line.sku);
          }
          continue;
        }

        const unitPrice = Number(item.unit_price);
        const current = target.get(line.sku) ?? {
          sku: line.sku,
          name: line.item_name,
          quantity: 0,
          unitPrice,
          valueCents: 0,
          events: 0,
        };
        current.quantity += quantity;
        current.valueCents += Math.round(quantity * unitPrice * 100);
        current.events += 1;
        target.set(line.sku, current);
      }
    }

    const toSortedItems = (values: Map<string, FinancialItem>) =>
      [...values.values()].sort((a, b) => b.valueCents - a.valueCents);
    const revenueItems = toSortedItems(revenue);
    const lossItems = toSortedItems(loss);
    return {
      revenueItems,
      lossItems,
      revenueCents: revenueItems.reduce((sum, item) => sum + item.valueCents, 0),
      lossCents: lossItems.reduce((sum, item) => sum + item.valueCents, 0),
      unpricedRevenueLines,
      unpricedLossLines,
      unpricedRevenueItems: unpricedRevenueSkus.size,
      unpricedLossItems: unpricedLossSkus.size,
    };
  }, [filteredTransactions, itemsBySku]);

  const chartAnalytics = useMemo(() => {
    const trendTotals = new Map<string, { revenueCents: number; lossCents: number }>();
    const pricedTransactions: { type: "checkout" | "waste"; valueCents: number }[] = [];
    const itemEvents = new Map<
      string,
      { name: string; checkoutEvents: number; wasteEvents: number }
    >();
    const datedTransactions: { transaction: Txn; date: Date }[] = [];

    for (const transaction of filteredTransactions) {
      const date = new Date(transaction.created_at);
      if (Number.isNaN(date.getTime())) continue;
      datedTransactions.push({ transaction, date });
      if (transaction.type !== "checkout" && transaction.type !== "waste") continue;

      let transactionValueCents = 0;
      const seenItems = new Set<string>();
      for (const line of transaction.transaction_items ?? []) {
        const quantity = Number(line.quantity);
        const item = itemsBySku.get(line.sku);
        const current = itemEvents.get(line.sku) ?? {
          name: line.item_name,
          checkoutEvents: 0,
          wasteEvents: 0,
        };
        if (
          Number.isFinite(quantity) &&
          quantity > 0 &&
          !seenItems.has(line.sku)
        ) {
          if (transaction.type === "checkout") current.checkoutEvents += 1;
          else current.wasteEvents += 1;
          seenItems.add(line.sku);
        }
        itemEvents.set(line.sku, current);
        if (
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          item?.unit_price == null ||
          !Number.isFinite(Number(item.unit_price))
        ) {
          continue;
        }
        transactionValueCents += Math.round(quantity * Number(item.unit_price) * 100);
      }

      if (transactionValueCents > 0) {
        pricedTransactions.push({
          type: transaction.type,
          valueCents: transactionValueCents,
        });
      }
    }

    const toDate = (day: string) => {
      const [year, month, date] = day.split("-").map(Number);
      return new Date(year, month - 1, date);
    };
    const datedTransactionsByTime = [...datedTransactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );
    const observedStart = datedTransactionsByTime[0]?.date;
    const observedEnd = datedTransactionsByTime.at(-1)?.date;
    const startDate = rangeParams.from ? toDate(rangeParams.from) : observedStart;
    const endDate = rangeParams.to ? toDate(rangeParams.to) : observedEnd;

    let trendPoints: TrendPoint[] = [];
    let periodLabel = "date";
    if (startDate && endDate && startDate <= endDate) {
      const daySpan = Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000);
      const granularity = daySpan <= 31 ? "day" : daySpan <= 180 ? "week" : "month";
      periodLabel =
        granularity === "day" ? "daily" : granularity === "week" ? "weekly" : "monthly";

      const bucketFor = (date: Date) => {
        const bucketDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        if (granularity === "week") {
          bucketDate.setDate(bucketDate.getDate() - ((bucketDate.getDay() + 6) % 7));
        } else if (granularity === "month") {
          bucketDate.setDate(1);
        }
        const key = localDayKey(bucketDate);
        const label =
          granularity === "month"
            ? bucketDate.toLocaleDateString("en-PH", { month: "short", year: "2-digit" })
            : bucketDate.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
        return { key, label, date: bucketDate };
      };

      const startBucket = bucketFor(startDate);
      const endBucket = bucketFor(endDate);
      const totalsByKey = new Map<string, { revenueCents: number; lossCents: number }>();
      for (const { transaction, date } of datedTransactions) {
        if (transaction.type !== "checkout" && transaction.type !== "waste") continue;
        const bucket = bucketFor(date);
        const total = totalsByKey.get(bucket.key) ?? { revenueCents: 0, lossCents: 0 };
        for (const line of transaction.transaction_items ?? []) {
          const item = itemsBySku.get(line.sku);
          const quantity = Number(line.quantity);
          if (
            !Number.isFinite(quantity) ||
            quantity <= 0 ||
            item?.unit_price == null ||
            !Number.isFinite(Number(item.unit_price))
          ) {
            continue;
          }
          const cents = Math.round(quantity * Number(item.unit_price) * 100);
          if (transaction.type === "checkout") total.revenueCents += cents;
          else total.lossCents += cents;
        }
        totalsByKey.set(bucket.key, total);
      }

      const points: TrendPoint[] = [];
      const cursor = startBucket.date;
      for (let guard = 0; guard < 2400; guard += 1) {
        const bucket = bucketFor(cursor);
        const totals = totalsByKey.get(bucket.key) ?? { revenueCents: 0, lossCents: 0 };
        points.push({ key: bucket.key, label: bucket.label, ...totals });
        if (bucket.key === endBucket.key) break;
        if (granularity === "day") cursor.setDate(cursor.getDate() + 1);
        else if (granularity === "week") cursor.setDate(cursor.getDate() + 7);
        else cursor.setMonth(cursor.getMonth() + 1);
      }
      trendPoints = points;
    }

    const maxTransactionCents = Math.max(
      ...pricedTransactions.map((transaction) => transaction.valueCents),
      0
    );
    const bins: HistogramBin[] = [];
    if (maxTransactionCents > 0) {
      const step = Math.max(1, Math.ceil(maxTransactionCents / 5));
      for (let index = 0; index < 5; index += 1) {
        const minCents = index * step;
        const maxCents =
          index === 4 ? maxTransactionCents : Math.min((index + 1) * step, maxTransactionCents);
        bins.push({
          minCents,
          maxCents,
          label: `${new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 }).format(minCents / 100)}–${new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 }).format(maxCents / 100)}`,
          checkoutCount: 0,
          wasteCount: 0,
        });
      }
      for (const transaction of pricedTransactions) {
        const index = Math.min(
          Math.floor(transaction.valueCents / step),
          bins.length - 1
        );
        if (transaction.type === "checkout") bins[index].checkoutCount += 1;
        else bins[index].wasteCount += 1;
      }
    }

    const scatterPoints = [...itemEvents.entries()]
      .map(([sku, item]) => ({ sku, ...item }))
      .filter((item) => item.checkoutEvents > 0 || item.wasteEvents > 0)
      .sort(
        (a, b) =>
          b.checkoutEvents + b.wasteEvents - (a.checkoutEvents + a.wasteEvents)
      );

    return { trendPoints, periodLabel, bins, scatterPoints };
  }, [filteredTransactions, itemsBySku, rangeParams.from, rangeParams.to]);

  const filterDescription = useMemo(
    () =>
      [
        rangeParams.from || rangeParams.to
          ? `Dates: ${rangeParams.from || "beginning"} to ${rangeParams.to || "today"}`
          : "All dates",
        selectedStaffName ? `Staff: ${selectedStaffName}` : null,
        typeFilter ? `Movement: ${MOVEMENT_LABEL[typeFilter] ?? typeFilter}` : null,
        catFilter
          ? `Category: ${categories.find((category) => category.id === catFilter)?.name ?? "selected category"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    [rangeParams.from, rangeParams.to, selectedStaffName, typeFilter, catFilter, categories]
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
            Note: [transaction.note, line.note].filter(Boolean).join("\n"),
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
      setReportPreviewOpen(false);
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
        body: JSON.stringify({
          to: emailTo.trim(),
          filters: {
            from: rangeParams.from,
            to: rangeParams.to,
            staff,
            type: typeFilter,
            category_id: catFilter,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not send the report");
      setToast({ msg: `PDF report queued for ${emailTo.trim()}`, tone: "success" });
      setEmailModalOpen(false);
      setReportPreviewOpen(false);
      setEmailTo("");
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setEmailSending(false);
    }
  }

  function applySavedPrice(updatedItem: Item) {
    setItems((current) =>
      current.map((item) => item.id === updatedItem.id ? { ...item, unit_price: updatedItem.unit_price } : item)
    );
  }

  function finishPriceSave(savedCount: number, pendingCount: number) {
    if (pendingCount > 0) {
      setToast({
        msg: `${pendingCount} price ${pendingCount === 1 ? "change was" : "changes were"} sent for admin approval${savedCount ? `; ${savedCount} ${savedCount === 1 ? "price was" : "prices were"} updated` : ""}.`,
        tone: "info",
      });
    } else {
      setToast({
        msg: `Updated ${savedCount} item ${savedCount === 1 ? "price" : "prices"}. Report insights are recalculated.`,
        tone: "success",
      });
    }
  }

  const priceEditor = (
    <ItemPriceEditor
      open={priceEditorOpen}
      items={items}
      onClose={() => setPriceEditorOpen(false)}
      onItemSaved={applySavedPrice}
      onComplete={finishPriceSave}
    />
  );

  const movementPeriodLabel =
    range === "custom"
      ? "custom dates"
      : RANGE_OPTIONS.find((option) => option.key === range)?.label.toLowerCase() ?? "selected range";
  const reportMetrics: ReportMetric[] = [
    {
      label: "Items Tracked",
      value: shownItems.length,
      hint: "Across your inventory",
      icon: "items",
      tone: "sage",
    },
    {
      label: "Low Stock",
      value: low.length,
      hint: "Below reorder threshold",
      icon: "low",
      tone: "ochre",
    },
    {
      label: "Out of Stock",
      value: out.length,
      hint: "Replenishment needed",
      icon: "out",
      tone: "terracotta",
    },
    {
      label: "Movements",
      value: filteredTransactions.length,
      hint: `Recorded transactions · ${movementPeriodLabel}`,
      icon: "movements",
      tone: "cocoa",
    },
  ];

  if (!reportPreviewOpen) {
    return (
      <div className="space-y-5" data-pull-to-refresh {...pullToRefresh.handlers}>
        {pullToRefresh.indicator}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cocoa-400">
              {businessName} / Management workspace
            </p>
            <h1 className="deco-title mt-1 text-3xl">Analytics &amp; Stock Report</h1>
            <p className="mt-1 text-sm text-cocoa-400">
              A clear view of your stock, movements, and expiry operations.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost hidden lg:inline-flex" onClick={load} disabled={loading}>
              {loading ? "Refreshing..." : "Reload"}
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                setReportPreviewOpen(true);
                setEmailModalOpen(false);
                setExportError(null);
              }}
              disabled={items.length === 0 || loading}
            >
              Export Report
            </button>
          </div>
        </div>

        <Card>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <label className="label" htmlFor="f-range">Date range</label>
              <select
                id="f-range"
                className="input w-full"
                value={range}
                onChange={(event) => setRange(event.target.value as RangeKey)}
              >
                {RANGE_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </div>
            {range === "custom" && (
              <>
                <div>
                  <label className="label" htmlFor="f-from">From</label>
                  <input
                    id="f-from"
                    type="date"
                    className="input w-full"
                    value={fromDay}
                    max={toDay || undefined}
                    onChange={(event) => setFromDay(event.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="f-to">To</label>
                  <input
                    id="f-to"
                    type="date"
                    className="input w-full"
                    value={toDay}
                    min={fromDay || undefined}
                    onChange={(event) => setToDay(event.target.value)}
                  />
                </div>
              </>
            )}
            <div>
              <label className="label" htmlFor="f-type">Movement</label>
              <select
                id="f-type"
                className="input w-full"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
              >
                <option value="">All movements</option>
                <option value="checkout">Checked out</option>
                <option value="restock">Restocked</option>
                <option value="waste">Waste</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-staff">Staff</label>
              <select
                id="f-staff"
                className="input w-full"
                value={staff}
                onChange={(event) => setStaff(event.target.value)}
              >
                <option value="">All staff</option>
                {staffOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="f-cat">Category</label>
              <select
                id="f-cat"
                className="input w-full"
                value={catFilter}
                onChange={(event) => setCatFilter(event.target.value)}
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </div>
            {(rangeParams.from || rangeParams.to || staff || typeFilter || catFilter) && (
              <div className="flex items-end">
                <button
                  type="button"
                  className="btn-ghost w-full"
                  onClick={() => {
                    setRange("week");
                    setFromDay("");
                    setToDay("");
                    setStaff("");
                    setTypeFilter("");
                    setCatFilter("");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>
        </Card>

        {error && (
          <div role="alert" className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
            {error}
          </div>
        )}
        {!transactionNotesAvailable && (
          <div className="rounded-xl bg-ochre-50 px-3.5 py-2.5 text-sm text-ochre-700">
            {TRANSACTION_NOTE_SCHEMA_WARNING}
          </div>
        )}
        {exportError && (
          <div role="alert" className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
            {exportError}
          </div>
        )}

        {loading ? <Spinner /> : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {reportMetrics.map((metric) => (
                <ReportMetricCard key={metric.label} metric={metric} />
              ))}
            </div>

            <div className="grid gap-3 xl:grid-cols-2">
              <ReportPriceInsight
                title="Total Revenue"
                cents={financialSummary.revenueCents}
                missingLines={financialSummary.unpricedRevenueLines}
                missingItems={financialSummary.unpricedRevenueItems}
                kind="revenue"
                onAddPrices={() => setPriceEditorOpen(true)}
              />
              <ReportPriceInsight
                title="Total Waste Cost"
                cents={financialSummary.lossCents}
                missingLines={financialSummary.unpricedLossLines}
                missingItems={financialSummary.unpricedLossItems}
                kind="waste"
                onAddPrices={() => setPriceEditorOpen(true)}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-[1.55fr_1fr]">
              <LineTrendChart
                points={chartAnalytics.trendPoints}
                periodLabel={chartAnalytics.periodLabel}
                unpricedLines={
                  financialSummary.unpricedRevenueLines + financialSummary.unpricedLossLines
                }
              />
              <MovementActivityDonut movement={movement} />
            </div>

            <SoonestExpiries items={soonestExpiry} />

            <Card className="!p-0">
              <div className="flex items-center justify-between border-b border-cream-200 bg-cream-50 px-4 py-3">
                <div>
                  <h2 className="text-sm font-bold text-cocoa-800">On hand by item</h2>
                  <p className="mt-1 text-xs text-cocoa-400">
                    Complete inventory · quantities, reorder thresholds, and stock status
                  </p>
                </div>
                <span className="text-[11px] text-cocoa-400">{shownItems.length} items</span>
              </div>
              {shownItems.length === 0 ? (
                <Empty>{items.length === 0 ? "No items yet." : "No items in this category."}</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px]">
                    <thead>
                      <tr className="bg-cream-100/60">
                        <th className="th">SKU</th>
                        <th className="th">Item</th>
                        <th className="th">Category</th>
                        <th className="th">Location</th>
                        <th className="th text-right">On hand</th>
                        <th className="th text-right">Threshold</th>
                        <th className="th">Expiry</th>
                        <th className="th">Stock status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownItems.map((item) => {
                        const status = stockStatus(item.quantity, item.low_stock_threshold);
                        const days = daysUntil(item.expiration_date);
                        return (
                          <tr key={item.id}>
                            <td className="td font-mono text-[10px]">{item.sku}</td>
                            <td className="td font-medium text-cocoa-800">{item.name}</td>
                            <td className="td">{item.category?.name ?? "Uncategorized"}</td>
                            <td className="td">{item.location?.name ?? "—"}</td>
                            <td className="td text-right">{fmtQty(item.quantity, item.unit)}</td>
                            <td className="td text-right">{fmtQty(item.low_stock_threshold, item.unit)}</td>
                            <td className="td whitespace-nowrap">
                              {item.expiration_date ? fmtDate(item.expiration_date) : "—"}
                              {days !== null && days < 0 && (
                                <span className="ml-1 text-terracotta-700">Expired</span>
                              )}
                            </td>
                            <td className="td"><Badge tone={status.tone} variant="tag">{status.label}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="border-t border-cream-200 bg-cream-50 px-4 py-2 text-[10px] text-cocoa-400">
                Stock status reflects quantity only. Review expired items before use.
              </p>
            </Card>

            <div className="grid gap-4 md:grid-cols-2">
              <QuantityBarChart
                title="Most wasted items"
                description="Ranked by recorded waste quantity · mixed units"
                entries={wasteByItem.map((item) => ({
                  key: item.sku,
                  name: item.name,
                  quantity: item.qty,
                  quantityLabel: fmtQty(item.qty, itemsBySku.get(item.sku)?.unit),
                  detail: `SKU ${item.sku}`,
                  events: item.count,
                }))}
                emptyMessage="No waste activity in this report."
                color="#8b3a24"
              />
              <ActivityScatterPlot
                points={chartAnalytics.scatterPoints}
                periodLabel={movementPeriodLabel}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-cream-200 pt-3 text-[11px] text-cocoa-400">
              <span>{filterDescription}</span>
              <span>Stock status reflects quantity only · {businessName}</span>
            </div>
          </>
        )}
        <Toast
          message={toast?.msg ?? null}
          tone={toast?.tone}
          onDone={() => setToast(null)}
        />
        {priceEditor}
      </div>
    );
  }

  return (
    <div className="space-y-5" data-pull-to-refresh {...pullToRefresh.handlers}>
      {pullToRefresh.indicator}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Analytics &amp; Stock Report</h1>
          <p className="mt-1 text-sm text-cocoa-400">
            Track checkout value and waste cost over any date range.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost hidden lg:inline-flex" onClick={load}>
            Reload
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              setReportPreviewOpen(true);
              setEmailModalOpen(false);
              setExportError(null);
            }}
            disabled={items.length === 0 || loading}
          >
            Export Report
          </button>
          <button
            className="btn-ghost"
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
              {staffOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
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
                setRange("week");
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
      {!transactionNotesAvailable && (
        <div className="rounded-xl bg-ochre-50 px-3.5 py-2.5 text-sm text-ochre-700">
          {TRANSACTION_NOTE_SCHEMA_WARNING}
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
          <section aria-labelledby="financial-summary-title" className="space-y-3">
            <div>
              <h2 id="financial-summary-title" className="text-base font-bold text-cocoa-800">
                Revenue and loss
              </h2>
              <p className="mt-1 text-xs text-cocoa-400">
                These estimates use each item&apos;s current Unit Price (stored as cost per
                unit) for the selected date range; they are not historical sales receipts.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Stat
                label="Total revenue (estimate)"
                value={formatPeso(financialSummary.revenueCents)}
                hint="Checked-out quantity × current Unit Price"
                tone="good"
              />
              <Stat
                label="Total lost (waste cost)"
                value={formatPeso(financialSummary.lossCents)}
                hint="Wasted quantity × current Unit Price"
                tone="danger"
              />
            </div>
            {(financialSummary.unpricedRevenueLines > 0 ||
              financialSummary.unpricedLossLines > 0) && (
              <p className="rounded-xl bg-ochre-50 px-3.5 py-2.5 text-xs text-ochre-700">
                Estimates exclude movements for items without a Unit Price
                {financialSummary.unpricedRevenueLines > 0
                  ? ` (${financialSummary.unpricedRevenueLines} checkout lines)`
                  : ""}
                {financialSummary.unpricedLossLines > 0
                  ? ` (${financialSummary.unpricedLossLines} waste lines)`
                  : ""}
                .
              </p>
            )}
            <div className="grid gap-4 xl:grid-cols-2">
              <FinancialBreakdown
                title="Revenue by item"
                description="Checkout value by item. Select a slice to inspect its quantity and value."
                entries={financialSummary.revenueItems}
                totalCents={financialSummary.revenueCents}
              />
              <FinancialBreakdown
                title="Lost value by item"
                description="Waste cost by item. Select a slice to inspect its quantity and value."
                entries={financialSummary.lossItems}
                totalCents={financialSummary.lossCents}
              />
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <LineTrendChart
                points={chartAnalytics.trendPoints}
                periodLabel={chartAnalytics.periodLabel}
                unpricedLines={
                  financialSummary.unpricedRevenueLines + financialSummary.unpricedLossLines
                }
              />
              <TransactionHistogram bins={chartAnalytics.bins} />
            </div>
          </section>

          <div className="grid gap-5 lg:grid-cols-2">
            <MovementChart
              movement={movement}
              transactions={filteredTransactions}
            />

            <QuantityBarChart
              title="Most checked out"
              description="Top items by quantity checked out in this report."
              entries={topMovers.map((item) => ({
                key: item.sku,
                name: item.name,
                quantity: item.qty,
                quantityLabel: fmtQty(item.qty, itemsBySku.get(item.sku)?.unit),
                detail: `SKU ${item.sku}`,
                events: item.events,
              }))}
              emptyMessage="No checkout activity yet."
              color="#8d6040"
            />
          </div>

          <ActivityScatterPlot
            points={chartAnalytics.scatterPoints}
            periodLabel={movementPeriodLabel}
          />

          <SoonestExpiries items={soonestExpiry} />

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
            <div className="space-y-4">
              <Card className="!p-0">
                <div className="border-b border-cream-200 bg-cream-50 px-4 py-2.5">
                  <h2 className="text-sm font-bold text-cocoa-800">Waste Summary</h2>
                </div>
                <div className="grid grid-cols-2 gap-3 p-4">
                  <Stat label="Total Waste" value={fmtQty(wasteTotal)} tone="danger" />
                  <Stat label="Waste Events" value={wasteCount} tone="warn" />
                </div>
              </Card>
              <QuantityBarChart
                title="Waste events by category"
                description="Number of waste item entries by category. Select a category to see its total quantity."
                entries={wasteByCategory.map((category) => ({
                  key: category.name,
                  name: category.name,
                  quantity: category.events,
                  quantityLabel: `${category.events} ${category.events === 1 ? "entry" : "entries"}`,
                  detail: `Total quantity: ${fmtQty(category.quantity)}`,
                  events: category.events,
                }))}
                emptyMessage="No waste recorded yet."
                color="#bd8c53"
              />
            </div>
            <QuantityBarChart
              title="Most wasted items"
              description="Top items by quantity wasted. Select an item to see its SKU and event count."
              entries={wasteByItem.map((item) => ({
                key: item.sku,
                name: item.name,
                quantity: item.qty,
                quantityLabel: fmtQty(item.qty, itemsBySku.get(item.sku)?.unit),
                detail: `SKU ${item.sku}`,
                events: item.count,
              }))}
              emptyMessage="No waste recorded yet."
              color="#8b3a24"
            />
          </div>
        </>
      )}

      {reportPreviewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !emailSending) {
              setReportPreviewOpen(false);
              setEmailModalOpen(false);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-preview-title"
            className="flex max-h-[96vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
          >
            <header className="flex items-center justify-between gap-4 border-b border-cream-200 px-4 py-3 sm:px-6">
              <div>
                <h2 id="report-preview-title" className="text-lg font-bold text-cocoa-800">
                  Export report
                </h2>
                <p className="text-xs text-cocoa-400">
                  Preview of the current filtered stock dashboard
                </p>
              </div>
              <button
                type="button"
                className="btn-ghost"
                aria-label="Close report preview"
                onClick={() => {
                  setReportPreviewOpen(false);
                  setEmailModalOpen(false);
                }}
                disabled={emailSending || exportingPdf}
              >
                Close
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f3ed] p-3 sm:p-5">
              <div className="mx-auto max-w-6xl space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3 text-cocoa-800">
                  <div>
                    <p className="text-xs text-cocoa-500">{businessName} / Management workspace / Stock Report</p>
                    <h3 className="mt-2 text-xl font-bold">Analytics &amp; Stock Report</h3>
                    <p className="mt-1 text-xs text-cocoa-500">{filterDescription}</p>
                  </div>
                  <p className="text-[11px] text-cocoa-500">
                    Generated {new Date().toLocaleString("en-PH", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {[
                    {
                      label: "Date range",
                      value: range === "custom"
                        ? `${fromDay || "Start"} – ${toDay || "Today"}`
                        : RANGE_OPTIONS.find((option) => option.key === range)?.label ?? "This week",
                    },
                    {
                      label: "Movement",
                      value: typeFilter ? MOVEMENT_LABEL[typeFilter] ?? typeFilter : "All movements",
                    },
                    { label: "Staff", value: selectedStaffName ?? "All staff" },
                    {
                      label: "Category",
                      value: categories.find((category) => category.id === catFilter)?.name ?? "All categories",
                    },
                  ].map((filter) => (
                    <div key={filter.label} className="min-w-0 rounded-lg bg-white px-3 py-2.5">
                      <p className="text-[10px] text-cocoa-400">{filter.label}</p>
                      <p className="mt-0.5 truncate text-xs font-semibold text-cocoa-800">{filter.value}</p>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {reportMetrics.map((metric) => (
                    <ReportMetricCard key={metric.label} metric={metric} />
                  ))}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <ReportPriceInsight
                    title="Total Revenue"
                    cents={financialSummary.revenueCents}
                    missingLines={financialSummary.unpricedRevenueLines}
                    missingItems={financialSummary.unpricedRevenueItems}
                    kind="revenue"
                    onAddPrices={() => setPriceEditorOpen(true)}
                  />
                  <ReportPriceInsight
                    title="Total Waste Cost"
                    cents={financialSummary.lossCents}
                    missingLines={financialSummary.unpricedLossLines}
                    missingItems={financialSummary.unpricedLossItems}
                    kind="waste"
                    onAddPrices={() => setPriceEditorOpen(true)}
                  />
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  <LineTrendChart
                    points={chartAnalytics.trendPoints}
                    periodLabel={chartAnalytics.periodLabel}
                    unpricedLines={
                      financialSummary.unpricedRevenueLines + financialSummary.unpricedLossLines
                    }
                  />
                  <MovementActivityDonut movement={movement} />
                </div>

                <SoonestExpiries items={soonestExpiry} />

                <Card className="!p-0">
                  <div className="flex items-center justify-between border-b border-cream-200 bg-cream-50 px-4 py-3">
                    <div>
                      <h4 className="text-sm font-bold text-cocoa-800">On hand by item</h4>
                      <p className="mt-1 text-[11px] text-cocoa-400">Complete inventory · quantities, reorder thresholds, and stock status</p>
                    </div>
                    <span className="text-[11px] text-cocoa-400">{shownItems.length} items</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px]">
                      <thead>
                        <tr className="bg-cream-100/60">
                          <th className="th">SKU</th>
                          <th className="th">Item</th>
                          <th className="th">Category</th>
                          <th className="th">Location</th>
                          <th className="th text-right">On hand</th>
                          <th className="th text-right">Threshold</th>
                          <th className="th">Expiry</th>
                          <th className="th">Stock status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownItems.map((item) => {
                          const status = stockStatus(item.quantity, item.low_stock_threshold);
                          return (
                            <tr key={item.id}>
                              <td className="td font-mono text-[10px]">{item.sku}</td>
                              <td className="td font-medium text-cocoa-800">{item.name}</td>
                              <td className="td">{item.category?.name ?? "Uncategorized"}</td>
                              <td className="td">{item.location?.name ?? "—"}</td>
                              <td className="td text-right">{fmtQty(item.quantity, item.unit)}</td>
                              <td className="td text-right">{fmtQty(item.low_stock_threshold, item.unit)}</td>
                              <td className="td whitespace-nowrap">{item.expiration_date ? fmtDate(item.expiration_date) : "—"}</td>
                              <td className="td"><Badge tone={status.tone} variant="tag">{status.label}</Badge></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="border-t border-cream-200 bg-cream-50 px-4 py-2 text-[10px] text-cocoa-400">
                    Stock status reflects quantity only. Review expired items before use.
                  </p>
                </Card>

                <div className="grid gap-3 xl:grid-cols-2">
                  <QuantityBarChart
                    title="Most wasted items"
                    description="Ranked by recorded waste quantity · mixed units"
                    entries={wasteByItem.map((item) => ({
                      key: item.sku,
                      name: item.name,
                      quantity: item.qty,
                      quantityLabel: fmtQty(item.qty, itemsBySku.get(item.sku)?.unit),
                      detail: `SKU ${item.sku}`,
                      events: item.count,
                    }))}
                    emptyMessage="No waste activity in this report."
                    color="#8b3a24"
                  />
                  <ActivityScatterPlot
                    points={chartAnalytics.scatterPoints}
                    periodLabel={movementPeriodLabel}
                  />
                </div>
              </div>
            </div>

            <footer className="border-t border-cream-200 bg-white px-4 py-3 sm:px-6">
              {exportError && (
                <p role="alert" className="mb-3 rounded-lg bg-terracotta-50 px-3 py-2 text-sm text-terracotta-700">
                  {exportError}
                </p>
              )}
              {emailModalOpen && (
                <div className="mb-3 flex flex-wrap items-end gap-3 rounded-xl bg-cream-50 p-3">
                  <div className="min-w-[220px] flex-1">
                    <label className="label" htmlFor="email-to">Email address</label>
                    <input
                      id="email-to"
                      className="input w-full"
                      type="email"
                      placeholder="owner@example.com"
                      value={emailTo}
                      onChange={(event) => setEmailTo(event.target.value)}
                      autoFocus
                    />
                    <p className="mt-1 text-[11px] text-cocoa-400">
                      Sends this filtered report as a PDF attachment.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={sendEmailReport}
                    disabled={emailSending || !emailTo.trim()}
                  >
                    {emailSending ? "Sending..." : "Send PDF report"}
                  </button>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-cocoa-400">
                  {filterDescription} · {shownItems.length} items · {filteredTransactions.length} movements
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      setEmailModalOpen((open) => !open);
                      setEmailTo("");
                    }}
                    disabled={emailSending || exportingPdf}
                  >
                    Send to email
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={exportPdf}
                    disabled={exportingPdf || emailSending}
                  >
                    {exportingPdf ? "Preparing PDF..." : "Export PDF"}
                  </button>
                </div>
              </div>
            </footer>
          </section>
        </div>
      )}

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
      {priceEditor}
    </div>
  );
}
