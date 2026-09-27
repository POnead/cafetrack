/**
 * Read-only access to the `settings` key/value table.
 *
 * Values are cached in-process for a minute: every request that signs or
 * refreshes a session touches `session_timeout_minutes`, and hitting the DB
 * for it on each call would be wasteful.
 *
 * Deliberately independent of lib/auth.ts — auth.ts is imported by local-db.ts,
 * which is imported by supabase.ts, so importing this module from auth.ts
 * would close an import cycle. Routes read the value here and pass it in.
 */
import { db } from "./supabase";

const CACHE_TTL_MS = 60_000;

/** Matches the seeded schema defaults, used whenever the setting is unreadable. */
export const DEFAULT_SESSION_MINUTES = 15;
export const DEFAULT_EXPIRY_WARNING_DAYS = 7;

let cache: { at: number; values: Record<string, string> } | null = null;

async function readAll(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;

  try {
    const { data } = await db().from("settings").select("key, value");

    const values: Record<string, string> = {};
    for (const row of (data ?? []) as { key: string; value: string }[]) {
      values[row.key] = row.value;
    }

    cache = { at: Date.now(), values };
    return values;
  } catch {
    // A settings read must never be the reason sign-in fails — fall back to
    // defaults (or the last good read) and let the request carry on.
    return cache?.values ?? {};
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const values = await readAll();
  return values[key] ?? null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Session lifetime in minutes (settings.session_timeout_minutes). */
export async function getSessionMinutes(): Promise<number> {
  return clampInt(await getSetting("session_timeout_minutes"), DEFAULT_SESSION_MINUTES, 1, 480);
}

/** Days before expiry that an item starts warning (settings.expiry_warning_days). */
export async function getExpiryWarningDays(): Promise<number> {
  return clampInt(await getSetting("expiry_warning_days"), DEFAULT_EXPIRY_WARNING_DAYS, 1, 365);
}

/** Drop the cache — used by tests after writing a setting. */
export function clearSettingsCache() {
  cache = null;
}
