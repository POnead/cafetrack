import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody, clientIp, dbFail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { isIdDocType, providerSummary, type IdSignal } from "@/lib/id-verification";
import { nameSignal } from "@/lib/id-verification/name-signal";
import { checkIdNumber, normaliseIdNumber } from "@/lib/id-verification/id-number";
import { idNumberSignal, idTypeHasExpiry } from "@/lib/id-verification/specification";

export const runtime = "nodejs";

/**
 * Everything the review screen needs about one account's ID, in one call.
 *
 * Separate from /api/users/[id]/id because that route's GET serves image *bytes*
 * and this one serves *metadata*. Folding them together would mean the review
 * screen either fetched every image to read a status, or fetched a status and
 * had to guess whether the images were already loaded.
 *
 * The signals and extracted fields are here rather than on the staff list. They
 * are small, but they are only read when someone is actually reviewing, and the
 * list is fetched on every page load by a page an admin opens constantly.
 *
 * Admin-only for the same reason the images are: the proxy establishes that a
 * session exists, not which account it is, so this would otherwise let any
 * staff member read any other staff member's ID details.
 */

const REVIEW_COLUMNS =
  "id, full_name, username, role, is_active, verification_status, id_doc_type, " +
  "id_doc_number, id_doc_expiry, id_fields, id_signals, id_provider, verification_notes, " +
  "verified_at, verified_by, id_doc_front is not null as has_front, " +
  "id_doc_back is not null as has_back, id_photo is not null as has_photo";

const FIELD_LIMITS = {
  full_name: 160,
  id_number: 80,
  date_of_birth: 10,
  date_of_expiry: 10,
} as const;

type EditableIdFields = Record<keyof typeof FIELD_LIMITS, string>;

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

function editableFields(value: unknown): EditableIdFields | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const fields = {} as EditableIdFields;

  for (const [key, limit] of Object.entries(FIELD_LIMITS) as [
    keyof typeof FIELD_LIMITS,
    number,
  ][]) {
    if (typeof record[key] !== "string") return null;
    const text = (record[key] as string).trim();
    if (text.length > limit) return null;
    fields[key] = text;
  }

  if (fields.date_of_birth && !isIsoDate(fields.date_of_birth)) return null;
  if (fields.date_of_expiry && !isIsoDate(fields.date_of_expiry)) return null;
  return fields;
}

export const GET = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("users")
      .select(REVIEW_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    return ok({
      user: data,
      // Same defensive parse as the review route: a null or hand-edited column
      // renders an empty list rather than failing the screen.
      signals: Array.isArray(data.id_signals) ? (data.id_signals as IdSignal[]) : [],
      fields: (data.id_fields ?? {}) as Record<string, string | null>,
      // Which engines are available *now*, so the upload form can say what will
      // run before anything is attached rather than after.
      providers: await providerSummary(),
    });
  }
);

/** Save the admin-checked OCR suggestions without approving the ID. */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const body = await readBody(req);
    const fields = editableFields(body.fields);
    if (!fields) {
      return fail(
        "Enter valid ID details. Dates must use the YYYY-MM-DD format and be real calendar dates."
      );
    }

    const { data: before, error: readError } = await db()
      .from("users")
      .select(
        "id, username, full_name, role, id_doc_front, id_doc_type, id_doc_number, id_doc_expiry, " +
          "id_fields, id_signals, verification_status"
      )
      .eq("id", id)
      .maybeSingle();

    if (readError) return dbFail(readError, { context: "id status read" });
    if (!before) return fail("User not found", 404);
    if (before.role !== "staff") return fail("Only staff accounts have ID details", 400);
    if (!before.id_doc_front) return fail("No ID has been attached to this account yet");
    const docType = isIdDocType(before.id_doc_type) ? before.id_doc_type : "other";
    if (!idTypeHasExpiry(docType) && fields.date_of_expiry) {
      return fail(
        "This ID type does not have an expiry date. Clear the expiry field and save again."
      );
    }

    if (fields.id_number && checkIdNumber(fields.id_number, docType).ok) {
      const { data: otherAccounts, error: duplicateError } = await db()
        .from("users")
        .select("id, role, id_doc_type, id_doc_number");
      if (duplicateError) {
        return fail(`Could not check for a reused ID number: ${duplicateError.message}`, 500);
      }
      if (!Array.isArray(otherAccounts)) return fail("Could not check for a reused ID number.", 500);
      const normalised = normaliseIdNumber(fields.id_number);
      const duplicate = otherAccounts.some((row) => {
        const account = row as {
          id: string;
          role: string;
          id_doc_type: string | null;
          id_doc_number: string | null;
        };
        return (
          account.id !== id &&
          account.role === "staff" &&
          account.id_doc_type === docType &&
          normaliseIdNumber(account.id_doc_number) === normalised
        );
      });
      if (duplicate) {
        return fail("This ID number is already attached to another staff account.", 409);
      }
    }

    const previousFields =
      before.id_fields && typeof before.id_fields === "object" && !Array.isArray(before.id_fields)
        ? (before.id_fields as Record<string, unknown>)
        : {};
    const updatedFields = (Object.keys(FIELD_LIMITS) as (keyof EditableIdFields)[]).filter(
      (key) =>
        String(previousFields[key] ?? "") !== fields[key] ||
        (key === "id_number" && String(before.id_doc_number ?? "") !== fields.id_number) ||
        (key === "date_of_expiry" &&
          String(before.id_doc_expiry ?? "").slice(0, 10) !== fields.date_of_expiry)
    );

    const storedSignals: unknown[] = Array.isArray(before.id_signals)
      ? before.id_signals
      : [];
    const previousSignals = storedSignals.filter(
      (signal: unknown): signal is IdSignal =>
        !!signal &&
        typeof signal === "object" &&
        typeof (signal as IdSignal).id === "string" &&
        typeof (signal as IdSignal).label === "string" &&
        typeof (signal as IdSignal).detail === "string" &&
        ["pass", "warn", "fail", "unknown"].includes((signal as IdSignal).tone)
    );
    const signals = previousSignals.filter(
      (signal) =>
        signal.id !== "name_match" &&
        signal.id !== "id_fields_reviewed" &&
        signal.id !== "id_number_shape" &&
        !/^ocr(?:_space)?_(?:full_name|id_number|date_of_birth|date_of_expiry)$/.test(
          signal.id
        ) &&
        (idTypeHasExpiry(docType) || !signal.id.endsWith("date_of_expiry"))
    );
    signals.push(
      nameSignal(
        fields.full_name || null,
        before.full_name,
        fields.full_name ? "ok" : "ran_but_read_nothing"
      )
    );
    const numberCheck = idNumberSignal(fields.id_number, docType);
    if (numberCheck) signals.push(numberCheck);
    signals.push(
      {
        id: "id_fields_reviewed",
        label: "ID details reviewed",
        tone: "pass",
        detail:
          `An admin checked and saved the name, ID number, birth date, and ${
            idTypeHasExpiry(docType) ? "expiry details" : "other applicable details"
          }. ` +
          "Compare them with the ID image before making the final decision.",
      }
    );

    const { data, error } = await db()
      .from("users")
      .update({
        id_fields: {
          full_name: fields.full_name || null,
          id_number: fields.id_number || null,
          date_of_birth: fields.date_of_birth || null,
          date_of_expiry: fields.date_of_expiry || null,
        },
        id_doc_number: fields.id_number || null,
        id_doc_expiry: fields.date_of_expiry || null,
        id_signals: signals,
        ...(updatedFields.length > 0
          ? {
              verification_status: "unverified",
              verification_notes: null,
              verified_at: null,
              verified_by: null,
            }
          : {}),
      })
      .eq("id", id)
      .select(REVIEW_COLUMNS)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "USER_ID_DETAILS_REVIEW",
      "user",
      id,
      {
        updated_fields: updatedFields,
        previous_status: before.verification_status,
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      signals,
      fields: data.id_fields ?? {},
    });
  }
);
