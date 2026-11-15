"use client";

import {
  useEffect,
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
  useDialogFocusTrap,
} from "@/components/ui";
import { fmtQty, fmtDate, daysUntil, toCsv, formatPeso } from "@/lib/format";
import { stockStatus } from "@/lib/status";
import { TRANSACTION_NOTE_SCHEMA_WARNING } from "@/lib/transaction-note-schema";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";
import {
  localDayBoundsIso,
  resolvedTimeZone,
} from "@/lib/zoned-time";
import { InventoryValueTrendChart } from "@/components/charts/InventoryValueTrendChart";
import { StockMovementChart } from "@/components/charts/StockMovementChart";
import { ValueTrendChart } from "@/components/charts/ValueTrendChart";
import { TransactionHistogramChart } from "@/components/charts/TransactionHistogramChart";
import { StockByCategoryChart } from "@/components/charts/StockByCategoryChart";
import {
  StockStatusDonutChart,
} from "@/components/charts/StockStatusDonutChart";
import { TopItemsBarChart } from "@/components/charts/TopItemsBarChart";
import { ValueBreakdownChart } from "@/components/charts/ValueBreakdownChart";
import {
  TransactionActivityDonutChart,
  ACTIVITY_COLORS,
} from "@/components/charts/TransactionActivityDonutChart";
import { MovementActivityChart } from "@/components/charts/MovementActivityChart";
import { ActivityScatterChart } from "@/components/charts/ActivityScatterChart";
import { CHART_COLORS } from "@/components/charts/theme";
import type {
  MovementDatum,
  HistogramDatum,
  ValueTrendDatum,
  MoneySlice,
} from "@/components/charts/types";
import type { InventoryHistory } from "@/lib/inventory-history";
import type { Grouping } from "@/components/charts/bucketHistory";

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

type FinancialItem = {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  valueCents: number;
  events: number;
  /** True when the SKU no longer exists in the catalogue. */
  archived?: boolean;
};

/* Stock wording + tones come from @/lib/status so every page agrees. */

type ExpiryItem = Item & { days: number | null };

function localDayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Split a value list into at most seven slices plus "Other items".
 *
 * Seven named slices plus a remainder reads as a breakdown; a wheel of
 * thirty slices reads as a colour chart. The total is not affected, and the
 * remainder is a single honest slice rather than a rounding-away.
 */
function buildMoneySlices(entries: FinancialItem[]): MoneySlice[] {
  const sorted = entries.filter((entry) => entry.valueCents > 0);
  const leading = sorted.slice(0, 7);
  const other = sorted.slice(7);
  const asSliceName = (item: FinancialItem) =>
    item.archived ? `${item.name} (archived)` : item.name;
  const slices: MoneySlice[] = leading.map((item) => ({
    key: item.sku,
    name: asSliceName(item),
    valueCents: item.valueCents,
    items: [
      {
        sku: item.sku,
        name: asSliceName(item),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        valueCents: item.valueCents,
      },
    ],
  }));
  if (other.length > 0) {
    slices.push({
      key: "__other__",
      name: "Other items",
      valueCents: other.reduce((sum, item) => sum + item.valueCents, 0),
      items: other.map((item) => ({
        sku: item.sku,
        name: asSliceName(item),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        valueCents: item.valueCents,
      })),
    });
  }
  return slices;
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
  icon: "items" | "low" | "out" | "movements" | "value";
  tone: "sage" | "ochre" | "terracotta" | "cocoa";
  /** How to write `value`. `peso-cents` reads it as cents and prints ₱. */
  format?: "number" | "peso-cents";
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
          {metric.icon === "value" && (
            <>
              <rect x="3" y="5" width="18" height="15" rx="2" />
              <path d="M3 9h18" />
              <path d="M12 13v.01" />
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
        <AnimatedReportValue
          value={metric.value}
          format={metric.format ?? "number"}
          label={metric.label}
        />
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


function BadgeTone({ status }: { status: { tone: "slate" | "green" | "amber" | "red" | "blue"; label: string } }) {
  return <Badge tone={status.tone} variant="tag">{status.label}</Badge>;
}

type ReportsTab = "overview" | "inventory" | "movements" | "performance";
const REPORT_TABS: { id: ReportsTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "inventory", label: "Inventory" },
  { id: "movements", label: "Movements & Financials" },
  { id: "performance", label: "Item Performance" },
];
type OnHandSortKey =
  | "name"
  | "sku"
  | "category"
  | "location"
  | "quantity"
  | "threshold"
  | "expiry"
  | "status";

function OnHandSortHeader({
  label,
  sortKey,
  className,
  tableSort,
  onSort,
}: {
  label: string;
  sortKey: OnHandSortKey;
  className?: string;
  tableSort: { key: OnHandSortKey; dir: 1 | -1 };
  onSort: (key: OnHandSortKey) => void;
}) {
  const active = tableSort.key === sortKey;
  return (
    <th
      className={`th sticky top-0 z-10 border-b border-cream-200 bg-cream-100 ${className ?? ""}`}
      aria-sort={active ? (tableSort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 font-semibold"
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span aria-hidden="true" className={active ? "text-cocoa-700" : "text-cocoa-300"}>
          {active ? (tableSort.dir === 1 ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

export default function ReportsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [transactionsLoading, setTransactionsLoading] = useState(true);
  const loading = itemsLoading || transactionsLoading;
  const [inventoryHistory, setInventoryHistory] = useState<InventoryHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transactionNotesAvailable, setTransactionNotesAvailable] = useState(true);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const [reportPreviewOpen, setReportPreviewOpen] = useState(false);
  const [reportPreviewCompleteness, setReportPreviewCompleteness] = useState<{
    completeness: {
      items: "complete" | "truncated" | "unknown";
      movements: "complete" | "truncated" | "unknown";
      itemsScanned: number;
      movementsScanned: number;
      itemCap: number;
      movementCap: number;
    };
    warnings: string[];
  } | null>(null);
  const [reportPreviewCompletenessLoading, setReportPreviewCompletenessLoading] = useState(false);
  const [reportPreviewCompletenessError, setReportPreviewCompletenessError] = useState<string | null>(null);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [priceEditorOpen, setPriceEditorOpen] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailSending, setEmailSending] = useState(false);

  const loadSequence = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const historySequence = useRef(0);
  const historyController = useRef<AbortController | null>(null);
  const itemsSequence = useRef(0);
  const itemsController = useRef<AbortController | null>(null);
  const previewPanelRef = useRef<HTMLElement | null>(null);
  useDialogFocusTrap(previewPanelRef, reportPreviewOpen);
  const columnsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const columnsPanelRef = useRef<HTMLDivElement | null>(null);

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
  const [grouping, setGrouping] = useState<Grouping>("auto");
const [activeTab, setActiveTab] = useState<ReportsTab>("overview");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [tableQuery, setTableQuery] = useState("");
  const [tableSort, setTableSort] = useState<{ key: OnHandSortKey; dir: 1 | -1 }>({
    key: "name",
    dir: 1,
  });
  const [tablePage, setTablePage] = useState(1);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
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

  /*
   * The calendar-day filters mean local calendar days in the user's own
   * IANA zone — not UTC days, and not a fixed offset, which cannot describe
   * a 25-hour day across a DST shift. Every request that interprets those
   * days resolves the boundary per date in this zone:
   *
   *   transactions     — half-open instant bounds (from_at / before)
   *   inventory history — the `tz` parameter, bucketing in the same zone
   *   PDF / email       — the same `tz` in the export body
   */
  const rangeBounds = useMemo(() => {
    const zone = resolvedTimeZone();
    return {
      zone,
      fromAt: rangeParams.from
        ? localDayBoundsIso(rangeParams.from, zone)?.fromAt ?? null
        : null,
      before: rangeParams.to
        ? localDayBoundsIso(rangeParams.to, zone)?.before ?? null
        : null,
    };
  }, [rangeParams.from, rangeParams.to]);

  /* ---------- loading ----------
   * Three independent loads, so a filter change does not drag the whole
   * inventory back out of the database:
   *
   *   loadItems            — mount and manual reload only
   *   loadTransactions     — mount, and whenever a range / staff / movement filter changes
   *   loadInventoryHistory — mount, and whenever a range / category filter changes
   *
   * The history request is advisory — a failure disables that one chart, not
   * the report.
   */

  /**
   * Load the complete active catalogue, page by page.
   *
   * One `/api/items` call truncates at the API's default limit, so every
   * previous version of this page quietly computed the inventory report from
   * part of the catalogue. The loop pages with `limit=500` until the API
   * says there is no more, and refuses to render a partial catalogue as if it
   * were the full one:
   *
   *   - an empty page while `has_more` is true aborts;
   *   - inconsistent pagination metadata (wrong `returned`, an offset that
   *     does not advance, or `has_more` past the reported total) aborts;
   *   - a page cap bounds the loop even if the API were to contradict
   *     itself forever.
   *
   * On any inconsistency, or a failed page, the catalogue is emptied and the
   * error is shown — the KPIs, charts, expiries and the On-hand table all
   * read from `items`, so none of them can present a fraction as the whole.
   */
  const ITEM_PAGE_SIZE = 500;
  const MAX_ITEM_PAGES = 40;

  async function loadItems() {
    itemsController.current?.abort();
    const controller = new AbortController();
    itemsController.current = controller;
    const requestId = ++itemsSequence.current;
    setItemsLoading(true);
    try {
      const collected: Item[] = [];
      let offset = 0;
      let complete = false;
      let seenTotal: number | null = null;

      for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
        if (requestId !== itemsSequence.current) return;

        const response = await fetch(
          `/api/items?limit=${ITEM_PAGE_SIZE}&offset=${offset}`,
          { signal: controller.signal }
        );
        const data = await response.json().catch(() => ({}));
        if (requestId !== itemsSequence.current) return;
        if (!response.ok || data.error) {
          throw new Error(data.error || "Could not load the inventory");
        }

        const pageItems: Item[] = Array.isArray(data.items) ? data.items : [];
        const returned = Number(data.returned ?? pageItems.length);
        const respOffset = Number(data.offset);
        const respLimit = Number(data.limit);
        const total = Number(data.total);
        const hasMore = Boolean(data.has_more);

        // Strict metadata validation: never silently accept contradictory
        // pagination metadata.
        if (!Number.isFinite(returned) || returned !== pageItems.length) {
          throw new Error("The item catalogue response is inconsistent");
        }
        if (returned > ITEM_PAGE_SIZE) {
          throw new Error("The item catalogue response is inconsistent");
        }
        if (!Number.isFinite(respOffset) || respOffset !== offset) {
          throw new Error("The item catalogue response offset is incorrect");
        }
        if (!Number.isFinite(respLimit) || respLimit !== ITEM_PAGE_SIZE) {
          throw new Error("The item catalogue response limit is incorrect");
        }
        if (!Number.isFinite(total) || total < 0) {
          throw new Error("The item catalogue total is invalid");
        }
        if (offset + returned > total) {
          throw new Error("The item catalogue pagination metadata is inconsistent");
        }
        if (hasMore && offset + returned >= total) {
          throw new Error("The item catalogue pagination metadata is inconsistent");
        }
        if (!hasMore && offset + returned < total) {
          throw new Error("The item catalogue pagination metadata is inconsistent");
        }
        if (hasMore && pageItems.length === 0) {
          throw new Error("The item catalogue pagination stalled");
        }
        if (seenTotal !== null && total !== seenTotal) {
          throw new Error("The item catalogue pagination metadata is inconsistent");
        }
        if (seenTotal === null) seenTotal = total;

        const nextOffset = offset + returned;
        if (hasMore && !(nextOffset > offset)) {
          throw new Error("The item catalogue pagination did not advance");
        }

        collected.push(...pageItems);

        if (!hasMore) {
          complete = true;
          break;
        }
        offset = nextOffset;
      }

      if (requestId !== itemsSequence.current) return;
      if (!complete) {
        throw new Error("The item catalogue pagination exceeded the 40-page maximum");
      }
      setItems(collected);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      if (requestId !== itemsSequence.current) return;
      // Never render a partial catalogue as the full report.
      setItems([]);
      setError("Could not load the full item catalogue. The inventory report is shown empty rather than incomplete.");
    } finally {
      if (requestId === itemsSequence.current) {
        if (itemsController.current === controller) itemsController.current = null;
        setItemsLoading(false);
      }
    }
  }

  // Advisory reads — a failure here leaves sensible defaults, not an alert.
  function loadAdvisory() {
    fetch("/api/refs/categories")
      .then((r) => r.json())
      .then((c) => setCategories(c.items ?? []))
      .catch(() => setCategories([]));
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        if (s?.settings?.business_name) setBusinessName(s.settings.business_name);
      })
      .catch(() => {});
  }

  async function loadTransactions() {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const requestId = ++loadSequence.current;

    const loadAllTransactions = async () => {
      const all: Txn[] = [];
      let offset = 0;
      let notesAvailable = true;

      while (true) {
        const qs = new URLSearchParams({
          limit: String(TRANSACTION_PAGE_SIZE),
          offset: String(offset),
        });
        if (rangeBounds.fromAt) qs.set("from_at", rangeBounds.fromAt);
        if (rangeBounds.before) qs.set("before", rangeBounds.before);
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

    try {
      const transactionRows = await loadAllTransactions();
      if (requestId !== loadSequence.current) return;
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

      setError(null);
    } catch (e) {
      if (requestId !== loadSequence.current) return;
      setError(e instanceof Error ? e.message : "Could not load the report transactions");
    } finally {
      if (requestId === loadSequence.current) {
        loadController.current = null;
        setTransactionsLoading(false);
      }
    }
  }

  async function loadInventoryHistory() {
    // Mark the request in flight before anything else: a pending response must
    // never leave last filter's chart on screen looking current, and the
    // filter-change effect must not need to flip the flag itself.
    setHistoryLoading(true);
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    const requestId = ++historySequence.current;

    const qs = new URLSearchParams();
    if (rangeParams.from) qs.set("from", rangeParams.from);
    if (rangeParams.to) qs.set("to", rangeParams.to);
    if (catFilter) qs.set("category", catFilter);
    qs.set("tz", rangeBounds.zone);

    try {
      const response = await fetch(`/api/inventory-history?${qs}`, {
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Could not reconstruct the inventory history");
      }
      if (requestId !== historySequence.current) return;
      setInventoryHistory(payload);
      setHistoryError(null);
    } catch (e) {
      if (requestId !== historySequence.current) return;
      if (controller.signal.aborted) return;
      setHistoryError(
        e instanceof Error ? e.message : "Could not reconstruct the inventory history"
      );
    } finally {
      if (requestId === historySequence.current) {
        historyController.current = null;
        setHistoryLoading(false);
      }
    }
  }

  function loadAll() {
    setItemsLoading(true);
    setTransactionsLoading(true);
    setHistoryLoading(true);
    loadItems();
    loadTransactions();
    loadInventoryHistory();
  }

  useEffect(() => {
    loadItems();
    loadAdvisory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Verify report completeness from the shared report builder whenever the
  // export preview is open. The preview never assumes completeness; it waits
  // for authoritative metadata.
  useEffect(() => {
    if (!reportPreviewOpen) return;
    const controller = new AbortController();
    setReportPreviewCompleteness(null);
    setReportPreviewCompletenessLoading(true);
    setReportPreviewCompletenessError(null);

    fetch("/api/report-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: rangeParams.from,
        to: rangeParams.to,
        staff,
        type: typeFilter,
        category_id: catFilter,
        tz: rangeBounds.zone,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not verify report completeness");
        setReportPreviewCompleteness(data);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setReportPreviewCompletenessError(
          error instanceof Error ? error.message : "Could not verify report completeness"
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setReportPreviewCompletenessLoading(false);
      });

    return () => controller.abort();
  }, [reportPreviewOpen, rangeParams.from, rangeParams.to, staff, typeFilter, catFilter, rangeBounds.zone]);

  // Transactions refetch whenever a range / staff / movement filter changes.
  useEffect(() => {
    loadTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeParams.from, rangeParams.to, staff, typeFilter]);

  // The inventory value trend depends only on the range and the category, so
  // a staff or movement filter change does not touch it.
  useEffect(() => {
    loadInventoryHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeParams.from, rangeParams.to, catFilter]);

  const pullToRefresh = usePullToRefresh(loadAll);

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
    const tally = new Map<string, { name: string; qty: number; events: number; archived: boolean }>();
    for (const t of filteredTransactions) {
      if (t.type !== "checkout") continue;
      for (const li of t.transaction_items ?? []) {
        const current = itemsBySku.get(li.sku);
        const cur = tally.get(li.sku) ?? {
          name: current?.name ?? li.item_name,
          qty: 0,
          events: 0,
          archived: !current,
        };
        cur.qty += Number(li.quantity);
        cur.events += 1;
        tally.set(li.sku, cur);
      }
    }
    return [...tally.entries()]
      .map(([sku, v]) => ({ sku, ...v }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10);
  }, [filteredTransactions, itemsBySku]);

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
    const tally = new Map<string, { name: string; qty: number; count: number; archived: boolean }>();
    for (const t of filteredTransactions) {
      if (t.type !== "waste") continue;
      for (const li of t.transaction_items ?? []) {
        const current = itemsBySku.get(li.sku);
        const cur = tally.get(li.sku) ?? {
          name: current?.name ?? li.item_name,
          qty: 0,
          count: 0,
          archived: !current,
        };
        cur.qty += Number(li.quantity);
        cur.count += 1;
        tally.set(li.sku, cur);
      }
    }
    return [...tally.entries()]
      .map(([sku, v]) => ({ sku, ...v }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);
  }, [filteredTransactions, itemsBySku]);
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
          name: item?.name ?? line.item_name,
          quantity: 0,
          unitPrice,
          valueCents: 0,
          events: 0,
          archived: !item,
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

    let trendPoints: ValueTrendDatum[] = [];
    let movementPoints: MovementDatum[] = [];
    let periodLabel = "date";
    if (startDate && endDate && startDate <= endDate) {
      const daySpan = Math.ceil((endDate.getTime() - startDate.getTime()) / 86_400_000);
      const granularity =
        grouping === "daily"
          ? "day"
          : grouping === "weekly"
            ? "week"
            : grouping === "monthly"
              ? "month"
              : daySpan <= 31
                ? "day"
                : daySpan <= 180
                  ? "week"
                  : "month";
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
            ? bucketDate.toLocaleDateString("en-PH", { month: "short", year: "numeric" })
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

      /*
       * Stock in against stock out.
       *
       * The classification is the one the database enforces on write: a
       * restock adds stock, and a checkout and a waste log both draw it down.
       * Every movement line counts once, in one series, in one of the two.
       */
      const movementByKey = new Map<string, { stockIn: number; stockOut: number }>();
      for (const { transaction, date } of datedTransactions) {
        if (
          transaction.type !== "restock" &&
          transaction.type !== "checkout" &&
          transaction.type !== "waste"
        ) {
          continue;
        }
        const bucket = bucketFor(date);
        const total = movementByKey.get(bucket.key) ?? { stockIn: 0, stockOut: 0 };
        for (const line of transaction.transaction_items ?? []) {
          const quantity = Number(line.quantity);
          if (!Number.isFinite(quantity)) continue;
          if (transaction.type === "restock") total.stockIn += quantity;
          else total.stockOut += quantity;
        }
        movementByKey.set(bucket.key, total);
      }

      const movement: MovementDatum[] = [];
      const points: ValueTrendDatum[] = [];
      const cursor = startBucket.date;
      for (let guard = 0; guard < 2400; guard += 1) {
        const bucket = bucketFor(cursor);
        const totals = totalsByKey.get(bucket.key) ?? { revenueCents: 0, lossCents: 0 };
        points.push({ key: bucket.key, label: bucket.label, ...totals });
        const movementTotals = movementByKey.get(bucket.key) ?? {
          stockIn: 0,
          stockOut: 0,
        };
        movement.push({ key: bucket.key, label: bucket.label, ...movementTotals });
        if (bucket.key === endBucket.key) break;
        if (granularity === "day") cursor.setDate(cursor.getDate() + 1);
        else if (granularity === "week") cursor.setDate(cursor.getDate() + 7);
        else cursor.setMonth(cursor.getMonth() + 1);
      }
      trendPoints = points;
      movementPoints = movement;
    }

    const maxTransactionCents = Math.max(
      ...pricedTransactions.map((transaction) => transaction.valueCents),
      0
    );
    const bins: HistogramDatum[] = [];
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

    return { trendPoints, movementPoints, periodLabel, bins, scatterPoints };
  }, [filteredTransactions, itemsBySku, rangeParams.from, rangeParams.to, grouping]);

  /* ---------- snapshot-derived series for the charts ---------- */

  // Inventory value uses actual quantities at current unit prices, so the
  // excluded (unpriced) count has to be visible alongside the total.
  const inventoryValue = useMemo(() => {
    let cents = 0;
    let unpriced = 0;
    for (const item of shownItems) {
      const price = item.unit_price;
      if (price === null || price === undefined || !Number.isFinite(Number(price))) {
        unpriced += 1;
        continue;
      }
      cents += Math.round(Number(item.quantity) * Number(price) * 100);
    }
    return { cents, unpriced };
  }, [shownItems]);

  const statusDistribution = useMemo(() => {
    const counts = { ok: 0, low: 0, out: 0 };
    for (const item of shownItems) {
      const key = stockStatus(item.quantity, item.low_stock_threshold).key;
      if (key === "low") counts.low += 1;
      else if (key === "out") counts.out += 1;
      else counts.ok += 1;
    }
    return [
      { key: "ok", label: "Normal stock", count: counts.ok, color: CHART_COLORS.normal },
      { key: "low", label: "Low stock", count: counts.low, color: CHART_COLORS.low },
      { key: "out", label: "Out of stock", count: counts.out, color: CHART_COLORS.out },
    ];
  }, [shownItems]);

  const categoryStock = useMemo(() => {
    const tally = new Map<string, { quantity: number; items: number }>();
    for (const item of shownItems) {
      const name = item.category?.name ?? "Uncategorized";
      const current = tally.get(name) ?? { quantity: 0, items: 0 };
      current.quantity += Number(item.quantity);
      current.items += 1;
      tally.set(name, current);
    }
    return [...tally.entries()]
      .map(([name, totals]) => ({
        name,
        quantity: Math.round(totals.quantity * 100) / 100,
        items: totals.items,
      }))
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  }, [shownItems]);

  const valueSlices = useMemo(
    () => buildMoneySlices(financialSummary.revenueItems),
    [financialSummary.revenueItems]
  );
  const lossSlices = useMemo(
    () => buildMoneySlices(financialSummary.lossItems),
    [financialSummary.lossItems]
  );

  const activitySlices = useMemo(
    () =>
      movement.map((entry) => ({
        type: entry.type,
        label: MOVEMENT_LABEL[entry.type] ?? entry.type,
        count: entry.count,
        qty: entry.qty,
        color: ACTIVITY_COLORS[entry.type] ?? CHART_COLORS.primary,
      })),
    [movement]
  );

  const topMoverEntries = useMemo(
    () =>
      topMovers.map((item) => ({
        key: item.sku,
        name: item.name,
        value: item.qty,
        label: fmtQty(item.qty, itemsBySku.get(item.sku)?.unit),
        detail: item.archived ? "archived" : `SKU ${item.sku}`,
        sku: item.sku,
        archived: item.archived,
      })),
    [topMovers, itemsBySku]
  );

  const wasteByItemEntries = useMemo(
    () =>
      wasteByItem.map((item) => ({
        key: item.sku,
        name: item.name,
        value: item.qty,
        label: fmtQty(item.qty, itemsBySku.get(item.sku)?.unit),
        detail: item.archived ? "archived" : `SKU ${item.sku}`,
        sku: item.sku,
        archived: item.archived,
      })),
    [wasteByItem, itemsBySku]
  );

  const wasteByCategoryEntries = useMemo(
    () =>
      wasteByCategory.map((category) => ({
        key: category.name,
        name: category.name,
        value: category.events,
        label: `${category.events} ${category.events === 1 ? "entry" : "entries"}`,
      })),
    [wasteByCategory]
  );

/* ---------- on-hand table: search, table filters, sort, columns, pagination ---------- */

  type OnHandOptionalColumn = "category" | "threshold" | "location" | "expiry";
  const DEFAULT_ONHAND_COLUMNS: Record<OnHandOptionalColumn, boolean> = {
    category: true,
    threshold: true,
    location: false,
    expiry: false,
  };
  const [tablePageSize, setTablePageSize] = useState<25 | 50 | 100>(25);
  const [tableColumns, setTableColumns] =
    useState<Record<OnHandOptionalColumn, boolean>>(DEFAULT_ONHAND_COLUMNS);
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [tableCategoryFilter, setTableCategoryFilter] = useState("");
  const [tableLocationFilter, setTableLocationFilter] = useState("");
  const [tableStatusFilter, setTableStatusFilter] = useState("");

  /*
   * The location options come from the loaded catalogue itself — one read,
   * zero extra requests, and the list can never name a location the report
   * does not also show.
   */
  const locationOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const item of items) {
      const location = item.location;
      if (location?.id && !byId.has(location.id)) {
        byId.set(location.id, location.name ?? location.id);
      }
    }
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const onHandRows = useMemo(() => {
    const query = tableQuery.trim().toLowerCase();
    let matched = shownItems;

    if (tableCategoryFilter) {
      matched = matched.filter((item) => item.category?.id === tableCategoryFilter);
    }
    if (tableLocationFilter) {
      matched = matched.filter((item) => item.location?.id === tableLocationFilter);
    }
    if (tableStatusFilter) {
      matched = matched.filter(
        (item) =>
          stockStatus(item.quantity, item.low_stock_threshold).key === tableStatusFilter
      );
    }
    if (query) {
      matched = matched.filter((item) =>
        [item.sku, item.name, item.category?.name ?? "", item.location?.name ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    }

    const rank: Record<string, number> = { out: 0, low: 1, ok: 2 };
    const value = (item: Item, key: OnHandSortKey): string | number => {
      switch (key) {
        case "sku":
          return item.sku.toLowerCase();
        case "name":
          return item.name.toLowerCase();
        case "category":
          return (item.category?.name ?? "").toLowerCase();
        case "location":
          return (item.location?.name ?? "").toLowerCase();
        case "quantity":
          return Number(item.quantity);
        case "threshold":
          return Number(item.low_stock_threshold);
        case "expiry": {
          const d = daysUntil(item.expiration_date);
          return d === null ? Number.POSITIVE_INFINITY : d;
        }
        case "status":
          return rank[stockStatus(item.quantity, item.low_stock_threshold).key as "out" | "low" | "ok"];
      }
    };

    const dir = tableSort.dir;
    return [...matched].sort((a, b) => {
      const av = value(a, tableSort.key);
      const bv = value(b, tableSort.key);
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * dir;
      }
      return ((av as number) - (bv as number)) * dir;
    });
  }, [
    shownItems,
    tableQuery,
    tableCategoryFilter,
    tableLocationFilter,
    tableStatusFilter,
    tableSort,
  ]);

  const onHandPageCount = Math.max(1, Math.ceil(onHandRows.length / tablePageSize));
  const onHandPage = Math.min(tablePage, onHandPageCount);
  const onHandSliced = onHandRows.slice(
    (onHandPage - 1) * tablePageSize,
    onHandPage * tablePageSize
  );
  const onHandRangeStart =
    onHandRows.length === 0 ? 0 : (onHandPage - 1) * tablePageSize + 1;
  const onHandRangeEnd = Math.min(onHandPage * tablePageSize, onHandRows.length);

  const activeTableFilterCount =
    (tableQuery.trim() ? 1 : 0) +
    (tableCategoryFilter ? 1 : 0) +
    (tableLocationFilter ? 1 : 0) +
    (tableStatusFilter ? 1 : 0);

  function clearTableFilters() {
    setTableQuery("");
    setTableCategoryFilter("");
    setTableLocationFilter("");
    setTableStatusFilter("");
  }

  useEffect(() => {
    setTablePage(1);
  }, [
    tableQuery,
    tableCategoryFilter,
    tableLocationFilter,
    tableStatusFilter,
    tablePageSize,
    catFilter,
  ]);

  /*
   * The Columns popover: focus moves into it on open, Escape closes it and
   * returns focus to the trigger, clicking outside closes it. Native
   * checkboxes carry their own keyboard behavior — Tab/Space — so the
   * popover needs no roving-tabindex machinery.
   */
  useEffect(() => {
    if (!columnsMenuOpen) return;
    columnsPanelRef.current
      ?.querySelector<HTMLElement>("input, button")
      ?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      /*
       * If a modal dialog is open it is on top of the popover, so Escape
       * belongs to it — leave the popover open and let the modal close.
       */
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setColumnsMenuOpen(false);
      columnsTriggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [columnsMenuOpen]);

  function toggleOnHandColumn(column: OnHandOptionalColumn) {
    setTableColumns((current) => {
      const next = { ...current, [column]: !current[column] };
      /*
       * Hiding the column the table is sorted by would leave the order
       * correct but unexplained — sorting silently by something off-screen.
       * Reset to a sort that is always visible.
       */
      if (!next[column] && tableSort.key === column) {
        setTableSort({ key: "name", dir: 1 });
      }
      return next;
    });
  }

  const visibleOptionalColumns = (
    ["category", "threshold", "location", "expiry"] as const
  ).filter((column) => tableColumns[column]);
  const lockedColumns = ["sku", "name", "quantity", "status"];
  const visibleColumnCount = lockedColumns.length + visibleOptionalColumns.length;

  function toggleOnHandSort(key: OnHandSortKey) {
    setTableSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 1 ? -1 : 1 }
        : { key, dir: 1 }
    );
  }

  const soonestExpiryFull = useMemo(
    () =>
      shownItems
        .filter((i) => i.expiration_date)
        .map((i) => ({ ...i, days: daysUntil(i.expiration_date) }))
        .sort(
          (a, b) =>
            (a.days ?? Number.POSITIVE_INFINITY) -
            (b.days ?? Number.POSITIVE_INFINITY)
        ),
    [shownItems]
  );

  const expiringSoonCount = useMemo(
    () =>
      shownItems.filter((i) => {
        const d = daysUntil(i.expiration_date);
        return d !== null && d <= 7;
      }).length,
    [shownItems]
  );

  const activityTotals = useMemo(
    () => ({
      restock: movement.find((entry) => entry.type === "restock")?.count ?? 0,
      checkout: movement.find((entry) => entry.type === "checkout")?.count ?? 0,
      waste: movement.find((entry) => entry.type === "waste")?.count ?? 0,
    }),
    [movement]
  );

  const overviewMetrics: ReportMetric[] = [
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
      label: "Inventory Value",
      value: inventoryValue.cents,
      format: "peso-cents" as const,
      hint:
        inventoryValue.unpriced > 0
          ? `${inventoryValue.unpriced} item${inventoryValue.unpriced === 1 ? " has" : "s have"} no price and ${inventoryValue.unpriced === 1 ? "is" : "are"} excluded`
          : "Quantity × current unit price",
      icon: "value",
      tone: "cocoa",
    },
  ];

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
          tz: rangeBounds.zone,
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
            tz: rangeBounds.zone,
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
    /*
     * Prices feed the server-side reconstruction, not just the client-side
     * estimates, so saving a batch of prices refetches the inventory history
     * once — rather than once per item saved.
     */
    if (savedCount > 0) loadInventoryHistory();

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

/* ---------- tab bar ---------- */

  const tabBar = (
    <nav
      role="tablist"
      aria-label="Report sections"
      className="flex gap-2 overflow-x-auto rounded-2xl border border-cream-200 bg-cream-50 p-2"
    >
      {REPORT_TABS.map((tab) => (
        <button
          key={tab.id}
          id={`reports-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={`reports-panel-${tab.id}`}
          onClick={() => setActiveTab(tab.id)}
          className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
            activeTab === tab.id
              ? "bg-cocoa-800 text-white shadow-warm"
              : "text-cocoa-600 hover:bg-cream-100"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );

  /* ---------- filters: state, chips, and the shared filter panel ---------- */

  const rangeLabel =
    range === "custom"
      ? "Custom dates"
      : RANGE_OPTIONS.find((option) => option.key === range)?.label ?? "This week";
  const advancedFilterCount = [typeFilter, staff, catFilter].filter(Boolean).length;
  const selectedCategoryName = catFilter
    ? categories.find((category) => category.id === catFilter)?.name ?? "selected category"
    : null;
  const filterChips: { key: string; label: string; onRemove: () => void }[] = [
    range !== "week"
      ? { key: "range", label: `Range: ${rangeLabel}`, onRemove: () => { setRange("week"); setFromDay(""); setToDay(""); } }
      : null,
    typeFilter
      ? {
          key: "type",
          label: `Movement: ${MOVEMENT_LABEL[typeFilter] ?? typeFilter}`,
          onRemove: () => setTypeFilter(""),
        }
      : null,
    staff
      ? {
          key: "staff",
          label: `Staff: ${selectedStaffName ?? "selected staff"}`,
          onRemove: () => setStaff(""),
        }
      : null,
    catFilter
      ? {
          key: "cat",
          label: `Category: ${selectedCategoryName}`,
          onRemove: () => setCatFilter(""),
        }
      : null,
  ].filter((chip): chip is { key: string; label: string; onRemove: () => void } => Boolean(chip));

  function clearAllFilters() {
    setRange("week");
    setFromDay("");
    setToDay("");
    setStaff("");
    setTypeFilter("");
    setCatFilter("");
    setGrouping("auto");
  }

  const filterPanel = (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="f-range">Date range</label>
          <select
            id="f-range"
            className="input"
            value={range}
            onChange={(event) => setRange(event.target.value as RangeKey)}
          >
            {RANGE_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
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
                className="input"
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
                className="input"
                value={toDay}
                min={fromDay || undefined}
                onChange={(event) => setToDay(event.target.value)}
              />
            </div>
          </>
        )}

        <button
          type="button"
          className="btn-ghost"
          aria-expanded={filtersOpen}
          aria-controls="filters-panel"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters
          {advancedFilterCount > 0 && (
            <span className="ml-1.5 rounded-full bg-cocoa-800 px-1.5 py-0.5 text-[10px] font-bold text-white">
              {advancedFilterCount}
            </span>
          )}
          <span aria-hidden="true" className="ml-1.5 inline-block text-[10px]">
            {filtersOpen ? "▲" : "▼"}
          </span>
        </button>

        {(rangeParams.from || rangeParams.to || staff || typeFilter || catFilter) && (
          <button type="button" className="btn-ghost" onClick={clearAllFilters}>
            Clear filters
          </button>
        )}
      </div>

      {filtersOpen && (
        <div
          id="filters-panel"
          className="mt-3 grid gap-3 border-t border-cream-200 pt-3 sm:grid-cols-2 md:grid-cols-3"
        >
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
              <option value="">Everyone</option>
              {staffOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="f-cat">Category</label>
            <select
              id="f-cat"
              className="input w-full"
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {filterChips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-cream-200 pt-3">
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onRemove}
              aria-label={`Remove filter: ${chip.label}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-cream-200 bg-cream-100 px-2.5 py-1 text-[11px] font-medium text-cocoa-600 transition-colors hover:border-cream-300 hover:text-cocoa-800"
            >
              {chip.label}
              <span aria-hidden="true" className="text-cocoa-400">×</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );

  const alerts = (
    <>
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
    </>
  );

  const pageHeader = (
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
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn-ghost hidden lg:inline-flex"
          onClick={loadAll}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Reload"}
        </button>
        <div className="relative">
          <button
            className="btn-primary inline-flex items-center gap-2"
            onClick={() => setExportMenuOpen((open) => !open)}
            aria-expanded={exportMenuOpen}
            aria-haspopup="menu"
            disabled={items.length === 0 || loading}
          >
            Export
            <span aria-hidden="true" className="text-[10px]">▾</span>
          </button>
          {exportMenuOpen && (
            <>
              <button
                tabIndex={-1}
                aria-hidden="true"
                className="fixed inset-0 z-20 cursor-default"
                onClick={() => setExportMenuOpen(false)}
              />
              <div
                role="menu"
                aria-label="Export report"
                className="absolute right-0 z-30 mt-2 w-48 overflow-hidden rounded-xl border border-cream-200 bg-white shadow-warm"
              >
                <button
                  role="menuitem"
                  className="block w-full px-3 py-2.5 text-left text-sm text-cocoa-700 hover:bg-cream-50"
                  onClick={() => {
                    setExportMenuOpen(false);
                    setReportPreviewOpen(true);
                    setEmailModalOpen(false);
                    setExportError(null);
                  }}
                >
                  Download PDF…
                </button>
                <button
                  role="menuitem"
                  className="block w-full border-t border-cream-100 px-3 py-2.5 text-left text-sm text-cocoa-700 hover:bg-cream-50"
                  onClick={() => {
                    setExportMenuOpen(false);
                    exportCsv();
                  }}
                >
                  Download CSV
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

/* ---------- the four report sections, shared by the page and the PDF preview ---------- */

  const overviewSection = (
    <section
      id="reports-panel-overview"
      role="tabpanel"
      aria-labelledby="reports-tab-overview"
      className="space-y-4"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {overviewMetrics.map((metric) => (
          <ReportMetricCard key={metric.label} metric={metric} />
        ))}
      </div>

      {inventoryValue.unpriced > 0 && (
        <button
          type="button"
          className="inline-flex w-full items-center justify-between gap-3 rounded-xl border border-ochre-200 bg-ochre-50 px-4 py-2.5 text-left text-xs font-medium text-ochre-800 transition-colors hover:bg-ochre-100 sm:w-auto"
          onClick={() => setPriceEditorOpen(true)}
        >
          <span>
            {inventoryValue.unpriced} item{inventoryValue.unpriced === 1 ? " has" : "s have"} no unit price.
            Value charts leave them out.
          </span>
          <span className="shrink-0 font-semibold underline">Add prices</span>
        </button>
      )}

      <div className="grid gap-3 lg:grid-cols-3">
        {/* Needs attention — the triage panel */}
        <div className="rounded-2xl border border-cream-200 bg-white p-4 lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-cocoa-800">Needs attention</h2>
            <button
              type="button"
              className="text-[11px] font-semibold text-cocoa-500 hover:text-cocoa-800"
              onClick={() => setActiveTab("inventory")}
            >
              Open inventory →
            </button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("inventory")}
              className="rounded-xl bg-ochre-50 px-3 py-3 text-left transition-colors hover:bg-ochre-100"
            >
              <p className="text-2xl font-semibold leading-none tabular-nums text-ochre-800">
                {low.length}
              </p>
              <p className="mt-1.5 text-[10px] font-semibold text-ochre-700">Low stock</p>
              <p className="text-[9px] text-ochre-600/80">At or below threshold</p>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("inventory")}
              className="rounded-xl bg-terracotta-50 px-3 py-3 text-left transition-colors hover:bg-terracotta-100"
            >
              <p className="text-2xl font-semibold leading-none tabular-nums text-terracotta-800">
                {out.length}
              </p>
              <p className="mt-1.5 text-[10px] font-semibold text-terracotta-700">Out of stock</p>
              <p className="text-[9px] text-terracotta-600/80">Replenishment needed</p>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("inventory")}
              className="rounded-xl bg-cream-50 px-3 py-3 text-left transition-colors hover:bg-cream-100"
            >
              <p className="text-2xl font-semibold leading-none tabular-nums text-cocoa-800">
                {expiringSoonCount}
              </p>
              <p className="mt-1.5 text-[10px] font-semibold text-cocoa-600">Expiring soon</p>
              <p className="text-[9px] text-cocoa-400">Within 7 days or already expired</p>
            </button>
          </div>
        </div>

        {/* Recent stock activity */}
        <div className="rounded-2xl border border-cream-200 bg-white p-4">
          <h2 className="text-sm font-bold text-cocoa-800">Recent stock activity</h2>
          <p className="mt-1 text-xs text-cocoa-400">
            {movementPeriodLabel} · {filteredTransactions.length} movements
          </p>
          <div className="mt-3 space-y-2 text-xs">
            <p className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-sage-500" aria-hidden="true" />
                Restocked
              </span>
              <span className="font-semibold tabular-nums text-cocoa-800">{activityTotals.restock}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-cocoa-500" aria-hidden="true" />
                Checked out
              </span>
              <span className="font-semibold tabular-nums text-cocoa-800">{activityTotals.checkout}</span>
            </p>
            <p className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-rust-500" aria-hidden="true" />
                Logged as waste
              </span>
              <span className="font-semibold tabular-nums text-cocoa-800">{activityTotals.waste}</span>
            </p>
          </div>
        </div>
      </div>

      <InventoryValueTrendChart
        data={inventoryHistory}
        loading={historyLoading}
        error={historyError}
        grouping={grouping}
        onGroupingChange={setGrouping}
      />
    </section>
  );

  const inventorySection = (
    <section
      id="reports-panel-inventory"
      role="tabpanel"
      aria-labelledby="reports-tab-inventory"
      className="space-y-3"
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <StockByCategoryChart categories={categoryStock} />
        <StockStatusDonutChart status={statusDistribution} />
      </div>

      <SoonestExpiries items={soonestExpiryFull} />

      {/* On hand by item — searchable, filterable, sortable, paginated */}
      <Card className="!p-0">
        {/* header: title + summary, search, column visibility */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cream-200 bg-cream-50 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-cocoa-800">On hand by item</h2>
            <p className="mt-1 text-[11px] tabular-nums text-cocoa-400">
              {activeTableFilterCount > 0
                ? `${onHandRows.length} of ${shownItems.length} match`
                : `${shownItems.length} items tracked`}
              {` · page ${onHandPage} of ${onHandPageCount}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="onhand-search">
              Search items by name, SKU, category or location…
            </label>
            <input
              id="onhand-search"
              className="input w-44 sm:w-56"
              type="search"
              placeholder="Search items by name, SKU, category or location…"
              value={tableQuery}
              onChange={(event) => setTableQuery(event.target.value)}
            />

            {/* column visibility — tablet and up */}
            <div className="relative hidden md:block">
              <button
                ref={columnsTriggerRef}
                type="button"
                className="btn-ghost inline-flex items-center gap-1.5"
                aria-expanded={columnsMenuOpen}
                aria-haspopup="dialog"
                aria-controls="onhand-columns-popover"
                onClick={() => setColumnsMenuOpen((open) => !open)}
              >
                Columns
                <span className="text-[10px] tabular-nums text-cocoa-400">
                  {visibleColumnCount}/8
                </span>
                <span aria-hidden="true" className="text-[10px] text-cocoa-400">
                  ▾
                </span>
              </button>
              {columnsMenuOpen && (
                <>
                  <button
                    tabIndex={-1}
                    aria-hidden="true"
                    className="fixed inset-0 z-20 cursor-default"
                    onClick={() => setColumnsMenuOpen(false)}
                  />
                  <div
                    ref={columnsPanelRef}
                    id="onhand-columns-popover"
                    role="dialog"
                    aria-modal="false"
                    aria-label="Toggle optional columns"
                    className="absolute right-0 z-30 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-cream-200 bg-white py-1 shadow-warm"
                  >
                    <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-cocoa-400">
                      Optional columns
                    </p>
                    <fieldset className="m-0 border-0 p-0">
                      <legend className="sr-only">Optional columns</legend>
                      {(
                        [
                          ["category", "Category"],
                          ["threshold", "Threshold"],
                          ["location", "Location"],
                          ["expiry", "Expiry"],
                        ] as [OnHandOptionalColumn, string][]
                      ).map(([column, label]) => (
                        <label
                          key={column}
                          htmlFor={`onhand-col-${column}`}
                          className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-cocoa-700 hover:bg-cream-50"
                        >
                          <input
                            id={`onhand-col-${column}`}
                            type="checkbox"
                            className="h-4 w-4 accent-cocoa-800"
                            checked={tableColumns[column]}
                            onChange={() => toggleOnHandColumn(column)}
                          />
                          {label}
                        </label>
                      ))}
                    </fieldset>
                    <button
                      type="button"
                      className="block w-full border-t border-cream-100 px-3 py-2 text-left text-xs font-medium text-cocoa-500 hover:bg-cream-50"
                      onClick={() => {
                        setTableColumns({ ...DEFAULT_ONHAND_COLUMNS });
                      }}
                    >
                      Reset columns
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* table-level filters — affect only this table */}
        <div className="flex flex-wrap items-center gap-2 border-b border-cream-200 px-4 py-2">
          <label className="sr-only" htmlFor="onhand-cat">
            Filter by category
          </label>
          <select
            id="onhand-cat"
            className={`input w-auto text-xs ${
              tableCategoryFilter ? "border-cocoa-300 bg-cream-100 font-medium" : ""
            }`}
            value={tableCategoryFilter}
            onChange={(event) => setTableCategoryFilter(event.target.value)}
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="onhand-loc">
            Filter by location
          </label>
          <select
            id="onhand-loc"
            className={`input w-auto text-xs ${
              tableLocationFilter ? "border-cocoa-300 bg-cream-100 font-medium" : ""
            }`}
            value={tableLocationFilter}
            onChange={(event) => setTableLocationFilter(event.target.value)}
          >
            <option value="">All locations</option>
            {locationOptions.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="onhand-status">
            Filter by stock status
          </label>
          <select
            id="onhand-status"
            className={`input w-auto text-xs ${
              tableStatusFilter ? "border-cocoa-300 bg-cream-100 font-medium" : ""
            }`}
            value={tableStatusFilter}
            onChange={(event) => setTableStatusFilter(event.target.value)}
          >
            <option value="">All statuses</option>
            <option value="ok">In Stock</option>
            <option value="low">Low Stock</option>
            <option value="out">Out of Stock</option>
          </select>

          {activeTableFilterCount > 0 && (
            <button
              type="button"
              className="text-[11px] font-semibold text-cocoa-500 underline-offset-2 hover:text-cocoa-800 hover:underline"
              onClick={clearTableFilters}
            >
              Clear table filters
            </button>
          )}
        </div>

        {shownItems.length === 0 ? (
          <Empty>{items.length === 0 ? "No items yet." : "No items in this category."}</Empty>
        ) : onHandRows.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium text-cocoa-700">
              No items match the current search and filters.
            </p>
            <p className="mt-1 text-xs text-cocoa-400">
              Try a different search term, or clear the filters.
            </p>
            <button
              type="button"
              className="btn-ghost mt-3"
              onClick={clearTableFilters}
            >
              Clear search &amp; filters
            </button>
          </div>
        ) : (
          <>
            {/* mobile card view */}
            <div className="space-y-2.5 p-3 md:hidden">
              {onHandSliced.map((item) => {
                const status = stockStatus(item.quantity, item.low_stock_threshold);
                const days = daysUntil(item.expiration_date);
                return (
                  <DataCard key={item.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-cocoa-800" title={item.name}>
                          {item.name}
                        </div>
                        <div className="truncate font-mono text-xs text-cocoa-400" title={item.sku}>
                          {item.sku}
                        </div>
                      </div>
                      <BadgeTone status={status} />
                    </div>
                    <DataField label="On hand">{fmtQty(item.quantity, item.unit)}</DataField>
                    <DataField label="Threshold">{fmtQty(item.low_stock_threshold, item.unit)}</DataField>
                    <DataField label="Category">{item.category?.name ?? "—"}</DataField>
                    <DataField label="Location">{item.location?.name ?? "—"}</DataField>
                    <DataField label="Expiry">
                      {item.expiration_date ? (
                        <span className="text-xs">
                          {fmtDate(item.expiration_date)}
                          {days !== null && days < 0 && (
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

            {/* desktop table */}
            <div className="hidden max-h-[34rem] overflow-auto md:block">
              <table className="w-full">
                <thead>
                  <tr>
                    <OnHandSortHeader label="SKU" sortKey="sku" tableSort={tableSort} onSort={toggleOnHandSort} />
                    <OnHandSortHeader label="Item" sortKey="name" tableSort={tableSort} onSort={toggleOnHandSort} />
                    {tableColumns.category && (
                      <OnHandSortHeader label="Category" sortKey="category" tableSort={tableSort} onSort={toggleOnHandSort} />
                    )}
                    {tableColumns.location && (
                      <OnHandSortHeader label="Location" sortKey="location" tableSort={tableSort} onSort={toggleOnHandSort} />
                    )}
                    <OnHandSortHeader label="On hand" sortKey="quantity" className="text-right" tableSort={tableSort} onSort={toggleOnHandSort} />
                    {tableColumns.threshold && (
                      <OnHandSortHeader label="Threshold" sortKey="threshold" className="text-right" tableSort={tableSort} onSort={toggleOnHandSort} />
                    )}
                    {tableColumns.expiry && (
                      <OnHandSortHeader label="Expiry" sortKey="expiry" tableSort={tableSort} onSort={toggleOnHandSort} />
                    )}
                    <OnHandSortHeader label="Stock status" sortKey="status" tableSort={tableSort} onSort={toggleOnHandSort} />
                  </tr>
                </thead>
                <tbody>
                  {onHandSliced.map((item) => {
                    const status = stockStatus(item.quantity, item.low_stock_threshold);
                    const days = daysUntil(item.expiration_date);
                    return (
                      <tr key={item.id} className="transition-colors hover:bg-cream-50">
                        <td className="td max-w-[8.5rem]">
                          <span className="block truncate font-mono text-xs text-cocoa-400" title={item.sku}>
                            {item.sku}
                          </span>
                        </td>
                        <td className="td max-w-[13rem] lg:max-w-[18rem]">
                          <span className="block truncate font-medium text-cocoa-800" title={item.name}>
                            {item.name}
                          </span>
                        </td>
                        {tableColumns.category && (
                          <td className="td max-w-[9rem]">
                            <span className="block truncate text-cocoa-500" title={item.category?.name ?? ""}>
                              {item.category?.name ?? "—"}
                            </span>
                          </td>
                        )}
                        {tableColumns.location && (
                          <td className="td max-w-[9rem]">
                            <span className="block truncate text-cocoa-500" title={item.location?.name ?? ""}>
                              {item.location?.name ?? "—"}
                            </span>
                          </td>
                        )}
                        <td className="td whitespace-nowrap text-right tabular-nums">
                          {fmtQty(item.quantity, item.unit)}
                        </td>
                        {tableColumns.threshold && (
                          <td className="td whitespace-nowrap text-right tabular-nums text-cocoa-500">
                            {fmtQty(item.low_stock_threshold, item.unit)}
                          </td>
                        )}
                        {tableColumns.expiry && (
                          <td className="td whitespace-nowrap text-xs text-cocoa-500">
                            {item.expiration_date ? (
                              <>
                                {fmtDate(item.expiration_date)}
                                {days !== null && days < 0 && (
                                  <span className="text-terracotta-700"> (expired)</span>
                                )}
                              </>
                            ) : (
                              <span className="text-cocoa-200">—</span>
                            )}
                          </td>
                        )}
                        <td className="td whitespace-nowrap">
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

        {/* pagination — on the filtered set, always visible */}
        {shownItems.length > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 border-t border-cream-200 px-4 py-2 text-[11px] text-cocoa-400"
          aria-label="Table pagination"
        >
          <span className="tabular-nums">
            Showing {onHandRangeStart}–{onHandRangeEnd} of {onHandRows.length}{" "}
            {onHandRows.length === 1 ? "item" : "items"}
          </span>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="onhand-pagesize">
              Items per page
            </label>
            <select
              id="onhand-pagesize"
              className="input w-auto pr-8 text-[11px]"
              value={tablePageSize}
              onChange={(event) =>
                setTablePageSize(Number(event.target.value) as 25 | 50 | 100)
              }
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
            <span className="hidden text-cocoa-400 sm:inline">per page</span>
            <button
              type="button"
              className="btn-ghost !px-2.5 !py-1 text-[11px]"
              onClick={() => setTablePage((page) => Math.max(1, page - 1))}
              disabled={onHandPage <= 1}
            >
              ← Prev
            </button>
            <span className="tabular-nums">
              Page {onHandPage} of {onHandPageCount}
            </span>
            <button
              type="button"
              className="btn-ghost !px-2.5 !py-1 text-[11px]"
              onClick={() => setTablePage((page) => Math.min(onHandPageCount, page + 1))}
              disabled={onHandPage >= onHandPageCount}
            >
              Next →
            </button>
          </div>
        </div>
        )}

        <p className="border-t border-cream-200 bg-cream-50 px-4 py-2 text-[10px] text-cocoa-400">
          Stock status reflects quantity only. Review expired items before use.
        </p>
      </Card>
    </section>
  );

  const movementsSection = (
    <section
      id="reports-panel-movements"
      role="tabpanel"
      aria-labelledby="reports-tab-movements"
      className="space-y-4"
    >
      <div className="grid gap-3 lg:grid-cols-2">
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

      <div className="grid gap-4 xl:grid-cols-2">
        <StockMovementChart
          movement={chartAnalytics.movementPoints}
          periodLabel={chartAnalytics.periodLabel}
        />
        <ValueTrendChart
          points={chartAnalytics.trendPoints}
          periodLabel={chartAnalytics.periodLabel}
          unpricedLines={
            financialSummary.unpricedRevenueLines + financialSummary.unpricedLossLines
          }
        />
      </div>

      <TransactionActivityDonutChart activity={activitySlices} />
      <MovementActivityChart
        activity={activitySlices}
        transactions={filteredTransactions}
      />

      <details
        /* Preview shows the complete report — the collapsible stays open
           while the export modal is open, collapsed otherwise. The key
           remounts the element on the boundary so the default flips. */
        key={String(reportPreviewOpen)}
        className="rounded-2xl border border-cream-200 bg-cream-50"
        open={reportPreviewOpen || undefined}
      >
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-cocoa-700">
          Advanced analysis
        </summary>
        <div className="border-t border-cream-200 p-3">
          <TransactionHistogramChart bins={chartAnalytics.bins} />
        </div>
      </details>
    </section>
  );

  const performanceSection = (
    <section
      id="reports-panel-performance"
      role="tabpanel"
      aria-labelledby="reports-tab-performance"
      className="space-y-4"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="!p-0">
          <div className="border-b border-cream-200 bg-cream-50 px-4 py-3">
            <h2 className="text-sm font-bold text-cocoa-800">Waste Summary</h2>
            <p className="mt-1 text-xs text-cocoa-400">
              Recorded waste in the selected report.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 p-4">
            <Stat label="Total Waste" value={fmtQty(wasteTotal)} tone="danger" />
            <Stat label="Waste Events" value={wasteCount} tone="warn" />
          </div>
        </Card>
        <TopItemsBarChart
          title="Waste by category"
          description="Waste item entries by category. Select a bar to see its total quantity."
          metric="waste entries"
          entries={wasteByCategoryEntries}
          color={CHART_COLORS.neutral}
          emptyMessage="No waste recorded yet."
          unitLabel="entries"
          notes={
            <>
              Counted by waste item entries, not quantities, because the
              quantities are in mixed units. Total quantity is in the tooltip.
            </>
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <TopItemsBarChart
          title="Top-moving inventory items"
          description="Top ten items by units checked out in this date range."
          metric="units checked out"
          entries={topMoverEntries}
          color={CHART_COLORS.revenue}
          emptyMessage="No checkout activity in this date range."
          unitLabel="units"
          notes={
            <>
              Ranked by checkout units, not by how often the item was
              checked out, and not by waste. An item checked out once with
              ten units ranks above an item checked out ten times with one.
            </>
          }
        />
        <TopItemsBarChart
          title="Most wasted items"
          description="Ranked by waste quantity in this date range · mixed units."
          metric="units wasted"
          entries={wasteByItemEntries}
          color={CHART_COLORS.waste}
          emptyMessage="No waste activity in this date range."
          unitLabel="units"
        />
        <ValueBreakdownChart
          title="Revenue by item"
          description="Checkout value by item. Select a slice to inspect its quantity and value."
          slices={valueSlices}
          totalCents={financialSummary.revenueCents}
          emptyMessage="No priced items in this date range."
        />
        <ValueBreakdownChart
          title="Lost value by item"
          description="Waste cost by item. Select a slice to inspect its quantity and value."
          slices={lossSlices}
          totalCents={financialSummary.lossCents}
          emptyMessage="No priced waste in this date range."
        />
      </div>

      <details
        /* Preview shows the complete report — the collapsible stays open
           while the export modal is open, collapsed otherwise. The key
           remounts the element on the boundary so the default flips. */
        key={String(reportPreviewOpen)}
        className="rounded-2xl border border-cream-200 bg-cream-50"
        open={reportPreviewOpen || undefined}
      >
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-cocoa-700">
          Advanced analysis
        </summary>
        <div className="border-t border-cream-200 p-3">
          <ActivityScatterChart
            points={chartAnalytics.scatterPoints}
            periodLabel={movementPeriodLabel}
          />
        </div>
      </details>
    </section>
  );

  const reportSections = (
    <>
      {overviewSection}
      {inventorySection}
      {movementsSection}
      {performanceSection}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-cream-200 pt-3 text-[11px] text-cocoa-400">
        <span>{filterDescription}</span>
        <span>Stock status reflects quantity only · {businessName}</span>
      </div>
    </>
  );

  const tabContent = {
    overview: overviewSection,
    inventory: inventorySection,
    movements: movementsSection,
    performance: performanceSection,
  }[activeTab];

  return (
    <div className="space-y-5" data-pull-to-refresh {...pullToRefresh.handlers}>
      {pullToRefresh.indicator}
      {pageHeader}

      {alerts}

      {filterPanel}

      {tabBar}

      {tabContent}

      {reportPreviewOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-2 sm:p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !emailSending) {
              setReportPreviewOpen(false);
              setEmailModalOpen(false);
            }
          }}
        >
          <section
            ref={previewPanelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-preview-title"
            tabIndex={-1}
            className="flex max-h-[96vh] w-full max-w-7xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl outline-none"
          >
            <header className="flex items-center justify-between gap-4 border-b border-cream-200 px-4 py-3 sm:px-6">
              <div>
                <h2 id="report-preview-title" className="text-lg font-bold text-cocoa-800">
                  Export report
                </h2>
                <p className="text-xs text-cocoa-400">
                  Preview of the current filtered stock dashboard
                </p>
                <p className="mt-0.5 text-[10px] leading-4 text-cocoa-400">
                  Matching rows are included up to the report safety caps
                  (by default 10,000 items / 5,000 transactions). Completeness
                  is verified from the shared report builder before download.
                </p>
                <div className="mt-2 rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-[11px] text-cocoa-700">
                  {reportPreviewCompletenessLoading && (
                    <p>Verifying report completeness…</p>
                  )}
                  {reportPreviewCompletenessError && (
                    <p role="alert" className="text-terracotta-700">
                      Could not verify completeness: {reportPreviewCompletenessError}
                    </p>
                  )}
                  {reportPreviewCompleteness && (
                    <>
                      <p>
                        Catalogue items:{" "}
                        <strong>
                          {reportPreviewCompleteness.completeness.items === "complete"
                            ? "Complete"
                            : "Truncated"}
                        </strong>{" "}
                        ({reportPreviewCompleteness.completeness.itemsScanned.toLocaleString("en-PH")} scanned of cap{" "}
                        {reportPreviewCompleteness.completeness.itemCap.toLocaleString("en-PH")})
                      </p>
                      <p>
                        Transactions:{" "}
                        <strong>
                          {reportPreviewCompleteness.completeness.movements === "complete"
                            ? "Complete"
                            : "Truncated"}
                        </strong>{" "}
                        ({reportPreviewCompleteness.completeness.movementsScanned.toLocaleString("en-PH")} scanned of cap{" "}
                        {reportPreviewCompleteness.completeness.movementCap.toLocaleString("en-PH")})
                      </p>
                      {reportPreviewCompleteness.warnings.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-terracotta-700">
                          {reportPreviewCompleteness.warnings.map((warning) => (
                            <li key={warning}>{warning}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                  {!reportPreviewCompletenessLoading &&
                    !reportPreviewCompletenessError &&
                    !reportPreviewCompleteness && (
                      <p>Completeness not yet verified.</p>
                    )}
                </div>
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

                {reportSections}

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
