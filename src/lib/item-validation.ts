/**
 * Input validation shared by POST /api/items and PATCH /api/items/[id].
 *
 * Kept in one place so the two routes cannot drift into accepting different
 * things, and so the wording of a rejection is identical either way.
 *
 * The quantity rules matter more than they look. `Number(null)` and
 * `Number("")` are both `0`, so a payload with a missing or blank quantity used
 * to save as a silent zero — an item that was fully stocked would appear
 * emptied with no warning. `Number(undefined)` is `NaN`, which JSON-encodes to
 * `null` anyway, so a browser that submits an empty number field hits exactly
 * this case. A quantity has to be present and a real number; anything else is
 * a 400, not a default.
 */

/** Thrown for a rejected field; the route turns this into a 400. */
export class FieldError extends Error {}

function requireQuantity(raw: unknown, label: string): number {
  // null/undefined/"" all mean "not supplied", which is never a valid quantity.
  if (raw === null || raw === undefined || raw === "") {
    throw new FieldError(`${label} is required`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new FieldError(`${label} must be a number`);
  }
  if (n < 0) {
    throw new FieldError(`${label} cannot be negative`);
  }
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date column wants YYYY-MM-DD. This also rejects values that match the
 * shape but are not real days ("2026-02-30"), which Postgres would otherwise
 * reject for us — as a 500, from a 500 that should have been a 400.
 *
 * Empty / null is allowed and means "no expiry".
 */
export function parseExpiryDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;

  const s = String(raw).trim();
  if (!DATE_RE.test(s)) {
    throw new FieldError("Expiry date must be a valid date (YYYY-MM-DD)");
  }

  // Round-trip through Date to catch impossible days like 2026-02-30, which
  // would otherwise be rolled over to March instead of rejected.
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new FieldError("Expiry date must be a valid date (YYYY-MM-DD)");
  }
  return s;
}

/** Positive integer within an inclusive range; used for thresholds. */
export function parseThreshold(raw: unknown, label: string): number {
  if (raw === null || raw === undefined || raw === "") return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new FieldError(`${label} must be a number that is not negative`);
  }
  return Math.round(n);
}

export { requireQuantity };
