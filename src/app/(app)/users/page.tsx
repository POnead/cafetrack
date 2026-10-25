"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Card,
  Modal,
  Badge,
  Empty,
  Spinner,
  Toast,
  DataCard,
  DataField,
} from "@/components/ui";
import { BarcodeView, printBarcodeLabelsAsync } from "@/components/BarcodeView";
import { fmtDateTime } from "@/lib/format";
import { accountStatus } from "@/lib/status";

/**
 * The capture control, loaded on demand.
 *
 * It pulls in face-api and TensorFlow, which together are several megabytes, and
 * the staff list is a page an admin opens constantly for something that usually
 * has nothing to do with photos. Imported normally it would be in this page's
 * initial download and every visit would pay for it. `ssr: false` also keeps it
 * out of the server render entirely — it is a camera, and a server has no camera.
 */
const FaceCapture = dynamic(() => import("@/components/FaceCapture"), {
  ssr: false,
  loading: () => (
    <p className="text-sm text-cocoa-500">Loading the photo capture…</p>
  ),
});

/**
 * The ID upload control, loaded the same way and for the same reason: reading a
 * face off a card pulls in face-api and TensorFlow.
 */
const IdUpload = dynamic(() => import("@/components/IdUpload"), {
  ssr: false,
  loading: () => (
    <p className="text-sm text-cocoa-500">Loading the ID capture…</p>
  ),
});

/**
 * The review screen, loaded on demand because it is only ever opened
 * deliberately.
 *
 * Unlike the upload control this does *not* use ssr: false — it fetches nothing
 * sensitive during a render and has no camera, so the server renders it fine. Only
 * the control that needs the browser has to be excluded.
 */
const IdReview = dynamic(() => import("@/components/IdReview"), {
  loading: () => <Spinner />,
});

type StaffUser = {
  id: string;
  username: string;
  full_name: string;
  role: "admin" | "staff";
  qr_token: string | null;
  can_manage_items: boolean;
  approval_code: string | null;
  is_active: boolean;
  deactivation_reason: string | null;
  deactivated_at: string | null;
  created_at: string;
  /**
   * First name and surname separately. Both null on accounts created before the
   * columns existed; `full_name` remains the composed display string.
   */
  first_name: string | null;
  last_name: string | null;
  /** Employment details, both optional and both editable after hiring. */
  position: string | null;
  start_date: string | null;
  /** Duty face verification, from /api/users/:id/face. */
  face_enabled: boolean;
  face_enrolled_at: string | null;
  last_face_verified_at: string | null;
  /**
   * ID verification. The three scalars only — the document images and the check
   * signals are hundreds of kilobytes and live behind /api/users/:id/id/status,
   * for the same reason face_image is not in this list.
   */
  verification_status: "unverified" | "verified" | "rejected" | null;
  id_doc_type: string | null;
  verified_at: string | null;
};

/**
 * First name, falling back to the stored full name.
 *
 * Accounts created before the split columns have neither field. A blank beside
 * someone's name would read as data loss, so the leading word of the full name
 * stands in and the surname below carries the rest.
 */
function firstNameOf(u: StaffUser): string {
  if (u.first_name) return u.first_name;
  return u.full_name.trim().split(/\s+/)[0] ?? u.full_name;
}

function lastNameOf(u: StaffUser): string {
  if (u.last_name) return u.last_name;
  const parts = u.full_name.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}

/** Initials for the placeholder shown when there is no reference photo. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const EMPTY_FORM = {
  first_name: "",
  last_name: "",
  username: "",
  password: "",
  role: "staff" as "admin" | "staff",
  can_manage_items: false,
  position: "",
  start_date: "",
};

/**
 * How a verification status reads in the roster.
 *
 * "Not checked" rather than "Unverified" for the pending state. "Unverified"
 * reads as a suspicion about the person — that they were tried and failed —
 * which is a different claim from "nobody has looked at this yet", and the app
 * should not make it.
 */
const VERIFICATION_STATUS: Record<
  string,
  { tone: "green" | "amber" | "red" | "slate"; label: string }
> = {
  verified: { tone: "green", label: "ID verified" },
  unverified: { tone: "amber", label: "ID not checked" },
  rejected: { tone: "red", label: "ID rejected" },
};

/** The document types offered, matching ID_DOC_TYPES on the server. */
const ID_TYPES: { value: string; label: string }[] = [
  { value: "philsys", label: "PhilSys National ID" },
  { value: "lto_license", label: "LTO Driver's Licence" },
  { value: "passport", label: "Passport" },
  { value: "sss", label: "SSS ID" },
  { value: "umid", label: "UMID / GSIS" },
  { value: "philhealth", label: "PhilHealth ID" },
  { value: "voters", label: "Voter's ID" },
  { value: "other", label: "Other" },
];

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

  /*
   * Editing an existing account.
   *
   * Separate from the create form rather than a shared component: they share
   * three fields and differ on everything that matters. Creation asks for a
   * username and a password and mints a barcode; editing has no username (it is
   * the person's identity on their printed badge) and no password (that is what
   * Reset password is for).
   */
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [editForm, setEditForm] = useState({
    first_name: "",
    last_name: "",
    position: "",
    start_date: "",
  });
  const [editError, setEditError] = useState<string | null>(null);

  /** The photo and embedding captured for the account being edited, if any. */
  const [faceShot, setFaceShot] = useState<{
    photo: string;
    embedding: number[];
  } | null>(null);

  /** The same, for the create form. Kept apart so one cannot leak into the other. */
  const [createShot, setCreateShot] = useState<{
    photo: string;
    embedding: number[];
  } | null>(null);

  /** Whether the photo's action menu is open in the details panel. */
  const [photoMenuOpen, setPhotoMenuOpen] = useState(false);

  // The per-account panel: barcode, item-management grant, approval code. One
  // modal for all of it, opened from both the table and the cards, because the
  // grant and the approval code used to live *only* in the mobile card — the
  // desktop table had no route to either, so on a laptop an admin could not
  // grant item-management or issue an approval code at all.
  const [detailsUser, setDetailsUser] = useState<StaffUser | null>(null);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // Deactivating asks for a reason first, so it is behind a confirmation modal.
  const [disabling, setDisabling] = useState<StaffUser | null>(null);
  const [reason, setReason] = useState("");

  /*
   * Re-activating asks the admin to type their own password.
   *
   * The two directions are deliberately not symmetric in what they ask for.
   * Deactivating only takes something away, and records why. Re-activating hands
   * back a working login for a person the cafe decided to lock out — and the
   * admin session permitting it may have been sitting open and unattended on the
   * till all afternoon. A reason would only be a note; the password is the thing
   * that proves the admin came back rather than someone who found an unlocked
   * screen.
   */
  const [reactivating, setReactivating] = useState<StaffUser | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [reactivationError, setReactivationError] = useState<string | null>(null);

  // Rotating a barcode is the other action that can lock someone out, and it
  // used to be a single unlabelled click in a list row — so an admin looking for
  // the approval-code control hit it and silently invalidated a printed badge
  // they had no reason to touch. It asks first now, for the same reason
  // deactivation does.
  const [rotating, setRotating] = useState<StaffUser | null>(null);

  /*
   * ID verification, two modals.
   *
   * Separate from the edit panel because they answer different questions. Edit
   * is "fix a name"; verify is "look at two images and decide", and it needs the
   * full width to put them side by side, which is the only way that question can
   * be answered.
   */
  const [verifying, setVerifying] = useState<StaffUser | null>(null);
  const [verifyingError, setVerifyingError] = useState<string | null>(null);
  const [docType, setDocType] = useState("philsys");
  const [idNumber, setIdNumber] = useState("");
  const [idShot, setIdShot] = useState<import("@/components/IdUpload").IdUploadResult | null>(
    null
  );

  /** The account whose documents are on screen for review. */
  const [reviewing, setReviewing] = useState<StaffUser | null>(null);

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
      /*
       * Admins are not staff, and this page is for staff.
       *
       * The owner was sitting at the top of this list offering a Deactivate
       * button that could only ever be refused — the route refuses it, because an
       * admin is the one role whose deactivation can leave nobody able to undo
       * it. Showing the row at all invites the attempt and the error. Admin
       * accounts are managed elsewhere; this page is the roster of people who
       * scan a barcode to start work.
       */
      if (u.role === "admin") return false;

      if (roleFilter && u.role !== roleFilter) return false;
      if (statusFilter === "active" && !u.is_active) return false;
      if (statusFilter === "inactive" && u.is_active) return false;
      if (!needle) return true;
      return (
        u.full_name.toLowerCase().includes(needle) ||
        u.username.toLowerCase().includes(needle) ||
        (u.position ?? "").toLowerCase().includes(needle)
      );
    });
  }, [users, uq, roleFilter, statusFilter]);

  /*
   * The roster size, counted the same way `filtered` counts.
   *
   * The API returns admins along with staff — the settings screen needs them — so
   * counting `users.length` here would read "3 of 4 accounts" and imply an
   * account this page can never show. The denominator has to be the same set the
   * numerator is drawn from, or the count is quietly wrong by exactly the number
   * of admins.
   */
  const rosterTotal = useMemo(() => users.filter((u) => u.role !== "admin").length, [users]);

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setCreateShot(null);
    setCreating(true);
  }

  /** Open the edit panel, seeded from the account as it currently stands. */
  function openEdit(user: StaffUser) {
    setEditForm({
      first_name: firstNameOf(user),
      last_name: lastNameOf(user),
      position: user.position ?? "",
      // The API stores a plain YYYY-MM-DD, which is what an <input type="date">
      // expects. Guarded because a timestamp here would be silently rejected by
      // the browser and render as an empty field.
      start_date: (user.start_date ?? "").slice(0, 10),
    });
    setEditError(null);
    setFaceShot(null);
    setEditing(user);
  }

  /**
   * Save the edited details.
   *
   * Two calls, in order, and the second only if the first worked. The face
   * enrolment is a separate endpoint on purpose: it is a multipart upload, and
   * folding it into the JSON update would mean one request carrying a 30KB photo
   * for an edit that most often changes only a name.
   *
   * A failure part-way is reported honestly rather than as a success. The name
   * has already changed; saying "could not save" without saying which half would
   * send the admin round in circles.
   */
  async function saveEdit() {
    if (!editing) return;

    if (!editForm.first_name.trim() && !editForm.last_name.trim()) {
      setEditError("A name is required");
      return;
    }

    setSaving(true);
    setEditError(null);

    const updated = await patch(editing, {
      first_name: editForm.first_name.trim(),
      last_name: editForm.last_name.trim(),
      position: editForm.position.trim(),
      start_date: editForm.start_date,
    });

    if (!updated) {
      setSaving(false);
      return; // patch() has already raised a toast.
    }

    if (!faceShot) {
      setEditing(null);
      setFaceShot(null);
      setSaving(false);
      setToast({ msg: "Account updated", tone: "success" });
      return;
    }

    // Face enrolment goes to its own multipart endpoint.
    const fd = new FormData();
    fd.append("embedding", faceShot.embedding.join(","));
    fd.append(
      "image",
      new File([dataUrlToBlob(faceShot.photo)], "face.jpg", { type: "image/jpeg" })
    );

    try {
      const res = await fetch(`/api/users/${editing.id}/face`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The photo could not be saved");

      await load();
      setEditing(null);
      setFaceShot(null);
      // Says which of the two things happened. A single "Account updated" for a
      // save that also stored a face is what made the photo's fate unclear.
      setToast({
        msg: data.warning ?? "Reference photo saved — this person can now confirm their face",
        tone: data.warning ? "error" : "success",
      });
    } catch (e: any) {
      // The details were saved; the photo was not. Say which.
      setEditError(
        `The details were saved, but the photo was not: ${e.message}. ` +
          "Try the photo again."
      );
      await load();
    } finally {
      setSaving(false);
    }
  }

  /** Turn a base64 data URL into a Blob, without unpicking the prefix by hand. */
  function dataUrlToBlob(dataUrl: string): Blob {
    const [head, b64] = dataUrl.split(",");
    const mime = /:(.*?);/.exec(head)?.[1] || "image/jpeg";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /** Remove a reference photo, so someone can be re-enrolled from scratch. */
  async function removeFace(user: StaffUser) {
    setBusyId(user.id);
    try {
      const res = await fetch(`/api/users/${user.id}/face`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove the photo");

      await load();
      setDetailsUser((open) =>
        open && open.id === user.id ? { ...open, face_enabled: false, face_enrolled_at: null } : open
      );
      setFaceShot(null);
      setToast({ msg: "Reference photo removed", tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setBusyId(null);
    }
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

      const created = data.user as StaffUser;
      setCreating(false);
      setFaceShot(null);
      await load();
      setToast({ msg: `Account ${created.username} created`, tone: "success" });

      /*
       * The photo is a second, separate call.
       *
       * The account is already created by the time a photo can fail, so this
       * cannot be one transaction. It is reported honestly instead: the account
       * exists, the photo did not, and the edit panel is opened so the photo can
       * be retried without creating a duplicate account.
       */
      if (createShot) {
        const fd = new FormData();
        fd.append("embedding", createShot.embedding.join(","));
        fd.append(
          "image",
          new File([dataUrlToBlob(createShot.photo)], "face.jpg", { type: "image/jpeg" })
        );

        const faceRes = await fetch(`/api/users/${created.id}/face`, { method: "POST", body: fd });
        const faceData = await faceRes.json();

        if (!faceRes.ok) {
          await load();
          setEditForm({
            first_name: firstNameOf(created),
            last_name: lastNameOf(created),
            position: created.position ?? "",
            start_date: (created.start_date ?? "").slice(0, 10),
          });
          setEditing(created);
          setFormError(
            `The account was created, but the photo could not be saved: ${faceData.error}. ` +
              "Add it here."
          );
          return;
        }

        await load();
        setToast({ msg: `Account ${created.username} created with a reference photo`, tone: "success" });
      }

      // Staff sign in with this code — show the panel straight away so the label
      // can be printed without another trip back to the list.
      if (created.qr_token) setDetailsUser(created);
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

      // Keep the open panel in step with the refresh. Every control inside it
      // changes the very thing it displays — generating a code, rotating a
      // barcode, flipping the grant — so a panel left showing the pre-change
      // value would have the admin copy down a code that no longer works.
      const updated = data.user as StaffUser;
      setDetailsUser((open) =>
        open && open.id === updated.id ? { ...open, ...updated } : open
      );

      return updated;
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      return null;
    } finally {
      setBusyId(null);
    }
  }

  /**
 * Grant or revoke item management (FR-03). One click, no confirmation — unlike
 * deactivation, this is reversible and does not lock anyone out, and the change
 * is recorded in the audit trail either way.
 */
async function toggleItemPermission(user: StaffUser) {
  const grant = !user.can_manage_items;
  const updated = await patch(user, { can_manage_items: grant });
  if (updated) {
    setToast({
      msg: grant
        ? `${updated.full_name} can now add, edit and delete items`
        : `${updated.full_name} now submits items for approval`,
      tone: "success",
    });
  }
}

/** Re-activating asks for the admin's password; deactivating asks for a reason. */
  async function toggleActive(user: StaffUser) {
    if (!user.is_active) {
      setConfirmPassword("");
      setReactivationError(null);
      setReactivating(user);
      return;
    }

    setReason("");
    setDisabling(user);
  }

  async function confirmReactivate() {
    if (!reactivating) return;

    setSaving(true);
    const updated = await patch(reactivating, {
      is_active: true,
      confirm_password: confirmPassword,
    });
    setSaving(false);

    if (updated) {
      setReactivating(null);
      setConfirmPassword("");
      setReactivationError(null);
      setToast({ msg: `${updated.full_name}'s account is active again`, tone: "success" });
    } else if (confirmPassword) {
      /*
       * `patch` has already raised a toast, but this dialog stays open and a
       * transient toast alone tells the admin nothing about which field to fix
       * or that the password was the thing that failed.
       */
      setReactivationError("That password is not correct. Try again.");
    }
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

  /**
   * Issue a fresh barcode, but only from inside the confirmation. The caller is
   * `confirmRotate`; nothing else should reach for this directly.
   */
  async function confirmRotate() {
    if (!rotating) return;

    setSaving(true);
    const updated = await patch(rotating, { regenerate_token: true });
    setSaving(false);

    if (updated) {
      setRotating(null);
      setToast({
        msg: `New barcode issued — reprint ${updated.full_name}'s ID label, the old one no longer works`,
        tone: "success",
      });
    }
  }

  /** Issue a fresh approval code, or revoke the current one. */
  async function regenerateApprovalCode(user: StaffUser) {
    const updated = await patch(user, { regenerate_approval_code: true });
    if (updated) {
      setToast({
        msg: `Approval code for ${updated.full_name}: ${updated.approval_code}`,
        tone: "success",
      });
    }
  }

  async function clearApprovalCode(user: StaffUser) {
    const updated = await patch(user, { approval_code: null });
    if (updated) {
      setToast({
        msg: `Approval code cleared — ${updated.full_name} now submits items for approval`,
        tone: "success",
      });
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

  /** Open the upload form, seeded from whatever is already on the account. */
  function openVerify(user: StaffUser) {
    setDocType(user.id_doc_type ?? "philsys");
    setIdNumber("");
    setIdShot(null);
    setVerifyingError(null);
    setVerifying(user);
  }

  /**
   * Upload the ID and run the checks.
   *
   * Reports honestly about which half happened. The account already exists by
   * the time an upload can fail, so this cannot be one transaction — and saying
   * "could not verify" without saying the documents did or did not land would
   * leave an admin unsure whether to retake the photo.
   */
  async function submitVerification() {
    if (!verifying || !idShot) return;

    setSaving(true);
    setVerifyingError(null);

    const fd = new FormData();
    fd.append("front", idShot.front);
    fd.append("doc_type", docType);
    if (idShot.back) fd.append("back", idShot.back);
    if (idShot.photo) fd.append("photo", idShot.photo);
    if (idShot.cardEmbedding) fd.append("card_embedding", idShot.cardEmbedding.join(","));
    if (idShot.photoEmbedding) fd.append("photo_embedding", idShot.photoEmbedding.join(","));
    if (idShot.cardHash) fd.append("card_hash", idShot.cardHash);
    if (idNumber.trim()) fd.append("id_number", idNumber.trim());

    try {
      const res = await fetch(`/api/users/${verifying.id}/id`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "The ID could not be saved");

      await load();
      setVerifying(null);
      setIdShot(null);

      // Straight to the review screen. Uploading is not approving, and an admin
      // who has just taken three photos is not going to want to go and find the
      // account again to look at them.
      setReviewing({ ...verifying, verification_status: "unverified" });
      setToast({
        msg: "ID attached — check the two images and approve or reject",
        tone: "info",
      });
    } catch (e: any) {
      setVerifyingError(e.message);
    } finally {
      setSaving(false);
    }
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
        <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
          {error}
        </div>
      )}

      <Card className="!p-0">
        <div className="flex flex-wrap gap-3 border-b border-cream-200 bg-cream-50 p-4">
          <input
            aria-label="Search accounts by name or username"
            className="input max-w-xs"
            placeholder="Search name or username..."
            value={uq}
            onChange={(e) => setUq(e.target.value)}
          />
          <select
            aria-label="Filter by role"
            className="input max-w-[160px]"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as "" | "admin" | "staff")}
          >
            <option value="">All roles</option>
            <option value="admin">Admins</option>
            <option value="staff">Staff</option>
          </select>
          <select
            aria-label="Filter by status"
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
            {filtered.length} of {rosterTotal} accounts
          </div>
        </div>

        {filtered.length === 0 && (
          <Empty>
            {rosterTotal === 0
              ? "No accounts yet."
              : "No accounts match your filters."}
          </Empty>
        )}

        {filtered.length > 0 && (
          <>
            <div className="space-y-2.5 px-3 pb-3 lg:hidden">
              {filtered.map((u) => (
                <DataCard key={u.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-cocoa-800">
                        {u.full_name}
                        {u.id === meId && (
                          <span className="ml-2 text-[11px] text-cocoa-300">you</span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-cocoa-400">
                        {u.username}
                      </div>
                    </div>
                    <Badge tone={accountStatus(u.is_active).tone} variant="tag">
                      {accountStatus(u.is_active).label}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={u.role === "admin" ? "blue" : "slate"}>
                      {u.role}
                    </Badge>
                    {/*
                      Verification state, on the roster itself rather than only in
                      the details panel — it is the one thing an admin scanning
                      this list needs to see at a glance, and burying it one
                      click down is how an unverified hire ends up on the floor
                      for a week.
                    */}
                    {(() => {
                      const s = VERIFICATION_STATUS[u.verification_status ?? "unverified"];
                      if (!s) return null;
                      return (
                        <Badge tone={s.tone} variant="tag">
                          {s.label}
                        </Badge>
                      );
                    })()}
                  </div>

                  <DataField label="Barcode">
                    <span className="font-mono text-xs">
                      {u.qr_token ?? "—"}
                    </span>
                  </DataField>
                  <DataField label="Added">
                    <span className="text-xs text-cocoa-400">
                      {fmtDateTime(u.created_at)}
                    </span>
                  </DataField>

                  {/* Read-only. The control lives in the details panel, but the
                      state still belongs on the card — an admin scanning this
                      list should see who can edit without opening anything. */}
                  <DataField label="Item access">
                    <span className="text-xs">
                      {u.role === "admin"
                        ? "Always (admin)"
                        : u.can_manage_items
                          ? "Granted"
                          : "Submits for approval"}
                    </span>
                  </DataField>

                  {!u.is_active && (
                    <DataField label="Reason">
                      <span className="text-xs">
                        {u.deactivation_reason ?? "no reason given"}
                        {u.deactivated_at && (
                          <span className="block text-cocoa-300">
                            {fmtDateTime(u.deactivated_at)}
                          </span>
                        )}
                      </span>
                    </DataField>
                  )}

                  {/*
                      View is the only action on the row.

                      Reset password and Deactivate live in the details panel, which
                      is where the thing they act on is visible: the barcode that
                      will stop working, the name on the badge, whether a photo is
                      enrolled. Three buttons across a row on a phone put them at
                      thumb height next to the wrong person, and deactivating is
                      not something to do by muscle memory.
                    */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button
                      className="btn-ghost min-h-[40px] w-full !px-2 !py-1.5 text-xs"
                      onClick={() => setDetailsUser(u)}
                    >
                      View
                    </button>
                  </div>
                </DataCard>
              ))}
            </div>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full">
              <thead>
                <tr className="bg-cream-100/60">
                  <th className="th">Name</th>
                  <th className="th">Username</th>
                  <th className="th">Role</th>
                  <th className="th">Item access</th>
                  <th className="th">ID check</th>
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
                    <td className="td whitespace-nowrap text-xs text-cocoa-500">
                      {u.role === "admin"
                        ? "Always"
                        : u.can_manage_items
                          ? "Granted"
                          : "Submits for approval"}
                    </td>
                    <td className="td">
                      {(() => {
                        const s = VERIFICATION_STATUS[u.verification_status ?? "unverified"];
                        if (!s) return <span className="text-cocoa-300">—</span>;
                        return (
                          <Badge tone={s.tone} variant="tag">
                            {s.label}
                          </Badge>
                        );
                      })()}
                    </td>
                    <td className="td font-mono text-xs text-cocoa-500">
                      {u.qr_token ?? "—"}
                    </td>
                    <td className="td whitespace-nowrap text-xs text-cocoa-400">
                      {fmtDateTime(u.created_at)}
                    </td>
                    <td className="td">
                      <Badge tone={accountStatus(u.is_active).tone} variant="tag">
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
                    {/* View only — see the note on the card above. */}
                    <td className="td text-right">
                      <div className="inline-flex flex-wrap justify-end gap-1.5">
                        <button
                          className="btn-ghost !px-3 !py-1 text-xs"
                          onClick={() => setDetailsUser(u)}
                        >
                          View
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="u-first">
                First name
              </label>
              <input
                id="u-first"
                className="input"
                value={form.first_name}
                placeholder="Juan"
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="u-last">
                Surname
              </label>
              <input
                id="u-last"
                className="input"
                value={form.last_name}
                placeholder="Dela Cruz"
                onChange={(e) => setForm({ ...form, last_name: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="u-position">
                Position
              </label>
              <input
                id="u-position"
                className="input"
                value={form.position}
                placeholder="Barista"
                onChange={(e) => setForm({ ...form, position: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="u-start">
                Start date
              </label>
              <input
                id="u-start"
                type="date"
                className="input"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </div>
          </div>
          <p className="-mt-1 text-[11px] text-cocoa-400">
            Both optional — you can fill either in later from Edit.
          </p>

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
              <option value="staff">Staff — signs in with username or barcode</option>
              <option value="admin">Admin — signs in with username and password</option>
            </select>

            {/* Only meaningful for staff — an admin can always manage items. */}
            {form.role === "staff" && (
              <div className="mt-4 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3">
                <label className="flex items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.can_manage_items}
                    onChange={(e) =>
                      setForm({ ...form, can_manage_items: e.target.checked })
                    }
                  />
                  <span>
                    <span className="font-semibold text-cocoa-800">
                      Can add, edit and delete items
                    </span>
                    <span className="mt-0.5 block text-xs text-cocoa-500">
                      Without this, new ingredients are submitted and wait on
                      Approvals before they count as stock. With it, their changes
                      take effect straight away.
                    </span>
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* The photo only applies to staff — an admin is never held at the duty
              check, so a reference face for one would be stored and never used. */}
          {form.role === "staff" && (
            <div className="border-t border-cream-200 pt-3.5">
              <p className="label">Reference photo</p>
              <FaceCapture disabled={saving} onCapture={(result) => setCreateShot(result)} />
              <p className="mt-2 text-[11px] text-cocoa-400">
                Optional. Without one, this person is not asked to confirm their
                face at the start of a duty — you can add it later from Edit.
              </p>
            </div>
          )}

          {formError && (
            <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
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

      {/* ---------- staff details ---------- */}
      <Modal
        open={!!detailsUser}
        onClose={() => {
          setDetailsUser(null);
          setPhotoMenuOpen(false);
        }}
        title={detailsUser ? `${detailsUser.full_name}` : ""}
        width="max-w-md"
      >
        {detailsUser && (
          <div className="space-y-4">
            {/* ---------- identity: photo on the left, details on the right ---------- */}
            <div className="flex gap-4">
              {/*
                `self-start` is load-bearing, not tidying.

                This wrapper is a flex item, and flex stretches items to the full
                height of the row by default. The photo itself is 96px, but the
                identity column beside it is several times that, so the wrapper
                grew to match — and `top-full` positions the photo menu against
                the *wrapper*, not the picture. The menu was therefore anchored
                to the bottom of the whole identity block and opened down beside
                the barcode, a long way from the photo it acts on. Pinning the
                wrapper to its own content puts the menu back under the picture.
              */}
              <div className="relative shrink-0 self-start">
                <button
                  type="button"
                  onClick={() => setPhotoMenuOpen((o) => !o)}
                  aria-label="Photo options"
                  aria-expanded={photoMenuOpen}
                  className="group relative block h-24 w-24 overflow-hidden rounded-2xl border-2 border-cream-200 bg-cream-100 transition hover:border-ochre-400 focus:outline-none focus:ring-2 focus:ring-ochre-400"
                >
                  {detailsUser.face_enabled ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/users/${detailsUser.id}/face`}
                      alt={`Reference photo for ${detailsUser.full_name}`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-2xl font-bold text-cocoa-400">
                      {initialsOf(detailsUser.full_name) || "?"}
                    </span>
                  )}
                  {/* The hover hint is what makes the photo read as a control rather
                      than a picture, which matters because on a touch screen there
                      is no hover at all. */}
                  <span className="absolute inset-x-0 bottom-0 bg-cocoa-900/70 py-1 text-[10px] font-semibold text-cream-100 opacity-0 transition group-hover:opacity-100">
                    Change
                  </span>
                </button>

                {/* Photo actions. A plain menu rather than three buttons under the
                    picture, so the identity block stays compact on a phone. */}
                {photoMenuOpen && (
                  <div className="absolute left-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-xl border border-cream-200 bg-white py-1 shadow-lg">
                    {detailsUser.face_enabled ? (
                      <>
                        <button
                          className="block w-full px-3 py-2 text-left text-xs text-cocoa-700 hover:bg-cream-100"
                          onClick={() => {
                            setPhotoMenuOpen(false);
                            window.open(`/api/users/${detailsUser.id}/face`, "_blank");
                          }}
                        >
                          View photo
                        </button>
                        <button
                          className="block w-full px-3 py-2 text-left text-xs text-cocoa-700 hover:bg-cream-100"
                          onClick={() => {
                            setPhotoMenuOpen(false);
                            setDetailsUser(null);
                            openEdit(detailsUser);
                          }}
                        >
                          Replace photo
                        </button>
                        <button
                          className="block w-full px-3 py-2 text-left text-xs text-terracotta-600 hover:bg-terracotta-50"
                          disabled={busyId === detailsUser.id}
                          onClick={() => {
                            setPhotoMenuOpen(false);
                            void removeFace(detailsUser);
                          }}
                        >
                          Remove photo
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="block w-full px-3 py-2 text-left text-xs text-cocoa-700 hover:bg-cream-100"
                          onClick={() => {
                            setPhotoMenuOpen(false);
                            setDetailsUser(null);
                            openEdit(detailsUser);
                          }}
                        >
                          Add photo
                        </button>
                        <p className="px-3 py-2 text-[11px] leading-snug text-cocoa-400">
                          Without a reference photo this person is not asked to
                          confirm their face at the start of a duty.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <dl className="min-w-0 space-y-1.5">
                    <div className="flex gap-2">
                      <dt className="w-[4.5rem] shrink-0 font-mono text-[11px] uppercase text-cocoa-400">
                        Name
                      </dt>
                      <dd className="truncate text-sm font-semibold text-cocoa-800">
                        {firstNameOf(detailsUser)}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-[4.5rem] shrink-0 font-mono text-[11px] uppercase text-cocoa-400">
                        Surname
                      </dt>
                      <dd className="truncate text-sm font-semibold text-cocoa-800">
                        {lastNameOf(detailsUser) || (
                          <span className="font-normal text-cocoa-400">—</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-[4.5rem] shrink-0 font-mono text-[11px] uppercase text-cocoa-400">
                        Position
                      </dt>
                      <dd className="truncate text-sm text-cocoa-700">
                        {detailsUser.position || (
                          <span className="text-cocoa-400">Not recorded</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-[4.5rem] shrink-0 font-mono text-[11px] uppercase text-cocoa-400">
                        Added
                      </dt>
                      <dd className="text-sm text-cocoa-700">
                        {fmtDateTime(detailsUser.created_at)}
                      </dd>
                    </div>
                    {detailsUser.start_date && (
                      <div className="flex gap-2">
                        <dt className="w-[4.5rem] shrink-0 font-mono text-[11px] uppercase text-cocoa-400">
                          Started
                        </dt>
                        <dd className="text-sm text-cocoa-700">
                          {fmtDateTime(detailsUser.start_date)}
                        </dd>
                      </div>
                    )}
                  </dl>

                  <Badge
                    tone={accountStatus(detailsUser.is_active).tone}
                    variant="tag"
                    dot
                  >
                    {accountStatus(detailsUser.is_active).label}
                  </Badge>
                </div>

                <div className="flex flex-wrap gap-1.5 pt-1">
                  <button
                    className="btn-ghost min-h-[36px] !px-2.5 !py-1 text-xs"
                    onClick={() => {
                      setDetailsUser(null);
                      openEdit(detailsUser);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn-ghost min-h-[36px] !px-2.5 !py-1 text-xs"
                    onClick={() => {
                      setDetailsUser(null);
                      setNewPassword("");
                      setResetting(detailsUser);
                    }}
                  >
                    Reset password
                  </button>
                  <button
                    className={
                      detailsUser.is_active
                        ? "btn-danger min-h-[36px] !px-2.5 !py-1 text-xs"
                        : "btn-primary min-h-[36px] !px-2.5 !py-1 text-xs"
                    }
                    disabled={busyId === detailsUser.id}
                    onClick={() => {
                      setDetailsUser(null);
                      toggleActive(detailsUser);
                    }}
                  >
                    {detailsUser.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              </div>
            </div>

            {/*
              Why the account was switched off.

              Sits below the Edit / Reset password / Reactivate row, and is built
              and placed exactly like the duty-check card beside it. Two reasons
              it is not another row in the name list: it is not a field about the
              person — Name, Position and Added are — it is the standing
              explanation for the state this panel is showing; and that list sits
              in a narrow column beside the photo, where the card came out
              visibly narrower than every other card in the panel and read as
              something different rather than as the same kind of thing. At full
              width the two line up. The date is muted so it reads as when it
              happened rather than as a second value.
            */}
            {!detailsUser.is_active && (
              <div className="rounded-xl bg-cream-50 px-3.5 py-2.5 text-xs text-cocoa-600">
                <span className="font-semibold text-cocoa-800">
                  Deactivation reason
                </span>
                <p className="mt-0.5">
                  {detailsUser.deactivation_reason || "No reason given"}
                  {detailsUser.deactivated_at && (
                    <span className="text-cocoa-400">
                      {" · "}
                      {fmtDateTime(detailsUser.deactivated_at)}
                    </span>
                  )}
                </p>
              </div>
            )}

            {/*
              The one warning that is about access rather than about records.

              Staff sign-in is two steps: a password, then a face or an ID card.
              An account with neither cannot finish signing in at all — not
              weakly, but not at all — and until this change that was invisible
              from this screen. The person simply stops being able to get to work
              and the only clue is a refusal at the till.

              So it is stated here, on the account, in the same place an admin
              already looks to find out why someone cannot do something.

              `verification_status === "verified"` is the proxy for "has a card",
              not a guess: approving a card is what writes that status, and the
              fingerprint the sign-in route compares against is written by the
              same upload.
            */}
            {detailsUser.role === "staff" &&
              detailsUser.is_active &&
              !detailsUser.face_enabled &&
              detailsUser.verification_status !== "verified" && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs leading-relaxed text-red-800">
                  <span className="font-semibold">Cannot sign in</span>
                  <p className="mt-0.5">
                    Signing in asks for a password and then a face or an ID card.
                    This account has neither on file, so {detailsUser.full_name || "they"}{" "}
                    will be refused at the second step. Add a reference photo
                    below, or upload and approve their ID.
                  </p>
                </div>
              )}

            {/* Duty check state, only once someone has actually been checked. */}
            {detailsUser.face_enabled && (
              <div className="rounded-xl bg-cream-50 px-3.5 py-2.5 text-xs text-cocoa-600">
                <span className="font-semibold text-cocoa-800">Duty face check</span>
                <p className="mt-0.5">
                  {detailsUser.last_face_verified_at
                    ? `Last passed ${fmtDateTime(detailsUser.last_face_verified_at)}`
                    : "Has not passed a duty check yet"}
                  {detailsUser.face_enrolled_at
                    ? ` · enrolled ${fmtDateTime(detailsUser.face_enrolled_at)}`
                    : ""}
                </p>
              </div>
            )}

            {/*
              ID verification, in the same shape as the duty check above so the
              panel reads as one list rather than two.

              Two buttons rather than one, because they are different actions on
              different states: attaching a document for the first time, and
              opening a document that is already on file to look at it again.
              Collapsing them into one button labelled by the *next* action means
              the label changes meaning depending on state, which is exactly the
              thing that makes an admin click the wrong one.
            */}
            {detailsUser.role === "staff" && (
              <DataField label="ID verification">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const s = VERIFICATION_STATUS[
                        detailsUser.verification_status ?? "unverified"
                      ];
                      return s ? (
                        <Badge tone={s.tone} variant="tag" dot>
                          {s.label}
                        </Badge>
                      ) : null;
                    })()}
                    {detailsUser.verified_at && (
                      <span className="text-[11px] text-cocoa-400">
                        {fmtDateTime(detailsUser.verified_at)}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <button
                      className="btn-ghost min-h-[40px] !px-3 !py-1.5 text-xs"
                      disabled={busyId === detailsUser.id}
                      onClick={() => {
                        setDetailsUser(null);
                        openVerify(detailsUser);
                      }}
                    >
                      {detailsUser.id_doc_type ? "Replace ID" : "Verify ID"}
                    </button>
                    <button
                      className="btn-ghost min-h-[40px] !px-3 !py-1.5 text-xs"
                      disabled={busyId === detailsUser.id}
                      onClick={() => {
                        setDetailsUser(null);
                        setReviewing(detailsUser);
                      }}
                    >
                      View &amp; decide
                    </button>
                  </div>

                  <p className="text-[11px] text-cocoa-400">
                    Photograph the person&apos;s ID and a photo of them. The checks compare the two
                    faces and look for signs of a doctored card — whether the card is genuine is
                    yours to decide.
                  </p>
                </div>
              </DataField>
            )}

            {/* ---------- barcode ---------- */}
            {detailsUser.qr_token ? (
              <div className="flex flex-col items-center gap-3 rounded-xl border border-cream-200 bg-cream-50 p-4">
                <BarcodeView
                  value={detailsUser.qr_token}
                  width={240}
                  label={`Barcode for ${detailsUser.full_name}`}
                />
                <p className="text-center text-[11px] text-cocoa-400">
                  This is the code they scan to sign in. Printing a new one
                  makes the label they already carry stop working.
                </p>
                <div className="flex w-full gap-2">
                  <button
                    className="btn-ghost flex-1 text-xs"
                    onClick={() => printToken(detailsUser)}
                  >
                    Print this label
                  </button>
                  <button
                    className="btn-ghost flex-1 text-xs"
                    disabled={busyId === detailsUser.id}
                    onClick={() => setRotating(detailsUser)}
                  >
                    New barcode
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-cocoa-500">
                Admins sign in with a username and password, so this account has
                no barcode.
              </p>
            )}

            {/* Both of these are staff-only. An admin can always manage items,
                so a grant or an approval code would mean nothing. */}
            {detailsUser.role === "staff" && (
              <>
                <DataField label="Item management">
                  <div className="space-y-1.5">
                    <button
                      className="btn-ghost min-h-[40px] !px-3 !py-1.5 text-xs"
                      disabled={busyId === detailsUser.id}
                      onClick={() => toggleItemPermission(detailsUser)}
                    >
                      {detailsUser.can_manage_items ? "Granted" : "Not granted"}
                    </button>
                    <p className="text-[11px] text-cocoa-400">
                      {detailsUser.can_manage_items
                        ? "Their item changes take effect immediately, without waiting for approval."
                        : "New ingredients and edits are submitted and wait on the Approvals page."}
                    </p>
                  </div>
                </DataField>

                <DataField label="Approval code">
                  <div className="space-y-1.5">
                    <span className="block font-mono text-sm">
                      {detailsUser.approval_code ?? "none issued"}
                    </span>
                    <p className="text-[11px] text-cocoa-400">
                      A code lets one person skip the approvals queue without
                      granting them item-management outright. Read it out and
                      give it to them — they type it when adding or editing an
                      item.
                    </p>
                    <div className="flex gap-2 pt-0.5">
                      <button
                        className="btn-ghost min-h-[40px] !px-3 !py-1.5 text-xs"
                        disabled={busyId === detailsUser.id}
                        onClick={() => regenerateApprovalCode(detailsUser)}
                      >
                        {detailsUser.approval_code
                          ? "New approval code"
                          : "Generate approval code"}
                      </button>
                      {detailsUser.approval_code && (
                        <button
                          className="btn-ghost min-h-[40px] !px-3 !py-1.5 text-xs"
                          disabled={busyId === detailsUser.id}
                          onClick={() => clearApprovalCode(detailsUser)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </div>
                </DataField>
              </>
            )}

            {/* No "Added" field down here — the identity block at the top already carries it,
                and the two sat far enough apart on a phone to read as two different
                dates belonging to two different things. */}

            {/* The manager override — the only action left down here. Edit,
                Reset password and Deactivate moved up into the identity block,
                so the panel reads left to right: who they are, then what you
                can do about it. */}
            {detailsUser.role === "staff" && detailsUser.is_active && (
              <button
                className="btn-ghost w-full"
                disabled={busyId === detailsUser.id}
                onClick={() => toggleActive(detailsUser)}
              >
                Let them in for this duty without a face check
              </button>
            )}
          </div>
        )}
      </Modal>

      {/* ---------- rotate barcode confirmation ---------- */}
      <Modal
        open={!!rotating}
        onClose={() => {
          if (!saving) setRotating(null);
        }}
        title={rotating ? `New barcode — ${rotating.full_name}` : ""}
        width="max-w-md"
      >
        <div className="space-y-4">
          <p className="text-sm text-cocoa-600">
            This replaces the code{" "}
            <span className="font-semibold text-cocoa-800">
              {rotating?.full_name}
            </span>{" "}
            signs in with.{" "}
            <span className="font-semibold text-cocoa-800">
              Any label already printed with the old barcode stops working
              immediately
            </span>{" "}
            — they will be refused at the login screen until you reprint and
            hand them the new one.
          </p>

          <div className="rounded-xl bg-cream-50 px-3.5 py-2.5 text-xs text-cocoa-500">
            Only do this if the label is lost or damaged, or if you are
            deliberately revoking their access. Rotating is recorded in the audit
            trail.
          </div>

          {rotating?.qr_token && (
            <div className="text-xs text-cocoa-400">
              Current code:{" "}
              <span className="font-mono text-cocoa-600">{rotating.qr_token}</span>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              className="btn-ghost"
              onClick={() => setRotating(null)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn-danger"
              onClick={confirmRotate}
              disabled={saving}
              autoFocus
            >
              {saving ? "Issuing..." : "Issue new barcode"}
            </button>
          </div>
        </div>
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
            <div className="mt-1 flex justify-between text-[11px]">
              <span
                className={
                  reason.trim().length === 0 ? "text-terracotta-600" : "text-cocoa-300"
                }
              >
                {reason.trim().length === 0
                  ? "A reason is required."
                  : "The person will see this when they try to sign in."}
              </span>
              <span className="text-cocoa-300">{reason.trim().length}/500</span>
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
              disabled={saving || reason.trim().length === 0}
            >
              {saving ? "Deactivating..." : "Deactivate account"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ---------- reactivate ---------- */}
      <Modal
        open={!!reactivating}
        onClose={() => {
          if (!saving) {
            setReactivating(null);
            setReactivationError(null);
          }
        }}
        title={reactivating ? `Reactivate — ${reactivating.username}` : ""}
        width="max-w-md"
      >
        {reactivating && (
          <div className="space-y-4">
            <p className="text-sm text-cocoa-600">
              <span className="font-semibold text-cocoa-800">
                {reactivating.full_name}
              </span>{" "}
              will be able to sign in again
              {reactivating.role === "staff"
                ? ", with the staff ID printed for them"
                : ""}
              .
              {reactivating.deactivation_reason && (
                <>
                  {" "}
                  You recorded this reason when you switched them off:{" "}
                  <span className="font-semibold text-cocoa-700">
                    {reactivating.deactivation_reason}
                  </span>
                  .
                </>
              )}
            </p>

            <div>
              <label className="label" htmlFor="reactivate-password">
                Your password
              </label>
              <input
                id="reactivate-password"
                className="input"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (reactivationError) setReactivationError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && confirmPassword) confirmReactivate();
                }}
              />
              <p className="mt-1 text-[11px] text-cocoa-300">
                To confirm this is you and not someone at an unattended till.
              </p>
            </div>

            {reactivationError && (
              <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
                {reactivationError}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                className="btn-ghost"
                onClick={() => {
                  setReactivating(null);
                  setReactivationError(null);
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={confirmReactivate}
                disabled={saving || confirmPassword.length === 0}
              >
                {saving ? "Reactivating..." : "Reactivate account"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- edit ---------- */}
      <Modal
        open={!!editing}
        onClose={() => {
          if (!saving) setEditing(null);
        }}
        title={editing ? `Edit — ${editing.username}` : ""}
        width="max-w-md"
      >
        {editing && (
          <div className="space-y-3.5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="e-first">
                  First name
                </label>
                <input
                  id="e-first"
                  className="input"
                  value={editForm.first_name}
                  placeholder="Juan"
                  onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="e-last">
                  Surname
                </label>
                <input
                  id="e-last"
                  className="input"
                  value={editForm.last_name}
                  placeholder="Dela Cruz"
                  onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                />
              </div>
            </div>
            <p className="-mt-1 text-[11px] text-cocoa-400">
              Together these are the name on the roster, the printed badge and the
              audit trail. The username is not changed here.
            </p>

            <div>
              <label className="label" htmlFor="e-position">
                Position
              </label>
              <input
                id="e-position"
                className="input"
                value={editForm.position}
                placeholder="Barista"
                onChange={(e) => setEditForm({ ...editForm, position: e.target.value })}
              />
            </div>

            <div>
              <label className="label" htmlFor="e-start">
                Start date
              </label>
              <input
                id="e-start"
                type="date"
                className="input"
                value={editForm.start_date}
                onChange={(e) => setEditForm({ ...editForm, start_date: e.target.value })}
              />
            </div>

            <div className="border-t border-cream-200 pt-3.5">
              <p className="label">Reference photo</p>
              <FaceCapture
                disabled={saving}
                currentPhoto={faceShot?.photo ?? null}
                onCapture={(result) => setFaceShot(result)}
              />
              {editing.face_enabled && !faceShot && (
                <p className="mt-2 text-[11px] text-cocoa-400">
                  Leaving this empty keeps the photo already stored. Use “Replace
                  photo” in the details panel to see it.
                </p>
              )}
              {editForm.start_date === "" && (
                <p className="mt-2 text-[11px] text-cocoa-400">
                  No start date recorded. You can leave it blank and add it later.
                </p>
              )}
            </div>

            {editError && (
              <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
                {editError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                className="btn-ghost"
                onClick={() => setEditing(null)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={saveEdit}
                disabled={saving || (!editForm.first_name.trim() && !editForm.last_name.trim())}
              >
                {saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- attach an ID ---------- */}
      <Modal
        open={!!verifying}
        onClose={() => {
          if (!saving) {
            setVerifying(null);
            setIdShot(null);
          }
        }}
        title={verifying ? `Verify ID — ${verifying.full_name}` : ""}
        width="max-w-lg"
      >
        {verifying && (
          <div className="space-y-3.5">
            <div className="rounded-xl bg-cream-50 px-3.5 py-2.5 text-xs leading-snug text-cocoa-600">
              Take a photo of the applicant&apos;s ID and a photo of them. The checks compare the
              portrait on the card with their face and look for an obviously doctored image —
              but whether the card is genuine is yours to decide, from the two pictures below.
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="id-doctype">
                  Kind of ID
                </label>
                <select
                  id="id-doctype"
                  className="input"
                  value={docType}
                  disabled={saving}
                  onChange={(e) => setDocType(e.target.value)}
                >
                  {ID_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="id-number">
                  ID number (optional)
                </label>
                <input
                  id="id-number"
                  className="input font-mono"
                  value={idNumber}
                  disabled={saving}
                  placeholder="As printed on the card"
                  onChange={(e) => setIdNumber(e.target.value)}
                />
              </div>
            </div>

            <IdUpload disabled={saving} onReady={setIdShot} />

            {verifyingError && (
              <div className="rounded-xl bg-terracotta-50 px-3.5 py-2.5 text-sm text-terracotta-700">
                {verifyingError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                className="btn-ghost"
                onClick={() => {
                  setVerifying(null);
                  setIdShot(null);
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={submitVerification}
                disabled={saving || !idShot}
              >
                {saving ? "Checking..." : "Attach and check"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- review and decide ---------- */}
      <Modal
        open={!!reviewing}
        onClose={() => setReviewing(null)}
        title={reviewing ? `ID check — ${reviewing.full_name}` : ""}
        width="max-w-2xl"
      >
        {reviewing && (
          <IdReview
            userId={reviewing.id}
            onClose={() => setReviewing(null)}
            onDone={async (message) => {
              await load();
              setReviewing(null);
              setToast({ msg: message, tone: "success" });
            }}
          />
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
