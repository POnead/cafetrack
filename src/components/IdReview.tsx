"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, DataField, Spinner } from "@/components/ui";

/**
 * The review screen: the two images side by side, what the checks said, and the
 * approve/reject decision.
 *
 * ## The layout is the point
 *
 * The images sit next to each other at the same size, because the decision being
 * made is "are these the same person" and that question is answered by looking,
 * not by reading. Everything the checks found sits below them as evidence, not
 * above them — an admin who reads a verdict before seeing the card has already
 * decided.
 *
 * ## Signals show their reasoning
 *
 * Each one is a sentence with the numbers in it, not a status word. That is a
 * deliberate contract with whoever wrote the checks: a bare "FAILED" would tell
 * an admin nothing they can act on, and would be indistinguishable from a model
 * being wrong. "Distance 0.61, threshold 0.55" can be argued with.
 *
 * ## Nothing decides itself
 *
 * There is no auto-approve, however clean the signals are, and there is no
 * auto-reject however bad they are. The buttons are always both present and
 * always the admin's to press.
 */

export type ReviewSignal = {
  id: string;
  label: string;
  tone: "pass" | "warn" | "fail" | "unknown";
  detail: string;
};

export type ReviewUser = {
  id: string;
  full_name: string;
  username: string;
  verification_status: string;
  id_doc_type: string | null;
  id_doc_number: string | null;
  verification_notes: string | null;
  verified_at: string | null;
  has_front: boolean;
  has_back: boolean;
  has_photo: boolean;
};

type Props = {
  userId: string;
  /** Called after a decision lands, so the roster can refresh. */
  onDone: (message: string) => void;
  onClose: () => void;
};

const TONE: Record<ReviewSignal["tone"], { badge: "green" | "amber" | "red" | "slate"; label: string }> = {
  pass: { badge: "green", label: "Passed" },
  warn: { badge: "amber", label: "Check this" },
  fail: { badge: "red", label: "Problem" },
  unknown: { badge: "slate", label: "Not checked" },
};

/** Maps the stored doc type onto the label shown. Mirrors ID_DOC_TYPE_LABELS. */
const DOC_LABEL: Record<string, string> = {
  philsys: "PhilSys National ID",
  lto_license: "LTO Driver's Licence",
  passport: "Passport",
  sss: "SSS ID",
  umid: "UMID / GSIS",
  philhealth: "PhilHealth ID",
  voters: "Voter's ID",
  other: "Other",
};

const STATUS: Record<string, { tone: "green" | "amber" | "red"; label: string }> = {
  verified: { tone: "green", label: "Verified" },
  unverified: { tone: "amber", label: "Not checked" },
  rejected: { tone: "red", label: "Rejected" },
};

export default function IdReview({ userId, onDone, onClose }: Props) {
  const [user, setUser] = useState<ReviewUser | null>(null);
  const [signals, setSignals] = useState<ReviewSignal[]>([]);
  const [fields, setFields] = useState<Record<string, string | null>>({});
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/users/${userId}/id/status`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the ID record");

      setUser(data.user);
      setSignals(data.signals ?? []);
      setFields(data.fields ?? {});
      setProviders(data.providers ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/id`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not record the decision");

      onDone(
        decision === "approve"
          ? `${user?.full_name ?? "Account"} verified`
          : `${user?.full_name ?? "Account"} rejected — the reason will be shown at sign-in`
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/id`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove the documents");

      await load();
      onDone("ID documents removed");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Spinner />;

  if (!user) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-cocoa-500">{error ?? "That account could not be loaded."}</p>
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  const status = STATUS[user.verification_status] ?? STATUS.unverified;
  const hasDocuments = user.has_front || user.has_back || user.has_photo;

  return (
    <div className="space-y-4">
      {/* ---- who, and where they stand ---- */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-cocoa-800">{user.full_name}</p>
          <p className="text-xs text-cocoa-400">
            {user.id_doc_type ? DOC_LABEL[user.id_doc_type] ?? user.id_doc_type : "No ID attached"}
            {user.id_doc_number ? ` · ${user.id_doc_number}` : ""}
          </p>
        </div>
        <Badge tone={status.tone} variant="tag" dot>
          {status.label}
        </Badge>
      </div>

      {/*
        The images, same size, side by side.

        `object-contain` rather than `cover`: an ID card cropped to fill a square
        loses the edges, and the edges are where the security features and the
        print quality live — the two things an admin is looking for when they ask
        whether a card has been doctored.
      */}
      {hasDocuments ? (
        <div className="grid grid-cols-2 gap-3">
          <figure className="space-y-1">
            <div className="flex aspect-[85.6/54] items-center justify-center overflow-hidden rounded-xl border border-cream-200 bg-cream-100">
              {user.has_front ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/users/${user.id}/id?part=front`}
                  alt={`Front of the ID for ${user.full_name}`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span className="text-xs text-cocoa-400">No front</span>
              )}
            </div>
            <figcaption className="text-center text-[11px] text-cocoa-400">ID</figcaption>
          </figure>

          <figure className="space-y-1">
            <div className="flex aspect-[85.6/54] items-center justify-center overflow-hidden rounded-xl border border-cream-200 bg-cream-100">
              {user.has_photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/users/${user.id}/id?part=photo`}
                  alt={`Photo of ${user.full_name}`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span className="text-xs text-cocoa-400">No photo</span>
              )}
            </div>
            <figcaption className="text-center text-[11px] text-cocoa-400">Person</figcaption>
          </figure>

          {user.has_back && (
            <figure className="col-span-2 space-y-1">
              <div className="flex items-center justify-center overflow-hidden rounded-xl border border-cream-200 bg-cream-100">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/users/${user.id}/id?part=back`}
                  alt={`Back of the ID for ${user.full_name}`}
                  className="max-h-40 w-auto object-contain"
                />
              </div>
              <figcaption className="text-center text-[11px] text-cocoa-400">Back of the ID</figcaption>
            </figure>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-cream-50 px-3.5 py-3 text-xs text-cocoa-500">
          Nothing attached yet. Use “Verify ID” on this account to upload the card and a photo of
          the person.
        </div>
      )}

      {/* ---- what was read off the card ---- */}
      {fields.full_name && (
        <DataField label="Read from the card">
          <span className="text-xs text-cocoa-700">
            {fields.full_name}
            {fields.id_number ? ` · ${fields.id_number}` : ""}
            {fields.date_of_birth ? ` · born ${fields.date_of_birth}` : ""}
          </span>
        </DataField>
      )}

      {/* ---- what the checks concluded ---- */}
      {signals.length > 0 && (
        <div className="space-y-2">
          <p className="label !mb-0">What the checks found</p>
          {signals.map((s) => (
            <div
              key={s.id}
              className="rounded-xl bg-cream-50 px-3.5 py-2.5 text-xs text-cocoa-600"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-cocoa-800">{s.label}</span>
                <Badge tone={TONE[s.tone]?.badge ?? "slate"} variant="tag">
                  {TONE[s.tone]?.label ?? s.tone}
                </Badge>
              </div>
              <p className="mt-1 leading-snug">{s.detail}</p>
            </div>
          ))}
        </div>
      )}

      {providers.length > 0 && (
        <p className="text-[11px] text-cocoa-400">
          Checked by: {providers.map((p) => p.label).join(", ")}.
        </p>
      )}

      {/* ---- the decision ---- */}
      {hasDocuments && (
        <div className="space-y-2.5 border-t border-cream-200 pt-3.5">
          <label className="label" htmlFor="id-review-reason">
            Reason (required to reject, optional to approve)
          </label>
          <textarea
            id="id-review-reason"
            className="input min-h-[72px] resize-y"
            rows={2}
            maxLength={300}
            value={reason}
            placeholder="e.g. The card is a different person; the surname does not match"
            onChange={(e) => setReason(e.target.value)}
          />

          {error && (
            <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
              {error}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="btn-ghost text-xs"
              onClick={purge}
              disabled={busy}
              title="Removes the stored images. Recorded in the audit trail."
            >
              Remove documents
            </button>
            <button
              className="btn-danger"
              onClick={() => decide("reject")}
              disabled={busy || reason.trim().length < 3}
            >
              {busy ? "Saving..." : "Reject"}
            </button>
            <button
              className="btn-primary"
              onClick={() => decide("approve")}
              disabled={busy}
            >
              {busy ? "Saving..." : "Approve"}
            </button>
          </div>
        </div>
      )}

      {error && !hasDocuments && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      {!hasDocuments && (
        <div className="flex justify-end">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
