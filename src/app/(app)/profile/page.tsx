"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Card, Spinner, Toast } from "@/components/ui";
import { BarcodeView, printBarcodeLabelsAsync } from "@/components/BarcodeView";
import { fmtDate, fmtDateTime } from "@/lib/format";
import {
  ID_DOC_TYPE_LABELS,
  type IdDocType,
} from "@/lib/id-verification/types";

type Profile = {
  id: string;
  username: string;
  full_name: string;
  role: string;
  position: string | null;
  start_date: string | null;
  recovery_email: string | null;
  /** Null for admins: a barcode identifies a staff badge, not an admin login. */
  qr_token: string | null;
  verification_status: "verified" | "unverified" | "rejected" | null;
  id_doc_type: string | null;
  id_doc_expiry: string | null;
  verified_at: string | null;
  /** True when a document is on file. The images themselves stay admin-only. */
  has_id_doc: boolean | null;
};

const ID_STATUS: Record<
  string,
  { tone: "green" | "amber" | "red"; label: string }
> = {
  verified: { tone: "green", label: "ID verified" },
  unverified: { tone: "amber", label: "Awaiting review" },
  rejected: { tone: "red", label: "ID rejected" },
};

function idDocTypeLabel(value: string | null): string {
  if (!value) return "Government ID";
  return ID_DOC_TYPE_LABELS[value as IdDocType] ?? value;
}

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingName, setSavingName] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: "success" | "error" } | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/profile")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not load your profile");
        if (!active) return;
        if (data.profile?.role !== "staff") {
          router.replace("/dashboard");
          return;
        }
        const loaded = data.profile as Profile;
        setProfile(loaded);
        setName(loaded.full_name || "Admin");
        setSavedName(loaded.full_name || "Admin");
      })
      .catch((error: unknown) => {
        if (active) {
          setToast({
            msg: error instanceof Error ? error.message : "Could not load your profile",
            tone: "error",
          });
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [router]);

  async function saveName() {
    const fullName = name.trim();
    if (!fullName) {
      setToast({ msg: "Enter your name.", tone: "error" });
      return;
    }
    if (fullName.length > 80) {
      setToast({ msg: "Your name must be 80 characters or fewer.", tone: "error" });
      return;
    }
    setSavingName(true);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: fullName }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update your name");
      setProfile((current) => current && { ...current, full_name: data.profile.full_name });
      setName(data.profile.full_name);
      setSavedName(data.profile.full_name);
      router.refresh();
      setToast({ msg: "Your name was updated.", tone: "success" });
    } catch (error) {
      setToast({
        msg: error instanceof Error ? error.message : "Could not update your name",
        tone: "error",
      });
    } finally {
      setSavingName(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setToast({ msg: "The new passwords do not match.", tone: "error" });
      return;
    }
    setChangingPassword(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          password: newPassword,
          confirm_password: confirmPassword,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not change your password");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setToast({ msg: "Your password was changed.", tone: "success" });
    } catch (error) {
      setToast({
        msg: error instanceof Error ? error.message : "Could not change your password",
        tone: "error",
      });
    } finally {
      setChangingPassword(false);
    }
  }

  async function printBadge() {
    if (!profile?.qr_token) return;
    try {
      await printBarcodeLabelsAsync([
        {
          value: profile.qr_token,
          title: profile.full_name,
          subtitle: profile.username,
        },
      ]);
    } catch (error) {
      setToast({
        msg:
          error instanceof Error
            ? error.message
            : "Could not open the barcode print preview.",
        tone: "error",
      });
    }
  }

  async function copyBadgeCode() {
    if (!profile?.qr_token) return;
    try {
      await navigator.clipboard.writeText(profile.qr_token);
      setToast({ msg: "Badge code copied.", tone: "success" });
    } catch {
      setToast({ msg: "Could not copy the badge code.", tone: "error" });
    }
  }

  if (loading) return <Spinner label="Loading your profile..." />;

  return (
    <div className="space-y-5">
      {toast && (
        <Toast
          message={toast.msg}
          tone={toast.tone}
          onDone={() => setToast(null)}
        />
      )}
      <div>
        <h1 className="deco-title text-3xl">My Profile</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          Review your account details and update your name or password.
        </p>
      </div>

      <Card className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold text-cocoa-800">Account details</h2>
          <p className="mt-1 text-sm text-cocoa-500">
            Your username is assigned by the administrator and cannot be changed here.
          </p>
        </div>
        {profile ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="profile-username">Username</label>
                <input id="profile-username" className="input bg-cream-50" value={profile.username} readOnly />
              </div>
              <div>
                <label className="label" htmlFor="profile-role">Account access</label>
                <input id="profile-role" className="input bg-cream-50 capitalize" value={profile.role} readOnly />
              </div>
              <div>
                <label className="label" htmlFor="profile-position">Position</label>
                <input id="profile-position" className="input bg-cream-50" value={profile.position || "Not set"} readOnly />
              </div>
              <div>
                <label className="label" htmlFor="profile-start-date">Start date</label>
                <input
                  id="profile-start-date"
                  className="input bg-cream-50"
                  value={profile.start_date ? fmtDate(profile.start_date) : "Not recorded"}
                  readOnly
                />
              </div>
              {profile.recovery_email && (
                <div className="sm:col-span-2">
                  <label className="label" htmlFor="profile-email">Recovery email</label>
                  <input id="profile-email" className="input bg-cream-50" value={profile.recovery_email} readOnly />
                </div>
              )}
            </div>
            <div className="border-t border-cream-200 pt-4">
              <label className="label" htmlFor="profile-name">Display name</label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="profile-name"
                  className="input flex-1"
                  value={name}
                  maxLength={80}
                  onChange={(event) => setName(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary"
                  disabled={savingName || !name.trim() || name.trim() === savedName}
                  onClick={() => void saveName()}
                >
                  {savingName ? "Saving..." : "Save name"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-cocoa-500">Profile details could not be loaded.</p>
        )}
      </Card>

      <Card className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-[1.05fr,1.25fr]">
          {profile?.role === "staff" && profile.qr_token && (
            <div className="space-y-4 rounded-2xl border border-cream-200 bg-cream-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-cocoa-800">Staff badge</h2>
                  <p className="mt-1 text-sm text-cocoa-500">
                    Use this code to sign in at the till, or print a fresh label
                    if the old one is worn.
                  </p>
                </div>
                <button
                  type="button"
                  className="text-xs font-semibold text-ochre-700 hover:text-ochre-800"
                  onClick={() => void copyBadgeCode()}
                >
                  Copy code
                </button>
              </div>
              <div className="flex justify-center overflow-hidden rounded-xl bg-white p-3">
                <BarcodeView
                  value={profile.qr_token}
                  width={240}
                  label={`Barcode for ${profile.full_name}`}
                />
              </div>
              <div className="space-y-2">
                <button
                  type="button"
                  className="btn-primary min-h-[44px] w-full"
                  onClick={() => void printBadge()}
                >
                  Print label
                </button>
                <p className="text-xs leading-relaxed text-cocoa-500">
                  Printing does not change your code. Only an administrator can
                  issue a new barcode — ask them if this one is lost or damaged.
                </p>
              </div>
            </div>
          )}

          <div className={profile?.role === "staff" && profile.qr_token ? "space-y-4" : "space-y-4"}>
            <div>
              <h2 className="text-lg font-semibold text-cocoa-800">Change password</h2>
              <p className="mt-1 text-sm text-cocoa-500">
                Verify your current password before choosing a new one.
              </p>
            </div>
            <form onSubmit={changePassword} className="grid gap-3">
              <div>
                <label className="label" htmlFor="profile-current-password">Current password</label>
                <input
                  id="profile-current-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  disabled={changingPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="profile-new-password">New password</label>
                <input
                  id="profile-new-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={newPassword}
                  disabled={changingPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="profile-confirm-password">Confirm new password</label>
                <input
                  id="profile-confirm-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  required
                  value={confirmPassword}
                  disabled={changingPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
              <button type="submit" className="btn-primary justify-self-start" disabled={changingPassword}>
                {changingPassword ? "Changing..." : "Change password"}
              </button>
            </form>
          </div>
        </div>

        {profile?.role === "staff" && profile.has_id_doc && (
          <div className="border-t border-cream-200 pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-cocoa-800">My ID</h2>
                <p className="mt-1 text-sm text-cocoa-500">
                  The document on file for your account.
                </p>
              </div>
              {(() => {
                const status = ID_STATUS[profile.verification_status ?? "unverified"];
                return status ? (
                  <Badge tone={status.tone} variant="tag" dot>
                    {status.label}
                  </Badge>
                ) : null;
              })()}
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="label">Document</dt>
                <dd className="text-sm font-medium text-cocoa-800">
                  {idDocTypeLabel(profile.id_doc_type)}
                </dd>
              </div>
              {profile.verified_at && (
                <div>
                  <dt className="label">Reviewed</dt>
                  <dd className="text-sm text-cocoa-700">
                    {fmtDateTime(profile.verified_at)}
                  </dd>
                </div>
              )}
              {profile.id_doc_expiry && (
                <div>
                  <dt className="label">Expires</dt>
                  <dd className="text-sm text-cocoa-700">
                    {fmtDate(profile.id_doc_expiry)}
                  </dd>
                </div>
              )}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-cocoa-500">
              {profile.verification_status === "verified"
                ? "Your ID has been checked and accepted."
                : profile.verification_status === "rejected"
                  ? "Your ID was not accepted. Ask an administrator to review or replace it."
                  : "Your ID is on file and waiting for an administrator to review it."}{" "}
              The document images themselves are only visible to an administrator.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
