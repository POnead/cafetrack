import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clearSettingsCache } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Read the tunable company settings.
 *
 * Admin-only, because the same page is the only place these can be written
 * (see PATCH below) and the values are operational policy rather than trivia.
 * `requireAdmin()` throws a 403 for staff, which `handler` turns into a clean
 * JSON response.
 */
export const GET = handler(async () => {
  await requireAdmin();

  const { data, error } = await db().from("settings").select("key, value").order("key");

  if (error) return fail(error.message, 500);

  const values: Record<string, string> = {};
  for (const row of (data ?? []) as { key: string; value: string }[]) {
    values[row.key] = row.value;
  }

  return ok({ settings: values });
});

/**
 * The editable settings, with the same bounds lib/settings.ts clamps to.
 * Kept here so the API rejects an out-of-range value at the door rather than
 * silently storing it and relying on every reader to re-clamp.
 */
const EDITABLE: Record<
  string,
  { min: number; max: number; label: string }
> = {
  session_timeout_minutes: { min: 1, max: 480, label: "Session timeout" },
  expiry_warning_days: { min: 1, max: 365, label: "Expiry warning window" },
};

/** Free-text settings have a length cap instead of a numeric range. */
const TEXT_SETTINGS: Record<string, { maxLength: number; label: string }> = {
  business_name: { maxLength: 120, label: "Business name" },
};

/**
 * Update settings. Accepts a partial object, e.g. `{ expiry_warning_days: "14" }`.
 *
 * The local adapter has no `upsert`, so each key is updated and inserted only
 * if no row came back — that keeps this working in both local and Supabase mode
 * without extending the adapter.
 */
export const PATCH = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const changes: Record<string, string> = {};

  for (const [key, raw] of Object.entries(body ?? {})) {
    const numeric = EDITABLE[key];
    const text = TEXT_SETTINGS[key];

    if (!numeric && !text) {
      return fail(`"${key}" is not a setting you can change`, 400);
    }

    if (numeric) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fail(`${numeric.label} must be a number`);
      if (n < numeric.min || n > numeric.max) {
        return fail(
          `${numeric.label} must be between ${numeric.min} and ${numeric.max}`
        );
      }
      // Store the rounded integer so a value like 14.6 cannot be read back raw.
      changes[key] = String(Math.round(n));
    } else {
      const s = String(raw ?? "").trim();
      if (!s) return fail(`${text!.label} cannot be empty`);
      if (s.length > text!.maxLength) {
        return fail(`${text!.label} must be under ${text!.maxLength} characters`);
      }
      changes[key] = s;
    }
  }

  if (Object.keys(changes).length === 0) {
    return fail("No settings to update");
  }

  for (const [key, value] of Object.entries(changes)) {
    const { data, error } = await db()
      .from("settings")
      .update({ value })
      .eq("key", key)
      .select("key");

    if (error) return fail(error.message, 500);

    // No row matched — the key is new to this database, so add it.
    if (!data || data.length === 0) {
      const { error: insertError } = await db()
        .from("settings")
        .insert({ key, value });
      if (insertError) return fail(insertError.message, 500);
    }
  }

  // The readers in lib/settings.ts cache for a minute; without this an admin
  // would save a new threshold and not see it take effect for up to 60s.
  clearSettingsCache();

  await audit(admin, "SETTINGS_UPDATE", "settings", null, changes);

  return ok({ settings: changes });
});
