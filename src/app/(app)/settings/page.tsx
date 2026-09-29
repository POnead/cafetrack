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

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: Tone } | null>(null);

  const [newCategory, setNewCategory] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [adding, setAdding] = useState<"category" | "location" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const [s, c, l] = await Promise.all([
        fetch("/api/settings").then((r) => r.json()),
        fetch("/api/refs/categories").then((r) => r.json()),
        fetch("/api/refs/locations").then((r) => r.json()),
      ]);

      if (s.error) throw new Error(s.error);

      setSettings(s.settings ?? {});
      setCategories(c.items ?? []);
      setLocations(l.items ?? []);
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
                          aria-label={`Minimum shelf life in days for ${r.name}`}
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

      {error && <div className="card p-4 text-sm text-red-700">{error}</div>}

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

      <Toast
        message={toast?.msg ?? null}
        tone={toast?.tone}
        onDone={() => setToast(null)}
      />
    </div>
  );
}
