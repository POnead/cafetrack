import { db } from "@/lib/supabase";
import { handler, ok, fail, badId } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/* ---------------- read one ---------------- */
export const GET = handler(
  async (_req: Request, { params }: { params: { id: string } }) => {
    await requireUser();

    const malformed = badId(params.id, "item");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("items")
      .select(
        `*, category:categories(id, name), location:locations(id, name)`
      )
      .eq("id", params.id)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("Item not found", 404);
    return ok({ item: data });
  }
);

/* ---------------- update ---------------- */
export const PATCH = handler(
  async (req: Request, { params }: { params: { id: string } }) => {
    const admin = await requireAdmin();

    const malformed = badId(params.id, "item");
    if (malformed) return malformed;

    const body = await req.json();

    const { data: before } = await db()
      .from("items")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();

    if (!before) return fail("Item not found", 404);

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (body.name !== undefined) patch.name = String(body.name).trim();
    if (body.category_id !== undefined) patch.category_id = body.category_id || null;
    if (body.location_id !== undefined) patch.location_id = body.location_id || null;
    if (body.physical_form !== undefined) patch.physical_form = body.physical_form;
    if (body.unit !== undefined) patch.unit = body.unit;
    if (body.expiration_date !== undefined)
      patch.expiration_date = body.expiration_date || null;
    if (body.low_stock_threshold !== undefined)
      patch.low_stock_threshold = Number(body.low_stock_threshold);

    // Quantity edits here are corrections, not movements — still versioned.
    if (body.quantity !== undefined) {
      const q = Number(body.quantity);
      if (Number.isNaN(q) || q < 0) return fail("Invalid quantity");
      patch.quantity = q;
      patch.version = Number(before.version) + 1;
    }

    const { data, error } = await db()
      .from("items")
      .update(patch)
      .eq("id", params.id)
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

    await audit(admin, "ITEM_UPDATE", "item", data.id, {
      sku: data.sku,
      name: data.name,
      changes,
    });

    await db().rpc("refresh_alerts");

    return ok({ item: data });
  }
);

/* ---------------- delete ---------------- */
export const DELETE = handler(
  async (_req: Request, { params }: { params: { id: string } }) => {
    const admin = await requireAdmin();

    const malformed = badId(params.id, "item");
    if (malformed) return malformed;

    const { data: item } = await db()
      .from("items")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();

    if (!item) return fail("Item not found", 404);

    const { error } = await db().from("items").delete().eq("id", params.id);
    if (error) return fail(error.message, 500);

    await audit(admin, "ITEM_DELETE", "item", item.id, {
      sku: item.sku,
      name: item.name,
      quantity_at_delete: item.quantity,
    });

    return ok({ ok: true });
  }
);
