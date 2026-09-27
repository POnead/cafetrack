/**
 * Single source of truth for the status wording and colours used across the
 * dashboard, inventory, alerts, checkout and reports pages.
 *
 * The database only stores numbers (quantity vs low_stock_threshold, and an
 * expiry date). The vocabulary lives here so a wording change can never drift
 * from one page to the next.
 */
import { daysUntil } from "./format";

/** Same union as Badge's `tone` prop — kept independent so this module stays pure. */
export type StatusTone = "slate" | "green" | "amber" | "red" | "blue";

export type Status = {
  /** Stable key for filtering/deriving — never shown to the user. */
  key: string;
  label: string;
  tone: StatusTone;
};

/** Mirrors the seeded `expiry_warning_days` setting (db/schema.sql). */
export const EXPIRY_WARNING_DAYS = 7;

/** Out of Stock / Low Stock / In Stock, from quantity vs threshold. */
export function stockStatus(
  quantity: number | string,
  lowStockThreshold: number | string
): Status {
  const qty = Number(quantity);
  const threshold = Number(lowStockThreshold);

  if (!(qty > 0)) return { key: "out", label: "Out of Stock", tone: "red" };
  if (qty <= threshold) return { key: "low", label: "Low Stock", tone: "amber" };
  return { key: "ok", label: "In Stock", tone: "green" };
}

/** Active / Deactivated, for the users.is_active flag. */
export function accountStatus(isActive: boolean): Status {
  return isActive
    ? { key: "active", label: "Active", tone: "green" }
    : { key: "deactivated", label: "Deactivated", tone: "red" };
}

/** The four kinds of alert refresh_alerts() can raise. */
export function alertTypeStatus(type: string): Status {
  switch (type) {
    case "out_of_stock":
      return { key: "out_of_stock", label: "Out of Stock", tone: "red" };
    case "low_stock":
      return { key: "low_stock", label: "Low Stock", tone: "amber" };
    case "expired":
      return { key: "expired", label: "Expired", tone: "red" };
    case "near_expiry":
      return { key: "near_expiry", label: "Expiring Soon", tone: "amber" };
    default:
      return { key: type, label: type, tone: "slate" };
  }
}

export type ExpiryStatus = Status & { days: number | null };

/** Expired / Expiring Soon / In Date, inside the configurable warning window. */
export function expiryStatus(
  expirationDate: string | null | undefined,
  warningDays = EXPIRY_WARNING_DAYS
): ExpiryStatus {
  if (!expirationDate) {
    return { key: "none", label: "No expiry", tone: "slate", days: null };
  }

  const days = daysUntil(expirationDate);
  if (days === null) {
    return { key: "none", label: "No expiry", tone: "slate", days: null };
  }
  if (days < 0) return { key: "expired", label: "Expired", tone: "red", days };
  if (days <= warningDays) {
    return { key: "soon", label: "Expiring Soon", tone: "amber", days };
  }
  return { key: "ok", label: "In Date", tone: "green", days };
}
