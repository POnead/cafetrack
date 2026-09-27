import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * `id` is a uuid column, so anything else is a malformed request rather than a
 * missing row — without this the database reports a type error and the route
 * would answer 500.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badId(id: string) {
  return UUID.test(id) ? null : fail("Not a valid alert id", 400);
}

/* ---------------- read one, with its context ---------------- */
/**
 * The list resolves an alert in one click; the detail page needs the item
 * behind it plus that item's other alerts (resolved ones included) so the
 * decision to resolve is an informed one.
 *
 * Three small queries instead of one nested select: the local PGlite adapter
 * only knows four explicit join paths, and none of them nest.
 */
export const GET = handler(
  async (_req: Request, { params }: { params: { id: string } }) => {
    const malformed = badId(params.id);
    if (malformed) return malformed;

    await requireUser();

    const { data: alert, error } = await db()
      .from("alerts")
      .select(
        `id, type, message, resolved, resolved_by, resolved_at, created_at, item_id,
         item:items(sku, name, unit, quantity, low_stock_threshold, expiration_date)`
      )
      .eq("id", params.id)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!alert) return fail("Alert not found", 404);

    // Category, location and physical form live on the item row.
    let item: unknown = null;
    let history: unknown[] = [];

    if (alert.item_id) {
      const [itemRes, historyRes] = await Promise.all([
        db()
          .from("items")
          .select(
            `id, sku, name, physical_form, unit, quantity, low_stock_threshold,
             expiration_date, version, updated_at,
             category:categories(id, name), location:locations(id, name)`
          )
          .eq("id", alert.item_id)
          .maybeSingle(),
        db()
          .from("alerts")
          .select(
            "id, type, message, resolved, resolved_by, resolved_at, created_at"
          )
          .eq("item_id", alert.item_id)
          .order("created_at", { ascending: false })
          .limit(25),
      ]);

      item = itemRes.data ?? null;
      history = historyRes.data ?? [];
    }

    return ok({ alert, item, history });
  }
);

/** Resolve or re-open a single alert. */
export const PATCH = handler(
  async (req: Request, { params }: { params: { id: string } }) => {
    const malformed = badId(params.id);
    if (malformed) return malformed;

    const user = await requireUser();
    const body = await req.json();
    const resolved = body.resolved !== false;

    const { data, error } = await db()
      .from("alerts")
      .update(
        resolved
          ? {
              resolved: true,
              resolved_by: user.fullName,
              resolved_at: new Date().toISOString(),
            }
          : { resolved: false, resolved_by: null, resolved_at: null }
      )
      .eq("id", params.id)
      .select()
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("Alert not found", 404);

    await audit(
      user,
      resolved ? "ALERT_RESOLVE" : "ALERT_REOPEN",
      "alert",
      data.id,
      { type: data.type, message: data.message }
    );

    return ok({ alert: data });
  }
);
