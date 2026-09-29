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

/**
 * A count of boxes for a restock line, or null for "not counted by the box".
 *
 * Distinct from requireQuantity on purpose: a blank is the normal case (the item
 * is counted loose) and must stay null, where requireQuantity treats a blank as
 * missing and rejects it. A negative or zero count is a mistake worth reporting
 * rather than silently ignoring, so it is a 400 here instead of being dropped.
 */
export function parseBoxCount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new FieldError("Box count must be a number");
  }
  if (n <= 0) {
    throw new FieldError("Box count must be greater than zero");
  }
  return n;
}

/**
 * `units_per_box` on an item, or null when the item is not supplied in boxes.
 *
 * A blank clears the field, which is how an item stops being counted by the
 * box. A non-positive value is refused rather than stored: it is a `check`
 * constraint, so letting it through would turn a bad number into a 500 from
 * Postgres when the insert is written.
 */
export function parseUnitsPerBox(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new FieldError("Units per box must be a number");
  }
  if (n <= 0) {
    throw new FieldError("Units per box must be greater than zero");
  }
  return n;
}

/**
 * A location's minimum shelf life on arrival, in days, or null for no rule.
 *
 * Zero is meaningful and allowed — it means "no minimum", which is the same
 * effect as no rule, and an admin setting a location back to zero should not
 * be told it is invalid. A negative value is nonsense and is refused.
 */
export function parseMinShelfLifeDays(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new FieldError("Minimum shelf life must be a number of days");
  }
  if (n < 0) {
    throw new FieldError("Minimum shelf life cannot be negative");
  }
  return Math.round(n);
}

/**
 * A category_id / location_id that is present must be well-formed.
 *
 * The columns *do* have foreign keys (schema.sql), so Postgres already refuses
 * an id that matches nothing — but it refuses by throwing, which the route turns
 * into a 500 carrying raw constraint text like `violates foreign key constraint
 * "items_category_id_fkey"`. That is a server fault reported for a malformed
 * request.
 *
 * This turns that into a 400 with a message a person can act on, checked before
 * the SKU is generated so a rejected request never burns a candidate.
 *
 * `exists` is the caller's lookup — POST /api/items and PATCH /api/items/[id]
 * resolve against the same tables but own different queries, so only the
 * decision is shared and the two routes cannot drift apart.
 *
 * null / undefined / "" all mean "leave it unset", which stays allowed.
 */
export async function assertRefExists(
  raw: unknown,
  label: string,
  exists: (id: string) => Promise<boolean>
): Promise<string | null> {
  if (raw === null || raw === undefined || raw === "") return null;

  const id = String(raw).trim();
  if (!id) return null;

  if (!(await exists(id))) {
    throw new FieldError(`${label} does not match an existing record`);
  }
  return id;
}

const FORMS = ["liquid", "powder", "solid"];

/**
 * physical_form is a `check` constraint (schema.sql), so Postgres rejects
 * anything else by throwing — which the route surfaces as a 500 carrying raw
 * constraint text. The Items form only ever offers these three values, so a
 * rejection here means a hand-made request rather than a UI mistake.
 *
 * An absent value keeps the column default, matching both the schema and the
 * form's own starting value.
 */
export function parsePhysicalForm(raw: unknown): string {
  const s = String(raw ?? "solid").trim().toLowerCase();
  if (!FORMS.includes(s)) {
    throw new FieldError(`Physical form must be one of: ${FORMS.join(", ")}`);
  }
  return s;
}

/**
 * Every staff token is generated as "CT-STF-" plus ten hex characters
 * (newStaffToken in lib/auth.ts), while an item SKU is "CT-<CATEGORY>-<4 hex>".
 * The two shapes cannot collide, so a code carrying this prefix is definitely
 * not an item.
 *
 * Used only to explain a rejected scan. Nothing is looked up and no credential
 * is validated here — the answer is identical whether or not the code is real,
 * so this reveals nothing about which staff ids exist.
 */
export function looksLikeStaffCode(code: string): boolean {
  return /^CT-STF-[0-9A-F]{10}$/i.test(code.trim());
}

export { requireQuantity };
