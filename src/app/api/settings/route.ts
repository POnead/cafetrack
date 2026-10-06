import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clearSettingsCache } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Keys never returned by GET, however they came to be in the table.
 *
 * `smtp_pass_enc` holds the encrypted mail app password. Even as ciphertext it
 * has no business in a general settings response — it is not a setting, it is a
 * credential, and anything that ships it to a browser widens the number of
 * places it can leak from. The Email page describes the account through
 * /api/email instead, which returns only whether a password exists.
 *
 * Blocked by key rather than deleted, so adding another credential later fails
 * closed instead of publishing it.
 */
const SECRET_KEYS = new Set(["smtp_pass_enc"]);

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
    if (SECRET_KEYS.has(row.key)) continue;
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
  // Email (FR-11).
  email_dedupe_hours: { min: 1, max: 168, label: "Duplicate alert window" },
  email_max_attempts: { min: 1, max: 10, label: "Delivery attempts" },
  email_daily_summary_hour: { min: 0, max: 23, label: "Daily summary hour" },
};

/** Free-text settings have a length cap instead of a numeric range. */
const TEXT_SETTINGS: Record<string, { maxLength: number; label: string }> = {
  business_name: { maxLength: 120, label: "Business name" },
  email_from: { maxLength: 200, label: "Sender address" },
};

/**
 * Off/on switches, stored as the strings "0" and "1" because that is what the
 * settings table holds and what the email code reads.
 *
 * Separate from the numeric bounds above so a stray `email_enabled: "banana"`
 * cannot be coerced into a truthy number by `Number()`.
 */
const TOGGLES: Record<string, string> = {
  email_enabled: "Email notifications",
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
    // Credentials are written through /api/email, which encrypts them. Letting
    // them be set here as plain text would put an unencrypted value in the
    // table under a key the rest of the app assumes is ciphertext.
    if (SECRET_KEYS.has(key)) {
      return fail(`"${key}" cannot be set here`, 400);
    }

    const numeric = EDITABLE[key];
    const text = TEXT_SETTINGS[key];
    const toggle = TOGGLES[key];

    if (!numeric && !text && !toggle) {
      return fail(`"${key}" is not a setting you can change`, 400);
    }

    if (toggle) {
      // Only the two canonical forms. Accepting anything else would mean
      // "off" and "maybe" both silently becoming true, which for a switch that
      // starts sending email is the wrong direction to be wrong in.
      const s = String(raw ?? "").trim().toLowerCase();
      if (s !== "0" && s !== "1" && s !== "true" && s !== "false") {
        return fail(`${toggle} must be on or off`);
      }
      changes[key] = s === "1" || s === "true" ? "1" : "0";
    } else if (numeric) {
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
