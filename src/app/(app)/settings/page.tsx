"use client";

/**
 * Admin settings: the tunable company policy, plus the two reference lists
 * (item categories and storage locations).
 *
 * The spec asks for admins to "manage company settings: item categories,
 * storage locations, alert thresholds" and to "configure low-stock thresholds
 * and expiration warning periods" — that is what this page is for.
 *
 * The global policies here include expiry warnings and role-specific session
 * timeouts. Per-item low-stock thresholds live on the inventory page because
 * they depend on the item.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, ConfirmDialog, Spinner, Toast, Empty } from "@/components/ui";
import { EmailNotifications } from "@/components/EmailNotifications";
import { matchThresholdBand } from "@/lib/face";

type Ref = { id: string; name: string; min_shelf_life_days?: number | null };
type Supplier = { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null };
type SupplierItem = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
};
type StaffPosition = {
  id: string;
  name: string;
  originalName?: string;
  access: "staff" | "admin";
  assignedCount?: number;
};
type Tone = "info" | "error" | "success";
type ExpiryPreset = "7" | "15" | "30" | "custom";
type SettingsTab = "email" | "staff" | "storage" | "suppliers" | "general";
type RemovalKind = "category" | "location" | "supplier";
type RemovalTarget = { kind: RemovalKind; id: string; name: string };

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "staff", label: "Staff" },
  { id: "storage", label: "Storage" },
  { id: "suppliers", label: "Suppliers" },
  { id: "general", label: "General" },
];

const GENERAL_SETTING_DEFAULTS = {
  expiry_warning_days: "7",
  admin_session_timeout_minutes: "5",
  staff_session_timeout_minutes: "10",
  face_duty_hours: "9",
  business_name: "Merrylane Cafe Foodhub",
  password_recovery_email: "",
};

const GENERAL_SETTING_KEYS = Object.keys(GENERAL_SETTING_DEFAULTS);
const STAFF_ACCESS_SETTING_KEYS = [
  "admin_session_timeout_minutes",
  "staff_session_timeout_minutes",
  "face_duty_hours",
] as const;

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const recoveryEmailInputRef = useRef<HTMLInputElement | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("email");
  const [focusRecoveryEmail, setFocusRecoveryEmail] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>("7");
  const [categories, setCategories] = useState<Ref[]>([]);
  const [locations, setLocations] = useState<Ref[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [staffPositions, setStaffPositions] = useState<StaffPosition[]>([]);
  const [newPosition, setNewPosition] = useState("");
  const [savingPositions, setSavingPositions] = useState(false);
  const savedStaffPositions = useRef<{ name: string; access: StaffPosition["access"] }[]>([]);
  const [adminName, setAdminName] = useState("Admin");
  const [savedAdminName, setSavedAdminName] = useState("Admin");
  const [savingAdminName, setSavingAdminName] = useState(false);

  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: Tone } | null>(null);
  const [pendingToggle, setPendingToggle] = useState<{
    key: string;
    title: string;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);

  const [newCategory, setNewCategory] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newSupplier, setNewSupplier] = useState("");
  const [adding, setAdding] = useState<"category" | "location" | "supplier" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<RemovalTarget | null>(null);
  const [removalReason, setRemovalReason] = useState("");
  const [removalPassword, setRemovalPassword] = useState("");
  const [removing, setRemoving] = useState(false);
  const [passwordChange, setPasswordChange] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const [changingPassword, setChangingPassword] = useState(false);

  /* Supplier detail is edited in place, and its items are fetched only when
     asked for. Both keep the settings page to one list rather than turning a
     reference list into a second inventory screen. */
  const [editingSupplierId, setEditingSupplierId] = useState<string | null>(null);
  const [supplierForm, setSupplierForm] = useState({
    name: "",
    contact_name: "",
    phone: "",
    email: "",
  });
  const [savingSupplier, setSavingSupplier] = useState(false);
  const [supplierItemsId, setSupplierItemsId] = useState<string | null>(null);
  const [supplierItems, setSupplierItems] = useState<SupplierItem[]>([]);
  const [supplierItemsLoading, setSupplierItemsLoading] = useState(false);

  const inFlight = useRef(false);

  useEffect(() => {
    const tabParam = searchParams.get("tab");
    const focusParam = searchParams.get("focus");
    if (tabParam === "general" || focusParam === "password_recovery_email") {
      setActiveTab("general");
    }
    if (focusParam === "password_recovery_email") {
      setFocusRecoveryEmail(true);
      router.replace("/settings?tab=general", { scroll: false });
    }
  }, [router, searchParams]);

  useEffect(() => {
    if (!focusRecoveryEmail || activeTab !== "general") return;

    const timer = window.setTimeout(() => {
      const input = recoveryEmailInputRef.current;
      if (!input) return;
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus({ preventScroll: true });
      setFocusRecoveryEmail(false);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [activeTab, focusRecoveryEmail]);

  /*
   * What the database currently holds, as opposed to what the form currently
   * shows.
   *
   * The edit fields are uncontrolled-ish: onChange writes into `settings` so the
   * input can be redrawn, and onBlur decides whether to save by comparing the
   * field against the stored value. Comparing against `settings` compared the
   * typed value with itself, because state had already been updated by the
   * keystroke — so no text or number field on this page ever saved. Keeping the
   * last saved value in its own ref is what makes "did this actually change?"
   * a real question again.
   */
  const saved = useRef<Record<string, string>>({});

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const meRes = await fetch("/api/auth/me");
      const meData = await meRes.json();
      if (!meRes.ok) throw new Error(meData.error || "Could not check your access");

      const admin = meData.user?.role === "admin";
      setIsAdmin(admin);
      if (!admin) return;
      const currentAdminName =
        typeof meData.user?.fullName === "string" && meData.user.fullName.trim()
          ? meData.user.fullName.trim()
          : "Admin";
      setAdminName(currentAdminName);
      setSavedAdminName(currentAdminName);

      const [s, c, l, sup, positions] = await Promise.all([
        fetch("/api/settings").then((r) => r.json()),
        fetch("/api/refs/categories").then((r) => r.json()),
        fetch("/api/refs/locations").then((r) => r.json()),
        fetch("/api/refs/suppliers").then((r) => r.json()),
        fetch("/api/staff-positions").then((r) => r.json()),
      ]);

      if (s.error) throw new Error(s.error);
      if (positions.error) throw new Error(positions.error);

      const loadedSettings = {
        ...GENERAL_SETTING_DEFAULTS,
        ...(s.settings ?? {}),
      };
      setSettings(loadedSettings);
      setExpiryPreset(
        loadedSettings.expiry_warning_days === "7" ||
          loadedSettings.expiry_warning_days === "15" ||
          loadedSettings.expiry_warning_days === "30"
          ? loadedSettings.expiry_warning_days
          : "custom"
      );
      saved.current = { ...loadedSettings };
      setCategories(c.items ?? []);
      setLocations(l.items ?? []);
      setSuppliers(sup.items ?? []);
      const loadedPositions: StaffPosition[] = (
        (positions.positions ?? []) as Omit<StaffPosition, "id">[]
      ).map((position) => ({
        ...position,
        id: crypto.randomUUID(),
        originalName: position.name,
      }));
      setStaffPositions(loadedPositions);
      savedStaffPositions.current = loadedPositions.map(({ name, access }) => ({
        name,
        access,
      }));
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load settings");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  async function saveAdminName() {
    const name = adminName.trim();
    if (!name) {
      setToast({ msg: "Enter the admin display name.", tone: "error" });
      return;
    }
    if (name.length > 80) {
      setToast({ msg: "The admin display name must be 80 characters or fewer.", tone: "error" });
      return;
    }
    if (name === savedAdminName) return;

    setSavingAdminName(true);
    try {
      const res = await fetch("/api/admin/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full_name: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not update the admin name");
      setAdminName(data.user.full_name || "Admin");
      setSavedAdminName(data.user.full_name || "Admin");
      setToast({ msg: "Admin name updated", tone: "success" });
      router.refresh();
    } catch (error) {
      setToast({
        msg: error instanceof Error ? error.message : "Could not update the admin name",
        tone: "error",
      });
    } finally {
      setSavingAdminName(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function askToDisableToggle(
    key: string,
    label: string,
    warning: string,
    value: string,
  ) {
    if (value !== "0") {
      void saveField(key, value);
      return;
    }

    setPendingToggle({
      key,
      title: `Turn off ${label}?`,
      message: warning,
      confirmLabel: `Turn off ${label}`,
      onConfirm: () => {
        setPendingToggle(null);
        void saveField(key, "0");
      },
    });
  }

  async function saveField(key: string, value: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");

      // Store the value the API actually kept, which may be rounded to the
      // field's precision (see `decimals` in api/settings).
      setSettings((prev) => ({ ...prev, [key]: data.settings[key] }));
      saved.current[key] = data.settings[key];
      window.dispatchEvent(new Event("cafetrack:settings-updated"));
      setToast({ msg: "Saved", tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      // Re-read so the field never shows a value the database rejected.
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function saveSpecificGeneralSettings(keys: string[], successMessage: string) {
    const changes = Object.fromEntries(
      keys
        .filter((key) => settings[key] !== saved.current[key])
        .map((key) => [key, settings[key]])
    );
    if (Object.keys(changes).length === 0) return;

    const staffAccessBounds: Record<string, { min: number; max: number; label: string }> = {
      admin_session_timeout_minutes: {
        min: 1,
        max: 480,
        label: "Admin session timeout",
      },
      staff_session_timeout_minutes: {
        min: 1,
        max: 480,
        label: "Staff session timeout",
      },
      face_duty_hours: { min: 1, max: 24, label: "Staff face-check interval" },
    };
    for (const [key, value] of Object.entries(changes)) {
      const bounds = staffAccessBounds[key];
      if (!bounds) continue;
      const number = Number(value);
      if (
        !Number.isInteger(number) ||
        number < bounds.min ||
        number > bounds.max
      ) {
        setToast({
          msg: `${bounds.label} must be a whole number between ${bounds.min} and ${bounds.max}.`,
          tone: "error",
        });
        return;
      }
    }

    if (changes.expiry_warning_days !== undefined) {
      const expiryDays = Number(changes.expiry_warning_days);
      if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365) {
        setToast({
          msg: "Enter a custom expiry warning between 1 and 365 whole days.",
          tone: "error",
        });
        return;
      }
    }

    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save settings");

      const persisted = data.settings as Record<string, string>;
      setSettings((prev) => ({ ...prev, ...persisted }));
      saved.current = { ...saved.current, ...persisted };
      window.dispatchEvent(new Event("cafetrack:settings-updated"));
      setToast({ msg: successMessage, tone: "success" });
      router.refresh();
    } catch (e: any) {
      setToast({ msg: e.message || "Could not save settings", tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function saveStaffPositions(next: StaffPosition[]) {
    setSavingPositions(true);
    try {
      const res = await fetch("/api/staff-positions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          positions: next.map(({ name, access, originalName }) => ({
            name: name.trim(),
            access,
            originalName,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save staff positions");
      const savedPositions: StaffPosition[] = (
        data.positions as Omit<StaffPosition, "id">[]
      ).map((position, index) => {
        const previousName =
          next[index]?.originalName ?? next[index]?.name ?? position.name;
        return {
          ...position,
          id: next[index]?.id ?? crypto.randomUUID(),
          assignedCount:
            staffPositions.find(
              (existing) =>
                existing.name.toLocaleLowerCase() === previousName.toLocaleLowerCase()
            )?.assignedCount ?? 0,
          originalName: position.name,
        };
      });
      setStaffPositions(savedPositions);
      savedStaffPositions.current = savedPositions.map(({ name, access }) => ({
        name,
        access,
      }));
      setToast({ msg: "Staff positions saved", tone: "success" });
      router.refresh();
    } catch (error) {
      setToast({
        msg: error instanceof Error ? error.message : "Could not save staff positions",
        tone: "error",
      });
    } finally {
      setSavingPositions(false);
    }
  }

  function addStaffPosition() {
    const name = newPosition.trim();
    if (!name) {
      setToast({ msg: "Enter a position name first.", tone: "error" });
      return;
    }
    if (
      staffPositions.some(
        (position) => position.name.toLocaleLowerCase() === name.toLocaleLowerCase()
      )
    ) {
      setToast({ msg: "That position already exists.", tone: "error" });
      return;
    }
    if (name.length > 80) {
      setToast({ msg: "Position names must be 80 characters or fewer.", tone: "error" });
      return;
    }
    setStaffPositions((current) => [
      ...current,
      { id: crypto.randomUUID(), name, access: "staff", assignedCount: 0 },
    ]);
    setNewPosition("");
  }

  async function changeOwnPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordChange.next !== passwordChange.confirm) {
      setToast({ msg: "New passwords do not match.", tone: "error" });
      return;
    }

    setChangingPassword(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          current_password: passwordChange.current,
          password: passwordChange.next,
          confirm_password: passwordChange.confirm,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not change password");
      setPasswordChange({ current: "", next: "", confirm: "" });
      setToast({ msg: "Password changed.", tone: "success" });
    } catch (error) {
      setToast({
        msg: error instanceof Error ? error.message : "Could not change password",
        tone: "error",
      });
    } finally {
      setChangingPassword(false);
    }
  }

  async function addRef(kind: "category" | "location") {
    const name = (kind === "category" ? newCategory : newLocation).trim();
    if (!name) {
      setToast({ msg: `Enter a ${kind} name first.`, tone: "error" });
      return;
    }

    setAdding(kind);
    try {
      const path = kind === "category" ? "categories" : "locations";
      const res = await fetch(`/api/refs/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add");

      const added: Ref = data.item;
      if (kind === "category") {
        setNewCategory("");
        setCategories((prev) =>
          [...prev, added].sort((a, b) => a.name.localeCompare(b.name))
        );
      } else {
        setNewLocation("");
        setLocations((prev) =>
          [...prev, added].sort((a, b) => a.name.localeCompare(b.name))
        );
      }
      setToast({ msg: `Added "${name}"`, tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setAdding(null);
    }
  }

  /**
   * Save a location's minimum shelf life.
   *
   * A blank clears the rule rather than storing 0, so "no rule" and "a rule of
   * zero days" stay the same thing in the database and there is one code path
   * for "this location has no minimum" instead of two that mean the same thing.
   */
  async function saveShelfLife(loc: Ref, raw: string) {
    setBusyId(loc.id);
    try {
      const res = await fetch("/api/refs/locations", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: loc.id,
          min_shelf_life_days: raw.trim() === "" ? null : raw,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");

      setLocations((prev) =>
        prev.map((l) =>
          l.id === loc.id
            ? { ...l, min_shelf_life_days: data.item.min_shelf_life_days }
            : l
        )
      );
      setToast({ msg: "Saved", tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  function requestRemoval(target: RemovalTarget) {
    setRemovalTarget(target);
    setRemovalReason("");
    setRemovalPassword("");
  }

  async function addSupplier() {
    const name = newSupplier.trim();
    if (!name) {
      setToast({ msg: "Enter a supplier name first.", tone: "error" });
      return;
    }

    setAdding("supplier");
    try {
      const res = await fetch("/api/refs/suppliers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not add");

      const added: Supplier = data.item;
      setNewSupplier("");
      setSuppliers((prev) =>
        [...prev, added].sort((a, b) => a.name.localeCompare(b.name))
      );
      setToast({ msg: `Added "${name}"`, tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setAdding(null);
    }
  }

  function cancelRemoval() {
    if (removing) return;
    setRemovalTarget(null);
    setRemovalReason("");
    setRemovalPassword("");
  }

  async function confirmRemoval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!removalTarget) return;
    if (!removalReason.trim() || !removalPassword) {
      setToast({ msg: "Enter a reason and your password to continue.", tone: "error" });
      return;
    }

    setRemoving(true);
    try {
      const path = removalTarget.kind === "category"
        ? "categories"
        : removalTarget.kind === "location"
          ? "locations"
          : "suppliers";
      const res = await fetch(`/api/refs/${path}/${removalTarget.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reason: removalReason,
          confirm_password: removalPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove");

      if (removalTarget.kind === "category") {
        setCategories((prev) => prev.filter((item) => item.id !== removalTarget.id));
      } else if (removalTarget.kind === "location") {
        setLocations((prev) => prev.filter((item) => item.id !== removalTarget.id));
      } else {
        setSuppliers((prev) => prev.filter((item) => item.id !== removalTarget.id));
      }
      setToast({ msg: `Removed "${removalTarget.name}"`, tone: "success" });
      setRemovalTarget(null);
      setRemovalReason("");
      setRemovalPassword("");
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setRemoving(false);
    }
  }

  function startEditSupplier(supplier: Supplier) {
    if (editingSupplierId === supplier.id) {
      setEditingSupplierId(null);
      return;
    }

    setEditingSupplierId(supplier.id);
    setSupplierForm({
      name: supplier.name,
      contact_name: supplier.contact_name ?? "",
      phone: supplier.phone ?? "",
      email: supplier.email ?? "",
    });
    // One expansion at a time: an edit form and an item list side by side in the
    // same row is more noise than either is worth.
    setSupplierItemsId(null);
  }

  async function saveSupplier(id: string) {
    setSavingSupplier(true);
    try {
      const res = await fetch(`/api/refs/suppliers/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(supplierForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save");

      const updated: Supplier = data.item;
      setSuppliers((prev) =>
        prev
          .map((s) => (s.id === updated.id ? updated : s))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setEditingSupplierId(null);
      setToast({ msg: `Saved "${updated.name}"`, tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setSavingSupplier(false);
    }
  }

  async function toggleSupplierItems(supplier: Supplier) {
    if (supplierItemsId === supplier.id) {
      setSupplierItemsId(null);
      return;
    }

    setSupplierItemsId(supplier.id);
    setSupplierItems([]);
    setSupplierItemsLoading(true);
    setEditingSupplierId(null);

    try {
      const res = await fetch(`/api/refs/suppliers/${supplier.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load items");
      setSupplierItems(data.items ?? []);
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      setSupplierItemsId(null);
    } finally {
      setSupplierItemsLoading(false);
    }
  }

  if (loading) return <Spinner label="Loading settings..." />;

  if (isAdmin !== true) {
    return (
      <Card className="space-y-2">
        <h1 className="deco-title text-3xl">Settings</h1>
        <p className="text-sm text-cocoa-500" role={error ? "alert" : undefined}>
          {error ?? "Admin access required"}
        </p>
      </Card>
    );
  }

  /* One list plus its add-box, reused for categories and locations. */
  function refList(
    kind: "category" | "location",
    title: string,
    hint: string,
    rows: Ref[],
    value: string,
    setValue: (v: string) => void
  ) {
    return (
      <Card>
        <h2 className="text-lg font-semibold text-cocoa-800">{title}</h2>
        <p className="mt-1 text-sm text-cocoa-500">{hint}</p>

        <div className="mt-4 flex gap-2">
          <input
            aria-label={`New ${kind} name`}
            className="input flex-1"
            value={value}
            placeholder={`New ${kind} name`}
            maxLength={60}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addRef(kind);
              }
            }}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={() => addRef(kind)}
            disabled={adding === kind}
          >
            {adding === kind ? "Adding..." : "Add"}
          </button>
        </div>

        <div className="mt-4">
          {rows.length === 0 ? (
            <Empty>No {kind}s yet.</Empty>
          ) : (
            <ul className="divide-y divide-cream-200">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <span className="text-sm font-medium text-cocoa-700">
                    {r.name}
                  </span>

                  <div className="flex items-center gap-2">
                    {/* Locations carry a minimum shelf life on arrival; categories
                        are just labels and have no equivalent rule, so the field
                        is shown for one list and not the other. */}
                    {kind === "location" && (
                      <label className="flex items-center gap-1.5 text-[11px] text-cocoa-400">
                        <span>min shelf life</span>
                        <input
                          className="input w-20 !py-1 text-center text-xs"
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={r.min_shelf_life_days ?? ""}
                          placeholder="none"
                          disabled={busyId === r.id}
                          onBlur={(e) => {
                            const next = e.target.value.trim();
                            const current =
                              r.min_shelf_life_days == null
                                ? ""
                                : String(r.min_shelf_life_days);
                            if (next === current) return;
                            saveShelfLife(r, next);
                          }}
                          aria-label={`Minimum shelf life on arrival for ${r.name}, in days`}
                        />
                        <span>days</span>
                      </label>
                    )}

                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => requestRemoval({ kind, id: r.id, name: r.name })}
                      disabled={busyId === r.id}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    );
  }

  // Which threshold the form is showing, and the bounds the API enforces for it.
  // Both come from matchThresholdBand so the form, the validator and the reader
  // cannot disagree — a range offered here that the route rejects would be a
  // setting the cafe never chose.
  const thresholdBand = matchThresholdBand(
    settings.face_engine === "sface" ? "sface" : "legacy"
  );
  const thresholdName = settings.face_engine === "sface" ? "SFace" : "original";
  const businessRecoveryDirty = ["business_name", "password_recovery_email"].some(
    (key) => settings[key] !== saved.current[key]
  );
  const expirySettingsDirty = ["expiry_warning_days"].some(
    (key) => settings[key] !== saved.current[key]
  );
  const tabPaths: Record<SettingsTab, string> = {
    email: "M3 5h18v14H3z M3 6l9 7 9-7",
    staff: "M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
    storage: "M3 21h18 M5 21V7l7-4 7 4v14 M9 21v-6h6v6 M9 9h.01 M15 9h.01",
    suppliers: "M3 7h11v11H3z M14 11h4l3 3v4h-7z M7 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M17 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
    general: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.6 2.77-.08-.02a1.7 1.7 0 0 0-1.82.62l-.05.07h-3.2l-.03-.08a1.7 1.7 0 0 0-1.43-1.13h-.09L9.9 16.4l.05-.08a1.7 1.7 0 0 0-.28-1.83l-.06-.06 1.6-2.77.09.02a1.7 1.7 0 0 0 1.82-.62l.05-.07h3.2l.03.08a1.7 1.7 0 0 0 1.43 1.13h.09z",
  };

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={pendingToggle !== null}
        title={pendingToggle?.title ?? ""}
        message={pendingToggle?.message ?? ""}
        confirmLabel={pendingToggle?.confirmLabel ?? "Continue"}
        tone="warning"
        onCancel={() => setPendingToggle(null)}
        onConfirm={() => {
          const action = pendingToggle?.onConfirm;
          setPendingToggle(null);
          action?.();
        }}
      />
      <div>
        <h1 className="deco-title text-3xl">Settings</h1>
      </div>

      {error && <div className="card p-4 text-sm text-terracotta-700">{error}</div>}

      <nav
        className="flex gap-2 overflow-x-auto rounded-2xl border border-cream-200 bg-cream-50 p-2"
        role="tablist"
        aria-label="Settings sections"
      >
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`settings-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`inline-flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
              activeTab === tab.id
                ? "bg-cocoa-800 text-white shadow-warm"
                : "text-cocoa-600 hover:bg-cream-100"
            }`}
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={tabPaths[tab.id]} />
            </svg>
            {tab.label}
          </button>
        ))}
      </nav>

      <section
        id="settings-panel-email"
        role="tabpanel"
        aria-labelledby="settings-tab-email"
        hidden={activeTab !== "email"}
      >
        <EmailNotifications view="settings" />
      </section>

      <section
        id="settings-panel-staff"
        role="tabpanel"
        aria-labelledby="settings-tab-staff"
        hidden={activeTab !== "staff"}
        className="space-y-5"
      >
        <Card>
          <h2 className="text-lg font-semibold text-cocoa-800">Staff &amp; session access</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {([
              ["admin_session_timeout_minutes", "Admin session timeout"],
              ["staff_session_timeout_minutes", "Staff session timeout"],
            ] as const).map(([key, label]) => (
              <div key={key}>
                <label className="label" htmlFor={key}>{label}</label>
                <input
                  id={key}
                  type="number"
                  className="input"
                  min={1}
                  max={480}
                  value={settings[key]}
                  disabled={saving}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, [key]: event.target.value }))
                  }
                />
                <p className="mt-1 text-xs text-cocoa-400">
                  Sign out after this many idle minutes (1–480).
                </p>
              </div>
            ))}
            <div>
              <label className="label" htmlFor="face_duty_hours">
                Staff face-check interval
              </label>
              <input
                id="face_duty_hours"
                type="number"
                className="input"
                min={1}
                max={24}
                value={settings.face_duty_hours}
                disabled={saving}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, face_duty_hours: event.target.value }))
                }
              />
              <p className="mt-1 text-xs text-cocoa-400">
                Require another face check after this many hours per duty (1–24).
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={
                saving ||
                !STAFF_ACCESS_SETTING_KEYS.some(
                  (key) => settings[key] !== saved.current[key]
                )
              }
              onClick={() =>
                void saveSpecificGeneralSettings(
                  [...STAFF_ACCESS_SETTING_KEYS],
                  "Staff and session access settings saved"
                )
              }
            >
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </Card>
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-cocoa-800">Positions &amp; access profiles</h2>
              <p className="mt-1 max-w-2xl text-sm text-cocoa-500">
                Add job positions and choose what their accounts can access. Staff access is
                limited to team pages; full admin access unlocks every management page and action.
              </p>
            </div>
          </div>

          <div className="mt-4 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="min-w-0">
              <label className="label" htmlFor="new-staff-position">Position name</label>
              <input
                id="new-staff-position"
                className="input w-full min-w-0"
                value={newPosition}
                placeholder="For example, Barista or Manager"
                maxLength={80}
                onChange={(event) => setNewPosition(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addStaffPosition();
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="btn-ghost whitespace-nowrap"
              disabled={
                savingPositions ||
                !newPosition.trim() ||
                newPosition.trim().length > 80 ||
                staffPositions.some(
                  (position) =>
                    position.name.toLocaleLowerCase() ===
                    newPosition.trim().toLocaleLowerCase()
                )
              }
              onClick={addStaffPosition}
            >
              Add position
            </button>
          </div>

          <div className="mt-4 min-w-0 space-y-3">
            {staffPositions.map((position, index) => (
              <div
                key={position.id}
                className="grid min-w-0 gap-3 rounded-xl border border-cream-200 p-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(14rem,1fr)_auto] lg:items-start"
              >
                <div className="min-w-0">
                  <label className="label" htmlFor={`staff-position-${index}`}>Position name</label>
                  <input
                    id={`staff-position-${index}`}
                    className="input w-full min-w-0"
                    value={position.name}
                    maxLength={80}
                    disabled={savingPositions}
                    onChange={(event) =>
                      setStaffPositions((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, name: event.target.value } : item
                        )
                      )
                    }
                  />
                  {Boolean(position.assignedCount) && (
                    <p className="mt-1 text-xs text-cocoa-400">
                      Assigned to {position.assignedCount} account{position.assignedCount === 1 ? "" : "s"}.
                      Renaming updates assigned accounts.
                    </p>
                  )}
                </div>
                <div className="min-w-0">
                  <label className="label" htmlFor={`staff-access-${index}`}>Access profile</label>
                  <select
                    id={`staff-access-${index}`}
                    className="input w-full min-w-0"
                    value={position.access}
                    disabled={savingPositions}
                    onChange={(event) =>
                      setStaffPositions((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, access: event.target.value as StaffPosition["access"] }
                            : item
                        )
                      )
                    }
                  >
                    <option value="staff">Staff — team pages only</option>
                    <option value="admin">Full admin — all pages and actions</option>
                  </select>
                </div>
                <div className="lg:pt-[1.375rem]">
                  <button
                    type="button"
                    className="btn-danger whitespace-nowrap"
                    disabled={savingPositions || Boolean(position.assignedCount)}
                    onClick={() =>
                      setStaffPositions((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              className="btn-primary"
              disabled={
                savingPositions ||
                (staffPositions.length === savedStaffPositions.current.length &&
                  staffPositions.every(
                    (position, index) =>
                      position.name.trim() === savedStaffPositions.current[index]?.name &&
                      position.access === savedStaffPositions.current[index]?.access
                  ))
              }
              onClick={() => void saveStaffPositions(staffPositions)}
            >
              {savingPositions ? "Saving positions..." : "Save positions"}
            </button>
          </div>
        </Card>
      </section>

      <section
        id="settings-panel-general"
        role="tabpanel"
        aria-labelledby="settings-tab-general"
        hidden={activeTab !== "general"}
        className="space-y-5"
      >
        <Card>
          <h2 className="text-lg font-semibold text-cocoa-800">Admin display name</h2>
          <p className="mt-1 text-sm text-cocoa-500">
            This name appears in the workspace and activity records. It defaults to Admin when no name is available.
          </p>
          <div className="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <label className="label" htmlFor="admin-display-name">Name</label>
              <input
                id="admin-display-name"
                className="input"
                value={adminName}
                placeholder="Admin"
                maxLength={80}
                disabled={savingAdminName}
                onChange={(event) => setAdminName(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={savingAdminName || !adminName.trim() || adminName.trim() === savedAdminName}
              onClick={() => void saveAdminName()}
            >
              {savingAdminName ? "Saving..." : "Save name"}
            </button>
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold text-cocoa-800">Business and recovery details</h2>
            {businessRecoveryDirty && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void saveSpecificGeneralSettings(["business_name", "password_recovery_email"], "Business details saved")}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            )}
          </div>
          <div className="mt-4 max-w-sm">
            <label className="label" htmlFor="business_name">Business name</label>
            <input
              id="business_name"
              className="input"
              value={settings.business_name ?? ""}
              maxLength={120}
              disabled={saving}
              onChange={(event) =>
                setSettings((prev) => ({ ...prev, business_name: event.target.value }))
              }
            />
          </div>
          <div className="mt-4 max-w-sm">
            <label className="label" htmlFor="password_recovery_email">
              Legacy owner recovery email
            </label>
            <input
              ref={recoveryEmailInputRef}
              id="password_recovery_email"
              type="email"
              autoComplete="email"
              className={`input ${
                focusRecoveryEmail || !String(settings.password_recovery_email ?? "").trim()
                  ? "border-terracotta-500 bg-terracotta-50 focus:border-terracotta-500 focus:ring-terracotta-200 animate-[shake_0.45s_ease-in-out_4]"
                  : ""
              }`}
              value={settings.password_recovery_email ?? ""}
              maxLength={254}
              disabled={saving}
              placeholder="owner@example.com"
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  password_recovery_email: event.target.value,
                }))
              }
            />
            <p className="mt-1 text-xs text-cocoa-400">
              Fallback for existing admin accounts without an individual recovery email. New admin
              accounts use the address saved for them in Staff Accounts. Configure a sending account
              in Settings → Email.
            </p>
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-lg font-semibold text-cocoa-800">Expiry alerts</h2>
            {expirySettingsDirty && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void saveSpecificGeneralSettings(["expiry_warning_days"], "Expiry alert saved")}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            )}
          </div>
          <div className="mt-4 max-w-lg">
            <label className="label" htmlFor="expiry_warning_preset">
              Expiry warning window
            </label>
            <select
              id="expiry_warning_preset"
              className="input"
              value={expiryPreset}
              disabled={saving}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value !== "7" &&
                  value !== "15" &&
                  value !== "30" &&
                  value !== "custom"
                ) {
                  return;
                }
                setExpiryPreset(value);
                setSettings((prev) => ({
                  ...prev,
                  expiry_warning_days: value === "custom" ? "" : value,
                }));
              }}
            >
              <option value="7">One week (7 days)</option>
              <option value="15">Half a month (15 days)</option>
              <option value="30">One month (30 days)</option>
              <option value="custom">Custom days</option>
            </select>
            {expiryPreset === "custom" && (
              <input
                aria-label="Custom expiry warning days"
                type="number"
                className="input mt-2"
                min={1}
                max={365}
                step={1}
                required
                value={settings.expiry_warning_days}
                disabled={saving}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    expiry_warning_days: event.target.value,
                  }))
                }
              />
            )}
            <p className="mt-1 text-xs text-cocoa-400">
              Raise a near-expiry alert this many days before an item expires (1–365).
            </p>
          </div>
        </Card>

        <Card>
          <h2 className="text-lg font-semibold text-cocoa-800">Change your password</h2>
          <p className="mt-1 text-sm text-cocoa-500">
            Confirm your current password before choosing a new one.
          </p>
          <form onSubmit={changeOwnPassword} className="mt-4 grid max-w-lg gap-3">
            <div>
              <label className="label" htmlFor="current-admin-password">Current password</label>
              <input
                id="current-admin-password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={passwordChange.current}
                disabled={changingPassword}
                onChange={(event) =>
                  setPasswordChange((prev) => ({ ...prev, current: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="new-admin-password">New password</label>
              <input
                id="new-admin-password"
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={passwordChange.next}
                disabled={changingPassword}
                onChange={(event) =>
                  setPasswordChange((prev) => ({ ...prev, next: event.target.value }))
                }
              />
            </div>
            <div>
              <label className="label" htmlFor="confirm-admin-password">
                Confirm new password
              </label>
              <input
                id="confirm-admin-password"
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={passwordChange.confirm}
                disabled={changingPassword}
                onChange={(event) =>
                  setPasswordChange((prev) => ({ ...prev, confirm: event.target.value }))
                }
              />
            </div>
            <button type="submit" className="btn-primary justify-self-start" disabled={changingPassword}>
              {changingPassword ? "Changing..." : "Change password"}
            </button>
          </form>
        </Card>
      </section>

      <div className="space-y-5" hidden={activeTab !== "staff"}>
        <Card>
          <h2 className="text-lg font-semibold text-cocoa-800">Staff login face check</h2>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-cocoa-800">Staff login face check</p>
            <p className="mt-1 text-xs leading-relaxed text-cocoa-500">
              When on, staff complete the automatic face scan, including the blink, before
              signing in the first time and again after the face-check interval above.
              A successful face check covers repeat sign-ins during that duty window.
              Face++ verifies the scan; MediaPipe detects the blink in the live camera.
              When off, staff sign in with their username or barcode and password without
              this login scan.
            </p>
          </div>
          <button
            className={settings.face_login_enabled === "1" ? "btn-ghost" : "btn-primary"}
            disabled={saving}
            onClick={() =>
              askToDisableToggle(
                "face_login_enabled",
                "staff face check",
                "This disables the live face scan for staff sign-in. Staff can then sign in with a username or barcode and password without the required face check and blink verification.",
                settings.face_login_enabled === "1" ? "0" : "1"
              )
            }
          >
            {settings.face_login_enabled === "1" ? "Turn off" : "Turn on"}
          </button>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={`mt-3 rounded-xl px-3.5 py-2.5 text-xs font-medium ${
            settings.face_login_enabled === "1"
              ? "bg-sage-50 text-sage-700"
              : "bg-cream-100 text-cocoa-600"
          }`}
        >
          {settings.face_login_enabled === "1"
            ? `On: the Face++ and blink-checked face scan is required once every ${settings.face_duty_hours || "9"} hours.`
            : "Off: staff can sign in with their password without a face scan."}
        </div>

        <p className="mt-3 text-xs text-cocoa-400">
          On a phone opening this over plain http on the cafe Wi-Fi, the browser
          blocks the camera. &ldquo;Take a photo instead&rdquo; still works there
          and needs no camera permission.
        </p>

        <div className="mt-4 max-w-sm">
          <label className="label" htmlFor={thresholdBand.setting}>
            Match threshold ({thresholdName})
          </label>
          <input
            id={thresholdBand.setting}
            type="number"
            step="0.001"
            className="input"
            min={thresholdBand.min}
            max={thresholdBand.max}
            placeholder={String(thresholdBand.fallback)}
            value={settings[thresholdBand.setting] ?? ""}
            disabled={saving}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, [thresholdBand.setting]: e.target.value }))
            }
            onBlur={(e) => {
              const v = e.target.value;
              if (v !== "" && v !== saved.current[thresholdBand.setting]) {
                saveField(thresholdBand.setting, v);
              }
            }}
          />
        </div>

        {/*
          The face model.

          Two engines that cannot see each other's vectors, so this is not a
          preference — switching it means every enrolled person has to be
          re-photographed before they can pass a check. That is said plainly here
          rather than discovered by a barista at the start of a shift, and the
          button is deliberately the quieter style.
        */}
        <div className="mt-4 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3">
          <p className="text-sm font-bold text-cocoa-800">Face model</p>
          <p className="mt-1 text-xs leading-snug text-cocoa-500">
            {settings.face_engine === "sface" ? "SFace" : "Original"}
          </p>
          <button
            type="button"
            className="btn-ghost mt-2.5 !py-1.5 text-xs"
            disabled={saving}
            onClick={() =>
              saveField("face_engine", settings.face_engine === "sface" ? "legacy" : "sface")
            }
          >
            {settings.face_engine === "sface" ? "Go back to the original model" : "Switch to the newer model"}
          </button>
        </div>
      </Card>

      {/*
        ID verification.

        Its own card rather than a third switch in the face card above, because it
        is a different kind of thing: that one asks a live person to prove they
        are present, and this one records a document an admin looked at. An admin
        deciding whether to turn either on is answering a different question
        about each.

        The switch wording is the load-bearing part. Turning this on does not
        verify anyone — it makes an account that was never checked unable to sign
        in. Getting that backwards in the label would be how a cafe locks its
        whole floor out of the app.
      */}
      <Card>
        <h2 className="text-lg font-semibold text-cocoa-800">ID verification</h2>

        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-cocoa-800">
                Require a checked ID before sign-in
              </p>
            </div>
            <button
              className={
                settings.id_verification_required === "1" ? "btn-ghost" : "btn-primary"
              }
              disabled={saving}
              onClick={() =>
                askToDisableToggle(
                  "id_verification_required",
                  "ID verification",
                  "This removes the requirement that staff present a checked ID before sign-in. Accounts with no verified ID will be allowed to sign in until you turn the rule back on.",
                  settings.id_verification_required === "1" ? "0" : "1"
                )
              }
            >
              {settings.id_verification_required === "1" ? "Turn off" : "Turn on"}
            </button>
          </div>

        </div>

      </Card>
      </div>

      <section
        id="settings-panel-storage"
        role="tabpanel"
        aria-labelledby="settings-tab-storage"
        className="space-y-5"
        hidden={activeTab !== "storage"}
      >
      {refList(
        "category",
        "Item categories",
        "How ingredients are grouped on the inventory page.",
        categories,
        newCategory,
        setNewCategory
      )}

      {refList(
        "location",
        "Storage locations",
        "Where stock is kept — chiller, dry storage, and so on.",
        locations,
        newLocation,
        setNewLocation
      )}
      </section>

      {/* ---------- suppliers ---------- */}
      <section
        id="settings-panel-suppliers"
        role="tabpanel"
        aria-labelledby="settings-tab-suppliers"
        hidden={activeTab !== "suppliers"}
      >
      <Card>
        <h2 className="text-lg font-semibold text-cocoa-800">Suppliers</h2>
        <p className="mt-1 text-sm text-cocoa-500">
          Vendors that supply ingredients. Keep their contact details here, see
          the items each one supplies, or assign a supplier to an item from the
          inventory page. A restock can also record who delivered it.
        </p>

        <div className="mt-4 flex gap-2">
          <input
            aria-label="New supplier name"
            className="input flex-1"
            value={newSupplier}
            placeholder="New supplier name"
            maxLength={120}
            onChange={(e) => setNewSupplier(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addSupplier();
              }
            }}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={addSupplier}
            disabled={adding === "supplier"}
          >
            {adding === "supplier" ? "Adding..." : "Add"}
          </button>
        </div>

        <div className="mt-4">
          {suppliers.length === 0 ? (
            <Empty>No suppliers yet.</Empty>
          ) : (
            <ul className="divide-y divide-cream-200">
              {suppliers.map((s) => {
                const editing = editingSupplierId === s.id;
                const showingItems = supplierItemsId === s.id;

                return (
                  <li key={s.id} className="py-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-cocoa-700">
                          {s.name}
                        </div>
                        <div className="text-xs text-cocoa-400">
                          {[s.contact_name, s.phone, s.email]
                            .filter(Boolean)
                            .join(" · ") || "No contact details yet"}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          className="btn-ghost !px-3 !py-1.5 text-xs"
                          onClick={() => startEditSupplier(s)}
                          disabled={busyId === s.id}
                        >
                          {editing ? "Close" : "Edit"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost !px-3 !py-1.5 text-xs"
                          onClick={() => toggleSupplierItems(s)}
                          disabled={busyId === s.id}
                        >
                          {showingItems ? "Hide items" : "Items"}
                        </button>
                        <button
                          type="button"
                          className="btn-danger !px-3 !py-1.5 text-xs"
                          onClick={() =>
                            requestRemoval({ kind: "supplier", id: s.id, name: s.name })
                          }
                          disabled={busyId === s.id}
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    {editing && (
                      <div className="mt-2 grid gap-2 rounded-xl bg-cream-50 p-3 sm:grid-cols-2">
                        <div>
                          <label className="label" htmlFor={`sup-name-${s.id}`}>
                            Name
                          </label>
                          <input
                            id={`sup-name-${s.id}`}
                            className="input"
                            maxLength={120}
                            value={supplierForm.name}
                            onChange={(e) =>
                              setSupplierForm((f) => ({
                                ...f,
                                name: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`sup-contact-${s.id}`}>
                            Contact person
                          </label>
                          <input
                            id={`sup-contact-${s.id}`}
                            className="input"
                            maxLength={120}
                            value={supplierForm.contact_name}
                            onChange={(e) =>
                              setSupplierForm((f) => ({
                                ...f,
                                contact_name: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`sup-phone-${s.id}`}>
                            Phone
                          </label>
                          <input
                            id={`sup-phone-${s.id}`}
                            className="input"
                            type="tel"
                            maxLength={40}
                            value={supplierForm.phone}
                            onChange={(e) =>
                              setSupplierForm((f) => ({
                                ...f,
                                phone: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div>
                          <label className="label" htmlFor={`sup-email-${s.id}`}>
                            Email
                          </label>
                          <input
                            id={`sup-email-${s.id}`}
                            className="input"
                            type="email"
                            maxLength={120}
                            value={supplierForm.email}
                            onChange={(e) =>
                              setSupplierForm((f) => ({
                                ...f,
                                email: e.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="flex justify-end gap-2 sm:col-span-2">
                          <button
                            className="btn-ghost !px-3 !py-1.5 text-xs"
                            onClick={() => setEditingSupplierId(null)}
                            disabled={savingSupplier}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="btn-primary !px-3 !py-1.5 text-xs"
                            onClick={() => saveSupplier(s.id)}
                            disabled={savingSupplier || !supplierForm.name.trim()}
                          >
                            {savingSupplier ? "Saving..." : "Save"}
                          </button>
                        </div>
                      </div>
                    )}

                    {showingItems && (
                      <div className="mt-2 rounded-xl bg-cream-50 p-3">
                        {supplierItemsLoading ? (
                          <p className="text-xs text-cocoa-400">Loading items...</p>
                        ) : supplierItems.length === 0 ? (
                          <p className="text-xs text-cocoa-400">No linked items.</p>
                        ) : (
                          <ul className="space-y-1">
                            {supplierItems.map((item) => (
                              <li
                                key={item.id}
                                className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs"
                              >
                                <span className="min-w-0 truncate text-cocoa-700">
                                  {item.name}{" "}
                                  <span className="font-mono text-cocoa-300">
                                    {item.sku}
                                  </span>
                                </span>
                                <span className="shrink-0 tabular-nums text-cocoa-500">
                                  {Number(item.quantity)} {item.unit}
                                  {Number(item.quantity) <=
                                    Number(item.low_stock_threshold) && (
                                    <span className="ml-1.5 text-ochre-700">
                                      reorder
                                    </span>
                                  )}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
      </section>

      {removalTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-cocoa-950/50 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) cancelRemoval();
          }}
        >
          <form
            className="card w-full max-w-lg space-y-4 p-5"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-setting-title"
            onSubmit={confirmRemoval}
          >
            <div>
              <h2 id="remove-setting-title" className="text-lg font-bold text-cocoa-900">
                Remove {removalTarget.name}?
              </h2>
              <p className="mt-1 text-sm text-cocoa-500">
                Give a reason and confirm with your admin password. This action is recorded
                in the audit history.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="removal-reason">Reason for removal</label>
              <textarea
                id="removal-reason"
                className="input min-h-24 resize-y"
                rows={3}
                maxLength={500}
                required
                value={removalReason}
                disabled={removing}
                onChange={(event) => setRemovalReason(event.target.value)}
                placeholder="Why is this record being removed?"
              />
            </div>
            <div>
              <label className="label" htmlFor="removal-password">Admin password</label>
              <input
                id="removal-password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={removalPassword}
                disabled={removing}
                onChange={(event) => setRemovalPassword(event.target.value)}
                placeholder="Enter your password"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={cancelRemoval}
                disabled={removing}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-danger"
                disabled={removing || !removalReason.trim() || !removalPassword}
              >
                {removing ? "Removing..." : "Confirm removal"}
              </button>
            </div>
          </form>
        </div>
      )}

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
