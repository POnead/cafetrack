"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  Modal,
  Spinner,
  Empty,
  Toast,
  Badge,
  DataCard,
  DataField,
  Tooltip,
} from "@/components/ui";
import { BarcodeView, printBarcodeLabelsAsync } from "@/components/BarcodeView";
import { fmtQty, fmtDate } from "@/lib/format";
import { stockStatus, expiryStatus } from "@/lib/status";
import { useLiveRefresh } from "@/lib/use-live-refresh";

type Me = { id: string; username: string; fullName: string; role: "admin" | "staff" };

type Item = {
  id: string;
  sku: string;
  name: string;
  physical_form: string;
  unit: string;
  units_per_box: number | null;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  expirable: boolean;
  par_level: number | null;
  target_days: number | null;
  unit_price: number | null;
  version: number;
  category: { id: string; name: string } | null;
  location: { id: string; name: string; min_shelf_life_days: number | null } | null;
  supplier: { id: string; name: string } | null;
};

type SupplierRef = { id: string; name: string };

type Ref = { id: string; name: string; min_shelf_life_days?: number | null };
type CategoryRef = Ref & { default_unit?: string | null; default_physical_form?: string | null };

type SortKey =
  | "name"
  | "sku"
  | "category"
  | "location"
  | "quantity"
  | "threshold"
  | "expiration"
  | "status";

/** Worst first, so "sort by status" surfaces what needs attention. */
const STATUS_RANK: Record<string, number> = { out: 0, low: 1, ok: 2 };

/**
 * Sort keys the API can order by, mapped to its parameter names.
 *
 * A key that is absent here is one Postgres cannot order by through this query
 * builder, because the value is joined in (category, location) or calculated
 * (status). Those sort the loaded page instead of the whole list, and the
 * header says so — see `sortHeader`.
 */
const SERVER_SORTS: Partial<Record<SortKey, string>> = {
  name: "name",
  sku: "sku",
  quantity: "quantity",
  threshold: "threshold",
  expiration: "expiration",
};

const EMPTY_FORM = {
  name: "",
  category_id: "",
  location_id: "",
  supplier_id: "",
  physical_form: "solid",
  unit: "pcs",
  units_per_box: "",
  quantity: "0",
  low_stock_threshold: "5",
  expiration_date: "",
  expirable: true,
  par_level: "",
  target_days: "",
  unit_price: "",
};

/**
 * Maps each unit to its most likely physical form. When the user picks a unit,
 * the physical form auto-fills to match — they can still override it.
 */
const UNIT_FORM_DEFAULT: Record<string, string> = {
  kg: "powder",
  g: "powder",
  oz: "solid",
  lb: "solid",
  L: "liquid",
  mL: "liquid",
  gallon: "liquid",
  pcs: "solid",
  pack: "solid",
  bottle: "liquid",
  can: "solid",
  box: "solid",
  sack: "powder",
  bag: "powder",
  pouch: "powder",
  sachet: "powder",
  carton: "liquid",
  cup: "solid",
  mug: "solid",
  slice: "solid",
  warp: "solid",
  portion: "solid",
  serving: "solid",
  dozen: "solid",
  kg_pack: "solid",
  bunch: "solid",
  bundle: "solid",
  tray: "solid",
  tin: "solid",
  jar: "powder",
  keg: "liquid",
  roll: "solid",
  sheet: "solid",
  loaf: "solid",
  crate: "solid",
  bucket: "liquid",
};

/**
 * Defines which physical forms are valid for each unit type.
 * Weight units (kg, g, oz, lb) → solid or powder (no liquid).
 * Volume units (L, mL, gallon) → liquid or powder (no solid — powders can be measured by volume).
 * Countable containers (bottle, can, jar, bucket, keg, carton) → liquid.
 * All other units → any physical form.
 */
const UNIT_VALID_FORMS: Record<string, string[]> = {
  // Weight — no liquid
  kg: ["solid", "powder"],
  g: ["solid", "powder"],
  oz: ["solid", "powder"],
  lb: ["solid", "powder"],
  // Volume — no solid
  L: ["liquid", "powder"],
  mL: ["liquid", "powder"],
  gallon: ["liquid", "powder"],
  // Liquid containers
  bottle: ["liquid"],
  jar: ["solid", "powder", "liquid"],
  can: ["solid"],
  carton: ["liquid"],
  keg: ["liquid"],
  bucket: ["liquid"],
};

/** Check if a unit/physical_form combination is valid. Returns null if valid, error message if not. */
function validateUnitForm(unit: string, physicalForm: string): string | null {
  // If no specific constraint for this unit, any form is allowed.
  const allowed = UNIT_VALID_FORMS[unit];
  if (!allowed) return null;
  if (!allowed.includes(physicalForm)) {
    return `${unit} does not support "${physicalForm}" physical form. This unit only allows: ${allowed.join(", ")}.`;
  }
  return null;
}

export default function ItemsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<CategoryRef[]>([]);
  const [locations, setLocations] = useState<Ref[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);

  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState("");

  // Search, category filter, sort and paging all happen in the API now
  // (NFR-05). Doing any of them here would sort or filter one page of rows and
  // call the result "the inventory", which is how a cafe ends up convinced an
  // item is missing when it is simply on page 3.
  //
  // The default matches what the API returns on its own — name ascending — so
  // opening the page looks exactly as it did.
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Search as typed drives the table, but the request waits for a pause in
  // typing — otherwise every keystroke is a query against the catalogue.
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const PAGE_SIZE = 50;

  // Any change to what is being looked at invalidates the position in the list.
  // Page 4 of a list that just got a filter applied is not a page, it is a gap.
  useEffect(() => {
    setPage(0);
  }, [q, catFilter, sortKey, sortDir]);

  const [editing, setEditing] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [correctionReason, setCorrectionReason] = useState("");
  const [approvalCode, setApprovalCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [labelItem, setLabelItem] = useState<Item | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: any } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stock count mode
  const [stockCountMode, setStockCountMode] = useState(false);
  const [countedQty, setCountedQty] = useState<Record<string, string>>({});
  const [savingCounts, setSavingCounts] = useState(false);

  const inFlight = useRef(false);

  async function load() {
    // Skip while a poll is still in flight so a slow response cannot land
    // late and overwrite fresher data.
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      // Search, category, sort and paging are all the API's job now (NFR-05).
      // Doing any of them here would sort or filter one page and call the result
      // "the inventory" — which is how a cafe ends up convinced an item is
      // missing when it is really on page 3.
      const qs = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        order: sortDir,
      });
      // Only columns on the items table can be ordered by. Category, location
      // and status are derived, so those headers sort the loaded page instead —
      // see toggleSort.
      const serverSort = SERVER_SORTS[sortKey];
      if (serverSort) qs.set("sort", serverSort);
      if (q) qs.set("q", q);
      if (catFilter) qs.set("category", catFilter);

      const [i, c, l, s, m] = await Promise.all([
        fetch(`/api/items?${qs}`).then((r) => r.json()),
        fetch("/api/refs/categories").then((r) => r.json()).catch(() => ({ items: [] })),
        fetch("/api/refs/locations").then((r) => r.json()).catch(() => ({ items: [] })),
        fetch("/api/refs/suppliers").then((r) => r.json()).catch(() => ({ items: [] })),
        fetch("/api/auth/me").then((r) => r.json()).catch(() => ({})),
      ]);

      if (i.error) throw new Error(i.error);

      setItems(i.items ?? []);
      setTotal(i.total ?? 0);
      setHasMore(Boolean(i.has_more));
      setCategories(c.items ?? []);
      setLocations(l.items ?? []);
      setSuppliers(s.items ?? []);
      if (m?.user) setMe(m.user as Me);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load items");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  // Subscribes to item changes and keeps a slow poll behind it. An item added or
  // restocked from another device should appear here without anyone refreshing.
  useLiveRefresh(load);

  // `load` closes over the filters and the page, so the dependency list is the
  // filters rather than the function — `load` itself is stable enough in practice
  // and the eslint rule is off across this codebase.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, catFilter, sortKey, sortDir, page]);

  /**
   * The loaded page, with the derived sort applied if one was chosen.
   *
   * `SERVER_SORTS` holds the columns that exist on the items table and are
   * therefore ordered by the API. Category, location and status are computed
   * from a joined or calculated value, so Postgres cannot order by them through
   * this query builder — those sorts apply to the current page only, and the
   * header says so rather than letting the user believe the whole list is
   * ordered that way.
   */
  const filtered = useMemo(() => {
    if (SERVER_SORTS[sortKey]) return items;

    const dir = sortDir === "asc" ? 1 : -1;
    const value = (i: Item): string | number => {
      switch (sortKey) {
        case "category":
          return i.category?.name?.toLowerCase() ?? "";
        case "location":
          return i.location?.name?.toLowerCase() ?? "";
        case "status":
          return STATUS_RANK[stockStatus(i.quantity, i.low_stock_threshold).key];
        default:
          return i.name;
      }
    };

    return [...items].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreak so equal rows do not shuffle between renders.
      return a.name.localeCompare(b.name);
    });
  }, [items, sortKey, sortDir]);

  /** Click a header to sort by it; clicking the active one flips direction. */
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text reads best A-Z; quantities, dates and status best highest-first.
      setSortDir(
        key === "name" || key === "sku" || key === "category" || key === "location"
          ? "asc"
          : "desc"
      );
    }
  }

  function sortHeader(key: SortKey, label: string, extra = "") {
    const active = sortKey === key;
    // Sorting by a joined or calculated column orders this page only. Saying so
    // on the header is better than a list that looks globally sorted and is not.
    const pageOnly = !SERVER_SORTS[key];
    const what = pageOnly
      ? `Sort this page by ${label} (applies to the loaded rows, not every item)`
      : `Sort by ${label}`;
    return (
      <th className={`th select-none ${extra}`}>
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className="inline-flex items-center gap-1 hover:text-cocoa-700"
          aria-label={what}
          title={pageOnly ? `${label} sorts the loaded page only` : undefined}
        >
          {label}
          <span
            className={`text-[10px] leading-none ${active ? "text-cocoa-600" : "text-cocoa-300"}`}
            aria-hidden="true"
          >
            {active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </button>
      </th>
    );
  }

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setCreating(true);
    setEditing(null);
  }

  function openEdit(item: Item) {
    setForm({
      name: item.name,
      category_id: item.category?.id ?? "",
      location_id: item.location?.id ?? "",
      supplier_id: item.supplier?.id ?? "",
      physical_form: item.physical_form,
      unit: item.unit,
      units_per_box: item.units_per_box == null ? "" : String(item.units_per_box),
      quantity: String(item.quantity),
      low_stock_threshold: String(item.low_stock_threshold),
      expiration_date: item.expiration_date ?? "",
      expirable: item.expirable,
      par_level: item.par_level == null ? "" : String(item.par_level),
      target_days: item.target_days == null ? "" : String(item.target_days),
      unit_price: item.unit_price == null ? "" : String(item.unit_price),
    });
    setCorrectionReason("");
    setFormError(null);
    setEditing(item);
    setCreating(false);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setCorrectionReason("");
    setApprovalCode("");
    setFormError(null);
  }

  async function save() {
    setSaving(true);
    setFormError(null);

    try {
      // Checked here so an empty box is reported in the form rather than
      // round-tripping to the API. `Number("")` is 0, which would otherwise
      // save a fully stocked item as empty.
      const qty = Number(form.quantity);
      if (form.quantity.trim() === "" || !Number.isFinite(qty) || qty < 0) {
        setFormError("Enter a quantity of 0 or more");
        return;
      }
      const low = Number(form.low_stock_threshold);
      if (form.low_stock_threshold.trim() !== "" && (!Number.isFinite(low) || low < 0)) {
        setFormError("Low-stock threshold must be a number that is not negative");
        return;
      }
      // Blank means the item is not supplied in boxes. A non-positive value is
      // refused here for the same reason as the quantity: it is a `check`
      // constraint, so it would otherwise come back as a 500.
      const perBox = form.units_per_box.trim() === "" ? null : Number(form.units_per_box);
      if (perBox !== null && (!Number.isFinite(perBox) || perBox <= 0)) {
        setFormError("Units per box must be greater than zero, or left blank");
        return;
      }
      const parLevel = form.par_level.trim() === "" ? null : Number(form.par_level);
      if (parLevel !== null && (!Number.isFinite(parLevel) || parLevel < 0)) {
        setFormError("Par level must be a number that is not negative");
        return;
      }
      const targetDays = form.target_days.trim() === "" ? null : Number(form.target_days);
      if (targetDays !== null && (!Number.isFinite(targetDays) || targetDays < 0)) {
        setFormError("Target days of stock must be a number that is not negative");
        return;
      }
      const unitPrice = form.unit_price.trim() === "" ? null : Number(form.unit_price);
      if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) {
        setFormError("Unit price must be a number that is not negative");
        return;
      }
      // Check unit / physical_form compatibility — e.g. "kg" cannot be "liquid".
      const formErr = validateUnitForm(form.unit, form.physical_form);
      if (formErr) {
        setFormError(formErr);
        return;
      }
      const quantityChanged = editing !== null && qty !== Number(editing.quantity);
      if (quantityChanged && !correctionReason.trim()) {
        setFormError("Enter a reason for the stock correction");
        return;
      }

      // Duplicate-name guard. Case-insensitive so "Creamer" and "creamer"
      // cannot coexist. Skipped when editing the same item (id match).
      const duplicate = items.find(
        (i) =>
          i.name.trim().toLowerCase() === form.name.trim().toLowerCase() &&
          i.id !== editing?.id
      );
      if (duplicate) {
        setFormError(
          `An item named "${duplicate.name}" already exists. Please choose a different name.`
        );
        return;
      }

      const payload = {
        name: form.name,
        category_id: form.category_id || null,
        location_id: form.location_id || null,
        supplier_id: form.supplier_id || null,
        physical_form: form.physical_form,
        unit: form.unit,
        units_per_box: perBox,
        quantity: qty,
        low_stock_threshold:
          form.low_stock_threshold.trim() === "" ? 5 : Math.round(low),
        expiration_date: form.expirable ? form.expiration_date || null : null,
        expirable: form.expirable,
        par_level: parLevel,
        target_days: targetDays,
        unit_price: unitPrice,
        ...(quantityChanged ? { correction_reason: correctionReason.trim() } : {}),
        ...(approvalCode.trim() ? { approval_code: approvalCode.trim() } : {}),
      };

      const res = await fetch(editing ? `/api/items/${editing.id}` : "/api/items", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");

      // FR-03: a staff member without the grant is not refused — their item is
      // saved, but as pending. Saying so plainly matters, because the alternative
      // is watching for the barcode to stop working and assuming the save failed.
      setToast({
        msg: editing
          ? data.pending_change
            ? "Edit submitted for approval — an admin will review it before it takes effect."
            : "Item updated"
          : data.pending_approval
            ? `Submitted for approval — SKU ${data.item.sku}. An admin approves it before it can be used.`
            : data.message?.includes("via your code")
              ? data.message
              : `Item created — SKU ${data.item.sku}`,
        tone: data.pending_approval || data.pending_change ? "info" : "success",
      });
      closeForm();
      load();
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: Item) {
    if (!confirm(`Delete "${item.name}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      setToast({ msg: data.error || "Delete failed", tone: "error" });
      return;
    }
    setToast({ msg: "Item deleted", tone: "success" });
    load();
  }

  /**
   * Print a label for every item on screen.
   *
   * Bounded on purpose. The list is paged now, so "everything" means two
   * different things: the rows in front of the user, and the whole catalogue.
   * Printing 500 labels without asking would be a paper jam and a lost afternoon,
   * so this prints the current view and tells the admin how to get the rest.
   */
  async function printAll() {
    if (filtered.length === 0) return;
    if (total > filtered.length) {
      const proceed = confirm(
        `Print labels for the ${filtered.length} items on this page?\n\n` +
          `There are ${total} in total. Clear the search and filters, or narrow ` +
          `to a category, to print a different set.`
      );
      if (!proceed) return;
    }
    await printBarcodeLabelsAsync(
      filtered.map((i) => ({
        value: i.expiration_date ? `${i.sku}-${i.expiration_date}` : i.sku,
        title: i.name,
        subtitle: i.expiration_date
          ? `${i.category?.name ?? ""} · expires ${fmtDate(i.expiration_date)}`
          : i.category?.name ?? "",
      }))
    );
  }

  /** Enter stock count mode — reset any previous counts. */
  function enterStockCountMode() {
    setCountedQty({});
    setStockCountMode(true);
  }

  /** Exit stock count mode — discard any counts entered. */
  function exitStockCountMode() {
    setCountedQty({});
    setStockCountMode(false);
  }

  /**
   * Save stock counts: find items where counted quantity differs from system,
   * confirm with the user, then PATCH each correction.
   */
  async function saveCounts() {
    const diffs = countableItems
      .map((item) => {
        const counted = countedQty[item.id];
        if (counted === undefined || counted.trim() === "") return null;
        const countedNum = Number(counted);
        if (!Number.isFinite(countedNum) || countedNum < 0) return null;
        if (countedNum !== Number(item.quantity)) {
          return { item, countedNum };
        }
        return null;
      })
      .filter(Boolean) as { item: Item; countedNum: number }[];

    if (diffs.length === 0) {
      setToast({ msg: "No differences found — nothing to save.", tone: "info" });
      return;
    }

    const diffLines = diffs.map(
      (d) =>
        `• ${d.item.name}: system ${fmtQty(d.item.quantity, d.item.unit)} → counted ${fmtQty(d.countedNum, d.item.unit)}`
    );
    const proceed = confirm(
      `Apply ${diffs.length} stock count correction(s)?\n\n${diffLines.join("\n")}\n\nThis will update the system quantities to match the physical counts.`
    );
    if (!proceed) return;

    setSavingCounts(true);
    try {
      await Promise.all(
        diffs.map(async (d) => {
          const res = await fetch(`/api/items/${d.item.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              quantity: d.countedNum,
              correction_reason: "Stock count",
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `Failed to update ${d.item.name}`);
        })
      );
      setToast({
        msg: `${diffs.length} item(s) updated from stock count.`,
        tone: "success",
      });
      exitStockCountMode();
      load();
    } catch (e: any) {
      setToast({ msg: e.message || "Failed to save stock counts.", tone: "error" });
    } finally {
      setSavingCounts(false);
    }
  }

  /* In stock count mode, show all filtered items. Previously-visited rows stay
     visible so the operator can see what they already entered and spot mistakes,
     instead of having each row disappear the moment it is counted. */
  const countableItems = filtered;

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Inventory Management</h1>
        </div>
        <div className="flex gap-2">
          <button
            className={stockCountMode ? "btn-primary" : "btn-ghost"}
            onClick={stockCountMode ? exitStockCountMode : enterStockCountMode}
            title={
              stockCountMode
                ? "Exit stock count mode"
                : "Enter stock count mode for physical inventory"
            }
          >
            {stockCountMode ? "Exit Stock Count" : "Stock Count Mode"}
          </button>
          <button
            className="btn-ghost"
            onClick={printAll}
            disabled={filtered.length === 0 || stockCountMode}
            title={
              total > PAGE_SIZE
                ? "Prints the items currently shown"
                : "Print a barcode label for every item"
            }
          >
            {total > PAGE_SIZE ? "Print this page's labels" : "Print barcode labels"}
          </button>
          <button className="btn-primary" onClick={openCreate} disabled={stockCountMode}>
            Add item
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      <Card className="!p-0">
        <div className="flex flex-wrap gap-3 border-b border-cream-200 bg-cream-50 p-4">
          <input
            aria-label="Search items by name or SKU"
            className="input max-w-xs"
            placeholder="Search name or SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label="Filter by category"
            className="input max-w-[200px]"
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
          <div className="ml-auto self-center text-xs text-cocoa-400">
            {total === 0
              ? "No items"
              : `${filtered.length} shown of ${total} ${
                  total === 1 ? "item" : "items"
                }`}
          </div>
        </div>

        {/* ---------- paging ----------
            Reached only past the first page: with a dozen items there is nothing
            to page and the control would be noise. Page numbers rather than
            prev/next because "next" on a 500-item catalogue means four clicks to
            reach anything. */}
        {total > PAGE_SIZE && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cream-200 bg-cream-50 px-4 py-2.5">
            <div className="text-xs text-cocoa-400">
              Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasMore || loading}
              >
                Next
              </button>
            </div>
          </div>
        )}

        {/* Phones get stacked cards; the table above the fold takes over at lg. */}
        {filtered.length > 0 && (
          <div className="space-y-2.5 lg:hidden">
            {filtered.map((i) => {
              const status = stockStatus(i.quantity, i.low_stock_threshold);
              const expiry = expiryStatus(i.expiration_date);
              return (
                <DataCard
                  key={i.id}
                  className={
                    status.key === "out"
                      ? "border-l-4 border-red-400"
                      : status.key === "low"
                        ? "border-l-4 border-amber-400"
                        : ""
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-cocoa-800">{i.name}</div>
                      <div className="font-mono text-xs text-cocoa-400">{i.sku}</div>
                    </div>
                    <Badge tone={status.tone} variant="tag">
                      {status.label}
                    </Badge>
                  </div>

                  <DataField label="On hand">
                    <span
                      className={
                        status.key === "ok" ? "" : "font-semibold text-terracotta-700"
                      }
                    >
                      {fmtQty(i.quantity, i.unit)}
                    </span>
                  </DataField>
                  <DataField label="Unit Price">
                    {i.unit_price != null ? (
                      <span>₱{Number(i.unit_price).toFixed(2)}</span>
                    ) : (
                      <span className="text-cocoa-200">—</span>
                    )}
                  </DataField>
                  {i.units_per_box != null && (
                    <DataField label="Packaging">
                      {Number(i.units_per_box)} {i.unit} per box · {fmtQty(i.quantity, i.unit)} on hand
                    </DataField>
                  )}
                  <DataField label="Category">{i.category?.name ?? "—"}</DataField>
                  <DataField label="Location">{i.location?.name ?? "—"}</DataField>
                  <DataField label="Form">
                    <span className="capitalize">{i.physical_form}</span>
                  </DataField>
                  <DataField label="Expiry">
                    {i.expiration_date ? (
                      <span
                        className={
                          expiry.key === "expired"
                            ? "font-semibold text-terracotta-700"
                            : expiry.key === "soon"
                            ? "text-ochre-700"
                            : ""
                        }
                      >
                        {fmtDate(i.expiration_date)}
                        {expiry.key === "expired" && " (expired)"}
                        {expiry.key === "soon" && ` (${expiry.days}d)`}
                      </span>
                    ) : (
                      <span className="text-cocoa-200">—</span>
                    )}
                  </DataField>

                  <div className="flex gap-1.5 pt-1">
                    <button
                      className="btn-ghost min-h-[40px] flex-1 !px-2 !py-1.5 text-xs"
                      onClick={() => setLabelItem(i)}
                    >
                      Label
                    </button>
                    <button
                      className="btn-ghost min-h-[40px] flex-1 !px-2 !py-1.5 text-xs"
                      onClick={() => openEdit(i)}
                    >
                      Edit
                    </button>
                    {me?.role === "admin" && (
                      <button
                        className="btn-danger min-h-[40px] flex-1 !px-2 !py-1.5 text-xs"
                        onClick={() => remove(i)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </DataCard>
              );
            })}
          </div>
        )}

        {filtered.length === 0 && (
          <Empty>No items match your filters.</Empty>
        )}

        {filtered.length > 0 && !stockCountMode && (
            <table className="w-full">
              <thead>
                <tr className="bg-cream-100/60">
                  {sortHeader("name", "Item")}
                  {sortHeader("sku", "SKU")}
                  {sortHeader("category", "Category")}
                  {sortHeader("location", "Location")}
                  <th className="th">Form</th>
                  {sortHeader("quantity", "On Hand", "text-right")}
                  <th className="th text-right">Unit Price</th>
                  <th className="th">Packaging</th>
                  {sortHeader("expiration", "Expiry")}
                  {sortHeader("status", "Status")}
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((i) => {
                  const status = stockStatus(i.quantity, i.low_stock_threshold);
                  const expiry = expiryStatus(i.expiration_date);
                  return (
                    <tr
                      key={i.id}
                      className={`transition-colors hover:bg-cream-50 ${
                        status.key === "out"
                          ? "bg-red-50"
                          : status.key === "low"
                            ? "bg-amber-50"
                            : ""
                      }`}
                    >
                      <td className="td font-semibold text-cocoa-800">{i.name}</td>
                      <td className="td font-mono text-xs text-cocoa-400">{i.sku}</td>
                      <td className="td text-cocoa-500">{i.category?.name ?? "—"}</td>
                      <td className="td text-cocoa-500">{i.location?.name ?? "—"}</td>
                      <td className="td capitalize text-cocoa-500">{i.physical_form}</td>
                      <td className="td text-right tabular-nums">
                        <span
                          className={
                            status.key === "ok" ? "" : "font-semibold text-terracotta-700"
                          }
                        >
                          {fmtQty(i.quantity, i.unit)}
                        </span>
                      </td>
                      <td className="td text-right tabular-nums">
                        {i.unit_price != null ? (
                          <span>₱{Number(i.unit_price).toFixed(2)}</span>
                        ) : (
                          <span className="text-cocoa-200">—</span>
                        )}
                      </td>
                      <td className="td">
                        {i.units_per_box != null && (
                          <span className="text-cocoa-500">
                            {Number(i.units_per_box)} {i.unit}/box
                          </span>
                        )}
                      </td>
                      <td className="td">
                        {i.expiration_date ? (
                          <span
                            className={
                              expiry.key === "expired"
                                ? "font-semibold text-terracotta-700"
                                : expiry.key === "soon"
                                ? "text-ochre-700"
                                : "text-cocoa-500"
                            }
                          >
                            {fmtDate(i.expiration_date)}
                            {expiry.key === "expired" && " (expired)"}
                            {expiry.key === "soon" && ` (${expiry.days}d)`}
                          </span>
                        ) : (
                          <span className="text-cocoa-200">—</span>
                        )}
                      </td>
                      <td className="td">
                        <Badge tone={status.tone} variant="tag">
                          {status.label}
                        </Badge>
                      </td>
                      <td className="td text-right">
                        <div className="inline-flex gap-1.5">
                          <button
                            className="btn-ghost !px-3 !py-1 text-xs"
                            onClick={() => setLabelItem(i)}
                          >
                            Label
                          </button>
                          <button
                            className="btn-ghost !px-3 !py-1 text-xs"
                            onClick={() => openEdit(i)}
                          >
                            Edit
                          </button>
                          {me?.role === "admin" && (
                            <button
                              className="btn-danger !px-3 !py-1 text-xs"
                              onClick={() => remove(i)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        )}
      </Card>

      {/* ---------- stock count mode ---------- */}
      {stockCountMode && (
        <Card className="!p-0">
          <div className="border-b border-cream-200 bg-cream-50 p-4">
            <h2 className="text-lg font-semibold text-cocoa-800">Stock Count</h2>
          </div>
          {countableItems.length > 0 && (
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full">
                <thead>
                  <tr className="bg-cream-100/60">
                    <th className="th">Item Name</th>
                    <th className="th">Unit</th>
                    <th className="th text-right">System Quantity</th>
                    <th className="th text-right">Actual Counted</th>
                    <th className="th text-center">Accuracy</th>
                  </tr>
                </thead>
                <tbody>
                {countableItems.map((i) => {
                  const systemQty = Number(i.quantity);
                    const counted = countedQty[i.id];
                    const countedNum = counted !== undefined && counted !== "" ? Number(counted) : null;
                    let accuracy: string | null = null;
                    let accuracyTone: "slate" | "green" | "amber" | "red" | "blue" = "slate";
                    if (countedNum !== null && systemQty > 0) {
                      const diff = Math.abs(countedNum - systemQty);
                      const pct = (diff / systemQty) * 100;
                      if (pct <= 5) { accuracy = "Accurate"; accuracyTone = "green"; }
                      else if (pct <= 15) { accuracy = "Close"; accuracyTone = "amber"; }
                      else { accuracy = "Mismatch"; accuracyTone = "red"; }
                    } else if (countedNum !== null && systemQty === 0) {
                      accuracy = countedNum > 0 ? "Found stock" : "OK";
                      accuracyTone = countedNum > 0 ? "green" : "blue";
                    }

                    return (
                      <tr key={i.id} className="transition-colors hover:bg-cream-50">
                        <td className="td font-semibold text-cocoa-800">{i.name}</td>
                        <td className="td text-cocoa-500">{i.unit}</td>
                        <td className="td text-right tabular-nums">
                          {fmtQty(systemQty, i.unit)}
                        </td>
                        <td className="td text-right">
                          <input
                            type="number"
                            min="0"
                            step="1"
                            className="input max-w-[120px] text-right"
                            placeholder="—"
                            value={countedQty[i.id] ?? ""}
                            onChange={(e) =>
                              setCountedQty((prev) => ({
                                ...prev,
                                [i.id]: e.target.value,
                              }))
                            }
                          />
                        </td>
                        <td className="td text-center">
                          {accuracy !== null ? (
                        <Badge tone={accuracyTone} variant="tag" className="text-[10px] font-medium">
                          {accuracy}
                        </Badge>
                      ) : (
                        <span className="text-xs text-cocoa-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
                </tbody>
              </table>
            </div>
          )}
          {countableItems.length > 0 && (
            <div className="space-y-2.5 p-4 lg:hidden">
              {countableItems.map((i) => {
                const systemQty = Number(i.quantity);
                const counted = countedQty[i.id];
                const countedNum = counted !== undefined && counted !== "" ? Number(counted) : null;
                let accuracy: string | null = null;
                let accuracyTone: "slate" | "green" | "amber" | "red" | "blue" = "slate";
                if (countedNum !== null && systemQty > 0) {
                  const diff = Math.abs(countedNum - systemQty);
                  const pct = (diff / systemQty) * 100;
                  if (pct <= 5) { accuracy = "Accurate"; accuracyTone = "green"; }
                  else if (pct <= 15) { accuracy = "Close"; accuracyTone = "amber"; }
                  else { accuracy = "Mismatch"; accuracyTone = "red"; }
                } else if (countedNum !== null && systemQty === 0) {
                  accuracy = countedNum > 0 ? "Found stock" : "OK";
                  accuracyTone = countedNum > 0 ? "green" : "blue";
                }

                return (
                  <div key={i.id} className="rounded-lg border border-cream-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-cocoa-800">{i.name}</div>
                        <div className="mt-0.5 text-xs text-cocoa-400">
                          Unit: {i.unit} · System: {fmtQty(systemQty, i.unit)}
                        </div>
                      </div>
                      {accuracy !== null && (
                        <Badge tone={accuracyTone} variant="tag" className="text-[9px] font-medium">
                          {accuracy}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2">
                      <label className="label text-xs" htmlFor={`counted-${i.id}`}>
                        Actual Counted (what you physically counted)
                      </label>
                      <input
                        id={`counted-${i.id}`}
                        type="number"
                        min="0"
                        step="1"
                        className="input"
                        placeholder="Enter counted quantity"
                        value={countedQty[i.id] ?? ""}
                        onChange={(e) =>
                          setCountedQty((prev) => ({
                            ...prev,
                            [i.id]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {countableItems.length === 0 && (
            <Empty>All items have been counted.</Empty>
          )}
          <div className="flex justify-end gap-2 border-t border-cream-200 bg-cream-50 p-4">
            <button className="btn-ghost" onClick={exitStockCountMode} disabled={savingCounts}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={saveCounts}
              disabled={savingCounts || filtered.length === 0}
            >
              {savingCounts ? "Saving..." : "Save Counts"}
            </button>
          </div>
        </Card>
      )}

      {/* ---------- create / edit modal ---------- */}
      <Modal
        open={creating || !!editing}
        onClose={closeForm}
        title={editing ? `Edit — ${editing.name}` : "Add item"}
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="item-name">
              Item name
            </label>
            <input
              id="item-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Arabica Coffee Beans"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="item-category">
                Category
              </label>
              <select
                id="item-category"
                className="input"
                value={form.category_id}
                onChange={(e) => {
                  const cat = categories.find((c) => c.id === e.target.value);
                  setForm((f) => ({
                    ...f,
                    category_id: e.target.value,
                    ...(cat?.default_unit ? { unit: cat.default_unit } : {}),
                    ...(cat?.default_physical_form ? { physical_form: cat.default_physical_form } : {}),
                  }));
                }}
              >
                <option value="">—</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="item-location">
                Storage location
              </label>
              <select
                id="item-location"
                className="input"
                value={form.location_id}
                onChange={(e) => setForm({ ...form, location_id: e.target.value })}
              >
                <option value="">—</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.min_shelf_life_days
                      ? ` — needs ${l.min_shelf_life_days}+ days of shelf life`
                      : ""}
                  </option>
                ))}
              </select>
              {/* Spelled out rather than hidden in the dropdown, because it is a
                  rule that will refuse a restock and the operator needs to know
                  which locations carry one. */}
              {locations.find((l) => l.id === form.location_id)?.min_shelf_life_days ? (
                <p className="mt-1 text-[11px] text-cocoa-400">
                  A restock into this location is refused if the batch has fewer than{" "}
                  {locations.find((l) => l.id === form.location_id)?.min_shelf_life_days}{" "}
                  day(s) of shelf life left.
                </p>
              ) : null}
            </div>
            <div>
              <label className="label" htmlFor="item-supplier">
                Supplier
              </label>
              <select
                id="item-supplier"
                className="input"
                value={form.supplier_id}
                onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
              >
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="item-physical-form">
                Physical form
              </label>
              <select
                id="item-physical-form"
                className={`input ${formError && formError.includes("physical form") ? "border-terracotta-500 focus:ring-terracotta-500" : ""}`}
                value={form.physical_form}
                onChange={(e) => {
                  const pf = e.target.value;
                  const err = validateUnitForm(form.unit, pf);
                  if (err) {
                    setFormError(err);
                    return;
                  }
                  setFormError(null);
                  setForm({ ...form, physical_form: pf });
                }}
              >
                <option value="solid">Solid</option>
                <option value="liquid">Liquid</option>
                <option value="powder">Powder</option>
              </select>
              {formError && formError.includes("physical form") && (
                <p className="mt-1 text-[11px] text-terracotta-600">{formError}</p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="item-unit">
                Unit
              </label>
              <select
                id="item-unit"
                className="input"
                value={form.unit}
                onChange={(e) => {
                  const unit = e.target.value;
                  // When the unit changes, always reset physical_form to the
                  // new unit's default — a stale form (e.g. "liquid" for kg)
                  // would be saved otherwise. The user can still override it
                  // afterwards; this just keeps the default in sync.
                  setForm((prev) => ({
                    ...prev,
                    unit,
                    physical_form: UNIT_FORM_DEFAULT[unit] ?? prev.physical_form,
                  }));
                }}
              >
                <option value="kg">kg — kilograms</option>
                <option value="g">g — grams</option>
                <option value="L">L — liters</option>
                <option value="mL">mL — milliliters</option>
                <option value="pcs">pcs — pieces</option>
                <option value="pack">pack</option>
                <option value="bottle">bottle</option>
                <option value="can">can</option>
                <option value="box">box</option>
                <option value="sack">sack</option>
                <option value="bag">bag</option>
                <option value="pouch">pouch</option>
                <option value="sachet">sachet</option>
                <option value="carton">carton</option>
                <option value="cup">cup</option>
                <option value="mug">mug</option>
                <option value="slice">slice</option>
                <option value="warp">warp</option>
                <option value="portion">portion</option>
                <option value="serving">serving</option>
                <option value="dozen">dozen</option>
                <option value="gallon">gallon</option>
                <option value="oz">oz — ounces</option>
                <option value="lb">lb — pounds</option>
                <option value="kg-pack">kg-pack</option>
                <option value="bunch">bunch</option>
                <option value="bundle">bundle</option>
                <option value="tray">tray</option>
                <option value="tin">tin</option>
                <option value="jar">jar</option>
                <option value="keg">keg</option>
                <option value="roll">roll</option>
                <option value="sheet">sheet</option>
                <option value="loaf">loaf</option>
                <option value="crate">crate</option>
                <option value="bucket">bucket</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              {/* Associated with htmlFor rather than merely sitting beside the
                  input: an unassociated label is announced as unlabelled by a
                  screen reader, and it is the only thing that lets the browser
                  test find this exact field instead of guessing by position. */}
              <label className="label" htmlFor="item-quantity">
                {editing ? "Quantity on hand (correction)" : "Starting quantity"}
              </label>
              <input
                id="item-quantity"
                className="input"
                type="number"
                min="0"
                step="0.001"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="item-threshold">
                Low-stock threshold
              </label>
              <input
                id="item-threshold"
                className="input"
                type="number"
                min="0"
                step="0.001"
                value={form.low_stock_threshold}
                onChange={(e) =>
                  setForm({ ...form, low_stock_threshold: e.target.value })
                }
              />
            </div>
          </div>

          {editing && Number(form.quantity) !== Number(editing.quantity) && (
            <div>
              <label className="label" htmlFor="item-correction-reason">
                Stock correction reason
              </label>
              <textarea
                id="item-correction-reason"
                className="input min-h-20"
                maxLength={500}
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                placeholder="Explain why the recorded quantity is being corrected"
                required
              />
            </div>
          )}

        <div>
          <label className="label" htmlFor="item-units-per-box">
            Units per box (optional)
          </label>
          <input
            id="item-units-per-box"
            className="input"
            type="number"
            min="0"
            step="1"
            value={form.units_per_box}
            onChange={(e) => setForm({ ...form, units_per_box: e.target.value })}
            placeholder="Leave blank if not supplied in boxes"
          />
          <p className="mt-1 text-[11px] text-cocoa-400">
            Fill this in if the supplier delivers whole boxes — a restock can then
            be entered as a box count and converted to {form.unit || "units"}.
          </p>
        </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="item-unit-price">
                <Tooltip label="Unit Price (optional)" tip="Cost per unit in PHP. Used for waste cost tracking in monthly analytics." />
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-cocoa-400">
                  ₱
                </span>
                <input
                  id="item-unit-price"
                  className="input pl-7"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.unit_price}
                  onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
                  placeholder="0.00"
                />
              </div>
              <p className="mt-1 text-[11px] text-cocoa-400">
                Cost per unit in PHP. Used for waste cost tracking in monthly analytics.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="item-par-level">
                <Tooltip label="Par level (optional)" tip="Maximum stock to keep on hand. Alerts trigger when stock falls below this level." />
              </label>
              <input
                id="item-par-level"
                className="input"
                type="number"
                min="0"
                step="1"
                value={form.par_level}
                onChange={(e) => setForm({ ...form, par_level: e.target.value })}
                placeholder="Maximum stock to keep on hand"
              />
            </div>
            <div>
              <label className="label" htmlFor="item-target-days">
                <Tooltip label="Target days of stock (optional)" tip="Days of supply to aim for. Used by demand forecasting to suggest reorder quantities." />
              </label>
              <input
                id="item-target-days"
                className="input"
                type="number"
                min="0"
                step="1"
                value={form.target_days}
                onChange={(e) => setForm({ ...form, target_days: e.target.value })}
                placeholder="How many days of stock to keep"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                id="item-expirable"
                type="checkbox"
                className="h-4 w-4 accent-cocoa-600"
                checked={form.expirable}
                onChange={(e) => setForm({ ...form, expirable: e.target.checked })}
              />
              <label htmlFor="item-expirable" className="label !mb-0">
                Expirable
              </label>
            </div>
            {!form.expirable && (
              <p className="text-[11px] text-cocoa-400">
                This item does not expire (e.g. cups, packaging).
              </p>
            )}
            {form.expirable && (
              <div>
                <label className="label" htmlFor="item-expiration-date">
                  Expiration date
                </label>
                <input
                  id="item-expiration-date"
                  className="input"
                  type="date"
                  value={form.expiration_date}
                  onChange={(e) => setForm({ ...form, expiration_date: e.target.value })}
                />
                <p className="mt-1 text-[11px] text-cocoa-400">
                  Leave empty if this item does not expire.
                </p>
              </div>
            )}
          </div>

          {editing && (
            <p className="text-[11px] text-cocoa-400">
              SKU <span className="font-mono">{editing.sku}</span> is permanent and
              encoded in the printed barcode label.
            </p>
          )}

          <div>
            <label className="label" htmlFor="item-approval-code">
              Approval code (optional)
            </label>
            <input
              id="item-approval-code"
              className="input font-mono"
              value={approvalCode}
              onChange={(e) => setApprovalCode(e.target.value)}
              placeholder="Enter your code to skip admin review"
              maxLength={32}
            />
            <p className="mt-1 text-[11px] text-cocoa-400">
              If an admin gave you a code, enter it here — your item or edit is
              approved immediately. Without it, it goes to the admin for review.
            </p>
          </div>

          {formError && (
            <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
              {formError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={closeForm} disabled={saving}>
              Cancel
            </button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving ? "Saving..." : editing ? "Save changes" : "Create item"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ---------- barcode modal ---------- */}
      <Modal
        open={!!labelItem}
        onClose={() => setLabelItem(null)}
        title={labelItem ? `Barcode label — ${labelItem.name}` : ""}
        width="max-w-sm"
      >
        {labelItem && (
          <div className="flex flex-col items-center gap-4">
            <BarcodeView
              value={labelItem.expiration_date ? `${labelItem.sku}-${labelItem.expiration_date}` : labelItem.sku}
              width={260}
              label={`Barcode for ${labelItem.name}`}
            />
            <div className="text-center">
              <div className="text-sm font-semibold text-cocoa-800">{labelItem.name}</div>
              <div className="text-xs text-cocoa-400">
                {labelItem.category?.name ?? "Uncategorized"} ·{" "}
                {fmtQty(labelItem.quantity, labelItem.unit)} on hand
              </div>
              {labelItem.expiration_date && (
                <div className="mt-1 text-xs text-cocoa-400">
                  Expires: {fmtDate(labelItem.expiration_date)}
                </div>
              )}
            </div>
            <button
              className="btn-primary w-full"
              onClick={() =>
                printBarcodeLabelsAsync([
                  {
                    value: labelItem.expiration_date
                      ? `${labelItem.sku}-${labelItem.expiration_date}`
                      : labelItem.sku,
                    title: labelItem.name,
                    subtitle: labelItem.expiration_date
                      ? `${labelItem.category?.name ?? "Uncategorized"} · expires ${fmtDate(labelItem.expiration_date)}`
                      : labelItem.category?.name ?? "",
                  },
                ])
              }
            >
              Print this label
            </button>
          </div>
        )}
      </Modal>

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
