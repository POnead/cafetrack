"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Modal, Spinner, Empty, Toast, Badge } from "@/components/ui";
import { BarcodeView, printBarcodeLabelsAsync } from "@/components/BarcodeView";
import { fmtQty, fmtDate } from "@/lib/format";
import { stockStatus, expiryStatus } from "@/lib/status";

type Item = {
  id: string;
  sku: string;
  name: string;
  physical_form: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  version: number;
  category: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
};

type Ref = { id: string; name: string };

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

const EMPTY_FORM = {
  name: "",
  category_id: "",
  location_id: "",
  physical_form: "solid",
  unit: "pcs",
  quantity: "0",
  low_stock_threshold: "5",
  expiration_date: "",
};

export default function ItemsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<Ref[]>([]);
  const [locations, setLocations] = useState<Ref[]>([]);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState("");

  // Default order matches what the API already returns (name ascending), so
  // leaving the page alone looks unchanged.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [editing, setEditing] = useState<Item | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [labelItem, setLabelItem] = useState<Item | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: any } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inFlight = useRef(false);

  async function load() {
    // Skip while a poll is still in flight so a slow response cannot land
    // late and overwrite fresher data.
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const [i, c, l] = await Promise.all([
        fetch("/api/items").then((r) => r.json()),
        fetch("/api/refs/categories").then((r) => r.json()).catch(() => ({ items: [] })),
        fetch("/api/refs/locations").then((r) => r.json()).catch(() => ({ items: [] })),
      ]);

      if (i.error) throw new Error(i.error);

      setItems(i.items ?? []);
      setCategories(c.items ?? []);
      setLocations(l.items ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load items");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The spec asks for "search, filter, and sort capabilities". Sorting is done
  // here rather than in the query because every row is already loaded, and
  // this keeps the local adapter out of it.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = items.filter((i) => {
      if (catFilter && i.category?.id !== catFilter) return false;
      if (!needle) return true;
      return (
        i.name.toLowerCase().includes(needle) || i.sku.toLowerCase().includes(needle)
      );
    });

    if (!sortKey) return rows;

    const dir = sortDir === "asc" ? 1 : -1;
    const value = (i: Item): string | number => {
      switch (sortKey) {
        case "name":
          return i.name.toLowerCase();
        case "sku":
          return i.sku.toLowerCase();
        case "category":
          return i.category?.name?.toLowerCase() ?? "";
        case "location":
          return i.location?.name?.toLowerCase() ?? "";
        case "quantity":
          return Number(i.quantity);
        case "threshold":
          return Number(i.low_stock_threshold);
        case "expiration":
          // Undated items sort last either way, instead of as an empty string
          // which would bury them at the top of a descending sort.
          return i.expiration_date ?? "";
        case "status":
          return STATUS_RANK[stockStatus(i.quantity, i.low_stock_threshold).key];
      }
    };

    return [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreak so equal rows do not shuffle between renders.
      return a.name.localeCompare(b.name);
    });
  }, [items, q, catFilter, sortKey, sortDir]);

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
    return (
      <th className={`th select-none ${extra}`}>
        <button
          type="button"
          onClick={() => toggleSort(key)}
          className="inline-flex items-center gap-1 hover:text-cocoa-700"
          aria-label={`Sort by ${label}`}
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
      physical_form: item.physical_form,
      unit: item.unit,
      quantity: String(item.quantity),
      low_stock_threshold: String(item.low_stock_threshold),
      expiration_date: item.expiration_date ?? "",
    });
    setFormError(null);
    setEditing(item);
    setCreating(false);
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
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

      const payload = {
        name: form.name,
        category_id: form.category_id || null,
        location_id: form.location_id || null,
        physical_form: form.physical_form,
        unit: form.unit,
        quantity: qty,
        low_stock_threshold:
          form.low_stock_threshold.trim() === "" ? 5 : Math.round(low),
        expiration_date: form.expiration_date || null,
      };

      const res = await fetch(editing ? `/api/items/${editing.id}` : "/api/items", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");

      setToast({
        msg: editing ? "Item updated" : `Item created — SKU ${data.item.sku}`,
        tone: "success",
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

  async function printAll() {
    if (filtered.length === 0) return;
    await printBarcodeLabelsAsync(
      filtered.map((i) => ({
        value: i.sku,
        title: i.name,
        subtitle: i.category?.name ?? "",
      }))
    );
  }

  if (loading) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Inventory Management</h1>
          <p className="mt-1 text-sm text-cocoa-500">
            Add ingredients, print barcode labels, and track quantities.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={printAll}>
            Print visible barcode labels
          </button>
          <button className="btn-primary" onClick={openCreate}>
            Add item
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <Card className="!p-0">
        <div className="flex flex-wrap gap-3 border-b border-cream-200 bg-cream-50 p-4">
          <input
            className="input max-w-xs"
            placeholder="Search name or SKU..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
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
            {filtered.length} of {items.length} items
          </div>
        </div>

        {filtered.length === 0 ? (
          <Empty>No items match your filters.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-cream-100/60">
                  {sortHeader("name", "Item")}
                  {sortHeader("sku", "SKU")}
                  {sortHeader("category", "Category")}
                  {sortHeader("location", "Location")}
                  <th className="th">Form</th>
                  {sortHeader("quantity", "On Hand", "text-right")}
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
                    <tr key={i.id} className="transition-colors hover:bg-cream-50">
                      <td className="td font-semibold text-cocoa-800">{i.name}</td>
                      <td className="td font-mono text-xs text-cocoa-400">{i.sku}</td>
                      <td className="td text-cocoa-500">{i.category?.name ?? "—"}</td>
                      <td className="td text-cocoa-500">{i.location?.name ?? "—"}</td>
                      <td className="td capitalize text-cocoa-500">{i.physical_form}</td>
                      <td className="td text-right tabular-nums">
                        <span
                          className={
                            status.key === "ok" ? "" : "font-semibold text-red-600"
                          }
                        >
                          {fmtQty(i.quantity, i.unit)}
                        </span>
                      </td>
                      <td className="td">
                        {i.expiration_date ? (
                          <span
                            className={
                              expiry.key === "expired"
                                ? "font-semibold text-red-600"
                                : expiry.key === "soon"
                                ? "text-amber-700"
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
                        <Badge tone={status.tone} variant="solid">
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
                          <button
                            className="btn-danger !px-3 !py-1 text-xs"
                            onClick={() => remove(i)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---------- create / edit modal ---------- */}
      <Modal
        open={creating || !!editing}
        onClose={closeForm}
        title={editing ? `Edit — ${editing.name}` : "Add item"}
      >
        <div className="space-y-4">
          <div>
            <label className="label">Item name</label>
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Arabica Coffee Beans"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Category</label>
              <select
                className="input"
                value={form.category_id}
                onChange={(e) => setForm({ ...form, category_id: e.target.value })}
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
              <label className="label">Storage location</label>
              <select
                className="input"
                value={form.location_id}
                onChange={(e) => setForm({ ...form, location_id: e.target.value })}
              >
                <option value="">—</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Physical form</label>
              <select
                className="input"
                value={form.physical_form}
                onChange={(e) => setForm({ ...form, physical_form: e.target.value })}
              >
                <option value="solid">Solid</option>
                <option value="liquid">Liquid</option>
                <option value="powder">Powder</option>
              </select>
            </div>
            <div>
              <label className="label">Unit</label>
              <input
                className="input"
                value={form.unit}
                onChange={(e) => setForm({ ...form, unit: e.target.value })}
                placeholder="kg, L, pcs..."
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">
                {editing ? "Quantity on hand (correction)" : "Starting quantity"}
              </label>
              <input
                className="input"
                type="number"
                min="0"
                step="0.001"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Low-stock threshold</label>
              <input
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

          <div>
            <label className="label">Expiration date</label>
            <input
              className="input"
              type="date"
              value={form.expiration_date}
              onChange={(e) => setForm({ ...form, expiration_date: e.target.value })}
            />
          </div>

          {editing && (
            <p className="text-[11px] text-cocoa-400">
              SKU <span className="font-mono">{editing.sku}</span> is permanent and
              encoded in the printed barcode label.
            </p>
          )}

          {formError && (
            <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
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
            <BarcodeView value={labelItem.sku} width={260} label={`Barcode for ${labelItem.name}`} />
            <div className="text-center">
              <div className="text-sm font-semibold text-cocoa-800">{labelItem.name}</div>
              <div className="text-xs text-cocoa-400">
                {labelItem.category?.name ?? "Uncategorized"} ·{" "}
                {fmtQty(labelItem.quantity, labelItem.unit)} on hand
              </div>
            </div>
            <button
              className="btn-primary w-full"
              onClick={() =>
                printBarcodeLabelsAsync([
                  {
                    value: labelItem.sku,
                    title: labelItem.name,
                    subtitle: labelItem.category?.name ?? "",
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
