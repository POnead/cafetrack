"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Modal, Badge, Empty, Spinner, Toast } from "@/components/ui";
import { BarcodeView, printBarcodeLabelsAsync } from "@/components/BarcodeView";
import { fmtDateTime } from "@/lib/format";
import { accountStatus } from "@/lib/status";

type StaffUser = {
  id: string;
  username: string;
  full_name: string;
  role: "admin" | "staff";
  qr_token: string | null;
  is_active: boolean;
  deactivation_reason: string | null;
  deactivated_at: string | null;
  created_at: string;
};

const EMPTY_FORM = {
  full_name: "",
  username: "",
  password: "",
  role: "staff" as "admin" | "staff",
};

export default function UsersPage() {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Table filters — client-side, like the inventory page.
  const [uq, setUq] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | "admin" | "staff">("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [barcodeUser, setBarcodeUser] = useState<StaffUser | null>(null);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Deactivating asks for a reason first, so it is behind a confirmation modal.
  const [disabling, setDisabling] = useState<StaffUser | null>(null);
  const [reason, setReason] = useState("");

  const [toast, setToast] = useState<{
    msg: string;
    tone: "info" | "error" | "success";
  } | null>(null);

  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const meRes = await fetch("/api/auth/me");
      const meData = await meRes.json();
      if (!meRes.ok) throw new Error(meData.error || "Could not load your session");

      setMeId(meData.user?.id ?? null);
      const admin = meData.user?.role === "admin";
      setIsAdmin(admin);

      if (admin) {
        const res = await fetch("/api/users");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load staff accounts");
        setUsers(data.users ?? []);
      }

      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load staff accounts");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const needle = uq.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter && u.role !== roleFilter) return false;
      if (statusFilter === "active" && !u.is_active) return false;
      if (statusFilter === "inactive" && u.is_active) return false;
      if (!needle) return true;
      return (
        u.full_name.toLowerCase().includes(needle) ||
        u.username.toLowerCase().includes(needle)
      );
    });
  }, [users, uq, roleFilter, statusFilter]);

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setCreating(true);
  }

  async function create() {
    setSaving(true);
    setFormError(null);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create the account");

      setCreating(false);
      await load();
      setToast({ msg: `Account ${data.user.username} created`, tone: "success" });

      // Staff sign in with this code — show it straight away so it can be printed.
      if (data.user.qr_token) setBarcodeUser(data.user as StaffUser);
    } catch (e: any) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function patch(user: StaffUser, body: Record<string, unknown>) {
    setBusyId(user.id);
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update the account");

      await load();
      return data.user as StaffUser;
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  /** Re-activating is one click; deactivating asks for a reason first. */
  async function toggleActive(user: StaffUser) {
    if (!user.is_active) {
      const updated = await patch(user, { is_active: true });
      if (updated) setToast({ msg: "Account activated", tone: "success" });
      return;
    }

    setReason("");
    setDisabling(user);
  }

  async function confirmDisable() {
    if (!disabling) return;

    setSaving(true);
    const updated = await patch(disabling, {
      is_active: false,
      deactivation_reason: reason.trim(),
    });
    setSaving(false);

    if (updated) {
      setDisabling(null);
      setReason("");
      setToast({
        msg: reason.trim()
          ? "Account deactivated — the reason will be shown at sign-in"
          : "Account deactivated",
        tone: "success",
      });
    }
  }

  async function regenerate(user: StaffUser) {
    const updated = await patch(user, { regenerate_token: true });
    if (updated) {
      setBarcodeUser(updated);
      setToast({ msg: "New staff code issued", tone: "success" });
    }
  }

  async function resetPassword() {
    if (!resetting) return;
    setSaving(true);
    const updated = await patch(resetting, { password: newPassword });
    setSaving(false);
    if (updated) {
      setResetting(null);
      setNewPassword("");
      setToast({ msg: `Password reset for ${updated.username}`, tone: "success" });
    }
  }

  async function printToken(user: StaffUser) {
    if (!user.qr_token) return;
    await printBarcodeLabelsAsync([
      { value: user.qr_token, title: user.full_name, subtitle: user.username },
    ]);
  }

  if (loading) return <Spinner />;

  if (!isAdmin) {
    return (
      <Card className="space-y-2">
        <h1 className="deco-title text-3xl">Staff Accounts</h1>
        <p className="text-sm text-cocoa-500">
          Only an admin account can manage users.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="deco-title text-3xl">Staff Accounts</h1>
          <p className="mt-1 text-sm text-cocoa-500">
            Staff sign in by scanning the barcode printed on their ID.
          </p>
        </div>
        <button className="btn-primary" onClick={openCreate}>
          Add account
        </button>
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
            placeholder="Search name or username..."
            value={uq}
            onChange={(e) => setUq(e.target.value)}
          />
          <select
            className="input max-w-[160px]"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as "" | "admin" | "staff")}
          >
            <option value="">All roles</option>
            <option value="admin">Admins</option>
            <option value="staff">Staff</option>
          </select>
          <select
            className="input max-w-[170px]"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | "active" | "inactive")
            }
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Deactivated</option>
          </select>
          <div className="ml-auto self-center text-xs text-cocoa-400">
            {filtered.length} of {users.length} accounts
          </div>
        </div>

        {filtered.length === 0 ? (
          <Empty>
            {users.length === 0
              ? "No accounts yet."
              : "No accounts match your filters."}
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-cream-100/60">
                  <th className="th">Name</th>
                  <th className="th">Username</th>
                  <th className="th">Role</th>
                  <th className="th">Barcode code</th>
                  <th className="th">Added</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="transition-colors hover:bg-cream-50">
                    <td className="td font-semibold text-cocoa-800">
                      {u.full_name}
                      {u.id === meId && (
                        <span className="ml-2 text-[11px] text-cocoa-300">
                          you
                        </span>
                      )}
                    </td>
                    <td className="td font-mono text-xs text-cocoa-400">
                      {u.username}
                    </td>
                    <td className="td">
                      <Badge tone={u.role === "admin" ? "blue" : "slate"}>
                        {u.role}
                      </Badge>
                    </td>
                    <td className="td font-mono text-xs text-cocoa-500">
                      {u.qr_token ?? "—"}
                    </td>
                    <td className="td whitespace-nowrap text-xs text-cocoa-400">
                      {fmtDateTime(u.created_at)}
                    </td>
                    <td className="td">
                      <Badge tone={accountStatus(u.is_active).tone} variant="solid">
                        {accountStatus(u.is_active).label}
                      </Badge>
                      {!u.is_active && (
                        <div className="mt-1 max-w-[14rem] text-[11px] leading-snug text-cocoa-400">
                          {u.deactivation_reason ? (
                            <span title={u.deactivation_reason}>
                              {u.deactivation_reason}
                            </span>
                          ) : (
                            <span className="text-cocoa-300">no reason given</span>
                          )}
                          {u.deactivated_at && (
                            <div className="text-cocoa-300">
                              {fmtDateTime(u.deactivated_at)}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="td text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        {u.qr_token && (
                          <>
                            <button
                              className="btn-ghost !px-3 !py-1 text-xs"
                              onClick={() => setBarcodeUser(u)}
                            >
                              Label
                            </button>
                            <button
                              className="btn-ghost !px-3 !py-1 text-xs"
                              onClick={() => printToken(u)}
                            >
                              Print
                            </button>
                            <button
                              className="btn-ghost !px-3 !py-1 text-xs"
                              disabled={busyId === u.id}
                              onClick={() => regenerate(u)}
                            >
                              New code
                            </button>
                          </>
                        )}
                        <button
                          className="btn-ghost !px-3 !py-1 text-xs"
                          onClick={() => {
                            setNewPassword("");
                            setResetting(u);
                          }}
                        >
                          Reset password
                        </button>
                        <button
                          className={
                            u.is_active
                              ? "btn-danger !px-3 !py-1 text-xs"
                              : "btn-primary !px-3 !py-1 text-xs"
                          }
                          disabled={busyId === u.id}
                          onClick={() => toggleActive(u)}
                        >
                          {u.is_active ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ---------- create ---------- */}
      <Modal
        open={creating}
        onClose={() => {
          if (!saving) setCreating(false);
        }}
        title="New account"
        width="max-w-md"
      >
        <div className="space-y-3.5">
          <div>
            <label className="label" htmlFor="u-name">
              Full name
            </label>
            <input
              id="u-name"
              className="input"
              value={form.full_name}
              placeholder="Juan Dela Cruz"
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            />
          </div>

          <div>
            <label className="label" htmlFor="u-username">
              Username
            </label>
            <input
              id="u-username"
              className="input font-mono"
              value={form.username}
              placeholder="barista3"
              autoComplete="off"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </div>

          <div>
            <label className="label" htmlFor="u-password">
              Password
            </label>
            <input
              id="u-password"
              className="input"
              type="password"
              value={form.password}
              placeholder="At least 6 characters"
              autoComplete="new-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>

          <div>
            <label className="label" htmlFor="u-role">
              Role
            </label>
            <select
              id="u-role"
              className="input"
              value={form.role}
              onChange={(e) =>
                setForm({ ...form, role: e.target.value as "admin" | "staff" })
              }
            >
              <option value="staff">Staff — signs in with a barcode code</option>
              <option value="admin">Admin — signs in with username and password</option>
            </select>
          </div>

          {formError && (
            <div className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
              {formError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="btn-ghost"
              onClick={() => setCreating(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="btn-primary" onClick={create} disabled={saving}>
              {saving ? "Saving..." : "Create account"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ---------- reset password ---------- */}
      <Modal
        open={!!resetting}
        onClose={() => {
          if (!saving) setResetting(null);
        }}
        title={resetting ? `Reset password — ${resetting.full_name}` : ""}
        width="max-w-sm"
      >
        <div className="space-y-3.5">
          <input
            className="input"
            type="password"
            autoFocus
            autoComplete="new-password"
            value={newPassword}
            placeholder="New password (6+ characters)"
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => setResetting(null)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={resetPassword}
              disabled={saving || newPassword.length < 6}
            >
              {saving ? "Saving..." : "Reset password"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ---------- staff barcode ---------- */}
      <Modal
        open={!!barcodeUser}
        onClose={() => setBarcodeUser(null)}
        title={barcodeUser ? `Staff barcode — ${barcodeUser.full_name}` : ""}
        width="max-w-sm"
      >
        {barcodeUser?.qr_token && (
          <div className="flex flex-col items-center gap-4">
            <BarcodeView
              value={barcodeUser.qr_token}
              width={260}
              label={`Barcode for ${barcodeUser.full_name}`}
            />
            <div className="text-center">
              <div className="text-sm font-semibold text-cocoa-800">
                {barcodeUser.full_name}
              </div>
              <div className="text-xs text-cocoa-400">{barcodeUser.username}</div>
            </div>
            <button
              className="btn-primary w-full"
              onClick={() => printToken(barcodeUser)}
            >
              Print this label
            </button>
          </div>
        )}
      </Modal>

      {/* ---------- deactivate confirmation ---------- */}
      <Modal
        open={!!disabling}
        onClose={() => {
          if (!saving) setDisabling(null);
        }}
        title={disabling ? `Deactivate — ${disabling.full_name}` : ""}
        width="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm text-cocoa-600">
            <span className="font-semibold text-cocoa-800">
              {disabling?.full_name}
            </span>{" "}
            will no longer be able to sign in
            {disabling?.role === "staff" ? ", even with the staff ID printed for them" : ""}
            . Stock movements already recorded are not affected.
          </p>

          <div>
            <label className="label" htmlFor="deactivation-reason">
              Reason (optional) — shown to them when they try to sign in
            </label>
            <textarea
              id="deactivation-reason"
              className="input min-h-[84px] resize-y"
              rows={3}
              maxLength={500}
              autoFocus
              value={reason}
              placeholder="e.g. End of contract, replaced by a new hire"
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="mt-1 text-right text-[11px] text-cocoa-300">
              {reason.trim().length}/500
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => setDisabling(null)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn-danger"
              onClick={confirmDisable}
              disabled={saving}
            >
              {saving ? "Deactivating..." : "Deactivate account"}
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
