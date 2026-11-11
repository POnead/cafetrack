"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Card,
  Badge,
  Empty,
  Spinner,
  Toast,
  DataCard,
  DataField,
  Modal,
} from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { usePullToRefresh } from "@/lib/use-pull-to-refresh";

type Entry = {
  seq: number;
  actor_name: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_name?: string;
  entity_username?: string | null;
  details: Record<string, unknown>;
  /**
   * Where the action came from and how it turned out.
   *
   * Both are written by lib/audit.ts and both sit outside the hash chain by
   * design, so a forged IP cannot make a forged entry look authentic. They are
   * the difference between "Maria checked out 2 kg" and "Maria checked out 2 kg,
   * from the till, and the confirmation password was wrong".
   */
  ip_address: string | null;
  outcome: string | null;
  created_at: string;
};

type Verify = { intact: boolean; broken: { broken_seq: number; reason: string }[] };

/**
 * What each action is, in words.
 *
 * The raw names are the wire format, kept in the log so the audit trail and the
 * code agree exactly. This is only for the reading: `STOCK_CHECKOUT_DENIED` is
 * precise and useless to an owner scanning a list. Unknown actions fall through
 * to the raw name, so an action added later is never shown as blank.
 */
const ACTION_LABEL: Record<string, string> = {
  LOGIN: "Signed in",
  LOGOUT: "Signed out",
  LOGIN_FAILED: "Sign-in rejected",
  PASSWORD_CHANGED: "Password changed",
  PASSWORD_CHANGE_FAILED: "Password change failed",
  ADMIN_NAME_UPDATE: "Admin name updated",
  PROFILE_NAME_UPDATE: "Profile name updated",
  STAFF_POSITIONS_UPDATE: "Staff positions updated",
  FACE_IMAGE_READ: "Staff photo viewed",
  USER_FACE_ENROLL: "Staff photo enrolled",
  USER_FACE_REVOKE: "Staff photo removed",
  USER_ID_UPLOAD: "Identity document uploaded",
  USER_ID_PURGE: "Identity document removed",
  USER_DELETE: "Staff account removed",
  ITEM_DELETE_DENIED: "Item deletion refused",
  DUTY_BYPASS_APPROVE: "Duty check exception approved",
  DUTY_BYPASS_REJECT: "Duty check exception rejected",
  DUTY_BYPASS_REQUEST: "Duty check exception requested",
  IDENTITY_PRIVACY_ACKNOWLEDGE: "Privacy notice acknowledged",
  IDENTITY_DATA_ERASE: "Identity data erased",
  PRIVACY_REQUEST_SUBMIT: "Privacy request submitted",
  IDENTITY_DOCUMENT_READ: "Identity document viewed",
  SUPPLIER_CREATE: "Supplier added",
  SUPPLIER_UPDATE: "Supplier edited",
  SUPPLIER_DELETE: "Supplier removed",
  STAFF_TOKEN_ROTATED: "Staff sign-in code reset",
  LOGIN_PASSWORD_OK: "Password accepted",
  REAUTH_FAILED: "Password confirmation failed",
  ADMIN_PASSWORD_RESET_CODE_SENT: "Password recovery code sent",
  ADMIN_PASSWORD_RESET_CODE_FAILED: "Password recovery code failed",
  ADMIN_PASSWORD_RESET: "Admin password reset",
  FACE_VERIFY: "Face check completed",
  FACE_VERIFY_OVERRIDE: "Face check overridden",
  FACE_VERIFY_RESET: "Face check reset",
  CATEGORY_CREATE: "Category added",
  CATEGORY_DELETE: "Category removed",
  LOCATION_CREATE: "Location added",
  LOCATION_UPDATE: "Location edited",
  LOCATION_DELETE: "Location removed",
  APPROVAL_CODE_ISSUED: "Approval code issued",
  APPROVAL_CODE_REVOKED: "Approval code revoked",
  STAFF_POSITION_ADD: "Staff position added",
  STAFF_POSITION_RENAME: "Staff position renamed",
  STAFF_POSITION_ACCESS: "Staff position access changed",
  STAFF_POSITION_REMOVE: "Staff position removed",
  REPORT_EXPORT: "Report downloaded",
  ITEM_CREATE: "Item added",
  ITEM_UPDATE: "Item edited",
  ITEM_DELETE: "Item deleted",
  ITEM_APPROVE: "Item approved",
  ITEM_REJECT: "Item rejected",
  ITEM_CHANGE_REQUEST: "Edit submitted for approval",
  ITEM_CHANGE_APPROVE: "Edit approved",
  ITEM_CHANGE_REJECT: "Edit rejected",
  ITEM_PERMISSION_GRANT: "Item permission granted",
  ITEM_PERMISSION_REVOKE: "Item permission revoked",
  STOCK_CHECKOUT: "Checked out",
  STOCK_RESTOCK: "Restocked",
  WASTE_LOG: "Waste logged",
  CHECKOUT_DENIED: "Checkout refused",
  RESTOCK_DENIED: "Restock refused",
  WASTE_LOG_DENIED: "Waste entry refused",
  STOCK_CHECKOUT_DENIED: "Checkout refused",
  STOCK_RESTOCK_DENIED: "Restock refused",
  ALERT_RESOLVE: "Alert resolved",
  ALERT_REOPEN: "Alert reopened",
  ALERTS_RECOMPUTE: "Alerts refreshed",
  USER_CREATE: "User added",
  USER_UPDATE: "User edited",
  EMAIL_RECIPIENT_CREATE: "Email recipient added",
  EMAIL_RECIPIENT_UPDATE: "Email recipient edited",
  EMAIL_RECIPIENT_DELETE: "Email recipient removed",
  EMAIL_SMTP_SAVE: "Sending account saved",
  EMAIL_SMTP_CLEAR: "Sending account cleared",
  EMAIL_SEND_NOW: "Queued email sent",
  EMAIL_RETRY_FAILED: "Failed email retried",
  EMAIL_SUMMARY_SEND: "Daily summary sent",
  EMAIL_TEST_SEND: "Test email sent",
  EMAIL_REPORT_SENT: "Report emailed",
  SETTINGS_UPDATE: "Settings changed",
  BACKUP_RUN: "Backup taken",
  SEED: "Database seeded",
};

const ACTION_TONE: Record<
  string,
  "green" | "amber" | "red" | "blue" | "slate"
> = {
  LOGIN: "blue",
  LOGOUT: "slate",
  LOGIN_FAILED: "red",
  ITEM_CREATE: "green",
  ITEM_UPDATE: "amber",
  ITEM_DELETE: "red",
  STOCK_CHECKOUT: "amber",
  STOCK_RESTOCK: "green",
  WASTE_LOG: "red",
  CHECKOUT_DENIED: "red",
  RESTOCK_DENIED: "red",
  WASTE_LOG_DENIED: "red",
  ALERT_RESOLVE: "blue",
  ALERT_REOPEN: "amber",
  USER_CREATE: "green",
  USER_UPDATE: "amber",
  SEED: "slate",
  // FR-03: the approval queue and the permission that bypasses it.
  ITEM_APPROVE: "green",
  ITEM_REJECT: "red",
  ITEM_PERMISSION_GRANT: "blue",
  ITEM_PERMISSION_REVOKE: "amber",
  // FR-11.
  EMAIL_RECIPIENT_CREATE: "green",
  EMAIL_RECIPIENT_UPDATE: "amber",
  EMAIL_RECIPIENT_DELETE: "red",
  EMAIL_SMTP_SAVE: "blue",
  EMAIL_SMTP_CLEAR: "amber",
  EMAIL_SEND_NOW: "blue",
  EMAIL_RETRY_FAILED: "amber",
  ADMIN_PASSWORD_RESET_CODE_FAILED: "red",
  EMAIL_SUMMARY_SEND: "blue",
  EMAIL_TEST_SEND: "blue",
  EMAIL_REPORT_SENT: "blue",
  // Reference data and configuration.
  CATEGORY_CREATE: "green",
  CATEGORY_DELETE: "red",
  LOCATION_CREATE: "green",
  LOCATION_UPDATE: "amber",
  LOCATION_DELETE: "red",
  STAFF_POSITION_ADD: "green",
  STAFF_POSITION_RENAME: "amber",
  STAFF_POSITION_ACCESS: "amber",
  STAFF_POSITION_REMOVE: "red",
  APPROVAL_CODE_ISSUED: "blue",
  APPROVAL_CODE_REVOKED: "amber",
  REPORT_EXPORT: "blue",
  SETTINGS_UPDATE: "amber",
  BACKUP_RUN: "slate",
};

/** The outcome column, when one was recorded. */
const OUTCOME_TONE: Record<string, "green" | "red" | "amber" | "slate"> = {
  success: "green",
  denied: "red",
  failed: "red",
};

/**
 * Whether an outcome is bad news.
 *
 * Used for the dot beside the action as well as the badge, so a refused action is
 * findable without reading every row — which is the entire reason the column
 * exists.
 */
function outcomeTone(outcome: string | null): "green" | "red" | "amber" | "slate" {
  if (!outcome) return "slate";
  return OUTCOME_TONE[outcome] ?? "amber";
}

const DETAIL_LABELS: Record<string, string> = {
  access: "Access level",
  assigned_accounts: "Accounts affected",
  attempted: "Messages attempted",
  actor: "Staff member",
  batch_id: "Batch reference",
  batch_code: "Batch code",
  category: "Category",
  change: "Change",
  changes: "Changes made",
  display_name: "Display name",
  email: "Email",
  email_address: "Email address",
  expiration_date: "Expiry date",
  failed: "Messages failed",
  filters: "Report filters",
  format: "Format",
  full_name: "Name",
  from: "From",
  image_bytes: "Image size",
  item_count: "Items in report",
  item_name: "Item",
  items: "Items affected",
  lines: "Lines affected",
  location: "Location",
  method: "Sign-in method",
  ms: "Delivery time (ms)",
  name: "Name",
  note: "Note",
  outcome: "Result",
  password: "Password",
  position: "Position",
  position_count: "Positions now configured",
  positions: "Updated positions",
  previous_access: "Previous access",
  previous_position: "Previous position",
  previous_status: "Previous status",
  quantity: "Quantity",
  quantity_at_delete: "Quantity when removed",
  queued: "Messages queued",
  reason: "Reason",
  recipient: "Recipient address",
  report_from: "Report from",
  report_to: "Report to",
  request_id: "Request reference",
  requeued: "Messages re-queued",
  role: "Role",
  sent: "Messages sent",
  skipped: "Messages skipped",
  sku: "SKU",
  status: "Status",
  subject: "Subject",
  subscriptions: "Notifications",
  supplier_id: "Supplier reference",
  supplier_name: "Supplier",
  to: "New value",
  transient: "Temporary failure",
  type: "Type",
  unit: "Unit",
  username: "Username",
  notice_version: "Privacy notice version",
  ip_address: "Source address",
  lawful_basis: "Legal basis",
};

function detailLabel(key: string): string {
  return DETAIL_LABELS[key] ?? key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function auditActionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayAuditValue(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value !== "string") return String(value);

  if (key === "access" || key === "previous_access") {
    if (value === "admin") return "Full admin access";
    if (value === "staff") return "Staff access";
  }
  if (key === "method" && value === "admin_login") return "Administrator sign-in";
  return value.replaceAll("_", " ");
}

function renderDetailValue(value: unknown, key = "", depth = 0): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-cocoa-400">Not recorded</span>;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <span className="break-words">{displayAuditValue(key, value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-cocoa-400">None</span>;
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return (
        <div className="flex flex-wrap gap-1.5">
          {value.map((item, index) => (
            <span key={index} className="rounded-full bg-cream-100 px-2.5 py-1 text-xs text-cocoa-700">
              {displayAuditValue(key, item)}
            </span>
          ))}
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <div key={index} className="rounded-xl border border-cream-200 bg-white p-3">
            {renderDetailValue(item, key, depth + 1)}
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>);
    if (fields.length === 0) return <span className="text-cocoa-400">No details</span>;
    return (
      <dl className={`grid gap-3 ${depth > 0 ? "sm:grid-cols-2" : ""}`}>
        {fields.map(([field, fieldValue]) => (
          <div key={field} className="min-w-0">
            <dt className="text-[11px] font-semibold text-cocoa-400">{detailLabel(field)}</dt>
            <dd className="mt-1 text-sm text-cocoa-700">
              {renderDetailValue(fieldValue, field, depth + 1)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="text-cocoa-400">Not recorded</span>;
}

function displaySourceAddress(address: string | null): string {
  if (!address) return "Not recorded";
  if (address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1") {
    return "Local device";
  }
  return address;
}

const ENTITY_LABEL: Record<string, string> = {
  user: "Staff account",
  item: "Inventory item",
  category: "Category",
  location: "Location",
  supplier: "Supplier",
  alert: "Stock alert",
  alerts: "Stock alerts",
  transaction: "Stock movement",
  email_recipient: "Email recipient",
  settings: "System settings",
  report: "Report",
  system: "System",
  staff_position: "Staff position",
};

function entityTypeLabel(type: string | null): string {
  if (!type) return "";
  return ENTITY_LABEL[type] ?? type.replaceAll("_", " ");
}

function displayEntity(entry: Entry): string {
  if (entry.entity_name?.trim()) return entry.entity_name;
  if (entry.entity_type === "user") return "Deleted user account";
  if (entry.entity_type) return `Deleted ${entityTypeLabel(entry.entity_type).toLowerCase()}`;
  return "—";
}

const PAGE_SIZE = 200;

/**
 * The value `query` held this many milliseconds ago.
 *
 * The filter below matches against a searchable string built for every loaded
 * entry, which is the most expensive thing this page does. Debouncing keeps
 * that off the keystroke path: the box still updates as fast as anyone can
 * type, but the list settles once they pause.
 */
function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<Entry | null>(null);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const res = await fetch(`/api/audit?limit=${PAGE_SIZE}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the audit trail");
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
      setHasMore(Boolean(data.has_more));
      setNextBefore(data.next_before ?? null);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load the audit trail");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);
  const pullToRefresh = usePullToRefresh(load);

  /**
   * One more page, older than everything already shown (NFR-05).
   *
   * Appended rather than replaced: the point of paging an audit trail is to read
   * it in order, and dropping what is already on screen to show something older
   * loses a person's place. `before` is the oldest seq loaded, so the rows that
   * come back are strictly older than the whole current view.
   */
  async function loadOlder() {
    if (nextBefore === null || loadingOlder) return;
    setLoadingOlder(true);

    try {
      const res = await fetch(`/api/audit?limit=${PAGE_SIZE}&before=${nextBefore}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load older entries");

      setEntries((current) => [...current, ...(data.entries ?? [])]);
      setHasMore(Boolean(data.has_more));
      setNextBefore(data.next_before ?? null);
    } catch (e: any) {
      setError(e.message || "Could not load older entries");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function checkChain() {
    setVerifying(true);
    try {
      const res = await fetch("/api/audit/verify");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not verify the chain");

      setVerify({ intact: Boolean(data.intact), broken: data.broken ?? [] });
      setToast({
        msg: data.intact
          ? "Hash chain verified — history is intact"
          : `Chain broken at entry ${data.broken?.[0]?.broken_seq ?? "?"}`,
        tone: data.intact ? "success" : "error",
      });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setVerifying(false);
    }
  }

  /* Distinct values so the dropdowns can only offer what actually exists. */
  const actionOptions = useMemo(
    () => [...new Set(entries.map((e) => e.action))].sort(),
    [entries]
  );
  const actorOptions = useMemo(
    () => [...new Set(entries.map((e) => e.actor_name))].sort(),
    [entries]
  );

  /*
   * One lowercase search string per entry, built once per load of the trail.
   *
   * This used to call JSON.stringify on every entry's `details` inside the
   * filter, which meant re-serialising up to 200 payloads on every keystroke.
   * The details do not change until the trail is reloaded, so the text is built
   * once here and the filter below just scans it.
   */
  const searchable = useMemo(
    () =>
      entries.map((e) =>
        [
          e.actor_name,
          e.action,
          e.entity_type ?? "",
          e.entity_id ?? "",
          e.entity_name ?? "",
          e.entity_username ?? "",
          JSON.stringify(e.details),
        ]
          .join(" ")
          .toLowerCase()
      ),
    [entries]
  );

  const debouncedQuery = useDebounced(query);

  const shown = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const to = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;

    return entries.filter((e, index) => {
      if (actionFilter && e.action !== actionFilter) return false;
      if (actorFilter && e.actor_name !== actorFilter) return false;

      const at = new Date(e.created_at).getTime();
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;

      if (!needle) return true;
      return searchable[index].includes(needle);
    });
  }, [entries, searchable, debouncedQuery, actionFilter, actorFilter, fromDate, toDate]);

  const hasFilters = Boolean(
    query || actionFilter || actorFilter || fromDate || toDate
  );

  /**
   * The API returns the newest `limit` rows, so the table shows a window, not
   * the whole trail. `seq` is a bigserial, so it is intentionally sparse —
   * rolled-back inserts burn numbers — and it must never be renumbered, since
   * it is hashed into every entry. Naming the window is what stops the first
   * visible number from reading like a truncated or tampered log.
   */
  const window = useMemo(() => {
    if (entries.length === 0) return null;
    const newest = entries[0].seq;
    const oldest = entries[entries.length - 1].seq;
    return { newest, oldest };
  }, [entries]);

  function clearFilters() {
    setQuery("");
    setActionFilter("");
    setActorFilter("");
    setFromDate("");
    setToDate("");
  }

  return (
    <div className="space-y-5" data-pull-to-refresh {...pullToRefresh.handlers}>
      {pullToRefresh.indicator}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Audit Trail</h1>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost hidden lg:inline-flex" onClick={load}>
            Reload
          </button>
          <button
            className="btn-primary"
            onClick={checkChain}
            disabled={verifying}
          >
            {verifying ? "Verifying..." : "Verify chain"}
          </button>
        </div>
      </div>

      {verify && (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            verify.intact
              ? "border-sage-500/40 bg-sage-50 text-sage-700"
              : "border-terracotta-500/40 bg-terracotta-50 text-terracotta-700"
          }`}
        >
          {verify.intact ? (
            <span>Hash chain intact — no entry has been altered.</span>
          ) : (
            <ul className="space-y-1">
              {verify.broken.map((b) => (
                <li key={b.broken_seq}>
                  Entry <span className="font-mono">{b.broken_seq}</span> —{" "}
                  {b.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      <Card className="!p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-cream-200 bg-cream-50 p-4">
          <input
            aria-label="Search the audit trail"
            className="input max-w-xs"
            placeholder="Search actor, action, entity..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="input max-w-[200px]"
            aria-label="Filter by action"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">All actions</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {auditActionLabel(a)}
              </option>
            ))}
          </select>
          <select
            className="input max-w-[200px]"
            aria-label="Filter by actor"
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
          >
            <option value="">All actors</option>
            {actorOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <input
              className="input w-[150px]"
              type="date"
              aria-label="From date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
            <span className="text-xs text-cocoa-300">to</span>
            <input
              className="input w-[150px]"
              type="date"
              aria-label="To date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          {hasFilters && (
            <button
              className="btn-ghost !px-3 !py-1.5 text-xs"
              onClick={clearFilters}
            >
              Clear
            </button>
          )}
          <div className="ml-auto text-xs text-cocoa-400">
            {shown.length} of {entries.length} shown
            {window && (
              <>
                {" · "}
                <span className="font-mono">seq {window.oldest}–{window.newest}</span>
              </>
            )}
            {hasMore && (
              <span
                title={`Older entries exist. The newest ${entries.length} of ${total} are loaded; the log is append-only, so sequences continue to skip numbers as new entries arrive.`}
              >
                {" · "}newest {entries.length} of {total}
              </span>
            )}
          </div>
        </div>

        {loading ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <Empty>No audit entries match.</Empty>
        ) : (
          <>
            {/* Stacked cards below lg; the wide table takes over above it. */}
            <div className="space-y-2.5 px-3 pb-3 lg:hidden">
              {shown.map((e) => (
                <DataCard key={e.seq}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-cocoa-800">
                        {e.actor_name}
                      </div>
                      <div className="text-xs text-cocoa-400">
                        {fmtDateTime(e.created_at)}
                      </div>
                    </div>
                    <Badge tone={ACTION_TONE[e.action] ?? "slate"}>
                      {auditActionLabel(e.action)}
                    </Badge>
                  </div>

                  <DataField label="Seq">
                    <span className="font-mono">{e.seq}</span>
                  </DataField>
                  {e.outcome && (
                    <DataField label="Outcome">
                      <Badge tone={outcomeTone(e.outcome)} variant="tag">
                        {e.outcome}
                      </Badge>
                    </DataField>
                  )}
                  {e.ip_address && (
                    <DataField label="From">
                      <span className="break-all text-xs text-cocoa-700">
                        {displaySourceAddress(e.ip_address)}
                      </span>
                    </DataField>
                  )}
                  <DataField label="Related to">
                    <span className="text-xs">
                      {displayEntity(e)}
                      <span className="block text-cocoa-400">
                        {entityTypeLabel(e.entity_type)}
                        {e.entity_type === "user" && e.entity_username
                          ? ` · @${e.entity_username}`
                          : ""}
                      </span>
                    </span>
                  </DataField>
                  <DataField label="Details">
                    <button
                      type="button"
                      className="btn-ghost !px-2.5 !py-1.5 text-xs"
                      aria-label={`View details for audit entry ${e.seq}`}
                      onClick={() => setSelectedEntry(e)}
                    >
                      View details
                    </button>
                  </DataField>
                </DataCard>
              ))}
            </div>

            <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1000px] table-fixed">
              <colgroup>
                <col className="w-12" />
                <col className="w-36" />
                <col className="w-24" />
                <col className="w-40" />
                <col className="w-24" />
                <col className="w-36" />
                <col className="w-40" />
                <col className="w-32" />
              </colgroup>
              <thead>
                <tr className="bg-cream-100/60">
                  <th className="th">#</th>
                  <th className="th">When</th>
                  <th className="th">Actor</th>
                  <th className="th">Action</th>
                  <th className="th">Outcome</th>
                  <th className="th">Source</th>
                  <th className="th">Entity</th>
                  <th className="th">Details</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.seq} className="transition-colors hover:bg-cream-50">
                    <td className="td font-mono text-xs text-cocoa-400">
                      {e.seq}
                    </td>
                    <td className="td whitespace-nowrap text-xs text-cocoa-500">
                      {fmtDateTime(e.created_at)}
                    </td>
                    <td className="td text-cocoa-700">{e.actor_name}</td>
                    <td className="td">
                      {/* The wire name stays in the tooltip: the log and the
                          code agree on it, and someone reading a defect report
                          needs to be able to search for the exact string. */}
                      <span title={e.action}>
                        <Badge tone={ACTION_TONE[e.action] ?? "slate"}>
                          {auditActionLabel(e.action)}
                        </Badge>
                      </span>
                    </td>
                    <td className="td whitespace-nowrap">
                      {e.outcome ? (
                        <Badge tone={outcomeTone(e.outcome)} variant="tag">
                          {e.outcome}
                        </Badge>
                      ) : (
                        <span className="text-cocoa-200">—</span>
                      )}
                    </td>
                    <td className="td text-xs text-cocoa-600">
                      <span title={e.ip_address ?? undefined}>
                        {displaySourceAddress(e.ip_address)}
                      </span>
                    </td>
                    <td className="td text-xs text-cocoa-700">
                      {displayEntity(e)}
                      <div className="mt-0.5 text-cocoa-400">
                        {entityTypeLabel(e.entity_type)}
                        {e.entity_type === "user" && e.entity_username
                          ? ` · @${e.entity_username}`
                          : ""}
                      </div>
                    </td>
                    <td className="td">
                      <button
                        type="button"
                        className="btn-ghost !px-2.5 !py-1.5 text-xs"
                        aria-label={`View details for audit entry ${e.seq}`}
                        onClick={() => setSelectedEntry(e)}
                      >
                        View details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* Older entries, one page at a time. Shown after the table rather
                than before it, because the newest activity is what someone
                opening an audit trail is nearly always looking for. */}
            {hasMore && (
              <div className="flex items-center justify-center gap-3 border-t border-cream-200 bg-cream-50 px-4 py-3">
                <span className="text-xs text-cocoa-400">
                  Showing the newest {entries.length} of {total} entries
                </span>
                <button
                  type="button"
                  className="btn-ghost !px-3 !py-1.5 text-xs"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? "Loading..." : "Load older entries"}
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <Modal
        open={selectedEntry !== null}
        onClose={() => setSelectedEntry(null)}
        title="Audit entry details"
        width="max-w-2xl"
        scrollable
      >
        {selectedEntry && (
          <div className="space-y-5">
            <section className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">Action</p>
                <div className="mt-2">
                  <Badge tone={ACTION_TONE[selectedEntry.action] ?? "slate"}>
                    {auditActionLabel(selectedEntry.action)}
                  </Badge>
                </div>
              </div>
              <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">Result</p>
                <div className="mt-2">
                  {selectedEntry.outcome ? (
                    <Badge tone={outcomeTone(selectedEntry.outcome)} variant="tag">
                      {selectedEntry.outcome}
                    </Badge>
                  ) : <span className="text-sm text-cocoa-400">Not recorded</span>}
                </div>
              </div>
              <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">Who and when</p>
                <p className="mt-1 text-sm font-semibold text-cocoa-800">{selectedEntry.actor_name}</p>
                <p className="mt-0.5 text-sm text-cocoa-600">{fmtDateTime(selectedEntry.created_at)}</p>
              </div>
              <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">Source</p>
                <p className="mt-1 text-sm text-cocoa-700">{displaySourceAddress(selectedEntry.ip_address)}</p>
              </div>
              <div className="rounded-xl border border-cream-200 bg-cream-50/70 p-3 sm:col-span-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-cocoa-400">Related record</p>
                <p className="mt-1 text-sm text-cocoa-700">
                  {displayEntity(selectedEntry)}
                </p>
                <p className="mt-0.5 text-xs text-cocoa-500">
                  {entityTypeLabel(selectedEntry.entity_type)}
                  {selectedEntry.entity_type === "user" && selectedEntry.entity_username
                    ? ` · Username: @${selectedEntry.entity_username}`
                    : ""}
                </p>
                {selectedEntry.entity_id && (
                  <p className="mt-1 break-all font-mono text-[11px] text-cocoa-400">
                    Record reference: {selectedEntry.entity_id}
                  </p>
                )}
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-sm font-bold text-cocoa-800">More information</h4>
              {Object.keys(selectedEntry.details).length > 0 ? (
                <div className="space-y-2">
                  {Object.entries(selectedEntry.details).map(([key, value]) => (
                    <section key={key} className="rounded-xl border border-cream-200 p-3">
                      <h5 className="mb-2 text-xs font-bold text-cocoa-500">{detailLabel(key)}</h5>
                      <div className="text-sm text-cocoa-700">
                        {renderDetailValue(value, key)}
                      </div>
                    </section>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-cream-200 bg-cream-50 px-3 py-2.5 text-sm text-cocoa-400">
                  No additional details were recorded.
                </p>
              )}
            </section>
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
