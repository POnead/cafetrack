"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Spinner } from "@/components/ui";
import { isIdDocType } from "@/lib/id-verification/types";
import { idTypeHasExpiry } from "@/lib/id-verification/specification";
import { formatIdNameForDisplay } from "@/lib/id-verification/name-signal";

/** Review the ID images and read details, then let an admin make the decision. */

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
  id_doc_expiry: string | null;
  verification_notes: string | null;
  verified_at: string | null;
  has_front: boolean;
  has_back: boolean;
};

type Props = {
  userId: string;
  /** Called after a decision lands, so the roster can refresh. */
  onDone: (message: string, documentsRemoved?: boolean) => void;
  onClose: () => void;
};

type EditableIdFields = {
  full_name: string;
  id_number: string;
  date_of_birth: string;
  date_of_expiry: string;
};

const EMPTY_FIELDS: EditableIdFields = {
  full_name: "",
  id_number: "",
  date_of_birth: "",
  date_of_expiry: "",
};

const TONE: Record<ReviewSignal["tone"], { badge: "green" | "amber" | "red" | "slate"; label: string }> = {
  pass: { badge: "green", label: "Pass" },
  warn: { badge: "amber", label: "Check" },
  fail: { badge: "red", label: "Problem" },
  unknown: { badge: "slate", label: "Not checked" },
};

function signalCopy(
  signal: ReviewSignal,
  fieldsReviewed: boolean,
  availableFieldCount: number,
  totalFieldCount: number
): Pick<ReviewSignal, "label" | "detail"> {
  switch (signal.id) {
    case "face_match":
      return {
        label: "Face match",
        detail:
          signal.tone === "pass"
            ? "The ID photo matches the staff photo."
            : signal.tone === "fail"
              ? "The ID photo does not match the staff photo."
              : "The photos could not be compared. Check them manually.",
      };
    case "name_match":
      return {
        label: "Name",
        detail:
          signal.tone === "pass"
            ? "The name matches the staff account."
            : signal.tone === "fail"
              ? "The name does not match the staff account."
              : "The name could not be checked. Compare it with the account.",
      };
    case "hv_ocr":
      return {
        label: "Text on ID",
        detail:
          signal.tone === "pass"
            ? "Text was read from the card. Check it against the details below."
            : "Text could not be read. Check the image and enter the details manually.",
      };
    case "hv_forgery":
      return {
        label: "Image check",
        detail:
          signal.tone === "pass"
            ? "No image tampering was detected."
            : signal.tone === "fail"
              ? "Possible image tampering detected. Check the card closely."
              : "Image tampering could not be checked.",
      };
    case "ocr_summary":
      return {
        label: fieldsReviewed ? "Details reviewed" : "Text on ID",
        detail: fieldsReviewed
          ? "Checked and saved by an admin."
          : availableFieldCount > 0
            ? `${availableFieldCount} of ${totalFieldCount} details found. Check them against the card.`
            : "No text could be read. Check the card and enter the details manually.",
      };
    case "ocr_space_summary":
      return {
        label: fieldsReviewed ? "Details reviewed" : "Text on ID",
        detail: fieldsReviewed
          ? "Checked and saved by an admin."
          : signal.tone === "pass"
            ? "Text was read from the ID."
            : "Text could not be read. Check the image and enter the details manually.",
      };
    case "id_fields_reviewed":
      return {
        label: "Details reviewed",
        detail: "Checked and saved by an admin.",
      };
    case "ocr_space_doc_type":
      return {
        label: "ID type",
        detail:
          signal.tone === "pass"
            ? "The ID type matches your selection."
            : "The ID type could not be confirmed. Check the card.",
      };
    case "id_number_shape":
      return {
        label: "ID number",
        detail:
          signal.tone === "pass"
            ? "The number format looks correct."
            : "The number format looks wrong. Check it against the card.",
      };
    case "card_duplicate":
      return {
        label: "Duplicate ID",
        detail:
          signal.tone === "pass"
            ? "No matching ID was found on another account."
            : "A duplicate check could not be completed.",
      };
    case "front_shape":
    case "back_shape":
      return {
        label: signal.id === "front_shape" ? "Front image" : "Back image",
        detail:
          signal.tone === "pass"
            ? "The image shape looks consistent with an ID card."
            : "The image shape may not match an ID card.",
      };
    default:
      if (signal.id.startsWith("provider_")) {
        return {
          label: signal.id.includes("ocr") ? "Text scan" : "ID check",
          detail: "This check could not be completed. Review the ID details manually.",
        };
      }

      return {
        label: signal.label
          .replace(/OCR\.space/gi, "Text scan")
          .replace(/Face\+\+/gi, "Face check")
          .replace(/HyperVerge/gi, "ID check"),
        detail: signal.detail
          .replace(/OCR\.space/gi, "text scan")
          .replace(/Face\+\+/gi, "face check")
          .replace(/HyperVerge/gi, "ID check")
          .replace(
            /\s*This text read stayed on this machine\. Other configured checks may send images to their providers\./gi,
            ""
          ),
      };
  }
}

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
  const [fields, setFields] = useState<EditableIdFields>(EMPTY_FIELDS);
  const [savedFields, setSavedFields] = useState<EditableIdFields>(EMPTY_FIELDS);
  const [fieldsReviewed, setFieldsReviewed] = useState(false);
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
      const source = data.fields ?? {};
      const loadedFields: EditableIdFields = {
        full_name: formatIdNameForDisplay(source.full_name),
        id_number: String(source.id_number ?? data.user.id_doc_number ?? ""),
        date_of_birth: String(source.date_of_birth ?? ""),
        date_of_expiry:
          isIdDocType(data.user.id_doc_type) && idTypeHasExpiry(data.user.id_doc_type)
            ? String(source.date_of_expiry ?? data.user.id_doc_expiry ?? "").slice(0, 10)
            : "",
      };
      setFields(loadedFields);
      setSavedFields(loadedFields);
      setFieldsReviewed(
        (data.signals ?? []).some((signal: ReviewSignal) => signal.id === "id_fields_reviewed")
      );
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

  const hasUnsavedFields = (Object.keys(EMPTY_FIELDS) as (keyof EditableIdFields)[]).some(
    (key) => fields[key] !== savedFields[key]
  );
  const canDecide = fieldsReviewed && !hasUnsavedFields;

  async function saveFields() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/users/${userId}/id/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save the ID details");

      setUser(data.user);
      setSignals(data.signals ?? []);
      const source = data.fields ?? {};
      const updatedFields: EditableIdFields = {
        full_name: formatIdNameForDisplay(source.full_name),
        id_number: String(source.id_number ?? data.user.id_doc_number ?? ""),
        date_of_birth: String(source.date_of_birth ?? ""),
        date_of_expiry:
          isIdDocType(data.user.id_doc_type) && idTypeHasExpiry(data.user.id_doc_type)
            ? String(source.date_of_expiry ?? data.user.id_doc_expiry ?? "").slice(0, 10)
            : "",
      };
      setFields(updatedFields);
      setSavedFields(updatedFields);
      setFieldsReviewed(true);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the ID details");
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

      onDone("ID documents removed", true);
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
  const isApproved = user.verification_status === "verified";
  const hasDocuments = user.has_front || user.has_back;
  const expiryApplicable =
    isIdDocType(user.id_doc_type) && idTypeHasExpiry(user.id_doc_type);
  const nameMismatch = signals.some(
    (signal) => signal.id === "name_match" && signal.tone === "fail"
  );
  const faceMismatch = signals.some(
    (signal) => signal.id === "face_match" && signal.tone === "fail"
  );
  const numberFormatProblem = signals.some(
    (signal) => signal.id === "id_number_shape" && signal.tone === "warn"
  );
  const hasLocalTextSummary = signals.some((signal) => signal.id === "ocr_summary");
  const hasTextSummary = signals.some(
    (signal) => signal.id === "ocr_summary" || signal.id === "ocr_space_summary"
  );
  const visibleSignals = signals.filter(
    (signal) =>
      signal.id !== "hv_face" &&
      signal.id !== "photo_shape" &&
      !(signal.id === "ocr_space_summary" && hasLocalTextSummary) &&
      !(fieldsReviewed && hasTextSummary && signal.id === "id_fields_reviewed")
  );
  const totalFieldCount = expiryApplicable ? 4 : 3;
  const availableFieldCount = [
    savedFields.full_name,
    savedFields.id_number,
    savedFields.date_of_birth,
    ...(expiryApplicable ? [savedFields.date_of_expiry] : []),
  ].filter((value) => value.trim().length > 0).length;

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <figure
            className={`min-w-0 space-y-2 rounded-2xl border border-cream-200 bg-cream-50 p-3 ${
              user.has_back ? "" : "sm:col-span-2"
            }`}
          >
            <figcaption className="flex items-center justify-between gap-2 text-xs font-semibold text-cocoa-700">
              <span>Front of ID</span>
              <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-cocoa-400">
                Document
              </span>
            </figcaption>
            <div className="flex aspect-[85.6/54] items-center justify-center overflow-hidden rounded-xl border border-cream-200 bg-white">
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
          </figure>

          {user.has_back && (
            <figure className="space-y-2 rounded-2xl border border-cream-200 bg-cream-50 p-3">
              <figcaption className="text-xs font-semibold text-cocoa-700">Back of ID</figcaption>
              <div className="flex aspect-[85.6/54] max-h-64 items-center justify-center overflow-hidden rounded-xl border border-cream-200 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/users/${user.id}/id?part=back`}
                  alt={`Back of the ID for ${user.full_name}`}
                  className="h-full w-full object-contain"
                />
              </div>
            </figure>
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-cream-50 px-3.5 py-3 text-xs text-cocoa-500">
          No ID attached yet. Upload the front of the card to begin.
        </div>
      )}

      {/* ---- review and correct OCR suggestions ---- */}
      {hasDocuments && (
        <section className="space-y-3 rounded-2xl border border-cream-200 bg-cream-50 p-3.5">
          <div>
            <p className="text-sm font-semibold text-cocoa-800">
              {isApproved ? "ID details" : "Review ID details"}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-cocoa-500">
              {isApproved
                ? "This approved ID is view-only."
                : "Check these details against the card, correct any mistakes, and save before making a decision."}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            <div className="sm:col-span-2 md:col-span-3">
              <label className="label" htmlFor="review-id-name">Name on ID</label>
              <input
                id="review-id-name"
                className="input"
                maxLength={160}
                title={fields.full_name}
                value={fields.full_name}
                disabled={busy || isApproved}
                onChange={(event) =>
                  setFields((current) => ({ ...current, full_name: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="review-id-number">ID number</label>
              <input
                id="review-id-number"
                className="input font-mono"
                maxLength={80}
                value={fields.id_number}
                disabled={busy || isApproved}
                onChange={(event) =>
                  setFields((current) => ({ ...current, id_number: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="review-id-birth">Date of birth</label>
              <input
                id="review-id-birth"
                className="input"
                type="date"
                value={fields.date_of_birth}
                disabled={busy || isApproved}
                onChange={(event) =>
                  setFields((current) => ({ ...current, date_of_birth: event.target.value }))
                }
              />
            </div>
            {expiryApplicable && (
              <div>
                <label className="label" htmlFor="review-id-expiry">Date of expiry</label>
                <input
                  id="review-id-expiry"
                  className="input"
                  type="date"
                  value={fields.date_of_expiry}
                  disabled={busy || isApproved}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, date_of_expiry: event.target.value }))
                  }
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-ochre-700">
              {isApproved
                ? "Approved ID details are shown read-only."
                : hasUnsavedFields
                  ? "Unsaved changes. Save before deciding."
                  : fieldsReviewed
                    ? nameMismatch
                      ? "The ID name does not match the account. Approval is blocked."
                      : faceMismatch
                        ? "The ID face does not match the staff photo. Approval is blocked."
                        : numberFormatProblem
                          ? "The ID number format does not match this type. Correct or clear it before approval."
                          : "Details saved. Compare them with the ID image before deciding."
                    : "Check these details against the card and save your review before deciding."}
            </p>
            {!isApproved && (
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => void saveFields()}
                disabled={busy || (!hasUnsavedFields && fieldsReviewed)}
              >
                {busy ? "Saving..." : "Save ID details"}
              </button>
            )}
          </div>
        </section>
      )}

      {/* ---- what the checks concluded ---- */}
      {visibleSignals.length > 0 && (
        <div className="space-y-2">
          <div>
            <p className="label !mb-0">ID checks</p>
            <p className="mt-1 text-[11px] leading-snug text-cocoa-400">
              Use these as a guide; compare the card before deciding.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {visibleSignals.map((s, index) => {
              const copy = signalCopy(
                s,
                fieldsReviewed,
                availableFieldCount,
                totalFieldCount
              );
              const tone =
                fieldsReviewed &&
                (s.id === "ocr_summary" || s.id === "ocr_space_summary")
                  ? "pass"
                  : s.id === "ocr_summary" && availableFieldCount === totalFieldCount
                    ? "pass"
                  : s.tone;
              return (
                <div
                  key={`${s.id}-${index}`}
                  className="rounded-xl bg-cream-50 px-3 py-2 text-xs text-cocoa-600"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-cocoa-800">{copy.label}</span>
                    <Badge tone={TONE[tone]?.badge ?? "slate"} variant="tag">
                      {TONE[tone]?.label ?? tone}
                    </Badge>
                  </div>
                  <p className="mt-1 leading-snug">{copy.detail}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- the decision ---- */}
      {hasDocuments && !isApproved && (
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

          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <button
              className="btn-ghost col-span-2 text-xs sm:col-span-1"
              onClick={purge}
              disabled={busy}
              title="Removes the stored images. Recorded in the audit trail."
            >
              Remove documents
            </button>
            <button
              className="btn-danger"
              onClick={() => decide("reject")}
              disabled={busy || !canDecide || reason.trim().length < 3}
            >
              {busy ? "Saving..." : "Reject"}
            </button>
            <button
              className="btn-primary"
              onClick={() => decide("approve")}
              disabled={busy || !canDecide || nameMismatch || faceMismatch || numberFormatProblem}
            >
              {busy ? "Saving..." : "Approve"}
            </button>
          </div>
        </div>
      )}

      {hasDocuments && isApproved && (
        <div className="space-y-3">
          <p className="rounded-xl bg-sage-50 px-3.5 py-2.5 text-sm text-sage-700">
            This ID is approved and can only be viewed. Replace it from the staff profile to start a new review.
          </p>
          <div className="flex justify-end">
            <button className="btn-ghost" onClick={onClose}>
              Close
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
