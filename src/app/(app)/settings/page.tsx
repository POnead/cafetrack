"use client";

/**
 * Admin settings: the tunable company policy, plus the two reference lists
 * (item categories and storage locations).
 *
 * The spec asks for admins to "manage company settings: item categories,
 * storage locations, alert thresholds" and to "configure low-stock thresholds
 * and expiration warning periods" — that is what this page is for.
 *
 * Note the threshold here is the *global* policy (how long before expiry an
 * item warns, how long a session lasts). The per-item low-stock threshold lives
 * on the item itself and is edited on the inventory page, because it depends
 * on what the item is.
 */
import { useEffect, useRef, useState } from "react";
import { Card, Spinner, Toast, Empty } from "@/components/ui";
import { matchThresholdBand } from "@/lib/face";
import {
  DEFAULT_ID_MATCH_THRESHOLD,
  MAX_ID_MATCH_THRESHOLD,
  MIN_ID_MATCH_THRESHOLD,
} from "@/lib/id-verification/local";

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
type Tone = "info" | "error" | "success";

const NUMERIC_FIELDS = [
  {
    key: "expiry_warning_days",
    label: "Expiry warning window",
    hint: "Days before expiry that an item starts raising a near-expiry alert.",
    min: 1,
    max: 365,
  },
  {
    key: "session_timeout_minutes",
    label: "Session timeout",
    hint: "Minutes of inactivity before a session signs itself out.",
    min: 1,
    max: 480,
  },
] as const;

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<Ref[]>([]);
  const [locations, setLocations] = useState<Ref[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: Tone } | null>(null);

  const [newCategory, setNewCategory] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newSupplier, setNewSupplier] = useState("");
  const [adding, setAdding] = useState<"category" | "location" | "supplier" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      const [s, c, l, sup] = await Promise.all([
        fetch("/api/settings").then((r) => r.json()),
        fetch("/api/refs/categories").then((r) => r.json()),
        fetch("/api/refs/locations").then((r) => r.json()),
        fetch("/api/refs/suppliers").then((r) => r.json()),
      ]);

      if (s.error) throw new Error(s.error);

      setSettings(s.settings ?? {});
      saved.current = { ...(s.settings ?? {}) };
      setCategories(c.items ?? []);
      setLocations(l.items ?? []);
      setSuppliers(sup.items ?? []);
      setError(null);
    } catch (e: any) {
      setError(e.message || "Could not load settings");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setToast({ msg: "Saved", tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
      // Re-read so the field never shows a value the database rejected.
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function addRef(kind: "category" | "location") {
    const name = (kind === "category" ? newCategory : newLocation).trim();
    if (!name) return;

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

  async function removeRef(kind: "category" | "location", ref: Ref) {
    setBusyId(ref.id);
    try {
      const path = kind === "category" ? "categories" : "locations";
      const res = await fetch(`/api/refs/${path}/${ref.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove");

      if (kind === "category") {
        setCategories((prev) => prev.filter((c) => c.id !== ref.id));
      } else {
        setLocations((prev) => prev.filter((l) => l.id !== ref.id));
      }
      setToast({ msg: `Removed "${ref.name}"`, tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function addSupplier() {
    const name = newSupplier.trim();
    if (!name) return;

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

  async function removeSupplier(supplier: Supplier) {
    setBusyId(supplier.id);
    try {
      const res = await fetch(`/api/refs/suppliers/${supplier.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove");

      setSuppliers((prev) => prev.filter((s) => s.id !== supplier.id));
      setToast({ msg: `Removed "${supplier.name}"`, tone: "success" });
    } catch (e: any) {
      setToast({ msg: e.message, tone: "error" });
    } finally {
      setBusyId(null);
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
              if (e.key === "Enter") addRef(kind);
            }}
          />
          <button
            className="btn-primary"
            onClick={() => addRef(kind)}
            disabled={adding === kind || !value.trim()}
          >
            Add
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
                      className="btn-danger"
                      onClick={() => removeRef(kind, r)}
                      disabled={busyId === r.id}
                    >
                      {busyId === r.id ? "Removing..." : "Remove"}
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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="deco-title text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-cocoa-500">
          Company-wide policy. Per-item low-stock thresholds are set on each item.
        </p>
      </div>

      {error && <div className="card p-4 text-sm text-terracotta-700">{error}</div>}

      {/*
        The Email page is the only place the `email_enabled` switch exists. It
        lived under "User Management" in the nav, which is where nobody looks
        for a setting that is about alerts rather than about users. Link from
        here too, so it is findable from both words people use — settings, or
        email.
      */}
      <Card>
        <h2 className="text-lg font-semibold text-cocoa-800">Email notifications</h2>
        <p className="mt-1 text-sm text-cocoa-500">
          Who gets told when stock runs low or expires, through which sending
          account, and how the test and retry controls confirm it is working.
          Everything is configured on its own page.
        </p>
        <p className="mt-3">
          <a href="/email" className="text-sm font-medium text-ochre-700 underline">
            Set up and test email notifications
          </a>
        </p>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-cocoa-800">
          Alerts &amp; sessions
        </h2>
        <p className="mt-1 text-sm text-cocoa-500">
          Applied across the whole system. Changes take effect immediately.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {NUMERIC_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="label" htmlFor={f.key}>
                {f.label}
              </label>
              <input
                id={f.key}
                type="number"
                className="input"
                min={f.min}
                max={f.max}
                value={settings[f.key] ?? ""}
                disabled={saving}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
                onBlur={(e) => {
                  const v = e.target.value;
                  // Only write on a real change, so blurring an untouched
                  // field does not fire a pointless request. The comparison is
                  // against what the database holds, not what the field shows —
                  // see `saved` above.
                  if (v !== "" && v !== saved.current[f.key]) saveField(f.key, v);
                }}
              />
              <p className="mt-1 text-xs text-cocoa-400">
                {f.hint} ({f.min}&ndash;{f.max})
              </p>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="business_name">
            Business name
          </label>
          <input
            id="business_name"
            className="input max-w-sm"
            value={settings.business_name ?? ""}
            maxLength={120}
            disabled={saving}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, business_name: e.target.value }))
            }
            onBlur={(e) => {
              const v = e.target.value;
              if (v !== (saved.current.business_name ?? "")) saveField("business_name", v);
            }}
          />
          <p className="mt-1 text-xs text-cocoa-400">
            Shown on printed reports and labels.
          </p>
        </div>
      </Card>

      {/*
        Face verification.

        Two switches in one card, but deliberately described as two separate
        decisions — they are not two views of one thing. One asks for a face at
        the start of a shift, the other changes how someone gets in at all. An
        admin should be able to tell them apart without reading any code.

        Both are off in every fresh database, so nothing here disturbs the login
        the cafe uses today until it is deliberately switched on.
      */}
      <Card>
        <h2 className="text-lg font-semibold text-cocoa-800">Face verification</h2>
        <p className="mt-1 text-sm text-cocoa-500">
          Uses the camera on the device to confirm who someone is. Staff need a
          reference photo added from Staff Accounts before either one can work.
        </p>

        <div className="mt-4 space-y-3">
          {(
            [
              {
                key: "face_verification_enabled",
                title: "Duty face check",
                on: "Staff confirm their face once per duty before they can move stock. One check covers the duty length set below.",
                off: "Enrol everyone's photo from Staff Accounts first — this holds every member of staff at the camera screen.",
              },
              {
                key: "face_login_enabled",
                title: "Sign in with a face",
                on: "Staff can scan their badge and confirm their face instead of typing a password. Admins still use a password.",
                off: "Staff without a reference photo cannot use this, so enrol them from Staff Accounts first. Password sign-in keeps working either way.",
              },
              {
                key: "face_require_profile_angles",
                title: "Turned-head checks",
                on: "A check asks for the straight-on photo and both turned-head photos. A printed portrait cannot produce the turned ones, which is what makes it fail.",
                off: "Only the straight-on photo is required. The turned-head photos stay on file as reference photographs, and turning this back on needs no re-enrolment.",
              },
            ] as const
          ).map((t) => {
            const on = settings[t.key] === "1";
            return (
              <div
                key={t.key}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-cocoa-800">{t.title}</p>
                  <p className="mt-1 text-xs leading-snug text-cocoa-500">
                    {on ? t.on : t.off}
                  </p>
                </div>
                <button
                  className={on ? "btn-ghost" : "btn-primary"}
                  disabled={saving}
                  onClick={() => saveField(t.key, on ? "0" : "1")}
                >
                  {on ? "Turn off" : "Turn on"}
                </button>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-xs text-cocoa-400">
          On a phone opening this over plain http on the cafe Wi-Fi, the browser
          blocks the camera. &ldquo;Take a photo instead&rdquo; still works there
          and needs no camera permission.
        </p>

        {/*
          The two numbers the check actually reads.

          They belong in this card rather than in Alerts & sessions: the duty
          length is how long one face check covers, and the threshold is how
          close two faces have to be. Both were settable through the API before
          this form existed, which meant an admin reading this page was told
          about values they could not see.

          The threshold field follows the engine in use, because the two engines
          do not share a scale — one field with the other model's bounds would
          let an admin save a number that means "accept nobody" on the model
          actually running.
        */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="face_duty_hours">
              Duty length
            </label>
            <input
              id="face_duty_hours"
              type="number"
              className="input"
              min={1}
              max={24}
              value={settings.face_duty_hours ?? ""}
              disabled={saving}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, face_duty_hours: e.target.value }))
              }
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== "" && v !== saved.current.face_duty_hours) {
                  saveField("face_duty_hours", v);
                }
              }}
            />
            <p className="mt-1 text-xs text-cocoa-400">
              Hours one check covers before the next one is due (1&ndash;24).
            </p>
          </div>

          <div>
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
            <p className="mt-1 text-xs text-cocoa-400">
              How far apart two faces may read and still count as the same person
              ({thresholdBand.min}&ndash;{thresholdBand.max}). Lower is stricter.
              The other model keeps its own value &mdash; switching does not carry
              this one across.
            </p>
          </div>
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
            {settings.face_engine === "sface"
              ? "Using the newer model (SFace). It separates people far better than the original, and recognises angled and partly covered faces."
              : "Using the original model. Enrolments made with it cannot be checked by the newer model, or the other way round."}
          </p>
          <p className="mt-1.5 text-xs leading-snug text-terracotta-700">
            Switching means everyone must have their photo taken again before they
            can pass a face check. Until then they will be told their face needs
            re-enrolling, and a manager can let them through with an override.
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
        <p className="mt-1 text-sm text-cocoa-500">
          Photograph a staff member&rsquo;s government ID and a photo of them from
          Staff Accounts. The app compares the face on the card with their face
          and shows you what it found — you still decide whether to approve it.
        </p>

        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-cream-200 bg-cream-50 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-cocoa-800">
                Require a checked ID before sign-in
              </p>
              <p className="mt-1 text-xs leading-snug text-cocoa-500">
                {settings.id_verification_required === "1"
                  ? "A staff account whose ID has been attached but not approved cannot sign in. Accounts with no ID attached are unaffected, and admins are never held up."
                  : "Off. You can attach and check IDs as you like, but a staff account can sign in before you have looked at its ID."}
              </p>
            </div>
            <button
              className={
                settings.id_verification_required === "1" ? "btn-ghost" : "btn-primary"
              }
              disabled={saving}
              onClick={() =>
                saveField(
                  "id_verification_required",
                  settings.id_verification_required === "1" ? "0" : "1"
                )
              }
            >
              {settings.id_verification_required === "1" ? "Turn off" : "Turn on"}
            </button>
          </div>

          {/*
            The ID portrait threshold.

            API-only until now, which meant the one number that decides whether
            the face comparison says anything was invisible to the admin who has
            to act on it. It is not the same scale as the face-match threshold
            above, and it belongs to SFace regardless of which face model is in
            use for sign-in — see the note in lib/id-verification/local.ts.
          */}
          <div>
            <label className="label" htmlFor="id_face_match_threshold">
              Portrait match threshold
            </label>
            <input
              id="id_face_match_threshold"
              type="number"
              step="0.001"
              className="input"
              min={MIN_ID_MATCH_THRESHOLD}
              max={MAX_ID_MATCH_THRESHOLD}
              placeholder={String(DEFAULT_ID_MATCH_THRESHOLD)}
              value={settings.id_face_match_threshold ?? ""}
              disabled={saving}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  id_face_match_threshold: e.target.value,
                }))
              }
              onBlur={(e) => {
                const v = e.target.value;
                if (v !== "" && v !== saved.current.id_face_match_threshold) {
                  saveField("id_face_match_threshold", v);
                }
              }}
            />
            <p className="mt-1 text-xs text-cocoa-400">
              How far apart the portrait on the card and the applicant&rsquo;s photo may
              read and still count as the same face ({MIN_ID_MATCH_THRESHOLD}&ndash;
              {MAX_ID_MATCH_THRESHOLD}). Lower is stricter. This check has its own
              model, so the face-model switch above does not change it.
            </p>
          </div>
        </div>

        <p className="mt-3 text-xs leading-snug text-cocoa-400">
          Turn this on only after you have attached IDs for the staff you already
          have — it is a record-keeping switch, not a way to verify anyone. The
          app can compare faces and spot an obviously doctored image; whether a
          Philippine ID is genuine is not something any tool can answer, so the
          approval is always yours.
        </p>
      </Card>

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

      {/* ---------- suppliers ---------- */}
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
              if (e.key === "Enter") addSupplier();
            }}
          />
          <button
            className="btn-primary"
            onClick={addSupplier}
            disabled={adding === "supplier" || !newSupplier.trim()}
          >
            Add
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
                          className="btn-ghost !px-3 !py-1.5 text-xs"
                          onClick={() => startEditSupplier(s)}
                          disabled={busyId === s.id}
                        >
                          {editing ? "Close" : "Edit"}
                        </button>
                        <button
                          className="btn-ghost !px-3 !py-1.5 text-xs"
                          onClick={() => toggleSupplierItems(s)}
                          disabled={busyId === s.id}
                        >
                          {showingItems ? "Hide items" : "Items"}
                        </button>
                        <button
                          className="btn-danger !px-3 !py-1.5 text-xs"
                          onClick={() => removeSupplier(s)}
                          disabled={busyId === s.id}
                        >
                          {busyId === s.id ? "Removing..." : "Remove"}
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
                          <p className="text-xs text-cocoa-400">
                            No items are linked to this supplier yet. Assign one
                            from the inventory page, or choose this supplier when
                            restocking.
                          </p>
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

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
