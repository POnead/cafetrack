"use client";

/**
 * Email notification settings (FR-11).
 *
 * Admin-only, and its own page rather than a section of Settings: it has a
 * different audience (who gets told what), a different failure mode (SMTP
 * misconfiguration), and a log worth reading on its own. Crowding it into the
 * general settings page would bury all three.
 *
 * Nothing here sends anything by accident. Email is off until an admin turns it
 * on, and the toggle is separate from whether SMTP is configured — one is the
 * cafe's decision, the other is the machine's.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Spinner, Toast, Empty, Badge, Modal, DataCard, DataField } from "@/components/ui";
import { fmtDate } from "@/lib/format";

type Kind = { key: string; label: string };

type Recipient = {
  id: string;
  email_address: string;
  display_name: string | null;
  is_active: boolean;
  subscriptions: string[];
};

type QueueRow = {
  id: string;
  kind: string;
  subject: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  last_error: string | null;
  queued_at: string;
  sent_at: string | null;
  email_recipients: { email_address: string; display_name: string | null } | null;
};

type Smtp = {
  configured: boolean;
  source: "website" | "environment" | "none";
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  unreadable: boolean;
  has_password: boolean;
};

type Preset = { key: string; label: string; host: string; port: number };

type Status = {
  enabled: boolean;
  configured: boolean;
  detail: string;
  from: string;
  recipients: number;
  source: "website" | "environment" | "none";
  user: string | null;
  unreadable: boolean;
};

type Tone = "info" | "error" | "success";

const STATUS_TONE: Record<QueueRow["status"], "slate" | "green" | "amber" | "red"> = {
  sent: "green",
  queued: "slate",
  sending: "amber",
  failed: "red",
};

export default function EmailSettingsPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [smtp, setSmtp] = useState<Smtp | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});

  // The sending account. `pass` is write-only: it is never populated from the
  // server, because the server never sends it back. Blank means "keep the
  // password already saved", which is why the field can be left alone when
  // changing only the port or the from-address.
  const [account, setAccount] = useState({
    host: "",
    port: "587",
    user: "",
    pass: "",
    from: "",
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: Tone } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editing, setEditing] = useState<Recipient | null>(null);
  const [form, setForm] = useState({ email_address: "", display_name: "", subscriptions: [] as string[] });
  const [showQueue, setShowQueue] = useState(true);
  // Where the test message goes. Defaults to the sending account, which is the
  // obvious thing to check, and stays editable because the account that sends is
  // often not the one that should receive.
  const [testTo, setTestTo] = useState("");

  const inFlight = useRef(false);

  const load = useCallback(async (withQueue = true) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [e, s] = await Promise.all([
        fetch(`/api/email${withQueue ? "?queue=1" : ""}`).then((r) => r.json()),
        fetch("/api/settings").then((r) => r.json()),
      ]);
      if (e.error) throw new Error(e.error);
      setStatus(e.status);
      setKinds(e.kinds ?? []);
      setPresets(e.presets ?? []);
      setSmtp(e.smtp ?? null);
      // Prefill the account form from what is saved, but never the password.
      setAccount((prev) => ({
        host: e.smtp?.host ?? prev.host,
        port: String(e.smtp?.port ?? 587),
        user: e.smtp?.user ?? prev.user,
        from: e.smtp?.from ?? prev.from,
        // Left blank on every load, by design.
        pass: "",
      }));
      setRecipients(e.recipients ?? []);
      setQueue(e.queue ?? []);
      setSettings(s.settings ?? {});
      setError(null);
    } catch (err: any) {
      setError(err.message || "Could not load email settings");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveSetting(key: string, value: string) {
    setBusy(key);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      setSettings((p) => ({ ...p, [key]: data.settings[key] }));
      await load(false);
      setToast({ msg: "Saved", tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      await load(false);
    } finally {
      setBusy(null);
    }
  }

  /** Save the sending account. Password is only sent when the field was filled. */
async function saveAccount() {
  setBusy("save_smtp");
  setError(null);
  try {
    const res = await fetch("/api/email", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      // An empty pass is omitted entirely rather than sent as "", so the server's
      // "keep what is stored" path is unambiguous.
      body: JSON.stringify({
        action: "save_smtp",
        host: account.host,
        port: account.port,
        user: account.user,
        from: account.from,
        ...(account.pass ? { pass: account.pass } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not save the account");

    // Cleared from the field so the password does not linger in the page state.
    setAccount((p) => ({ ...p, pass: "" }));
    setToast({
      msg: "Sending account saved — send a test message to confirm it works",
      tone: "success",
    });
    await load(false);
  } catch (e: any) {
    setError(e.message || "Could not save the account");
  } finally {
    setBusy(null);
  }
}

async function clearAccount() {
  if (!confirm("Forget the saved sending account?")) return;
  setBusy("clear_smtp");
  try {
    const res = await fetch("/api/email", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clear_smtp" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not remove the account");
    setToast({ msg: "Sending account removed", tone: "success" });
    await load(false);
  } catch (e: any) {
    setToast({ msg: e.message, tone: "error" });
  } finally {
    setBusy(null);
  }
}

/** Fill the form from a preset — host and port only, never the credentials. */
function applyPreset(p: Preset) {
  setAccount((prev) => ({ ...prev, host: p.host, port: String(p.port) }));
}

async function action(name: string, body: Record<string, unknown> = {}) {
    setBusy(name);
    try {
      const res = await fetch("/api/email", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: name, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not do that");
      const detail =
        data.sent !== undefined
          ? `${data.sent} sent${data.failed ? `, ${data.failed} failed` : ""}`
          : data.queued !== undefined
            ? `${data.queued} queued`
            : "Done";
      setToast({ msg: `${name.replace(/_/g, " ")}: ${detail}`, tone: data.failed ? "error" : "success" });
      await load();
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function saveRecipient() {
    setBusy("recipient");
    try {
      const res = await fetch("/api/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editing?.id,
          email_address: form.email_address,
          display_name: form.display_name || null,
          is_active: true,
          subscriptions: form.subscriptions,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");
      setToast({ msg: editing ? "Recipient updated" : "Recipient added", tone: "success" });
      setEditing(null);
      setForm({ email_address: "", display_name: "", subscriptions: [] });
      await load();
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function removeRecipient(r: Recipient) {
    if (!confirm(`Stop emailing ${r.email_address}?`)) return;
    setBusy(r.id);
    try {
      const res = await fetch(`/api/email?id=${r.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove");
      setToast({ msg: "Recipient removed", tone: "success" });
      await load();
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner label="Loading email settings..." />;

  const off = status && !status.enabled;

  return (
    <div className="space-y-5">
      <Toast message={toast?.msg ?? null} tone={toast?.tone} onDone={() => setToast(null)} />

      <div>
        <h1 className="deco-title text-3xl">Email Notifications</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          Who hears about low stock, expiry and rejected sign-ins — and when they
          hear about it.
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      {/* ---- the switch ---- */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-cocoa-800">Send email</h2>
              {status?.enabled ? (
                <Badge tone="green" variant="tag">On</Badge>
              ) : (
                <Badge tone="slate" variant="tag">Off</Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-cocoa-500">
              {status?.enabled
                ? `${status.recipients} recipient${status.recipients === 1 ? "" : "s"}.`
                : "No email is sent until this is turned on."}
            </p>
          </div>

          <button
            className={status?.enabled ? "btn-ghost" : "btn-primary"}
            disabled={busy === "email_enabled"}
            onClick={() => saveSetting("email_enabled", status?.enabled ? "0" : "1")}
          >
            {status?.enabled ? "Turn off" : "Turn on"}
          </button>
        </div>

        {status && !status.configured && (
          <div className="mt-4 rounded-xl bg-ochre-50 px-3.5 py-2.5 text-sm text-ochre-700">
            No sending account yet. Set one below — it takes effect immediately,
            no restart needed. Messages queue until then and go out once it
            works.
          </div>
        )}

        {status?.configured && (
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-cream-100 px-3.5 py-2.5 text-sm text-cocoa-600">
            <span>
              Sending from{" "}
              <strong className="text-cocoa-800">{status.user}</strong>
            </span>
            <span className="text-xs text-cocoa-400">
              {status.source === "website"
                ? "saved on this site"
                : "from .env.local — a saved account would take over"}
            </span>
          </div>
        )}

        {status?.unreadable && (
          <div className="mt-4 rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
            The saved password can no longer be read, which happens if{" "}
            <code className="font-mono">AUTH_SECRET</code> was changed. Enter the
            app password again below.
          </div>
        )}

        {off && status?.configured && (
          <p className="mt-3 text-sm text-cocoa-500">{status.detail}</p>
        )}
      </Card>

      {/* ---- the sending account ---- */}
      <Card>
        <h2 className="text-sm font-bold text-cocoa-800">Sending account</h2>
        <p className="mt-1 text-sm text-cocoa-500">
          The Gmail (or other) account messages are sent from.
        </p>

        {presets.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.key}
                className="btn-ghost !px-2.5 !py-1 text-xs"
                disabled={busy === "save_smtp"}
                onClick={() => applyPreset(p)}
              >
                Use {p.label}
              </button>
            ))}
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="smtp-host">Server</label>
            <input
              id="smtp-host"
              className="input"
              value={account.host}
              placeholder="smtp.gmail.com"
              onChange={(e) => setAccount({ ...account, host: e.target.value })}
            />
            <p className="mt-1 text-xs text-cocoa-500">
              Just the name — no <code className="font-mono">https://</code>.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="smtp-port">Port</label>
            <input
              id="smtp-port"
              className="input"
              inputMode="numeric"
              value={account.port}
              onChange={(e) => setAccount({ ...account, port: e.target.value })}
            />
            <p className="mt-1 text-xs text-cocoa-500">
              587 is usual. Use 465 only if your provider asks for it.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="smtp-user">Account email</label>
            <input
              id="smtp-user"
              className="input"
              type="email"
              value={account.user}
              placeholder="merrylane@gmail.com"
              onChange={(e) => setAccount({ ...account, user: e.target.value })}
            />
          </div>

          <div>
            <label className="label" htmlFor="smtp-pass">
              App password{" "}
              {smtp?.has_password && (
                <span className="font-normal normal-case text-cocoa-400">
                  (leave blank to keep the saved one)
                </span>
              )}
            </label>
            <input
              id="smtp-pass"
              className="input"
              type="password"
              autoComplete="off"
              value={account.pass}
              placeholder={smtp?.has_password ? "••••••••••••••••" : "16 characters"}
              onChange={(e) => setAccount({ ...account, pass: e.target.value })}
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor="smtp-from">From address</label>
            <input
              id="smtp-from"
              className="input"
              value={account.from}
              placeholder="Merrylane Cafe Foodhub"
              onChange={(e) => setAccount({ ...account, from: e.target.value })}
            />
            <p className="mt-1 text-xs text-cocoa-500">
              Gmail only accepts a From address it can verify — this must be the
              account above, or a verified alias of it. Anything else is rejected
              with an error that is hard to read.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            className="btn-primary"
            disabled={busy === "save_smtp"}
            onClick={saveAccount}
          >
            {busy === "save_smtp" ? "Saving..." : "Save account"}
          </button>

          {smtp?.has_password && (
            <button
              className="btn-ghost"
              disabled={busy === "clear_smtp"}
              onClick={clearAccount}
            >
              Remove saved account
            </button>
          )}
        </div>

        <details className="mt-4 text-xs text-cocoa-500">
          <summary className="cursor-pointer select-none">Using Gmail?</summary>
          <div className="mt-2 space-y-1.5 rounded-xl bg-cream-100 px-3.5 py-3">
            <p>
              Gmail will not accept your normal account password for sending.
              Turn on 2-Step Verification, then create an App Password at{" "}
              <a
                className="underline"
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noreferrer"
              >
                myaccount.google.com/apppasswords
              </a>{" "}
              and paste the 16 characters it gives you into the app password
              field.
            </p>
            <p>
              The password is encrypted before it is stored, and is never shown
              again — not even to you.
            </p>
          </div>
        </details>
      </Card>

      {/* ---- recipients ---- */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-cocoa-800">Recipients</h2>
          <button
            className="btn-primary"
            onClick={() => {
              setEditing({ id: "", email_address: "", display_name: null, is_active: true, subscriptions: [] } as Recipient);
              setForm({ email_address: "", display_name: "", subscriptions: [] });
            }}
          >
            Add recipient
          </button>
        </div>

        {recipients.length === 0 ? (
          <p className="mt-3 text-sm text-cocoa-500">
            No recipients yet. Alerts are still raised on the dashboard — nobody
            is emailed until an address is added here.
          </p>
        ) : (
          <div className="mt-4 space-y-3">
            {recipients.map((r) => (
              <div key={r.id} className="rounded-xl border border-cream-200 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-cocoa-900">{r.email_address}</div>
                    {r.display_name && (
                      <div className="text-xs text-cocoa-500">{r.display_name}</div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="btn-ghost"
                      disabled={busy === r.id}
                      onClick={() => {
                        setEditing(r);
                        setForm({
                          email_address: r.email_address,
                          display_name: r.display_name ?? "",
                          subscriptions: r.subscriptions ?? [],
                        });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-ghost"
                      disabled={busy === r.id}
                      onClick={() => removeRecipient(r)}
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="mt-2 text-xs text-cocoa-500">
                  {r.subscriptions?.length
                    ? `Sends: ${r.subscriptions.join(", ")}`
                    : "Sends everything"}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---- delivery settings ---- */}
      <Card>
        <h2 className="text-sm font-bold text-cocoa-800">When and how often</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="summary-hour">Daily summary hour</label>
            <select
              id="summary-hour"
              className="input"
              value={settings.email_daily_summary_hour ?? "7"}
              disabled={busy === "email_daily_summary_hour"}
              onChange={(e) => saveSetting("email_daily_summary_hour", e.target.value)}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-cocoa-500">
              One summary a day at this hour. It goes out once even if the server
              was off when the hour passed.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="max-attempts">Delivery attempts</label>
            <input
              id="max-attempts"
              type="number"
              min={1}
              max={10}
              className="input"
              value={settings.email_max_attempts ?? "3"}
              disabled={busy === "email_max_attempts"}
              onChange={(e) => saveSetting("email_max_attempts", e.target.value)}
            />
            <p className="mt-1 text-xs text-cocoa-500">
              How many times a failed message is retried before it is given up on.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="dedupe-hours">Repeat-alert window (hours)</label>
            <input
              id="dedupe-hours"
              type="number"
              min={1}
              max={168}
              className="input"
              value={settings.email_dedupe_hours ?? "24"}
              disabled={busy === "email_dedupe_hours"}
              onChange={(e) => saveSetting("email_dedupe_hours", e.target.value)}
            />
            <p className="mt-1 text-xs text-cocoa-500">
              The same alert is not emailed twice inside this window.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="email-from">From address</label>
            <input
              id="email-from"
              className="input"
              value={settings.email_from ?? ""}
              disabled={busy === "email_from"}
              onChange={(e) => setSettings((p) => ({ ...p, email_from: e.target.value }))}
              onBlur={(e) => saveSetting("email_from", e.target.value)}
            />
            <p className="mt-1 text-xs text-cocoa-500">
              Must be an address your SMTP server is allowed to send as.
            </p>
          </div>
        </div>
      </Card>

      {/* ---- actions ---- */}
      <Card>
        <h2 className="text-sm font-bold text-cocoa-800">Check it works</h2>
        <p className="mt-1 text-sm text-cocoa-500">
          Send yourself a message before you rely on an alert going out.
        </p>

        {!status?.configured && (
          <p className="mt-3 rounded-xl bg-cream-100 px-3.5 py-2.5 text-sm text-cocoa-600">
            Set the sending account above first.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <label className="label" htmlFor="test-to">Send the test to</label>
            <input
              id="test-to"
              className="input"
              type="email"
              value={testTo}
              placeholder={status?.user ?? "you@gmail.com"}
              onChange={(e) => setTestTo(e.target.value)}
            />
          </div>
          <button
            className="btn-primary"
            disabled={busy === "test" || !status?.configured}
            onClick={() => action("test", { to: testTo || status?.user })}
          >
            Send a test message
          </button>
          <button
            className="btn-ghost"
            disabled={busy === "send_now"}
            onClick={() => action("send_now")}
          >
            Send anything queued
          </button>
          <button
            className="btn-ghost"
            disabled={busy === "retry_failed"}
            onClick={() => action("retry_failed")}
          >
            Retry failed messages
          </button>
          <button
            className="btn-ghost"
            disabled={busy === "summary_now"}
            onClick={() => action("summary_now")}
          >
            Send today&apos;s summary now
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-cocoa-600">
            <input
              type="checkbox"
              checked={showQueue}
              onChange={(e) => setShowQueue(e.target.checked)}
            />
            Show the delivery log
          </label>
        </div>
      </Card>

      {/* ---- the log ---- */}
      {showQueue && (
        <Card className="!p-0">
          <div className="border-b border-cream-200 px-5 py-3.5">
            <h2 className="text-sm font-bold text-cocoa-800">Delivery log</h2>
            <p className="text-xs text-cocoa-500">The 50 most recent messages.</p>
          </div>

          {queue.length === 0 ? (
            <div className="p-5">
              <Empty>Nothing has been queued yet.</Empty>
            </div>
          ) : (
            <>
              <div className="hidden lg:block">
                <table className="w-full">
                  <thead className="bg-cream-100">
                    <tr>
                      <th className="th">To</th>
                      <th className="th">Subject</th>
                      <th className="th">Type</th>
                      <th className="th">Status</th>
                      <th className="th text-right">Tries</th>
                      <th className="th">Queued</th>
                    </tr>
                  </thead>
                  <tbody>
                    {queue.map((row) => (
                      <tr key={row.id} className="border-t border-cream-200">
                        <td className="td text-cocoa-700">
                          {row.email_recipients?.email_address ?? "—"}
                        </td>
                        <td className="td text-cocoa-700">{row.subject}</td>
                        <td className="td text-cocoa-500">{row.kind}</td>
                        <td className="td">
                          <Badge tone={STATUS_TONE[row.status]} variant="tag">
                            {row.status}
                          </Badge>
                          {row.last_error && (
                            <div className="mt-1 max-w-[22rem] text-xs text-terracotta-600">
                              {row.last_error}
                            </div>
                          )}
                        </td>
                        <td className="td text-right tabular-nums">{row.attempts}</td>
                        <td className="td text-cocoa-500">{fmtDate(row.queued_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 p-4 lg:hidden">
                {queue.map((row) => (
                  <DataCard key={row.id}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 font-semibold text-cocoa-900">
                        {row.subject}
                      </div>
                      <Badge tone={STATUS_TONE[row.status]} variant="tag">
                        {row.status}
                      </Badge>
                    </div>
                    <DataField label="To">
                      {row.email_recipients?.email_address ?? "—"}
                    </DataField>
                    <DataField label="Type">{row.kind}</DataField>
                    <DataField label="Tries">{row.attempts}</DataField>
                    <DataField label="Queued">{fmtDate(row.queued_at)}</DataField>
                  </DataCard>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* ---- add / edit ---- */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit recipient" : "Add recipient"}
      >
        <label className="label" htmlFor="rcpt-email">Email address</label>
        <input
          id="rcpt-email"
          className="input"
          type="email"
          value={form.email_address}
          placeholder="owner@example.com"
          onChange={(e) => setForm({ ...form, email_address: e.target.value })}
        />

        <label className="label mt-4" htmlFor="rcpt-name">Name (optional)</label>
        <input
          id="rcpt-name"
          className="input"
          value={form.display_name}
          placeholder="Merrylane Cafe Foodhub"
          onChange={(e) => setForm({ ...form, display_name: e.target.value })}
        />

        <div className="label mt-4">What they receive</div>
        <p className="mb-2 text-xs text-cocoa-500">
          Tick nothing to send everything — the usual choice for an owner.
        </p>
        <div className="space-y-1.5">
          {kinds.map((k) => (
            <label key={k.key} className="flex items-center gap-2 text-sm text-cocoa-700">
              <input
                type="checkbox"
                checked={form.subscriptions.includes(k.key)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    subscriptions: e.target.checked
                      ? [...form.subscriptions, k.key]
                      : form.subscriptions.filter((s) => s !== k.key),
                  })
                }
              />
              {k.label}
            </label>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
          <button
            className="btn-primary"
            disabled={busy === "recipient" || !form.email_address.trim()}
            onClick={saveRecipient}
          >
            {editing?.id ? "Save" : "Add"}
          </button>
        </div>
      </Modal>
    </div>
  );
}