"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  Badge,
  Empty,
  Spinner,
  Toast,
  DataCard,
  DataField,
} from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

type Entry = {
  seq: number;
  actor_name: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
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
  ALERT_RESOLVE: "Alert resolved",
  ALERT_REOPEN: "Alert reopened",
  USER_CREATE: "User added",
  USER_UPDATE: "User edited",
  EMAIL_RECIPIENT_CREATE: "Email recipient added",
  EMAIL_RECIPIENT_UPDATE: "Email recipient edited",
  EMAIL_RECIPIENT_DELETE: "Email recipient removed",
  EMAIL_SMTP_SAVE: "Sending account saved",
  EMAIL_SMTP_CLEAR: "Sending account cleared",
  EMAIL_REPORT_SENT: "Report emailed",
  CATEGORY_CREATE: "Category added",
  CATEGORY_DELETE: "Category removed",
  LOCATION_CREATE: "Location added",
  LOCATION_UPDATE: "Location edited",
  LOCATION_DELETE: "Location removed",
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
  EMAIL_REPORT_SENT: "blue",
  // Reference data and configuration.
  CATEGORY_CREATE: "green",
  CATEGORY_DELETE: "red",
  LOCATION_CREATE: "green",
  LOCATION_UPDATE: "amber",
  LOCATION_DELETE: "red",
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Audit Trail</h1>
          <p className="mt-1 text-sm text-cocoa-500">
            Append-only log — every entry is hashed together with the one before it.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={load}>
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
                {a}
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
                      {ACTION_LABEL[e.action] ?? e.action}
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
                      <span className="font-mono text-xs">{e.ip_address}</span>
                    </DataField>
                  )}
                  <DataField label="Entity">
                    <span className="text-xs">
                      {e.entity_type ?? "—"}
                      {e.entity_id && (
                        <span className="block font-mono text-cocoa-400">
                          {e.entity_id}
                        </span>
                      )}
                    </span>
                  </DataField>
                  <DataField label="Details">
                    <code
                      className="block break-all text-[11px] text-cocoa-500"
                      title={JSON.stringify(e.details)}
                    >
                      {JSON.stringify(e.details)}
                    </code>
                  </DataField>
                </DataCard>
              ))}
            </div>

            <div className="hidden overflow-x-auto lg:block">
            <table className="w-full">
              <thead>
                <tr className="bg-cream-100/60">
                  <th className="th">#</th>
                  <th className="th">When</th>
                  <th className="th">Actor</th>
                  <th className="th">Action</th>
                  <th className="th">Outcome</th>
                  <th className="th">From</th>
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
                          {ACTION_LABEL[e.action] ?? e.action}
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
                    <td className="td whitespace-nowrap font-mono text-xs text-cocoa-400">
                      {e.ip_address ?? "—"}
                    </td>
                    <td className="td text-xs text-cocoa-400">
                      {e.entity_type ?? "—"}
                      {e.entity_id && (
                        <div className="font-mono">{e.entity_id}</div>
                      )}
                    </td>
                    <td className="td max-w-[22rem]">
                      <code
                        className="block truncate text-[11px] text-cocoa-500"
                        title={JSON.stringify(e.details)}
                      >
                        {JSON.stringify(e.details)}
                      </code>
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

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
