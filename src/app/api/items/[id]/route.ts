import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody, clientIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { canManageItems, approvalCodeMatches } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import {
  FieldError,
  requireQuantity,
  parseThreshold,
  parseExpiryDate,
  parsePhysicalForm,
  parseUnitsPerBox,
  assertRefExists,
} from "@/lib/item-validation";

export const runtime = "nodejs";

/* ---------------- read one ---------------- */
// Next 15 delivers route `params` as a Promise; each handler awaits it once.
export const GET = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const { id } = await params;

    const malformed = badId(id, "item");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("items")
      .select(
        `*, category:categories(id, name), location:locations(id, name)`
      )
      .eq("id", id)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("Item not found", 404);
    return ok({ item: data });
  }
);

/* ---------------- update ---------------- */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    // FR-03: an admin, or a staff member granted item management.
    const user = await requireUser();
    const canEdit = await canManageItems(user);
    const { id } = await params;

    const malformed = badId(id, "item");
    if (malformed) return malformed;

    const body = await readBody(req);

    const { data: before } = await db()
      .from("items")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("Item not found", 404);

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    let quantityCorrectionReason: string | null = null;

    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.unit !== undefined) patch.unit = body.unit;

    // physical_form is a check constraint, so an unknown value would come back
    // from Postgres as a thrown error and surface as a 500. Reject it here.
    if (body.physical_form !== undefined) {
      try {
        patch.physical_form = parsePhysicalForm(body.physical_form);
      } catch (e: any) {
        if (e instanceof FieldError) return fail(e.message);
        throw e;
      }
    }

    // A reference id that is present must be well-formed. The columns have
    // foreign keys, so Postgres would reject an unknown id by throwing — which
    // the caller would see as a 500 rather than a 400.
    try {
      if (body.category_id !== undefined) {
        patch.category_id = await assertRefExists(
          body.category_id,
          "Category",
          async (id) =>
            Boolean(
              (
                await db()
                  .from("categories")
                  .select("id")
                  .eq("id", id)
                  .maybeSingle()
              ).data
            )
        );
      }
      if (body.location_id !== undefined) {
        patch.location_id = await assertRefExists(
          body.location_id,
          "Location",
          async (id) =>
            Boolean(
              (
                await db()
                  .from("locations")
                  .select("id")
                  .eq("id", id)
                  .maybeSingle()
              ).data
            )
        );
      }
    } catch (e: any) {
      if (e instanceof FieldError) return fail(e.message);
      throw e;
    }

    // A rejected field answers 400 rather than letting the database error
    // surface as a 500 from what is really a malformed request.
    try {
      if (body.low_stock_threshold !== undefined) {
        patch.low_stock_threshold = parseThreshold(
          body.low_stock_threshold,
          "Low-stock threshold"
        );
      }
      if (body.expiration_date !== undefined) {
        patch.expiration_date = parseExpiryDate(body.expiration_date);
      }
      if (body.quantity !== undefined) {
        patch.quantity = requireQuantity(body.quantity, "Quantity");
        // Quantity edits here are corrections, not movements — still versioned.
        patch.version = Number(before.version) + 1;
        if (Number(patch.quantity) !== Number(before.quantity)) {
          if (typeof body.correction_reason !== "string") {
            return fail("Enter a reason for the stock correction");
          }
          quantityCorrectionReason = body.correction_reason.trim();
          if (!quantityCorrectionReason) {
            return fail("Enter a reason for the stock correction");
          }
          if (quantityCorrectionReason.length > 500) {
            return fail("Stock correction reason must be 500 characters or fewer");
          }
        }
      }
      if (body.units_per_box !== undefined) {
        // A blank clears it, which is how an item stops being counted by the box.
        patch.units_per_box = parseUnitsPerBox(body.units_per_box);
      }
    } catch (e: any) {
      if (e instanceof FieldError) return fail(e.message);
      throw e;
    }

    // FR-03: a staff member without the grant cannot change the live item,
    // but they can ask for a change. The request keeps their proposed values
    // until an admin decides; patch was already validated above, so the
    // request carries the same rules as a direct edit.
    if (!canEdit) {
      const viaCode = await approvalCodeMatches(user, body.approval_code);
      if (!viaCode) {
        const proposal: Record<string, unknown> = {
          item_id: id,
          requested_by: user.id,
          base_version: before.version,
        };
        for (const key of [
          "name",
          "category_id",
          "location_id",
          "physical_form",
          "unit",
          "units_per_box",
          "quantity",
          "low_stock_threshold",
          "expiration_date",
        ] as const) {
          if (body[key] !== undefined) proposal[key] = patch[key];
        }
        if (quantityCorrectionReason) proposal.correction_reason = quantityCorrectionReason;

        const { data, error } = await db()
          .from("item_change_requests")
          .insert(proposal)
          .select()
          .single();

        if (error) return fail(error.message, 500);

        await audit(user, "ITEM_CHANGE_REQUEST", "item", id, {
          sku: before.sku,
          name: before.name,
          request_id: data.id,
        }, { ip: clientIp(req) });

        return ok({
          pending_change: true,
          request: data,
          message: "Edit submitted for approval — an admin will review it before it takes effect.",
        }, 201);
      }
      // With a valid code, fall through and apply the edit directly.
    }

    const { data, error } = await db()
      .from("items")
      .update(patch)
      .eq("id", id)
      .eq("version", before.version)
      .select()
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("Item was modified by someone else. Refresh and retry.", 409);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(patch)) {
      if (key === "updated_at" || key === "version") continue;
      if ((before as any)[key] !== (data as any)[key]) {
        changes[key] = { from: (before as any)[key], to: (data as any)[key] };
      }
    }

    await audit(user, "ITEM_UPDATE", "item", data.id, {
      sku: data.sku,
      name: data.name,
      changes,
      ...(quantityCorrectionReason
        ? { quantity_correction_reason: quantityCorrectionReason }
        : {}),
    }, { ip: clientIp(req) });

    await db().rpc("refresh_alerts");

    return ok({ item: data });
  }
);

/* ---------------- delete ---------------- */
export const DELETE = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    // Same permission as an edit: FR-03 grants add, edit and delete together,
    // because a person who can correct a typo but not remove a duplicate is only
    // half-trusted, which is a harder rule to explain than either extreme.
    const user = await requireUser();
    if (!(await canManageItems(user))) {
      return fail(
        "You need item management permission to delete an item. Ask an admin to grant it.",
        403
      );
    }
    const { id } = await params;

    const malformed = badId(id, "item");
    if (malformed) return malformed;

    const { data: item } = await db()
      .from("items")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!item) return fail("Item not found", 404);

    const { error } = await db().from("items").delete().eq("id", id);
    if (error) return fail(error.message, 500);

    await audit(user, "ITEM_DELETE", "item", item.id, {
      sku: item.sku,
      name: item.name,
      quantity_at_delete: item.quantity,
    }, { ip: clientIp(req) });

    return ok({ ok: true });
  }
);
