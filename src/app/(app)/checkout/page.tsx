"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  Card,
  Modal,
  Badge,
  Toast,
  DataCard,
  DataField,
  ConfirmDialog,
} from "@/components/ui";
import { fmtQty, fmtDate, daysUntil } from "@/lib/format";
import { expiryStatus, stockStatus } from "@/lib/status";
import { useScanFocus } from "@/lib/use-scan-focus";

type Mode = "checkout" | "restock" | "waste";

type CartLine = {
  sku: string;
  name: string;
  unit: string;
  qty: number;
  onHand: number;
  expirable: boolean;
  maxQty: number;
  batchId: string | null;
  batchCode: string | null;
  wasteReason: string;
  batches: InventoryBatch[];
  allocationMode: "auto" | "manual";
  selectedBatchKey: string;
  batchPickerOpen: boolean;
  batchQuantities: Record<string, number>;
  /** Mirrors items.low_stock_threshold, kept so warnings work after a commit. */
  threshold: number;
  expiry: string | null;
  /**
   * Expiry being entered for this restock, as YYYY-MM-DD. Empty means "leave
   * the item's existing date alone". Only ever sent for a restock — a checkout
   * or a waste log has no new batch to date, and must not overwrite one.
   */
  newExpiry: string;
  /**
   * Restock counted in boxes rather than in the item's own unit. null means the
   * line is counted normally. The conversion to the item's unit happens in the
   * database, which owns `units_per_box` — a browser-side guess would put the
   * wrong figure into stock.
   */
  byBox: boolean;
  /** The item's packaging factor, shown so the conversion is not a surprise. */
  unitsPerBox: number | null;
  /** Minimum shelf life the item's location demands, in days, or null. */
  minShelfLife: number | null;
};

type PendingWasteSelection = {
  sku: string;
  batch: InventoryBatch;
  item?: Looked;
};

type NoteEntry = {
  id: number;
  sku: string;
  text: string;
};

type Looked = {
  sku: string;
  name: string;
  unit: string;
  units_per_box: number | null;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  expirable: boolean;
  batches?: InventoryBatch[];
  location: { id: string; name: string; min_shelf_life_days: number | null } | null;
};

type InventoryBatch = {
  id: string;
  batch_code: string;
  received_quantity: number;
  remaining_quantity: number;
  expiration_date: string | null;
  received_at: string;
};

type BatchMenuPosition = {
  sku: string;
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

/** The supplier dropdown on a restock: an id and the name to show. */
type SupplierRef = { id: string; name: string };

/** A dismissible message about the item that was just scanned. */
type Notice = {
  /** sku + kind, so re-scanning the same item replaces the notice. */
  id: string;
  /**
   * `info` is for a confirmation — "you scanned the batch dated March" — which
   * is neither good nor bad news and must not be painted the same amber as a
   * genuine warning. It was missing from this union while call sites were
   * already passing it, so every such notice rendered as a warning.
   */
  tone: "info" | "warn" | "error";
  title: string;
  detail?: string;
};

const MAX_NOTICES = 4;
const NOTICE_DURATION_MS = 10_000;
const NOTICE_FADE_MS = 220;

function getBatchMenuPosition(
  line: CartLine,
  anchor: HTMLButtonElement
): BatchMenuPosition {
  const today = new Date().toISOString().slice(0, 10);
  const optionCount = new Set(
    line.batches
      .filter(
        (batch) =>
          Number(batch.remaining_quantity) > 0 &&
          (!batch.expiration_date || batch.expiration_date.slice(0, 10) >= today)
      )
      .map((batch) => batch.expiration_date?.slice(0, 10) ?? "no-expiry")
  ).size;
  const rect = anchor.getBoundingClientRect();
  const desiredHeight = Math.min(240, 56 + (optionCount + 1) * 40);
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const placeBelow = spaceBelow >= desiredHeight || spaceBelow >= spaceAbove;
  const maxHeight = Math.max(
    80,
    Math.min(desiredHeight, placeBelow ? spaceBelow : spaceAbove)
  );
  const width = Math.min(180, window.innerWidth - 16);
  const top = placeBelow
    ? rect.bottom + 6
    : Math.max(8, rect.top - maxHeight - 6);
  const left = Math.max(
    8,
    Math.min(rect.right - width, window.innerWidth - width - 8)
  );
  return { sku: line.sku, top, left, width, maxHeight };
}

const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "checkout", label: "Checkout", hint: "Deduct stock for items used" },
  { key: "restock", label: "Restock", hint: "Add stock received from supplier" },
  { key: "waste", label: "Log Waste", hint: "Deduct stock for spoilage or spills" },
];

const DEDUCTING: Mode[] = ["checkout", "waste"];

const MODE_VERB: Record<Mode, string> = {
  checkout: "Checked out",
  restock: "Restocked",
  waste: "Logged waste for",
};

const MODE_TITLE: Record<Mode, string> = {
  checkout: "Confirm checkout",
  restock: "Confirm restock",
  waste: "Confirm waste log",
};

const MODE_BADGE: Record<Mode, "blue" | "green" | "amber"> = {
  checkout: "blue",
  restock: "green",
  waste: "amber",
};

const QUICK_ITEMS: Looked[] = [
  { sku: "QC-ARABICA", name: "Arabica Coffee Beans", unit: "kg", units_per_box: null, quantity: 50, low_stock_threshold: 10, expiration_date: null, expirable: true, location: null },
  { sku: "QC-MILK", name: "Fresh Milk", unit: "L", units_per_box: null, quantity: 40, low_stock_threshold: 8, expiration_date: null, expirable: true, location: null },
  { sku: "QC-VANILLA", name: "Vanilla Syrup", unit: "bottles", units_per_box: null, quantity: 25, low_stock_threshold: 5, expiration_date: null, expirable: true, location: null },
  { sku: "QC-CUPS", name: "16oz Paper Cups", unit: "pcs", units_per_box: null, quantity: 500, low_stock_threshold: 100, expiration_date: null, expirable: false, location: null },
  { sku: "QC-LIDS", name: "Cup Lids", unit: "pcs", units_per_box: null, quantity: 500, low_stock_threshold: 100, expiration_date: null, expirable: false, location: null },
];

function CheckoutNoticeCard({
  notice,
  onDismiss,
}: {
  notice: Notice;
  onDismiss: (id: string) => void;
}) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const fadeTimeout = window.setTimeout(
      () => setFading(true),
      NOTICE_DURATION_MS
    );
    const dismissTimeout = window.setTimeout(
      () => onDismiss(notice.id),
      NOTICE_DURATION_MS + NOTICE_FADE_MS
    );

    return () => {
      window.clearTimeout(fadeTimeout);
      window.clearTimeout(dismissTimeout);
    };
  }, [notice, onDismiss]);

  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className={`notice-pop-right pointer-events-none flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm shadow-warm ${
        fading ? "notice-fade-out" : ""
      } ${
        notice.tone === "error"
          ? "border-terracotta-500/40 bg-terracotta-50 text-terracotta-700"
          : notice.tone === "warn"
            ? "border-ochre-500/40 bg-ochre-50 text-ochre-700"
            : "border-cocoa-200 bg-cream-50 text-cocoa-700"
      }`}
    >
      <div className="min-w-0">
        <div className="font-semibold">{notice.title}</div>
        {notice.detail && (
          <div className="mt-0.5 text-[11px] leading-snug opacity-80">
            {notice.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(notice.id)}
        aria-label="Dismiss"
        className="pointer-events-auto shrink-0 rounded-full px-1.5 text-xs font-bold opacity-60 transition-opacity hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

export default function CheckoutPage() {
  const pathname = usePathname();
  const [mode, setMode] = useState<Mode>("checkout");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [batchMenuPosition, setBatchMenuPosition] =
    useState<BatchMenuPosition | null>(null);
  const batchMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const pendingCartScrollSku = useRef<string | null>(null);
  const desktopCartScrollRef = useRef<HTMLDivElement>(null);
  const [pendingRemoval, setPendingRemoval] = useState<CartLine | null>(null);
  const [pendingWasteSelection, setPendingWasteSelection] =
    useState<PendingWasteSelection | null>(null);
  const [pendingWasteReason, setPendingWasteReason] = useState("");
  const [scanning, setScanning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmationCredential, setConfirmationCredential] = useState("");
  const [noteEntries, setNoteEntries] = useState<NoteEntry[]>([{ id: 1, sku: "", text: "" }]);
  const nextNoteEntryId = useRef(2);
  const [noteOpen, setNoteOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [quickQtys, setQuickQtys] = useState<Record<string, number>>({});

  /* Who delivered this restock. Optional, and restock-only: it is written back
     to every item in the cart as the supplier it was last received from, which
     is what the low-stock alert later shows as the number to call. */
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  const [supplierId, setSupplierId] = useState("");

  /* ---------------- search ---------------- */
  const [searchText, setSearchText] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchResults, setSearchResults] = useState<Looked[]>([]);
  const [allItems, setAllItems] = useState<Looked[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const keyboardOpen = keyboardInset > 0;
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchScrollMinimumRef = useRef<number | null>(null);
  const [searchDropdownPosition, setSearchDropdownPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  useEffect(() => {
    const updateKeyboardInset = () => {
      if (window.matchMedia("(min-width: 1024px)").matches) {
        setKeyboardInset(0);
        return;
      }

      const viewport = window.visualViewport;
      const inset = viewport
        ? Math.max(
            0,
            window.innerHeight - viewport.height - viewport.offsetTop
          )
        : 0;
      setKeyboardInset(inset > 100 ? inset : 0);
    };

    updateKeyboardInset();
    window.addEventListener("resize", updateKeyboardInset);
    window.visualViewport?.addEventListener("resize", updateKeyboardInset);
    window.visualViewport?.addEventListener("scroll", updateKeyboardInset);
    return () => {
      window.removeEventListener("resize", updateKeyboardInset);
      window.visualViewport?.removeEventListener("resize", updateKeyboardInset);
      window.visualViewport?.removeEventListener("scroll", updateKeyboardInset);
    };
  }, []);

  const updateSearchDropdownPosition = useCallback(() => {
    const input = searchInputRef.current;
    if (!input) return;

    const inputRect = input.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const mainTop =
      searchRef.current?.closest<HTMLElement>(".app-main")?.getBoundingClientRect().top ??
      viewportTop;
    const visibleTop = Math.max(viewportTop, mainTop) + 8;
    const visibleBottom = viewportBottom - 8;
    const belowSpace = Math.max(0, visibleBottom - inputRect.bottom - 4);
    const aboveSpace = Math.max(0, inputRect.top - visibleTop - 4);
    const openAbove = belowSpace < 140 && aboveSpace > belowSpace;
    const maxHeight = Math.min(320, openAbove ? aboveSpace : belowSpace);

    setSearchDropdownPosition({
      top: openAbove
        ? Math.max(visibleTop, inputRect.top - maxHeight - 4)
        : inputRect.bottom + 4,
      left: inputRect.left,
      width: inputRect.width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!showDropdown || searchResults.length === 0) return;

    let frame = 0;
    const schedulePositionUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateSearchDropdownPosition);
    };
    const viewport = window.visualViewport;

    schedulePositionUpdate();
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    viewport?.addEventListener("resize", schedulePositionUpdate);
    viewport?.addEventListener("scroll", schedulePositionUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      viewport?.removeEventListener("resize", schedulePositionUpdate);
      viewport?.removeEventListener("scroll", schedulePositionUpdate);
    };
  }, [showDropdown, searchResults.length, updateSearchDropdownPosition]);

  useEffect(() => {
    const main = searchRef.current?.closest<HTMLElement>(".app-main");
    if (!main) return;

    const previousPaddingBottom = main.style.paddingBottom;
    const previousOverflowY = main.style.overflowY;
    const previousTouchAction = main.style.touchAction;
    const previousOverscrollBehaviorY = main.style.overscrollBehaviorY;
    main.style.paddingBottom = keyboardInset > 0 ? `${keyboardInset}px` : "";
    if (keyboardInset > 0) {
      main.style.overflowY = "auto";
      main.style.touchAction = "pan-y";
      main.style.overscrollBehaviorY = "contain";
    }
    return () => {
      main.style.paddingBottom = previousPaddingBottom;
      main.style.overflowY = previousOverflowY;
      main.style.touchAction = previousTouchAction;
      main.style.overscrollBehaviorY = previousOverscrollBehaviorY;
    };
  }, [keyboardInset]);

  useEffect(() => {
    const main = searchRef.current?.closest<HTMLElement>(".app-main");
    if (!main || !keyboardOpen || !searchFocused) {
      searchScrollMinimumRef.current = null;
      return;
    }

    const keepSearchAtTop = () => {
      const minimum = searchScrollMinimumRef.current;
      if (minimum !== null && main.scrollTop < minimum) {
        main.scrollTop = minimum;
      }
    };

    main.addEventListener("scroll", keepSearchAtTop, { passive: true });
    return () => {
      main.removeEventListener("scroll", keepSearchAtTop);
    };
  }, [keyboardOpen, searchFocused]);

  useEffect(() => {
    if (!keyboardOpen || !searchFocused) return;

    const frame = window.requestAnimationFrame(() => {
      const search = searchRef.current;
      const main = searchRef.current?.closest<HTMLElement>(".app-main");
      if (search && main) {
        const scrollDelta =
          search.getBoundingClientRect().top - main.getBoundingClientRect().top;
        if (scrollDelta > 1) {
          const currentBottomPadding = Number.parseFloat(main.style.paddingBottom) || 0;
          main.style.paddingBottom = `${Math.max(currentBottomPadding, Math.ceil(scrollDelta) + 8)}px`;
        }
        if (Math.abs(scrollDelta) > 1) {
          main.scrollTop = Math.max(0, main.scrollTop + scrollDelta);
        }
        searchScrollMinimumRef.current = main.scrollTop;
      }
      window.requestAnimationFrame(updateSearchDropdownPosition);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [keyboardOpen, searchFocused, updateSearchDropdownPosition]);

  useEffect(() => {
    const sku = pendingCartScrollSku.current;
    if (sku) pendingCartScrollSku.current = null;
    if (!sku || !window.matchMedia("(min-width: 1024px)").matches) return;

    const frame = window.requestAnimationFrame(() => {
      const desktopScroller = desktopCartScrollRef.current;
      const desktopRow = desktopScroller
        ? Array.from(
            desktopScroller.querySelectorAll<HTMLElement>("[data-cart-sku]")
          ).find((row) => row.dataset.cartSku === sku)
        : null;

      if (desktopScroller && desktopRow) {
        const scrollerRect = desktopScroller.getBoundingClientRect();
        const rowRect = desktopRow.getBoundingClientRect();
        const stickyHeaderOffset = 40;
        if (rowRect.bottom > scrollerRect.bottom) {
          desktopScroller.scrollBy({
            top: rowRect.bottom - scrollerRect.bottom + 12,
            behavior: "smooth",
          });
        } else if (rowRect.top < scrollerRect.top + stickyHeaderOffset) {
          desktopScroller.scrollBy({
            top: rowRect.top - scrollerRect.top - stickyHeaderOffset,
            behavior: "smooth",
          });
        }
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [cart]);

  useEffect(() => {
    if (pathname !== "/checkout") setNoteOpen(false);
  }, [pathname]);

  /*
   * A USB scanner types and presses Enter with no click, so the field has to take
   * focus back after the operator touches something else. `autoFocus` only fires
   * on mount and is not enough on a till.
   *
   * Suspended while the results dropdown is open: it is a listbox, it holds focus,
   * and stealing it back mid-arrow-key-navigation would make the dropdown
   * unusable. See src/lib/use-scan-focus.ts.
   */
  useScanFocus(searchInputRef, !showDropdown);

  // Fetch all items once for local search
  useEffect(() => {
    fetch("/api/items?limit=500")
      .then((r) => r.json())
      .then((data) => {
        if (data.items) {
          setAllItems(
            data.items.map((i: any) => ({
              sku: i.sku,
              name: i.name,
              unit: i.unit,
              units_per_box: i.units_per_box,
              quantity: i.quantity,
              low_stock_threshold: i.low_stock_threshold,
              expiration_date: i.expiration_date,
              expirable: i.expirable ?? true,
              batches: i.batches ?? [],
              location: i.location,
            }))
          );
        }
      })
      .catch(() => {});
  }, []);

  // Suppliers for the restock dropdown. Failure is silent: the restock still
  // works without a supplier, so a reference list that cannot load must not
  // block the till or colour the screen with an error about something optional.
  useEffect(() => {
    let alive = true;
    fetch("/api/refs/suppliers")
      .then((r) => r.json())
      .then((data) => {
        if (alive && Array.isArray(data.items)) setSuppliers(data.items);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Filter items as the user types. `allItems` is a dependency because it
  // arrives asynchronously: without it, a query typed before the fetch landed
  // matched against an empty list and never re-ran, so the dropdown stayed shut.
  useEffect(() => {
    const query = searchText.trim().toLowerCase();
    if (query.length === 0) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    const matches = allItems.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.sku.toLowerCase().includes(query)
    );
    setSearchResults(matches.slice(0, 8));
    setShowDropdown(matches.length > 0);
  }, [searchText, allItems]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        searchRef.current &&
        !searchRef.current.contains(e.target as Node) &&
        !(e.target as Element).closest?.("[data-checkout-search-dropdown]")
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function handleSearchAdd(item: Looked) {
    setSearchText("");
    setShowDropdown(false);
    setSearchResults([]);
    const soonBatches = (item.batches ?? [])
      .flatMap((batch) => {
        if (Number(batch.remaining_quantity) <= 0) return [];
        const status = expiryStatus(batch.expiration_date);
        return status.key === "soon" && status.days !== null
          ? [status.days]
          : [];
      })
      .sort((a, b) => a - b);
    const expiryWarning =
      (soonBatches.length > 0
        ? { key: "soon" as const, days: soonBatches[0] }
        : null) ??
      ((item.batches ?? []).length === 0
        ? expiryStatus(item.expiration_date)
        : null);

    // Blocking: out of stock
    if (deducting && Number(item.quantity) <= 0) {
      pushNotice({
        id: `${item.sku}:out`,
        tone: "error",
        title: `${item.name} is out of stock`,
        detail: "Nothing left to deduct, so it was not added to the cart.",
      });
      return;
    }

    if (mode === "checkout" && availableQuantity(item) <= 0) {
      pushNotice({
        id: `${item.sku}:expired`,
        tone: "error",
        title: `${item.name} has no usable stock`,
        detail: "All remaining batches are expired. Log them as waste before checkout.",
      });
      return;
    }

    if (mode === "waste" && expiredBatchQuantityFor(item.batches ?? []) <= 0) {
      const freshBatch = remainingBatches(item.batches ?? []).find(
        (batch) => !isBatchExpired(batch)
      );
      if (freshBatch) {
        promptWasteReason(item, freshBatch);
        return;
      }
    }

    upsert(item);

    // Non-blocking warnings
    if (deducting && Number(item.quantity) <= (Number(item.low_stock_threshold) || 0)) {
      pushNotice({
        id: `${item.sku}:low`,
        tone: "warn",
        title: `Low stock: ${fmtQty(Number(item.quantity), item.unit)} of ${item.name} left`,
        detail: `At or below the ${fmtQty(
          Number(item.low_stock_threshold) || 0,
          item.unit
        )} threshold — consider restocking.`,
      });
    }

    if (expiryWarning?.key === "soon") {
      pushNotice({
        id: `${item.sku}:soon`,
        tone: "warn",
        title: `${item.name} expires in ${expiryWarning.days} day(s)`,
        detail: deducting ? "Use this one first." : "Consider using the existing stock first.",
      });
    }
  }

  const deducting = DEDUCTING.includes(mode);
  const totalQty = useMemo(() => cart.reduce((n, l) => n + l.qty, 0), [cart]);
  const ready = cart.length > 0 && totalQty > 0;
  const hasNote = noteEntries.some((entry) => entry.text.trim());

  /*
   * The "needs attention" rail.
   *
   * Memoised because it filters the full item list — up to 500 rows, fetched at
   * :135 — and the render below reads it twice, for the count and for the list.
   * Unmemoised, that scan ran twice on every single render, including every
   * keystroke in the search box and every qty stepper click in the cart.
   */
  const needsAttention = useMemo(
    () =>
      allItems.filter((item) => {
        const s = stockStatus(item.quantity, item.low_stock_threshold);
        const batches = (item.batches ?? []).filter(
          (batch) => Number(batch.remaining_quantity) > 0
        );
        const hasBatchExpiry = batches.some((batch) => {
          const status = expiryStatus(batch.expiration_date);
          return status.key === "expired" || status.key === "soon";
        });
        const itemExpiry = expiryStatus(item.expiration_date);
        return (
          s.key === "out" ||
          s.key === "low" ||
          (batches.length > 0
            ? hasBatchExpiry
            : Number(item.quantity) > 0 &&
              (itemExpiry.key === "expired" || itemExpiry.key === "soon"))
        );
      }),
    [allItems]
  );

  function availableQuantity(item: Looked): number {
    const batches = item.batches ?? [];
    if (batches.length === 0) {
      return expiryStatus(item.expiration_date).key === "expired"
        ? 0
        : Number(item.quantity);
    }

    const today = new Date().toISOString().slice(0, 10);
    return batches.reduce((total, batch) => {
      const usable =
        Number(batch.remaining_quantity) > 0 &&
        (!batch.expiration_date || batch.expiration_date >= today);
      return total + (usable ? Number(batch.remaining_quantity) : 0);
    }, 0);
  }

  function usableBatches(batches: InventoryBatch[]): InventoryBatch[] {
    const today = new Date().toISOString().slice(0, 10);
    return remainingBatches(batches).filter(
      (batch) =>
        !batch.expiration_date || batch.expiration_date.slice(0, 10) >= today
    );
  }

  function remainingBatches(batches: InventoryBatch[]): InventoryBatch[] {
    return [...batches]
      .filter((batch) => Number(batch.remaining_quantity) > 0)
      .sort((a, b) => {
        if (!a.expiration_date) return b.expiration_date ? 1 : 0;
        if (!b.expiration_date) return -1;
        return a.expiration_date.localeCompare(b.expiration_date);
      });
  }

  function isBatchExpired(batch: InventoryBatch): boolean {
    return Boolean(
      batch.expiration_date &&
        batch.expiration_date.slice(0, 10) <
          new Date().toISOString().slice(0, 10)
    );
  }

  function expiredBatchQuantityFor(batches: InventoryBatch[]): number {
    return batches.reduce(
      (total, batch) =>
        isBatchExpired(batch)
          ? total + Math.max(0, Number(batch.remaining_quantity) || 0)
          : total,
      0
    );
  }

  function isOutOfStock(item: Looked): boolean {
    if (!deducting) return false;
    return mode === "checkout"
      ? availableQuantity(item) <= 0
      : Number(item.quantity) <= 0;
  }

  /* ---------------- notices ---------------- */

  function pushNotice(notice: Notice) {
    setNotices((prev) =>
      [notice, ...prev.filter((n) => n.id !== notice.id)].slice(0, MAX_NOTICES)
    );
  }

  const dismissNotice = useCallback((id: string) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  function clearLookupNotice() {
    setNotices((prev) => prev.filter((notice) => !notice.id.startsWith("lookup:")));
  }

  /* ---------------- cart ---------------- */

  function upsert(
    item: Looked,
    scannedBatch: InventoryBatch | null = null,
    wasteReason = ""
  ) {
    const onHand = Number(item.quantity);
    const threshold = Number(item.low_stock_threshold) || 0;
    const expiry = item.expiration_date ?? null;
    const maxQty = scannedBatch
      ? Number(scannedBatch.remaining_quantity)
      : mode === "checkout"
        ? availableQuantity(item)
        : mode === "waste" && !scannedBatch
          ? expiredBatchQuantityFor(item.batches ?? [])
          : onHand;
    // Counted by the box only when the item actually has a packaging factor.
    // Offering the option for an item without one would let someone enter a box
    // count that the database then rejects.
    const unitsPerBox =
      item.units_per_box == null ? null : Number(item.units_per_box);
    const minShelfLife =
      item.location?.min_shelf_life_days == null
        ? null
        : Number(item.location.min_shelf_life_days);

    const existing = cart.find((line) => line.sku === item.sku);
    if (existing?.allocationMode === "manual") {
      pushNotice({
        id: `${item.sku}:manual-allocation`,
        tone: "info",
        title: `${item.name} already has manual batch selections`,
        detail:
          "Adjust its selected batch quantities in the cart, or switch it back to Auto FEFO before adding it again.",
      });
      return;
    }
    if (
      existing?.batchId &&
      scannedBatch &&
      existing.batchId !== scannedBatch.id
    ) {
      pushNotice({
        id: `${item.sku}:batch-conflict`,
        tone: "error",
        title: `${item.name} is already in the cart`,
        detail:
          "Remove it before selecting a different batch for this movement.",
      });
      return;
    }

    pendingCartScrollSku.current = item.sku;
    setCart((prev) => {
      const current = prev.find((l) => l.sku === item.sku);

      if (!current) {
        return [
          ...prev,
          {
            sku: item.sku,
            name: item.name,
            unit: item.unit,
            qty: deducting ? Math.min(1, maxQty) : 1,
            onHand,
            expirable: item.expirable ?? true,
            maxQty,
            batchId: scannedBatch?.id ?? null,
            batchCode: scannedBatch?.batch_code ?? null,
            wasteReason,
            batches: item.batches ?? [],
            allocationMode: "auto",
            selectedBatchKey: "auto",
            batchPickerOpen: false,
            batchQuantities: {},
            threshold,
            expiry,
            newExpiry: "",
            byBox: false,
            unitsPerBox,
            minShelfLife,
          },
        ];
      }

      const next = current.qty + 1;
      return prev.map((l) =>
        l.sku === item.sku
          ? {
              ...l,
              name: item.name,
              unit: item.unit,
              onHand,
              expirable: item.expirable ?? true,
              maxQty: scannedBatch ? maxQty : current.maxQty,
              batchId: scannedBatch?.id ?? current.batchId,
              batchCode: scannedBatch?.batch_code ?? current.batchCode,
              wasteReason: wasteReason || current.wasteReason,
              batches: item.batches ?? l.batches,
              batchQuantities: l.batchQuantities,
              allocationMode: l.allocationMode,
              selectedBatchKey: l.selectedBatchKey,
              batchPickerOpen: l.batchPickerOpen,
              threshold,
              expiry,
              // Re-scanning must not wipe a date the operator already typed, or
              // flip the box toggle they chose.
              newExpiry: l.newExpiry,
              byBox: l.byBox && unitsPerBox !== null,
              unitsPerBox,
              minShelfLife,
              qty: deducting ? Math.min(next, scannedBatch ? maxQty : current.maxQty) : next,
            }
          : l
      );
    });
  }

  function setQty(sku: string, value: number) {
    setCart((prev) =>
      prev.map((l) => {
        if (l.sku !== sku) return l;
        let q = Number.isFinite(value) ? value : l.qty;
        if (q < 0) q = 0;
        if (l.allocationMode === "manual") {
          const selectedBatches = usableBatches(l.batches).filter(
            (batch) => batchKey(batch) === l.selectedBatchKey
          );
          const available = selectedBatches.reduce(
            (sum, batch) => sum + Number(batch.remaining_quantity),
            0
          );
          q = Math.min(q, available);
          return {
            ...l,
            qty: q,
            batchQuantities: allocateBatches(selectedBatches, q),
          };
        }
        // Deducting more than we hold would be rejected by the database.
        if (deducting && q > l.maxQty) q = l.maxQty;
        return { ...l, qty: q };
      })
    );
  }

  function selectWasteBatch(sku: string, batchId: string) {
    setCart((prev) =>
      prev.map((line) => {
        if (line.sku !== sku) return line;
        if (batchId === "auto") {
          const maxQty = expiredBatchQuantityFor(line.batches);
          return {
            ...line,
            batchId: null,
            batchCode: null,
            maxQty,
            qty: Math.min(line.qty || (maxQty > 0 ? 1 : 0), maxQty),
          };
        }

        const batch = line.batches.find((candidate) => candidate.id === batchId);
        if (!batch) return line;
        const maxQty = Number(batch.remaining_quantity);
        return {
          ...line,
          batchId: batch.id,
          batchCode: batch.batch_code,
          maxQty,
          qty: Math.min(line.qty || 1, maxQty),
        };
      })
    );
  }

  function requestWasteBatchSelection(
    line: CartLine,
    batchId: string,
    item?: Looked
  ) {
    if (batchId === "auto") {
      selectWasteBatch(line.sku, batchId);
      return;
    }

    const batch = line.batches.find((candidate) => candidate.id === batchId);
    if (!batch) return;
    if (!isBatchExpired(batch)) {
      setPendingWasteSelection({ sku: line.sku, batch, item });
      setPendingWasteReason("");
      return;
    }

    selectWasteBatch(line.sku, batchId);
  }

  function promptWasteReason(item: Looked, batch: InventoryBatch) {
    setPendingWasteSelection({ sku: item.sku, batch, item });
    setPendingWasteReason("");
    setSubmitError(null);
  }

  function confirmWasteBatchSelection() {
    const pending = pendingWasteSelection;
    const reason = pendingWasteReason.trim();
    if (!pending) return;
    if (!reason) {
      setSubmitError("Enter a reason before logging waste from non-expired stock.");
      return;
    }

    if (pending.item) {
      upsert(pending.item, pending.batch, reason);
    } else {
      selectWasteBatch(pending.sku, pending.batch.id);
      setWasteReason(pending.sku, reason);
    }
    setPendingWasteSelection(null);
    setPendingWasteReason("");
    setSubmitError(null);
  }

  function setWasteReason(sku: string, wasteReason: string) {
    setCart((prev) =>
      prev.map((line) => (line.sku === sku ? { ...line, wasteReason } : line))
    );
  }

  function requiresWasteReason(line: CartLine): boolean {
    if (mode !== "waste" || !line.batchId) return false;
    const batch = line.batches.find((candidate) => candidate.id === line.batchId);
    return Boolean(batch && !isBatchExpired(batch));
  }

  function wasteBatchSelector(line: CartLine) {
    if (mode !== "waste") return null;
    return (
      <label className="mt-2 block text-[11px] text-cocoa-500">
        Waste from
        <select
          className="input mt-1 w-full text-xs"
          value={line.batchId ?? "auto"}
          onChange={(event) =>
            requestWasteBatchSelection(line, event.target.value)
          }
          aria-label={`Select waste batch for ${line.name}`}
        >
          <option value="auto">
            Auto — expired batches only ({fmtQty(expiredBatchQuantityFor(line.batches), line.unit)})
          </option>
          {remainingBatches(line.batches).map((batch) => (
            <option key={batch.id} value={batch.id}>
              {batch.batch_code} · {batch.expiration_date ? fmtDate(batch.expiration_date) : "No expiry"} ·{" "}
              {fmtQty(Number(batch.remaining_quantity), line.unit)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  function batchKey(batch: InventoryBatch): string {
    return batch.expiration_date?.slice(0, 10) ?? "no-expiry";
  }

  function allocateBatches(
    batches: InventoryBatch[],
    quantity: number
  ): Record<string, number> {
    let remaining = quantity;
    const allocations: Record<string, number> = {};
    for (const batch of batches) {
      const allocated = Math.min(
        remaining,
        Number(batch.remaining_quantity)
      );
      if (allocated > 0) allocations[batch.id] = allocated;
      remaining -= allocated;
      if (remaining <= 0) break;
    }
    return allocations;
  }

  function setBatchSelection(sku: string, selectedBatchKey: string) {
    batchMenuAnchorRef.current = null;
    setBatchMenuPosition(null);
    setCart((prev) =>
      prev.map((line) => {
        if (line.sku !== sku || line.batchId) return line;
        if (selectedBatchKey === "auto") {
          return {
            ...line,
            allocationMode: "auto",
            selectedBatchKey,
            batchPickerOpen: false,
            batchQuantities: {},
            maxQty: usableBatches(line.batches).reduce(
              (sum, batch) => sum + Number(batch.remaining_quantity),
              0
            ),
          };
        }

        const selectedBatches = remainingBatches(line.batches).filter(
          (batch) => batchKey(batch) === selectedBatchKey
        );
        const usableSelection = selectedBatches.filter(
          (batch) => !isBatchExpired(batch)
        );
        const maxQty = usableSelection.reduce(
          (sum, batch) => sum + Number(batch.remaining_quantity),
          0
        );
        const qty = Math.min(line.qty, maxQty);
        return {
          ...line,
          allocationMode: "manual",
          selectedBatchKey,
          batchPickerOpen: false,
          maxQty,
          qty,
          batchQuantities: allocateBatches(usableSelection, qty),
        };
      })
    );
  }

  function toggleBatchPicker(sku: string) {
    const line = cart.find((candidate) => candidate.sku === sku);
    if (!line) return;
    if (line.batchPickerOpen) {
      batchMenuAnchorRef.current = null;
      setBatchMenuPosition(null);
    } else {
      const anchor = batchMenuAnchorRef.current;
      if (anchor) setBatchMenuPosition(getBatchMenuPosition(line, anchor));
    }

    setCart((prev) =>
      prev.map((line) =>
        line.sku === sku ? { ...line, batchPickerOpen: !line.batchPickerOpen } : {
          ...line,
          batchPickerOpen: false,
        }
      )
    );
  }

  function getBatchOptions(line: CartLine) {
    return Array.from(
      new Set(usableBatches(line.batches).map((batch) => batchKey(batch)))
    ).map((key) => ({
      key,
      label: key === "no-expiry" ? "No expiry date" : fmtDate(key),
    }));
  }

  const openBatchLine = cart.find((line) => line.batchPickerOpen);

  useEffect(() => {
    if (!openBatchLine) return;

    const repositionMenu = () => {
      let anchor = batchMenuAnchorRef.current;
      if (!anchor?.isConnected || anchor.getClientRects().length === 0) {
        anchor = Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-batch-picker-trigger]")
        ).find(
          (button) =>
            button.dataset.batchPickerTrigger === openBatchLine.sku &&
            button.getClientRects().length > 0
        ) ?? null;
        batchMenuAnchorRef.current = anchor;
      }

      if (anchor) {
        setBatchMenuPosition(getBatchMenuPosition(openBatchLine, anchor));
      }
    };

    window.addEventListener("scroll", repositionMenu, true);
    window.addEventListener("resize", repositionMenu);
    repositionMenu();
    return () => {
      window.removeEventListener("scroll", repositionMenu, true);
      window.removeEventListener("resize", repositionMenu);
    };
  }, [openBatchLine]);

  function allocationControls(line: CartLine) {
    if (mode !== "checkout" || line.batchId) {
      return null;
    }

    const candidates = usableBatches(line.batches);
    const batchOptions = getBatchOptions(line);
    const automaticExpiry = candidates[0]?.expiration_date
      ? fmtDate(candidates[0].expiration_date)
      : "No expiry date";
    const selectedExpiry =
      line.allocationMode === "auto"
        ? automaticExpiry
        : line.selectedBatchKey === "no-expiry"
          ? "No expiry date"
          : fmtDate(line.selectedBatchKey);

    return (
      <div className="flex min-h-[2.5rem] min-w-0 items-center">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-cocoa-700">
              {line.allocationMode === "auto" ? "Auto FEFO" : "Selected batch"}
            </div>
            <div className="truncate text-[10px] text-cocoa-400">
              {line.allocationMode === "auto" ? "Expires " : ""}
              {selectedExpiry}
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost shrink-0 !px-2 !py-1 text-[11px]"
            data-batch-picker-trigger={line.sku}
            aria-expanded={line.batchPickerOpen}
            aria-controls={`batch-picker-${line.sku}`}
            onClick={(event) => {
              batchMenuAnchorRef.current = event.currentTarget;
              toggleBatchPicker(line.sku);
            }}
          >
            {line.batchPickerOpen ? "Done" : "Change"}
          </button>
        </div>
      </div>
    );
  }

  function setNewExpiry(sku: string, value: string) {
    setCart((prev) => prev.map((l) => (l.sku === sku ? { ...l, newExpiry: value } : l)));
  }

  function setByBox(sku: string, byBox: boolean) {
    setCart((prev) =>
      prev.map((l) => {
        if (l.sku !== sku) return l;
        // Switching back to loose counting must not leave a stale box figure
        // behind, and switching on starts the count again at 1 rather than
        // inheriting whatever the loose quantity happened to be.
        return { ...l, byBox, qty: byBox ? 1 : l.qty };
      })
    );
  }

  /**
   * Catch an impossible date (2026-02-30) in the browser rather than paying a
   * round-trip to be told. The API re-checks this — a client is not a trust
   * boundary — but the native date input makes a bad value unlikely in the
   * first place, and an inline message beats a modal full-screen error.
   */
  function expiryProblem(line: CartLine): string | null {
    if (!line.expirable) return null;
    if (!line.newExpiry) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(line.newExpiry)) {
      return "Use the date picker — YYYY-MM-DD.";
    }
    const d = new Date(`${line.newExpiry}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== line.newExpiry) {
      return `${line.newExpiry} is not a real date.`;
    }
    return null;
  }

  function removeLine(sku: string) {
    setCart((prev) => prev.filter((l) => l.sku !== sku));
    const emptyEntry = { id: nextNoteEntryId.current++, sku: "", text: "" };
    setNoteEntries((prev) => {
      const remaining = prev.filter((entry) => entry.sku !== sku);
      return remaining.length > 0 ? remaining : [emptyEntry];
    });
  }

  function requestRemoveLine(sku: string) {
    const line = cart.find((item) => item.sku === sku);
    if (line) setPendingRemoval(line);
  }

  function confirmRemoveLine() {
    if (!pendingRemoval) return;
    removeLine(pendingRemoval.sku);
    if (cart.length === 1) setConfirmOpen(false);
    setPendingRemoval(null);
  }

  function clearCart() {
    setCart([]);
    clearItemNoteEntries();
    setToast({
      msg: "All items cleared from the cart.",
      tone: "info",
    });
  }

  function addNoteEntry() {
    const entry = { id: nextNoteEntryId.current++, sku: "", text: "" };
    setNoteEntries((prev) => [...prev, entry]);
  }

  function clearItemNoteEntries() {
    const emptyEntry = { id: nextNoteEntryId.current++, sku: "", text: "" };
    setNoteEntries((prev) => {
      const standaloneNotes = prev.filter((entry) => !entry.sku);
      return standaloneNotes.length > 0
        ? standaloneNotes
        : [emptyEntry];
    });
  }

  function collectNotes(): {
    transactionNote: string | null;
    itemNotes: Record<string, string>;
  } | null {
    const transactionNote = noteEntries
      .filter((entry) => !entry.sku)
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join("\n");
    const itemNotes: Record<string, string> = {};

    for (const entry of noteEntries) {
      const text = entry.text.trim();
      if (!entry.sku || !text) continue;
      itemNotes[entry.sku] = [itemNotes[entry.sku], text].filter(Boolean).join("\n");
    }

    if (transactionNote.length > 500) {
      setToast({
        msg: "Transaction notes are limited to 500 characters.",
        tone: "error",
      });
      return null;
    }

    const oversizedItem = Object.entries(itemNotes).find(([, text]) => text.length > 500);
    if (oversizedItem) {
      const itemName = cart.find((line) => line.sku === oversizedItem[0])?.name ?? "An item";
      setToast({
        msg: `Notes for ${itemName} are limited to 500 characters.`,
        tone: "error",
      });
      return null;
    }

    return {
      transactionNote: transactionNote || null,
      itemNotes,
    };
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setSubmitError(null);
    setNotices([]);
    setSearchText("");
    setSearchResults([]);
    setShowDropdown(false);
    if (cart.length > 0) {
      setCart([]);
      clearItemNoteEntries();
      setToast({
        msg: "Cart cleared — one transaction can only be one movement type.",
        tone: "info",
      });
    }
  }

  /* ---------------- scanning ---------------- */

  async function handleScan(code: string) {
    clearLookupNotice();
    setScanning(true);

    try {
      const res = await fetch(
        `/api/items/lookup?code=${encodeURIComponent(code)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Item not found");

      const item = data.item as Looked;
      const qty = Number(item.quantity);
      const threshold = Number(item.low_stock_threshold) || 0;
      const expiry = expiryStatus(item.expiration_date);
      const scannedBatch = data.scannedBatch as InventoryBatch | null;

      // Blocking: there is nothing to deduct, so the line is not added.
      if (deducting && qty <= 0) {
        pushNotice({
          id: `${item.sku}:out`,
          tone: "error",
          title: `${item.name} is out of stock`,
          detail: "Nothing left to deduct, so it was not added to the cart.",
        });
        return;
      }

      if (mode === "checkout" && !scannedBatch && availableQuantity(item) <= 0) {
        pushNotice({
          id: `${item.sku}:expired`,
          tone: "error",
          title: `${item.name} has no usable stock`,
          detail: "All remaining batches are expired. Log them as waste before checkout.",
        });
        return;
      }

      if (mode === "checkout" && scannedBatch) {
        const today = new Date().toISOString().slice(0, 10);
        if (
          scannedBatch.remaining_quantity <= 0 ||
          (scannedBatch.expiration_date !== null &&
            scannedBatch.expiration_date < today)
        ) {
          pushNotice({
            id: `${item.sku}:batch-expired`,
            tone: "error",
            title: "This batch cannot be checked out",
            detail: "The scanned batch is depleted or expired. Scan another batch.",
          });
          return;
        }
      }
      if (mode === "waste" && scannedBatch && scannedBatch.remaining_quantity <= 0) {
        pushNotice({
          id: `${item.sku}:batch-empty`,
          tone: "error",
          title: "This batch is already depleted",
          detail: "Scan a batch with stock remaining.",
        });
        return;
      }
      if (mode === "waste" && scannedBatch && !isBatchExpired(scannedBatch)) {
        promptWasteReason(item, scannedBatch);
        return;
      }
      if (
        mode === "waste" &&
        !scannedBatch &&
        expiredBatchQuantityFor(item.batches ?? []) <= 0
      ) {
        const freshBatch = remainingBatches(item.batches ?? []).find(
          (batch) => !isBatchExpired(batch)
        );
        if (freshBatch) {
          promptWasteReason(item, freshBatch);
          return;
        }
      }
      upsert(item, mode === "restock" ? null : scannedBatch);

      // If the barcode carried a date suffix, show it so the operator knows
      // which batch they just scanned — old items have a different code.
      if (data.batchExpiry) {
        pushNotice({
          id: `${item.sku}:batch`,
          tone: "info",
          title: `${item.name} — batch dated ${fmtDate(data.batchExpiry)}`,
          detail: scannedBatch
            ? "This exact batch will be used for the movement."
            : "Scanned a dated product label.",
        });
      }

      // Non-blocking warnings — the line is still added, because the operator
      // may be recording what actually happened rather than what should happen.
      if (deducting && qty <= threshold) {
        pushNotice({
          id: `${item.sku}:low`,
          tone: "warn",
          title: `Low stock: ${fmtQty(qty, item.unit)} of ${item.name} left`,
          detail: `At or below the ${fmtQty(
            threshold,
            item.unit
          )} threshold — consider restocking.`,
        });
      }

      if (expiry.key === "soon") {
        pushNotice({
          id: `${item.sku}:soon`,
          tone: "warn",
          title: `${item.name} expires in ${expiry.days} day(s)`,
          detail:
            mode === "restock"
              ? "The existing stock is still expiring soon. Consider using it before this new batch, or the dates will be combined."
              : deducting
              ? "Use this one first."
              : "Consider using the existing stock first.",
        });
      }
    } catch (e: any) {
      pushNotice({
        id: "lookup:error",
        tone: "error",
        title: "Item lookup failed",
        detail: e.message || "Lookup failed",
      });
    } finally {
      setScanning(false);
    }
  }

  /* ---------------- commit ---------------- */

  async function commit() {
    const lines = cart.filter((l) => l.qty > 0);
    if (lines.length === 0) {
      setSubmitError("Every line needs a quantity greater than zero.");
      return;
    }

    const lineNeedingWasteReason = lines.find(
      (line) => requiresWasteReason(line) && !line.wasteReason.trim()
    );
    if (lineNeedingWasteReason) {
      setSubmitError(
        `${lineNeedingWasteReason.name}: enter a reason for wasting stock that has not expired.`
      );
      return;
    }
    const oversizedWasteReason = lines.find(
      (line) => line.wasteReason.trim().length > 500
    );
    if (oversizedWasteReason) {
      setSubmitError(
        `${oversizedWasteReason.name}: the waste reason is limited to 500 characters.`
      );
      return;
    }
    const oversizedWasteNote = lines.find(
      (line) =>
        [
          itemNoteText(line.sku).trim(),
          mode === "waste" ? line.wasteReason.trim() : null,
        ]
          .filter(Boolean)
          .join("\n").length > 500
    );
    if (oversizedWasteNote) {
      setSubmitError(
        `${oversizedWasteNote.name}: the waste reason and item note together are limited to 500 characters.`
      );
      return;
    }

    // A restock with an impossible date is refused here, before the request, so
    // the operator is told which line is wrong instead of losing the whole cart
    // to a single rejected date.
    const badExpiry = lines.find((l) => expiryProblem(l));
    if (badExpiry) {
      setSubmitError(
        `${badExpiry.name}: ${expiryProblem(badExpiry)} The cart was not submitted.`
      );
      return;
    }

    const notes = collectNotes();
    if (!notes) return;

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: mode,
          confirmation: confirmationCredential,
          note: notes.transactionNote,
          // Only a restock can name a supplier; the API ignores the field on any
          // other movement.
          supplier_id: mode === "restock" ? supplierId || null : null,
          items: lines.map((l) => ({
            sku: l.sku,
            // A by-box line sends `boxes` and no `qty`: the database converts
            // using the item's own units_per_box, so the browser never has to
            // agree with the server about the factor.
            qty: l.byBox ? 0 : l.qty,
            boxes: l.byBox ? l.qty : null,
            // Sent for a restock only, and only when a date was actually typed —
            // an absent date tells the database to keep the item's existing one.
            exp: mode === "restock" && l.newExpiry ? l.newExpiry : null,
            batch_id: mode !== "restock" ? l.batchId : null,
            batch_allocations:
              mode === "checkout" && l.allocationMode === "manual"
                ? Object.entries(l.batchQuantities)
                    .filter(([, qty]) => qty > 0)
                    .map(([batch_id, qty]) => ({ batch_id, qty }))
                : null,
            note:
              [
                notes.itemNotes[l.sku],
                mode === "waste" ? l.wasteReason.trim() : null,
              ]
                .filter(Boolean)
                .join("\n") || null,
            waste_reason:
              mode === "waste" ? l.wasteReason.trim() || null : null,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not commit this transaction");

      setToast({
        msg: `${MODE_VERB[mode]} ${lines.length} ${
          lines.length === 1 ? "line" : "lines"
        }.`,
        tone: "success",
      });

      const result = data.result as
        | {
            items?: {
              sku: string;
              name: string;
              unit: string;
              before: number;
              after: number;
              expiration?: string | null;
              current_batches?: InventoryBatch[];
            }[];
          }
        | undefined;
      const stockChanges = new Map(
        (result?.items ?? []).map((line) => [line.sku, line])
      );

      if (stockChanges.size > 0) {
        setAllItems((items) =>
          items.map((item) => {
            const changed = stockChanges.get(item.sku);
            return changed
              ? {
                  ...item,
                  quantity: Number(changed.after),
                  expiration_date: changed.expiration ?? null,
                  batches: changed.current_batches ?? item.batches,
                }
              : item;
          })
        );
        setSearchResults((items) =>
          items.map((item) => {
            const changed = stockChanges.get(item.sku);
            return changed
              ? {
                  ...item,
                  quantity: Number(changed.after),
                  expiration_date: changed.expiration ?? null,
                  batches: changed.current_batches ?? item.batches,
                }
              : item;
          })
        );
      }

      // The API echoes before/after per line, so we can say when the movement
      // the operator just recorded pushed something under its threshold. Only
      // genuine crossings are reported — anything already low was warned about
      // at scan time.
      if (deducting) {
        const crossed = (result?.items ?? [])
          .map((line): Notice | null => {
            const threshold = lines.find((l) => l.sku === line.sku)?.threshold ?? 0;
            const after = Number(line.after);
            const before = Number(line.before);

            if (after <= 0) {
              return {
                id: `${line.sku}:out`,
                tone: "error",
                title: `${line.name} is now out of stock`,
                detail: "Restock before the next service.",
              };
            }

            if (before > threshold && after <= threshold) {
              return {
                id: `${line.sku}:low`,
                tone: "warn",
                title: `${line.name} is now low on stock`,
                detail: `${fmtQty(after, line.unit)} left — threshold is ${fmtQty(
                  threshold,
                  line.unit
                )}.`,
              };
            }

            return null;
          })
          .filter((n): n is Notice => n !== null);

        setNotices(crossed.slice(0, MAX_NOTICES));
      } else {
        setNotices([]);
      }

      setCart([]);
      setNoteEntries([{ id: nextNoteEntryId.current++, sku: "", text: "" }]);
      setNoteOpen(false);
      setConfirmationCredential("");
      setSupplierId("");
      setConfirmOpen(false);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  /* ---------------- render ---------------- */

  const projected = (line: CartLine) =>
    Math.max(0, deducting ? line.onHand - line.qty : line.onHand + line.qty);

  function scannedBatchExpiry(line: CartLine): string {
    const expirationDate = line.batches.find(
      (batch) => batch.id === line.batchId
    )?.expiration_date;
    return expirationDate ? `Expires ${fmtDate(expirationDate)}` : "No expiry date";
  }

  const modeLabel = MODES.find((m) => m.key === mode)?.label ?? mode;
  const transactionNoteText = noteEntries
    .filter((entry) => !entry.sku)
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n");

  function itemNoteText(sku: string): string {
    return noteEntries
      .filter((entry) => entry.sku === sku)
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join("\n");
  }

  /**
   * The per-line restock controls: the "counted by the box" checkbox and the new
   * batch's expiry date. Both are restock-only, because both describe stock
   * arriving rather than stock leaving.
   *
   * `variant` tells the two copies apart. The cart is rendered twice — a
   * stacked card for phones and a table row for desktop — and only a CSS
   * breakpoint hides one of them, so both are always in the DOM and the same
   * SKU legitimately appears twice. The ids therefore carry the variant.
   *
   * Without it the id is duplicated, and a duplicated id is not merely untidy:
   * a <label for> activates the *first* element with that id, which is always
   * the copy hidden by the current breakpoint. So on a desktop, clicking
   * "Expiration date" did nothing at all, because the date picker it pointed
   * at was display:none in the phone card. The same ambiguity hit anything
   * resolving the field by id, including browser tests.
   */
  function restockFields(line: CartLine, variant: "card" | "row") {
    if (mode !== "restock") return null;
    if (!line.expirable) {
      return (
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wide text-cocoa-500">
            Non-expiring item
          </div>
          <p className="mt-1 text-[11px] text-cocoa-400">
            Received date is recorded automatically when restocked.
          </p>
        </div>
      );
    }

    const problem = expiryProblem(line);
    const boxed = line.byBox && line.unitsPerBox != null;
    const converted = boxed ? line.qty * Number(line.unitsPerBox!) : null;

    // Unique per SKU *and* per copy, so the label, the input and the error
    // message it describes always refer to each other.
    const expId = `exp-${line.sku}-${variant}`;
    const errId = `exp-err-${line.sku}-${variant}`;

    return (
      <>
        {/* Offered only for an item that actually has a packaging factor —
            otherwise a box count could not be converted and the request would
            be refused. */}
        {line.unitsPerBox != null && (
          <div className="min-w-0">
            <label className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-cocoa-400">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cocoa-700"
                checked={line.byBox}
                onChange={(e) => setByBox(line.sku, e.target.checked)}
              />
              Count by the box
            </label>
            {boxed && (
              <p className="mt-1 text-[11px] text-cocoa-400">
                {line.qty} box{line.qty === 1 ? "" : "es"} × {line.unitsPerBox}{" "}
                {line.unit} ={" "}
                <span className="font-semibold text-cocoa-700">
                  {converted} {line.unit}
                </span>{" "}
                added
              </p>
            )}
          </div>
        )}

        <div className="min-w-0">
          <label
            htmlFor={expId}
            className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-cocoa-400"
          >
            Expiration date
          </label>
          <input
            id={expId}
            type="date"
            className="input w-full"
            value={line.newExpiry}
            onChange={(e) => setNewExpiry(line.sku, e.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? errId : undefined}
          />
          {problem ? (
            <p id={errId} className="mt-1 text-[11px] font-semibold text-terracotta-700">
              {problem}
            </p>
          ) : (
            <ShelfLifeHint line={line} />
          )}
          <p className="mt-1 text-[11px] text-cocoa-400">
            Received date is recorded automatically when restocked.
          </p>
        </div>
      </>
    );
  }

  /**
   * Tells the operator what the date will have to satisfy before they commit,
   * rather than only refusing afterwards. A line with no date shows what it
   * currently is, so a blank box is never read as "clear it".
   */
  function ShelfLifeHint({ line }: { line: CartLine }) {
    if (line.minShelfLife) {
      if (!line.newExpiry) {
        return (
          <p className="mt-1 text-[11px] text-cocoa-400">
            This location needs at least {line.minShelfLife} day(s) of shelf life on
            arrival.
          </p>
        );
      }
      const days = daysUntil(line.newExpiry);
      const ok = days !== null && days >= (line.minShelfLife ?? 0);
      return (
        <p
          className={`mt-1 text-[11px] font-semibold ${ok ? "text-cocoa-400" : "text-terracotta-700"}`}
        >
          {ok
            ? `Meets the ${line.minShelfLife}-day shelf life minimum.`
            : `Too close to expiry — this location needs ${line.minShelfLife} day(s) left, so the restock will be refused.`}
        </p>
      );
    }

    if (line.onHand <= 0) return null;

    if (!line.newExpiry && line.expiry) {
      return (
        <p className="mt-1 text-[11px] text-cocoa-400">
          Blank keeps the current date, {fmtDate(line.expiry)}.
        </p>
      );
    }

    if (line.newExpiry && line.expiry && line.newExpiry !== line.expiry) {
      const oldDays = daysUntil(line.expiry);
      const newDays = daysUntil(line.newExpiry);
      const overwriting =
        oldDays !== null &&
        oldDays < 30 &&
        (newDays === null || newDays > oldDays);
      return (
        <p
          className={`mt-1 text-[11px] font-semibold ${overwriting ? "text-ochre-700" : "text-cocoa-400"}`}
        >
          {overwriting
            ? `Warning: existing stock expires on ${fmtDate(line.expiry)} and is being combined with the new batch dated ${fmtDate(line.newExpiry)}. Use the existing stock first if possible.`
            : `New date replaces the previous expiry of ${fmtDate(line.expiry)}.`}
        </p>
      );
    }
    return null;
  }

  return (
    <div className="relative space-y-5 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-4 lg:space-y-0">
      <div className="flex flex-col gap-3 lg:shrink-0 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="deco-title text-3xl">Checkout &amp; Restock</h1>
          <p className="mt-1 text-xs text-cocoa-400">
            Keep every ingredient, supply and stock movement in order.
          </p>
        </div>
        <Link href="/history" className="btn-ghost self-start !px-3 !py-2 text-xs">
          View history
        </Link>
        {notices.length > 0 && (
          <div className="pointer-events-none absolute right-0 top-12 z-30 w-[min(100%,24rem)] space-y-2 lg:top-0 lg:w-[min(32rem,55%)]">
            {notices.map((n) => (
              <CheckoutNoticeCard
                key={n.id}
                notice={n}
                onDismiss={dismissNotice}
              />
            ))}
          </div>
        )}
      </div>

      {/* ---------- movement type ---------- */}
      <div className="grid gap-2 sm:grid-cols-3 lg:shrink-0">
        {MODES.map((m) => {
          const active = m.key === mode;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => switchMode(m.key)}
              className={`rounded-xl border px-4 py-2.5 text-left transition-colors ${
                active
                  ? "border-cocoa-700 bg-cocoa-700 text-cream-50"
                  : "border-cream-200 bg-white text-cocoa-600 hover:bg-cream-100"
              }`}
            >
              <div className="text-sm font-bold">{m.label}</div>
              <div
                className={`mt-0.5 text-[11px] ${
                  active ? "text-cream-300/80" : "text-cocoa-300"
                }`}
              >
                {m.hint}
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[215px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        {/* ---------- inventory alerts ---------- */}
        <aside className="flex max-h-[60vh] flex-col overflow-hidden rounded-2xl border border-cream-200 bg-white lg:h-full lg:min-h-0 lg:max-h-none">
          <div className="flex shrink-0 items-center justify-between border-b border-cream-200 bg-cream-50 px-3 py-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-cocoa-500">Alerts</span>
            <span className="text-[10px] text-cocoa-400">{needsAttention.length} active</span>
          </div>
          <div className="flex-1 space-y-0.5 overflow-y-auto p-1.5">
            {needsAttention.map((item) => {
              const status = stockStatus(item.quantity, item.low_stock_threshold);
              const exp = expiryStatus(item.expiration_date);
              const activeBatches = (item.batches ?? []).filter(
                (batch) => Number(batch.remaining_quantity) > 0
              );
              const expiredQuantity = activeBatches.reduce(
                (total, batch) =>
                  expiryStatus(batch.expiration_date).key === "expired"
                    ? total + Number(batch.remaining_quantity)
                    : total,
                0
              );
              const usableQuantity = availableQuantity(item);
              const tips: string[] = [
                `${item.quantity} ${item.unit} on hand`,
                `Threshold: ${item.low_stock_threshold} ${item.unit}`,
              ];
              if (expiredQuantity > 0) {
                tips.push(
                  `${fmtQty(expiredQuantity, item.unit)} expired; ${fmtQty(usableQuantity, item.unit)} usable`
                );
              } else if (Number(item.quantity) > 0 && exp.days !== null) {
                tips.push(exp.days < 0 ? `Expired ${Math.abs(exp.days)} days ago` : `Expires in ${exp.days} days`);
              }
              const tip = tips.join("\n");
              const badge =
                status.key === "out"
                  ? { label: "Out", tone: status.tone }
                  : expiredQuantity > 0
                    ? { label: usableQuantity > 0 ? "Expired batch" : "Expired", tone: "red" as const }
                    : Number(item.quantity) > 0 && exp.key === "soon"
                      ? { label: "Expiring", tone: exp.tone }
                      : status.key === "low"
                        ? { label: "Low", tone: status.tone }
                        : null;
              if (!badge) return null;
              return (
                <div
                  key={item.sku}
                  title={tip}
                  className="w-full rounded-lg px-2.5 py-2 text-left text-xs hover:bg-cream-50"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="min-w-0 truncate font-semibold text-cocoa-800">{item.name}</span>
                    <Badge
                      tone={badge.tone}
                      className="!shrink-0 !px-1.5 !py-0.5 !text-[9px] !font-bold !uppercase !tracking-wide"
                    >
                      {badge.label}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-[10px] text-cocoa-400">
                    {fmtQty(Number(item.quantity), item.unit)} · {item.sku}
                  </div>
                  {expiredQuantity > 0 && (
                    <div className="mt-0.5 text-[10px] text-cocoa-500">
                      {fmtQty(expiredQuantity, item.unit)} expired ·{" "}
                      {fmtQty(usableQuantity, item.unit)} usable
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Link href="/alerts" className="shrink-0 border-t border-cream-200 px-3 py-2 text-[10px] font-medium text-cocoa-500 hover:text-cocoa-800">
            View all alerts ↗
          </Link>
        </aside>

        {/* ---------- checkout workspace ---------- */}
        <div className="relative rounded-2xl border border-cream-200 bg-white lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:overflow-hidden">
          {/* Header: transaction mode */}
          <div className="flex shrink-0 items-center justify-between rounded-t-2xl border-b border-cream-200 bg-white px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-cocoa-700">{modeLabel}</span>
              <Badge tone={MODE_BADGE[mode]}>{cart.length} {cart.length === 1 ? "item" : "items"}</Badge>
            </div>
            {cart.length > 0 && (
              <button
                type="button"
                className="btn-danger !px-3 !py-1.5 text-xs"
                onClick={clearCart}
              >
                Clear all
              </button>
            )}
          </div>

          <div className="space-y-4 p-4 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
            {/* Search + scan */}
            <div
              ref={searchRef}
              className={`relative ${
                keyboardOpen && searchFocused
                  ? "sticky top-0 z-40 -mx-4 bg-white/95 px-4 py-2 shadow-sm backdrop-blur"
                  : ""
              }`}
            >
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="input w-full !pl-10 text-base"
                  placeholder="Scan barcode or type item name..."
                  aria-label="Scan an item barcode"
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value);
                    clearLookupNotice();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const query = searchText.trim().toLowerCase();
                      const firstResult =
                        searchResults[0] ??
                        allItems.find(
                          (item) =>
                            item.name.toLowerCase().includes(query) ||
                            item.sku.toLowerCase().includes(query)
                        );
                      if (firstResult) {
                        handleSearchAdd(firstResult);
                      } else if (searchText.trim()) {
                        handleScan(searchText.trim());
                        setSearchText("");
                      }
                    }
                  }}
                  onFocus={() => {
                    setSearchFocused(true);
                    if (searchResults.length > 0) setShowDropdown(true);
                  }}
                  onBlur={() => setSearchFocused(false)}
                />
                <svg
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cocoa-300"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                {searchText && (
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-cocoa-300 hover:text-cocoa-500"
                    onClick={() => {
                      setSearchText("");
                      setSearchResults([]);
                      setShowDropdown(false);
                      searchInputRef.current?.focus();
                    }}
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Search results dropdown */}
              {showDropdown &&
                searchResults.length > 0 &&
                searchDropdownPosition &&
                createPortal(
                  <div
                    data-checkout-search-dropdown
                    onMouseDown={(event) => event.preventDefault()}
                    className="fixed z-[80] overflow-hidden rounded-xl border border-cream-200 bg-white shadow-lg"
                    style={{
                      top: searchDropdownPosition.top,
                      left: searchDropdownPosition.left,
                      width: searchDropdownPosition.width,
                      maxHeight: searchDropdownPosition.maxHeight,
                    }}
                  >
                    <ul
                      className="overflow-y-auto overscroll-contain"
                      style={{ maxHeight: searchDropdownPosition.maxHeight }}
                    >
                      {searchResults.map((item) => {
                      const out = isOutOfStock(item);
                      const exp = expiryStatus(item.expiration_date);
                      const batches = [...(item.batches ?? [])]
                        .filter((batch) => Number(batch.remaining_quantity) > 0)
                        .sort((a, b) => {
                          if (!a.expiration_date) return b.expiration_date ? 1 : 0;
                          if (!b.expiration_date) return -1;
                          return a.expiration_date.localeCompare(b.expiration_date);
                        });
                      const expiredBatchQuantity = expiredBatchQuantityFor(batches);
                      const usableQty = availableQuantity(item);
                      const soonBatchDays = batches
                        .flatMap((batch) => {
                          const status = expiryStatus(batch.expiration_date);
                          return status.key === "soon" && status.days !== null
                            ? [status.days]
                            : [];
                        })
                        .sort((a, b) => a - b)[0];
                      return (
                        <li key={item.sku}>
                          <button
                            type="button"
                            disabled={out}
                            className={`flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-sm transition-colors ${
                              out
                                ? "cursor-not-allowed bg-cream-50 opacity-50"
                                : "hover:bg-cream-50"
                            }`}
                            onClick={() => handleSearchAdd(item)}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-cocoa-800">{item.name}</div>
                              <div className="font-mono text-[11px] text-cocoa-400">{item.sku}</div>
                              {batches.length > 0 && (
                                <div className="mt-1 space-y-0.5 text-[11px] leading-snug text-cocoa-500">
                                  {batches.map((batch, index) => (
                                    <div key={batch.id}>
                                      {index === 0 ? "Oldest" : "Next"} batch —{" "}
                                      {fmtQty(Number(batch.remaining_quantity), item.unit)}
                                      {batch.expiration_date
                                        ? `, expires ${fmtDate(batch.expiration_date)}`
                                        : ", no expiry date"}
                                    </div>
                                  ))}
                                  <div className="font-medium text-cocoa-600">
                                    Checkout uses earliest-expiring stock first.
                                  </div>
                                </div>
                              )}
                            </div>
                            <div className="shrink-0 text-right">
                              <div className="text-xs text-cocoa-500">
                                {fmtQty(Number(item.quantity), item.unit)} total
                              </div>
                              {batches.length > 0 && (
                                <div className="mt-0.5 text-[10px] text-cocoa-400">
                                  {fmtQty(usableQty, item.unit)} usable
                                </div>
                              )}
                              {expiredBatchQuantity > 0 && (
                                <div className="mt-0.5 text-[10px] text-terracotta-700">
                                  {fmtQty(expiredBatchQuantity, item.unit)} expired
                                </div>
                              )}
                                      {(batches.length > 0
                                        ? expiredBatchQuantity > 0
                                        : Number(item.quantity) > 0 && exp.key === "expired") && (
                                <Badge
                                  tone="red"
                                  className="!px-1.5 !py-0 !text-[9px] !font-bold !uppercase !tracking-wide"
                                >
                                  {batches.length > 0 && usableQty > 0
                                    ? "Expired batch"
                                    : "Expired"}
                                </Badge>
                              )}
                              {(batches.length > 0
                                ? soonBatchDays !== undefined
                                : Number(item.quantity) > 0 && exp.key === "soon") && (
                                <Badge
                                  tone="amber"
                                  className="!px-1.5 !py-0 !text-[9px] !font-bold !uppercase !tracking-wide"
                                >
                                  {batches.length > 0 ? soonBatchDays : exp.days}d left
                                </Badge>
                              )}
                            </div>
                          </button>
                        </li>
                      );
                      })}
                    </ul>
                  </div>,
                  document.body
                )}
            </div>

            <p className="text-[11px] text-cocoa-300">
              {scanning
                ? "Looking up..."
                : "Scan a barcode, type an item name, or type a SKU. Results appear instantly."}
            </p>

            {/* Cart items */}
            <div className="lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:overscroll-contain lg:pr-1">
              {cart.length === 0 ? (
                <div className="py-8 text-center text-sm text-cocoa-400">
                  Nothing added yet — scan, search, or check the alerts.
                </div>
              ) : (
                <>
                  <div className="space-y-2.5 lg:hidden">
                    {cart.map((l) => (
                      <DataCard key={l.sku} data-cart-sku={l.sku}>
                        <div className="min-w-0">
                          <div className="font-semibold text-cocoa-800">{l.name}</div>
                          <div className="font-mono text-xs text-cocoa-400">{l.sku}</div>
                          {l.batchCode ? (
                            <div className="mt-1 text-[11px] text-cocoa-500">
                              Batch {l.batchCode}
                            </div>
                          ) : mode === "checkout" && l.allocationMode === "auto" ? (
                            <div className="mt-1 text-[11px] text-cocoa-500">
                              Auto FEFO
                            </div>
                          ) : null}
                          {allocationControls(l)}
                          {wasteBatchSelector(l)}
                        </div>
                        <DataField label="On hand">{fmtQty(l.onHand, l.unit)}</DataField>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">
                            Quantity
                          </span>
                          <div className="flex items-center gap-1.5">
                            <button
                              className="btn-ghost min-h-[40px] !px-3.5 !py-2 text-sm"
                              onClick={() => setQty(l.sku, l.qty - 1)}
                              aria-label={`Decrease ${l.name}`}
                            >
                              -
                            </button>
                            <input
                              className="input w-24 text-center"
                              type="number"
                              inputMode="decimal"
                              min="0"
                              max={deducting ? l.maxQty : undefined}
                              step="0.001"
                              value={l.qty}
                              onChange={(e) => setQty(l.sku, Number(e.target.value))}
                            />
                            <button
                              className="btn-ghost min-h-[40px] !px-3.5 !py-2 text-sm"
                              onClick={() => setQty(l.sku, l.qty + 1)}
                              aria-label={`Increase ${l.name}`}
                            >
                              +
                            </button>
                          </div>
                        </div>
                        {restockFields(l, "card")}
                        <button
                          type="button"
                          className="btn-danger !h-10 !w-10 !p-0"
                          onClick={() => requestRemoveLine(l.sku)}
                          aria-label={`Remove ${l.name} from cart`}
                        >
                          <svg
                            className="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M4 7h16" />
                            <path d="M10 11v6M14 11v6" />
                            <path d="m5 7 1 14h12l1-14M9 7V4h6v3" />
                          </svg>
                        </button>
                      </DataCard>
                    ))}
                  </div>
                  <div
                    ref={desktopCartScrollRef}
                    className="hidden h-full overflow-auto lg:block"
                  >
                    <table className="w-full min-w-[760px] table-fixed border-collapse">
                      <thead>
                        <tr className="bg-cream-100/60">
                          <th className={`th sticky top-0 z-10 bg-cream-100/95 !py-2 ${mode === "checkout" ? "w-[34%]" : "w-[38%]"}`}>Item</th>
                          <th className="th sticky top-0 z-10 w-[14%] bg-cream-100/95 !py-2 text-left">On hand</th>
                          <th className={`th sticky top-0 z-10 bg-cream-100/95 !py-2 text-center ${mode === "waste" ? "w-[43%]" : mode === "checkout" ? "w-[22%]" : "w-[25%]"}`}>
                            Quantity
                          </th>
                          {mode === "checkout" && (
                            <th className="th sticky top-0 z-10 w-[25%] bg-cream-100/95 !py-2">
                              Batch allocation
                            </th>
                          )}
                          {mode === "restock" && (
                            <th className="th sticky top-0 z-10 w-[18%] bg-cream-100/95 !py-2">Restock details</th>
                          )}
                          <th className="th sticky top-0 z-10 w-[5%] bg-cream-100/95 !py-2 text-center" />
                        </tr>
                      </thead>
                      <tbody>
                        {cart.map((l) => (
                          <tr
                            key={l.sku}
                            data-cart-sku={l.sku}
                            className="border-b border-cream-200 transition-colors hover:bg-cream-50/80"
                          >
                            <td className="px-4 py-4 text-sm text-cocoa-700">
                              <div className="truncate font-medium text-cocoa-800" title={l.name}>
                                {l.name}
                              </div>
                              <div className="mt-0.5 truncate font-mono text-[10px] text-cocoa-400" title={l.sku}>
                                {l.sku}
                              </div>
                              {wasteBatchSelector(l)}
                            </td>
                            <td className="px-3 py-4 text-sm tabular-nums text-cocoa-700">
                              <div>{fmtQty(l.onHand, l.unit)}</div>
                              {mode === "checkout" &&
                                l.batches.some(isBatchExpired) && (
                                  <div className="mt-0.5 text-[10px] text-terracotta-700">
                                    {fmtQty(
                                      l.batches.reduce(
                                        (sum, batch) =>
                                          sum +
                                          (isBatchExpired(batch)
                                            ? Number(batch.remaining_quantity)
                                            : 0),
                                        0
                                      ),
                                      l.unit
                                    )}{" "}
                                    expired
                                  </div>
                                )}
                            </td>
                            <td className="px-3 py-4">
                              <div className="flex items-center justify-center gap-2">
                                <div className="flex h-10 items-center rounded-xl border border-cream-200">
                                  <button
                                    className="h-full w-9 text-cocoa-400 transition-colors hover:text-cocoa-800"
                                    onClick={() => setQty(l.sku, l.qty - 1)}
                                    aria-label={`Decrease ${l.name}`}
                                  >
                                    -
                                  </button>
                                  <input
                                    className="w-12 border-0 bg-transparent p-0 text-center text-sm text-cocoa-800 outline-none focus:ring-0"
                                    type="number"
                                    min="0"
                                    max={deducting ? l.maxQty : undefined}
                                    step="0.001"
                                    value={l.qty}
                                    onChange={(e) => setQty(l.sku, Number(e.target.value))}
                                  />
                                  <button
                                    className="h-full w-9 text-cocoa-400 transition-colors hover:text-cocoa-800"
                                    onClick={() => setQty(l.sku, l.qty + 1)}
                                    aria-label={`Increase ${l.name}`}
                                  >
                                    +
                                  </button>
                                </div>
                                <span className="text-[10px] text-cocoa-400">{l.unit}</span>
                              </div>
                            </td>
                            {mode === "checkout" && (
                              <td className="px-3 py-4">
                                {l.batchCode ? (
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="truncate text-xs font-medium text-cocoa-700">
                                        {l.batchCode}
                                      </div>
                                      <div className="text-[10px] text-cocoa-400">
                                        {scannedBatchExpiry(l)}
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  allocationControls(l)
                                )}
                              </td>
                            )}
                            {mode === "restock" && (
                              <td className="px-3 py-4">{restockFields(l, "row")}</td>
                            )}
                            <td className="px-2 py-4 text-center">
                              <button
                                type="button"
                                className="btn-ghost !h-8 !w-8 !p-0 text-cocoa-400 hover:text-terracotta-700"
                                onClick={() => requestRemoveLine(l.sku)}
                                aria-label={`Remove ${l.name} from cart`}
                              >
                                <svg
                                  className="h-4 w-4"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M4 7h16" />
                                  <path d="M10 11v6M14 11v6" />
                                  <path d="m5 7 1 14h12l1-14M9 7V4h6v3" />
                                </svg>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            {/* Summary + commit */}
            {mode === "checkout" && (
              <div className="flex items-center gap-2 border-t border-cream-200 bg-cream-50/70 px-3 py-2 text-[10px] text-cocoa-400">
                <span aria-hidden="true">ⓘ</span>
                Auto FEFO uses the earliest-expiring usable batch. Expired stock is unavailable for checkout.
              </div>
            )}
            <div className="space-y-3 border-t border-cream-200 pt-3 lg:flex lg:flex-wrap lg:items-end lg:justify-between lg:gap-3 lg:space-y-0">
              <div className="flex items-center justify-between px-1 text-xs text-cocoa-400 lg:w-full">
                <p>
                  Lines <span className="ml-1 font-semibold tabular-nums text-cocoa-600">{cart.length}</span>
                </p>
                <p>
                  Total qty <span className="ml-1 font-semibold tabular-nums text-cocoa-600">{fmtQty(totalQty)}</span>
                </p>
              </div>
              <div className="min-w-0 space-y-2 lg:min-w-[40%] lg:flex-1">
                <button
                  type="button"
                  className="btn-ghost !rounded-xl !px-3 !py-2 text-xs"
                  aria-expanded={noteOpen}
                  aria-controls="note-composer"
                  onClick={() => {
                    if (noteOpen) {
                      setNoteOpen(false);
                    } else {
                      setNoteOpen(true);
                    }
                  }}
                >
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                  </svg>
                  {noteOpen ? "Done noting" : hasNote ? "Edit notes" : "Add note"}
                </button>
                {noteOpen ? (
                  <div id="note-composer" className="space-y-2 rounded-xl border border-cream-200 bg-white p-2">
                    {noteEntries.map((entry, index) => (
                      <div key={entry.id} className="flex min-w-0 items-center gap-2">
                        <select
                          className="input min-w-0 max-w-[45%] !py-2 text-xs sm:max-w-[40%]"
                          value={entry.sku}
                          aria-label={`Note line ${index + 1} item`}
                          onChange={(event) => {
                            const sku = event.target.value;
                            setNoteEntries((prev) =>
                              prev.map((current) =>
                                current.id === entry.id ? { ...current, sku } : current
                              )
                            );
                          }}
                        >
                          <option value="">Note only</option>
                          {cart
                            .filter(
                              (line) =>
                                line.sku === entry.sku ||
                                !noteEntries.some(
                                  (other) => other.id !== entry.id && other.sku === line.sku
                                )
                            )
                            .map((line) => (
                            <option key={line.sku} value={line.sku}>
                              {line.name}
                            </option>
                            ))}
                        </select>
                        <input
                          className="input min-w-0 flex-1 !py-2 text-sm"
                          type="text"
                          value={entry.text}
                          maxLength={500}
                          placeholder={entry.sku ? "Write a note for this item..." : "Write a note..."}
                          aria-label={`Note line ${index + 1} text`}
                          onChange={(event) =>
                            setNoteEntries((prev) =>
                              prev.map((current) =>
                                current.id === entry.id
                                  ? { ...current, text: event.target.value }
                                  : current
                              )
                            )
                          }
                        />
                        {noteEntries.length > 1 && (
                          <button
                            type="button"
                            className="btn-ghost !h-9 !w-9 shrink-0 !p-0 text-cocoa-400"
                            aria-label={`Remove note line ${index + 1}`}
                            onClick={() =>
                              setNoteEntries((prev) => prev.filter((current) => current.id !== entry.id))
                            }
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-3 px-1 pt-1">
                      <p className="text-[11px] text-cocoa-400">
                        Choose an item for a line, or leave it as Note only.
                      </p>
                      <button
                        type="button"
                        className="btn-ghost shrink-0 !px-2 !py-1 text-xs"
                        onClick={addNoteEntry}
                      >
                        + Add line
                      </button>
                    </div>
                  </div>
                ) : hasNote ? (
                  <p className="truncate pl-1 text-xs text-cocoa-400">
                    {noteEntries
                      .filter((entry) => entry.text.trim())
                      .map((entry) => {
                        const itemName = cart.find((line) => line.sku === entry.sku)?.name;
                        return itemName ? `${itemName}: ${entry.text.trim()}` : entry.text.trim();
                      })
                      .join(" · ")}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5 lg:w-48 lg:shrink-0">
                <button
                  className="btn-primary w-full !py-3 text-sm"
                  disabled={!ready}
                  onClick={() => {
                    if (!collectNotes()) return;
                    setSubmitError(null);
                    setConfirmationCredential("");
                    setConfirmOpen(true);
                  }}
                >
                  Review &amp; commit
                </button>
                <p className="text-center text-[10px] text-cocoa-300">
                  {ready
                    ? "Confirm with your staff ID or password."
                    : "Add items to continue."}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {openBatchLine &&
        batchMenuPosition?.sku === openBatchLine.sku &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={`batch-picker-${openBatchLine.sku}`}
            className="fixed z-[100] flex flex-col gap-1 overflow-y-auto rounded-xl border border-cream-200 bg-white p-1.5 shadow-warm"
            style={{
              top: batchMenuPosition.top,
              left: batchMenuPosition.left,
              width: batchMenuPosition.width,
              maxHeight: batchMenuPosition.maxHeight,
            }}
          >
            <button
              type="button"
              className={`${
                openBatchLine.allocationMode === "auto"
                  ? "btn-primary"
                  : "btn-ghost"
              } !rounded-lg !px-2 !py-1.5 text-xs`}
              aria-pressed={openBatchLine.allocationMode === "auto"}
              onClick={() => setBatchSelection(openBatchLine.sku, "auto")}
            >
              Auto FEFO
            </button>
            {getBatchOptions(openBatchLine).map((option) => (
              <button
                key={option.key}
                type="button"
                className={`${
                  openBatchLine.allocationMode === "manual" &&
                  openBatchLine.selectedBatchKey === option.key
                    ? "btn-primary"
                    : "btn-ghost"
                } !rounded-lg !px-2 !py-1.5 text-xs`}
                aria-pressed={
                  openBatchLine.allocationMode === "manual" &&
                  openBatchLine.selectedBatchKey === option.key
                }
                onClick={() =>
                  setBatchSelection(openBatchLine.sku, option.key)
                }
              >
                {option.label}
              </button>
            ))}
          </div>,
          document.body
        )}

      <Modal
        open={pendingWasteSelection !== null}
        onClose={() => {
          setPendingWasteSelection(null);
          setPendingWasteReason("");
        }}
        title="Reason for wasting usable stock"
        width="max-w-md"
      >
        {pendingWasteSelection && (
          <div className="space-y-4">
            <p className="text-sm text-cocoa-600">
              {pendingWasteSelection.item?.name ??
                cart.find((line) => line.sku === pendingWasteSelection.sku)?.name ??
                pendingWasteSelection.sku}{" "}
              has stock remaining in batch {pendingWasteSelection.batch.batch_code}
              {pendingWasteSelection.batch.expiration_date
                ? `, which expires ${fmtDate(pendingWasteSelection.batch.expiration_date)}`
                : " with no expiry date"}
              . Enter why this stock must be wasted before adding it.
            </p>
            <label className="block text-xs font-semibold text-cocoa-600">
              Waste reason <span className="text-terracotta-700">*</span>
              <textarea
                className="input mt-1 min-h-24 w-full text-sm"
                maxLength={500}
                value={pendingWasteReason}
                onChange={(event) => setPendingWasteReason(event.target.value)}
                placeholder="For example: damaged packaging or spilled during preparation"
                aria-label="Reason for wasting non-expired stock"
                autoFocus
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setPendingWasteSelection(null);
                  setPendingWasteReason("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!pendingWasteReason.trim()}
                onClick={confirmWasteBatchSelection}
              >
                Confirm reason &amp; add batch
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- password confirmation ---------- */}
      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting && !pendingRemoval) setConfirmOpen(false);
        }}
        title={MODE_TITLE[mode]}
        width="max-w-xl"
        scrollable
      >
        <div className="space-y-4">
          <ul className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
            {cart.map((l) => (
              <li
                key={l.sku}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50/60 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-cocoa-700">{l.name}</div>
                  <div className="text-[11px] text-cocoa-400">
                    On hand {fmtQty(l.onHand, l.unit)}
                    <span className="mx-1.5">·</span>
                    After {fmtQty(projected(l), l.unit)}
                  </div>
                  {mode === "checkout" && l.allocationMode === "manual" && (
                    <div className="mt-1 text-[11px] text-cocoa-500">
                      {l.selectedBatchKey === "no-expiry"
                        ? "No expiry date"
                        : `Expires ${fmtDate(l.selectedBatchKey)}`}
                      {" · "}{fmtQty(l.qty, l.unit)}
                    </div>
                  )}
                  {l.batchCode && (
                    <div className="mt-1 text-[11px] text-cocoa-500">
                      Selected batch: {l.batchCode}
                    </div>
                  )}
                  {requiresWasteReason(l) && (
                    <div className="mt-2 w-full">
                      <p className="mb-1 text-xs font-semibold text-terracotta-700">
                        This batch has not expired. Confirm the waste reason.
                      </p>
                      <textarea
                        className="input min-h-16 w-full text-xs"
                        maxLength={500}
                        value={l.wasteReason}
                        onChange={(event) =>
                          setWasteReason(l.sku, event.target.value)
                        }
                        placeholder="Required reason for wasting usable stock"
                        aria-label={`Reason for wasting ${l.name}`}
                      />
                    </div>
                  )}
                  {itemNoteText(l.sku).trim() && (
                    <div className="mt-1 space-y-0.5 text-xs text-cocoa-500">
                      {itemNoteText(l.sku)
                        .split("\n")
                        .filter(Boolean)
                        .map((itemNote, index) => (
                          <p key={`${l.sku}-note-${index}`} className="whitespace-pre-line">
                            <span className="font-semibold">Note:</span> {itemNote}
                          </p>
                        ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    className="btn-ghost !h-9 !w-9 !p-0"
                    onClick={() => setQty(l.sku, l.qty - 1)}
                    aria-label={`Decrease ${l.name} quantity`}
                  >
                    −
                  </button>
                  <input
                    className="input !h-9 w-20 text-center tabular-nums"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.001"
                    value={l.qty}
                    onChange={(e) => setQty(l.sku, Number(e.target.value))}
                    aria-label={`${l.name} quantity`}
                  />
                  <button
                    type="button"
                    className="btn-ghost !h-9 !w-9 !p-0"
                    onClick={() => setQty(l.sku, l.qty + 1)}
                    aria-label={`Increase ${l.name} quantity`}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="btn-danger !h-9 !w-9 !p-0"
                    onClick={() => requestRemoveLine(l.sku)}
                    aria-label={`Remove ${l.name} from cart`}
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 7h16" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="m5 7 1 14h12l1-14M9 7V4h6v3" />
                    </svg>
                  </button>
                </div>
                <div className="w-full text-right text-xs text-cocoa-500 sm:hidden">
                  {deducting ? "−" : "+"}{fmtQty(l.qty, l.unit)}
                  <span className="text-cocoa-300">{" → "}{fmtQty(projected(l), l.unit)}</span>
                </div>
              </li>
            ))}
          </ul>

          {transactionNoteText && (
            <div className="whitespace-pre-line rounded-xl bg-cream-100 px-3.5 py-2.5 text-xs text-cocoa-600">
              <span className="font-semibold">Transaction note:</span>{" "}
              {transactionNoteText}
            </div>
          )}

          {mode === "restock" && (
            <div>
              <label className="label" htmlFor="txn-supplier">
                Supplier (optional)
              </label>
              <select
                id="txn-supplier"
                className="input"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">None — not recorded</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-cocoa-300">
                {supplierId
                  ? "This supplier will be recorded for every item in the restock."
                  : "Choose who delivered this restock, or leave as none."}
              </p>
            </div>
          )}

          <div>
            <label className="label" htmlFor="txn-confirmation">
              Scan your staff ID barcode or enter your password
            </label>
            <input
              id="txn-confirmation"
              className="input"
              type="password"
              autoComplete="off"
              autoFocus
              value={confirmationCredential}
              placeholder="Staff ID barcode or password"
              aria-describedby="txn-confirmation-hint"
              onChange={(e) => {
                setConfirmationCredential(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && confirmationCredential && !submitting) commit();
              }}
            />
            <p id="txn-confirmation-hint" className="mt-1 text-[11px] text-cocoa-400">
              Scan the badge for this signed-in staff account, or type your password in this same field.
            </p>
          </div>

          {submitError && (
            <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
              {submitError}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={commit}
              disabled={submitting || !confirmationCredential}
            >
              {submitting ? (
                <span
                  role="status"
                  aria-label="Committing transaction"
                  className="inline-flex items-center"
                >
                  Committing
                  <span className="ml-1 inline-flex gap-0.5" aria-hidden="true">
                    <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                    <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                    <span className="animate-bounce">.</span>
                  </span>
                </span>
              ) : (
                MODE_TITLE[mode]
              )}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingRemoval !== null}
        onCancel={() => setPendingRemoval(null)}
        onConfirm={confirmRemoveLine}
        title="Remove item?"
        message={
          pendingRemoval
            ? `Remove ${pendingRemoval.name} from this transaction?`
            : ""
        }
        confirmLabel="Remove item"
        tone="danger"
      />

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
