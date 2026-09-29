"use client";

import { useState } from "react";
import {
  Card,
  Modal,
  Empty,
  Badge,
  Toast,
  DataCard,
  DataField,
} from "@/components/ui";
import { ScanInput } from "@/components/ScanInput";
import { fmtQty, fmtDate, daysUntil } from "@/lib/format";
import { expiryStatus } from "@/lib/status";

type Mode = "checkout" | "restock" | "waste";

type CartLine = {
  sku: string;
  name: string;
  unit: string;
  qty: number;
  onHand: number;
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

type Looked = {
  sku: string;
  name: string;
  unit: string;
  units_per_box: number | null;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  location: { id: string; name: string; min_shelf_life_days: number | null } | null;
};

/** An inline, dismissible message about the item that was just scanned. */
type Notice = {
  /** sku + kind, so re-scanning the same item replaces the notice. */
  id: string;
  tone: "warn" | "error";
  title: string;
  detail?: string;
};

const MAX_NOTICES = 4;

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

export default function CheckoutPage() {
  const [mode, setMode] = useState<Mode>("checkout");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);

  const deducting = DEDUCTING.includes(mode);
  const totalQty = cart.reduce((n, l) => n + l.qty, 0);
  const ready = cart.length > 0 && totalQty > 0;

  /* ---------------- notices ---------------- */

  function pushNotice(notice: Notice) {
    setNotices((prev) =>
      [notice, ...prev.filter((n) => n.id !== notice.id)].slice(0, MAX_NOTICES)
    );
  }

  function dismissNotice(id: string) {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }

  /* ---------------- cart ---------------- */

  function upsert(item: Looked) {
    const onHand = Number(item.quantity);
    const threshold = Number(item.low_stock_threshold) || 0;
    const expiry = item.expiration_date ?? null;
    // Counted by the box only when the item actually has a packaging factor.
    // Offering the option for an item without one would let someone enter a box
    // count that the database then rejects.
    const unitsPerBox =
      item.units_per_box == null ? null : Number(item.units_per_box);
    const minShelfLife =
      item.location?.min_shelf_life_days == null
        ? null
        : Number(item.location.min_shelf_life_days);

    setCart((prev) => {
      const existing = prev.find((l) => l.sku === item.sku);

      if (!existing) {
        return [
          ...prev,
          {
            sku: item.sku,
            name: item.name,
            unit: item.unit,
            qty: deducting ? Math.min(1, onHand) : 1,
            onHand,
            threshold,
            expiry,
            newExpiry: "",
            byBox: false,
            unitsPerBox,
            minShelfLife,
          },
        ];
      }

      const next = existing.qty + 1;
      return prev.map((l) =>
        l.sku === item.sku
          ? {
              ...l,
              name: item.name,
              unit: item.unit,
              onHand,
              threshold,
              expiry,
              // Re-scanning must not wipe a date the operator already typed, or
              // flip the box toggle they chose.
              newExpiry: l.newExpiry,
              byBox: l.byBox && unitsPerBox !== null,
              unitsPerBox,
              minShelfLife,
              qty: deducting ? Math.min(next, onHand) : next,
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
        // Deducting more than we hold would be rejected by the database.
        if (deducting && q > l.onHand) q = l.onHand;
        return { ...l, qty: q };
      })
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
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setScanError(null);
    setSubmitError(null);
    setNotices([]);
    if (cart.length > 0) {
      setCart([]);
      setToast({
        msg: "Cart cleared — one transaction can only be one movement type.",
        tone: "info",
      });
    }
  }

  /* ---------------- scanning ---------------- */

  async function handleScan(code: string) {
    setScanError(null);
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

      // Blocking: there is nothing to deduct, so the line is not added.
      if (deducting && qty <= 0) {
        setScanError(`${item.name} is out of stock — nothing left to deduct.`);
        pushNotice({
          id: `${item.sku}:out`,
          tone: "error",
          title: `${item.name} is out of stock`,
          detail: "Nothing left to deduct, so it was not added to the cart.",
        });
        return;
      }

      upsert(item);
      setScanError(null);

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

      if (expiry.key === "expired") {
        pushNotice({
          id: `${item.sku}:expired`,
          tone: "error",
          title: `${item.name} expired on ${fmtDate(item.expiration_date)}`,
          detail: deducting
            ? "Check before using it — log it as waste if it cannot be served."
            : "Double-check the date before adding it back.",
        });
      } else if (expiry.key === "soon") {
        pushNotice({
          id: `${item.sku}:soon`,
          tone: "warn",
          title: `${item.name} expires in ${expiry.days} day(s)`,
          detail: "Use this one first.",
        });
      }
    } catch (e: any) {
      setScanError(e.message || "Lookup failed");
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

    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: mode,
          password,
          note: note.trim() || null,
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

      // The API echoes before/after per line, so we can say when the movement
      // the operator just recorded pushed something under its threshold. Only
      // genuine crossings are reported — anything already low was warned about
      // at scan time.
      if (deducting) {
        const result = data.result as
          | {
              items?: {
                sku: string;
                name: string;
                unit: string;
                before: number;
                after: number;
              }[];
            }
          | undefined;

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
      setNote("");
      setPassword("");
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

  const modeLabel = MODES.find((m) => m.key === mode)?.label ?? mode;

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
   * "New expiry date" did nothing at all, because the date picker it pointed
   * at was display:none in the phone card. The same ambiguity hit anything
   * resolving the field by id, including browser tests.
   */
  function restockFields(line: CartLine, variant: "card" | "row") {
    if (mode !== "restock") return null;
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
            New expiry date
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
            <p id={errId} className="mt-1 text-[11px] font-semibold text-red-600">
              {problem}
            </p>
          ) : (
            <ShelfLifeHint line={line} />
          )}
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
          className={`mt-1 text-[11px] font-semibold ${ok ? "text-cocoa-400" : "text-red-600"}`}
        >
          {ok
            ? `Meets the ${line.minShelfLife}-day shelf life minimum.`
            : `Too close to expiry — this location needs ${line.minShelfLife} day(s) left, so the restock will be refused.`}
        </p>
      );
    }

    if (!line.newExpiry && line.expiry) {
      return (
        <p className="mt-1 text-[11px] text-cocoa-400">
          Blank keeps the current date, {fmtDate(line.expiry)}.
        </p>
      );
    }
    return null;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="deco-title text-3xl">Checkout &amp; Restock</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          Scan an item label, set the quantity, then confirm with your password.
        </p>
      </div>

      {/* ---------- waste warning ---------- */}
      {mode === "waste" && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-bold">Logging waste.</span> Everything added
          here is deducted from stock as spoilage, spills or expired goods, and
          is recorded separately from a normal checkout in the audit trail.
        </div>
      )}

      {/* ---------- movement type ---------- */}
      <div className="grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => {
          const active = m.key === mode;
          return (
            <button
              key={m.key}
              type="button"
              onClick={() => switchMode(m.key)}
              className={`rounded-2xl border px-4 py-3 text-left transition-colors ${
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

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        {/* ---------- scan ---------- */}
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-bold text-cocoa-800">Scan item</h2>
            <Badge tone={MODE_BADGE[mode]}>{modeLabel}</Badge>
          </div>

          <ScanInput
            key={mode}
            onScan={handleScan}
            disabled={scanning}
            placeholder="Scan the item label or type the SKU, then press Enter"
          />

          {notices.length > 0 && (
            <ul className="space-y-2">
              {notices.map((n) => (
                <li
                  key={n.id}
                  className={`flex items-start justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm ${
                    n.tone === "error"
                      ? "border-red-200 bg-red-50 text-red-800"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-semibold">{n.title}</div>
                    {n.detail && (
                      <div className="mt-0.5 text-[11px] leading-snug opacity-80">
                        {n.detail}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => dismissNotice(n.id)}
                    aria-label="Dismiss"
                    className="shrink-0 rounded-full px-1.5 text-xs font-bold opacity-60 transition-opacity hover:opacity-100"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-cocoa-300">
            {scanning
              ? "Looking up..."
              : "The scanner types into this field automatically. Re-scanning an item bumps its quantity."}
          </p>

          {scanError && (
            <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {scanError}
            </div>
          )}
        </Card>

        {/* ---------- summary + confirm ---------- */}
        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-bold text-cocoa-800">This transaction</h2>

          <div className="flex items-center justify-between text-sm">
            <span className="text-cocoa-500">Lines</span>
            <span className="font-bold tabular-nums text-cocoa-900">
              {cart.length}
            </span>
          </div>

          <div className="flex items-center justify-between text-sm">
            <span className="text-cocoa-500">Total quantity</span>
            <span className="font-bold tabular-nums text-cocoa-900">
              {fmtQty(totalQty)}
            </span>
          </div>

          <div>
            <label className="label" htmlFor="txn-note">
              Note (optional)
            </label>
            <textarea
              id="txn-note"
              className="input min-h-[72px] resize-y"
              value={note}
              maxLength={500}
              placeholder="e.g. morning shift, 3 spilled"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <button
            className="btn-primary mt-auto w-full"
            disabled={!ready}
            onClick={() => {
              setSubmitError(null);
              setPassword("");
              setConfirmOpen(true);
            }}
          >
            Review &amp; commit
          </button>

          <p className="text-center text-[11px] text-cocoa-300">
            {ready
              ? "You will confirm this with your password."
              : "Scan at least one item to continue."}
          </p>
        </Card>
      </div>
      {/* ---------- cart ---------- */}
      <Card className="!p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cream-200 bg-cream-50 px-4 py-3">
          <h2 className="text-sm font-bold text-cocoa-800">Scanned items</h2>
          <span className="text-[11px] text-cocoa-400">
            {deducting
              ? "Quantities are capped at what is on hand"
              : "Quantities add on top of current stock"}
          </span>
        </div>

        {cart.length === 0 ? (
          <Empty>Nothing scanned yet — scan or type a SKU to begin.</Empty>
        ) : (
          <>
            <div className="space-y-2.5 pb-3 lg:hidden">
              {cart.map((l) => (
                <DataCard key={l.sku}>
                  <div className="min-w-0">
                    <div className="font-semibold text-cocoa-800">{l.name}</div>
                    <div className="font-mono text-xs text-cocoa-400">{l.sku}</div>
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

                  <DataField label="Projected">
                    <span className="font-semibold tabular-nums text-cocoa-900">
                      {fmtQty(projected(l), l.unit)}
                    </span>
                  </DataField>

                  {restockFields(l, "card")}

                  <button
                    className="btn-danger min-h-[40px] w-full !py-1.5 text-sm"
                    onClick={() => removeLine(l.sku)}
                  >
                    Remove
                  </button>
                </DataCard>
              ))}
            </div>

            <div className="hidden overflow-x-auto lg:block">
            <table className="w-full">
              <thead>
                <tr className="bg-cream-100/60">
                  <th className="th">Item</th>
                  <th className="th">SKU</th>
                  <th className="th text-right">On hand</th>
                  <th className="th text-center">Quantity</th>
                  {mode === "restock" && <th className="th">Received</th>}
                  <th className="th text-right">Projected</th>
                  <th className="th text-right">Remove</th>
                </tr>
              </thead>
              <tbody>
                {cart.map((l) => (
                  <tr key={l.sku} className="transition-colors hover:bg-cream-50">
                    <td className="td font-semibold text-cocoa-800">{l.name}</td>
                    <td className="td font-mono text-xs text-cocoa-400">{l.sku}</td>
                    <td className="td text-right tabular-nums">
                      {fmtQty(l.onHand, l.unit)}
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          className="btn-ghost !px-2.5 !py-1 text-xs"
                          onClick={() => setQty(l.sku, l.qty - 1)}
                          aria-label={`Decrease ${l.name}`}
                        >
                          -
                        </button>
                        <input
                          className="input w-24 text-center"
                          type="number"
                          min="0"
                          step="0.001"
                          value={l.qty}
                          onChange={(e) => setQty(l.sku, Number(e.target.value))}
                        />
                        <button
                          className="btn-ghost !px-2.5 !py-1 text-xs"
                          onClick={() => setQty(l.sku, l.qty + 1)}
                          aria-label={`Increase ${l.name}`}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    {mode === "restock" && (
                      <td className="td min-w-[12rem]">{restockFields(l, "row")}</td>
                    )}
                    <td className="td text-right font-semibold tabular-nums text-cocoa-900">
                      {fmtQty(projected(l), l.unit)}
                    </td>
                    <td className="td text-right">
                      <button
                        className="btn-danger !px-3 !py-1 text-xs"
                        onClick={() => removeLine(l.sku)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {/* ---------- password confirmation ---------- */}
      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting) setConfirmOpen(false);
        }}
        title={MODE_TITLE[mode]}
        width="max-w-md"
      >
        <div className="space-y-4">
          <ul className="space-y-1.5">
            {cart.map((l) => (
              <li
                key={l.sku}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <span className="min-w-0 truncate text-cocoa-700">{l.name}</span>
                <span className="shrink-0 tabular-nums text-cocoa-500">
                  {deducting ? "-" : "+"}
                  {fmtQty(l.qty, l.unit)}
                  <span className="text-cocoa-300">
                    {" → "}
                    {fmtQty(projected(l), l.unit)}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {note.trim() && (
            <div className="rounded-xl bg-cream-100 px-3.5 py-2.5 text-xs text-cocoa-600">
              {note.trim()}
            </div>
          )}

          <div>
            <label className="label" htmlFor="txn-password">
              Your password
            </label>
            <input
              id="txn-password"
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              placeholder="Confirm to record this movement"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password && !submitting) commit();
              }}
            />
          </div>

          {submitError && (
            <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
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
              disabled={submitting || !password}
            >
              {submitting ? "Committing..." : MODE_TITLE[mode]}
            </button>
          </div>
        </div>
      </Modal>

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
