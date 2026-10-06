"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Spinner, Empty, Toast, Badge, DataCard, DataField, Modal } from "@/components/ui";
import { fmtQty, fmtDate } from "@/lib/format";

/**
 * The FR-03 approval queue.
 *
 * Staff without item-management permission can put an ingredient in; it waits
 * here until an admin approves or rejects it. Only admins can decide — the API
 * refuses a staff decision with a 403, so this page shows nothing but read-only
 * information to anyone else.
 *
 * An approved item immediately becomes stock: it counts toward the dashboard,
 * can be scanned at the till, and raises alerts if it is already low or close to
 * its date. That is why approving is a real decision and not a formality.
 */

type Item = {
  id: string;
  sku: string;
  name: string;
  physical_form: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  item_status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  category: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
};

export default function ApprovalsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: any } | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<Item | null>(null);
  const [note, setNote] = useState("");

  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [me, res] = await Promise.all([
        fetch("/api/auth/me").then((r) => r.json()).catch(() => ({})),
        fetch("/api/items?status=pending").then((r) => r.json()),
      ]);

      setIsAdmin(me?.user?.role === "admin");
      if (res.error) throw new Error(res.error);
      setItems(res.items ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load submissions");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // A submission from a colleague should appear without a manual refresh.
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function decide(item: Item, decision: "approve" | "reject", why?: string) {
    setBusy(item.id);
    setError(null);
    try {
      const res = await fetch("/api/items/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, decision, note: why ?? null }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.error) throw new Error(data.error);

      setToast({ msg: data.message || "Done", tone: "success" });
      setRejecting(null);
      setNote("");
      await load();
    } catch (e: any) {
      setError(e.message || "Could not record that decision");
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner label="Loading submissions..." />;

  return (
    <div className="space-y-5">
      <Toast message={toast?.msg ?? null} tone={toast?.tone} onDone={() => setToast(null)} />

      <div>
        <h1 className="deco-title text-3xl">Approvals</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          Ingredients submitted by staff, waiting to become stock.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      {!isAdmin && (
        <div className="rounded-xl bg-cream-100 px-3.5 py-2.5 text-sm text-cocoa-600">
          Only an admin can approve or reject a submission. You can see what is
          waiting, and add items yourself from All Items.
        </div>
      )}

      {items.length === 0 ? (
        <Empty>Nothing is waiting for approval.</Empty>
      ) : (
        <>
          {/* phones */}
          <div className="space-y-3 lg:hidden">
            {items.map((i) => (
              <DataCard key={i.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-cocoa-900">{i.name}</div>
                    <div className="text-xs text-cocoa-500">{i.sku}</div>
                  </div>
                  <Badge tone="amber" variant="tag">Awaiting approval</Badge>
                </div>

                <DataField label="Starting quantity">
                  {fmtQty(i.quantity, i.unit)}
                </DataField>
                <DataField label="Category">{i.category?.name ?? "—"}</DataField>
                <DataField label="Storage">{i.location?.name ?? "—"}</DataField>
                <DataField label="Expires">
                  {i.expiration_date ? fmtDate(i.expiration_date) : "—"}
                </DataField>
                <DataField label="Submitted">{fmtDate(i.submitted_at)}</DataField>

                {isAdmin && (
                  <div className="flex gap-2 pt-1">
                    <button
                      className="btn-primary flex-1"
                      disabled={busy === i.id}
                      onClick={() => decide(i, "approve")}
                    >
                      {busy === i.id ? "Working..." : "Approve"}
                    </button>
                    <button
                      className="btn-ghost flex-1"
                      disabled={busy === i.id}
                      onClick={() => setRejecting(i)}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </DataCard>
            ))}
          </div>

          {/* desktop */}
          <Card className="!p-0 hidden lg:block">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-cream-100">
                  <tr>
                    <th className="th">Item</th>
                    <th className="th">Category</th>
                    <th className="th">Storage</th>
                    <th className="th text-right">Starting qty</th>
                    <th className="th">Expires</th>
                    <th className="th">Submitted</th>
                    <th className="th text-right">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-t border-cream-200">
                      <td className="td">
                        <div className="font-semibold text-cocoa-900">{i.name}</div>
                        <div className="text-xs text-cocoa-500">{i.sku}</div>
                      </td>
                      <td className="td text-cocoa-600">{i.category?.name ?? "—"}</td>
                      <td className="td text-cocoa-600">{i.location?.name ?? "—"}</td>
                      <td className="td text-right tabular-nums">
                        {fmtQty(i.quantity, i.unit)}
                      </td>
                      <td className="td text-cocoa-600">
                        {i.expiration_date ? fmtDate(i.expiration_date) : "—"}
                      </td>
                      <td className="td text-cocoa-600">{fmtDate(i.submitted_at)}</td>
                      <td className="td">
                        {isAdmin ? (
                          <div className="flex justify-end gap-2">
                            <button
                              className="btn-primary"
                              disabled={busy === i.id}
                              onClick={() => decide(i, "approve")}
                            >
                              {busy === i.id ? "..." : "Approve"}
                            </button>
                            <button
                              className="btn-ghost"
                              disabled={busy === i.id}
                              onClick={() => setRejecting(i)}
                            >
                              Reject
                            </button>
                          </div>
                        ) : (
                          <Badge tone="amber" variant="tag">Awaiting approval</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Modal
        open={Boolean(rejecting)}
        onClose={() => { setRejecting(null); setNote(""); }}
        title={`Reject ${rejecting?.name ?? ""}`}
      >
        <p className="text-sm text-cocoa-600">
          The submission is kept with your reason, so whoever added it can see
          what happened. It will not count as stock.
        </p>
        <label className="label mt-4" htmlFor="reject-note">Reason (optional)</label>
        <textarea
          id="reject-note"
          className="input min-h-[80px] resize-y"
          value={note}
          maxLength={500}
          placeholder="e.g. duplicate of Vanilla Syrup"
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => { setRejecting(null); setNote(""); }}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy === rejecting?.id}
            onClick={() => rejecting && decide(rejecting, "reject", note)}
          >
            {busy === rejecting?.id ? "Working..." : "Reject submission"}
          </button>
        </div>
      </Modal>
    </div>
  );
}