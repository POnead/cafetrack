import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody } from "@/lib/api";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { deleteRef } from "@/lib/ref-delete";

export const runtime = "nodejs";

const FIELDS = "id, name, contact_name, phone, email, created_at";

/**
 * One supplier, plus the items it supplies.
 *
 * The reverse link already existed (items.supplier_id) but nothing read it, so
 * "which items does this supplier deliver?" was only answerable by opening every
 * item in turn. This is the query that makes a supplier record more than a name
 * in a dropdown.
 *
 * Two queries rather than an embedded select: the local PGlite adapter only maps
 * the join paths listed in lib/local-db.ts, and `suppliers.items` is not one of
 * them. Keeping it separate means the route behaves the same on both backends.
 */
export const GET = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const { id } = await params;

    const malformed = badId(id, "supplier");
    if (malformed) return malformed;

    const { data: supplier, error } = await db()
      .from("suppliers")
      .select(FIELDS)
      .eq("id", id)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!supplier) return fail("Supplier not found", 404);

    const { data: items, error: itemsError } = await db()
      .from("items")
      .select(
        `id, sku, name, unit, quantity, low_stock_threshold, expiration_date,
         item_status,
         category:categories(id, name), location:locations(id, name)`
      )
      .eq("supplier_id", id)
      .order("name", { ascending: true });

    if (itemsError) return fail(itemsError.message, 500);

    return ok({ supplier, items: items ?? [] });
  }
);

/* ---------------- update ---------------- */

/**
 * Edit a supplier's name and contact details.
 *
 * Every field is optional so a caller can change the phone number without
 * restating the name, but an explicitly empty contact field clears it - that is
 * how a stale number gets removed. `undefined` means "leave alone"; `""` means
 * "store null".
 *
 * Without this route the contact columns existed in the schema and were accepted
 * by POST /api/refs/suppliers, but nothing in the UI ever sent them and there was
 * no way to correct one afterwards. A supplier record with a phone number nobody
 * can change is not a contact record.
 */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "supplier");
    if (malformed) return malformed;

    const body = await readBody(req);
    const patch: Record<string, string | null> = {};

    if (body.name !== undefined) {
      const name = String(body.name ?? "").trim();
      if (!name) return fail("Supplier name is required");
      if (name.length > 120)
        return fail("Supplier name must be under 120 characters");

      // Names are the user-facing label, so a duplicate is a conflict rather
      // than a database error surfacing as a 500. Compared in JS rather than
      // with `neq`, because the local adapter does not implement it.
      const { data: existing } = await db()
        .from("suppliers")
        .select("id")
        .eq("name", name)
        .maybeSingle();
      if (existing && existing.id !== id)
        return fail("That supplier already exists", 409);

      patch.name = name;
    }

    const text = (
      field: string,
      label: string,
      max: number
    ): string | null | undefined => {
      if (body[field] === undefined) return undefined;
      const value = String(body[field] ?? "").trim();
      if (value.length > max) throw new Error(`${label} must be under ${max} characters`);
      return value || null;
    };

    let contactName: string | null | undefined;
    let phone: string | null | undefined;
    let email: string | null | undefined;
    try {
      contactName = text("contact_name", "Contact name", 120);
      phone = text("phone", "Phone", 40);
      email = text("email", "Email", 120);
    } catch (e: any) {
      return fail(e.message);
    }

    if (contactName !== undefined) patch.contact_name = contactName;
    if (phone !== undefined) patch.phone = phone;
    if (email !== undefined) patch.email = email;

    if (Object.keys(patch).length === 0)
      return fail("Nothing to update");

    const { data, error } = await db()
      .from("suppliers")
      .update(patch)
      .eq("id", id)
      .select(FIELDS)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("Supplier not found", 404);

    await audit(admin, "SUPPLIER_UPDATE", "supplier", data.id, patch);

    return ok({ item: data });
  }
);

/* ---------------- delete ---------------- */

// Next 15 delivers route `params` as a Promise, so it is awaited once here and
// the resolved id is used for the rest of the handler.
export const DELETE = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;

    const malformed = badId(id, "supplier");
    if (malformed) return malformed;

    const failed = await deleteRef({
      table: "suppliers",
      column: "supplier_id",
      id,
      label: "supplier",
      noun: "supplier",
      action: "SUPPLIER_DELETE",
    });
    if (failed) return failed;

    return ok({ ok: true });
  }
);
