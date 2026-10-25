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

type Ref = { id: string; name: string; min_shelf_life_days?: number | null };
type Supplier = { id: string; name: string; contact_name: string | null; phone: string | null; email: string | null };
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

  const inFlight = useRef(false);

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

      // Store the value the API actually kept, which is the rounded integer.
      setSettings((prev) => ({ ...prev, [key]: data.settings[key] }));
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
                  // field does not fire a pointless request.
                  if (v !== "" && v !== settings[f.key]) saveField(f.key, v);
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
              if (v !== settings.business_name) saveField("business_name", v);
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
                on: "Staff confirm their face once per duty before they can move stock. One check covers the hours set in Alerts & sessions.",
                off: "Enrol everyone's photo from Staff Accounts first — this holds every member of staff at the camera screen.",
              },
              {
                key: "face_login_enabled",
                title: "Sign in with a face",
                on: "Staff can scan their badge and confirm their face instead of typing a password. Admins still use a password.",
                off: "Staff without a reference photo cannot use this, so enrol them from Staff Accounts first. Password sign-in keeps working either way.",
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
          Vendors that supply ingredients. Assign suppliers to items from the
          inventory page.
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
              {suppliers.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5"
                >
                  <div>
                    <span className="text-sm font-medium text-cocoa-700">
                      {s.name}
                    </span>
                    {s.contact_name && (
                      <span className="ml-2 text-xs text-cocoa-400">
                        {s.contact_name}
                      </span>
                    )}
                    {s.phone && (
                      <span className="ml-2 text-xs text-cocoa-400">
                        {s.phone}
                      </span>
                    )}
                    {s.email && (
                      <span className="ml-2 text-xs text-cocoa-400">
                        {s.email}
                      </span>
                    )}
                  </div>
                  <button
                    className="btn-danger"
                    onClick={() => removeSupplier(s)}
                    disabled={busyId === s.id}
                  >
                    {busyId === s.id ? "Removing..." : "Remove"}
                  </button>
                </li>
              ))}
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
