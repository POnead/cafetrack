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
  created_at: string;
};

type Verify = { intact: boolean; broken: { broken_seq: number; reason: string }[] };

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
};

export default function AuditPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
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
      const res = await fetch("/api/audit?limit=200");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load the audit trail");
      setEntries(data.entries ?? []);
      setTotal(data.total ?? 0);
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

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const to = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;

    return entries.filter((e) => {
      if (actionFilter && e.action !== actionFilter) return false;
      if (actorFilter && e.actor_name !== actorFilter) return false;

      const at = new Date(e.created_at).getTime();
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;

      if (!needle) return true;
      return [
        e.actor_name,
        e.action,
        e.entity_type ?? "",
        e.entity_id ?? "",
        JSON.stringify(e.details),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [entries, query, actionFilter, actorFilter, fromDate, toDate]);

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
    const truncated = total > entries.length;
    return { newest, oldest, truncated, total };
  }, [entries, total]);

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
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-700"
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
        <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}

      <Card className="!p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-cream-200 bg-cream-50 p-4">
          <input
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
                {window.truncated && (
                  <span title={`Older entries exist — the table loads the newest ${entries.length} of ${window.total}. Numbers skip because the log is append-only.`}>
                    {" · "}newest {entries.length} of {window.total}
                  </span>
                )}
              </>
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
                      {e.action}
                    </Badge>
                  </div>

                  <DataField label="Seq">
                    <span className="font-mono">{e.seq}</span>
                  </DataField>
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
                      <Badge tone={ACTION_TONE[e.action] ?? "slate"}>
                        {e.action}
                      </Badge>
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
