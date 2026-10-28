import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

/* ---------------- list ---------------- */
export const GET = handler(async (req: Request) => {
  await requireUser();

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "open";

  let query = db()
    .from("alerts")
    .select(
      `id, type, message, resolved, resolved_by, resolved_at, created_at, item_id,
       item:items(sku, name, unit, quantity, low_stock_threshold, expiration_date, supplier_id)`
    )
    .order("created_at", { ascending: false })
    .limit(500);

  if (status === "open") query = query.eq("resolved", false);
  if (status === "resolved") query = query.eq("resolved", true);

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  /*
   * Attach the item's supplier, so a low-stock alert can say who to call.
   *
   * The alert row embeds its item, but a second embed inside that item is not a
   * path the local adapter knows how to join, so suppliers are fetched as one
   * extra query and stitched on. Two queries for up to 500 alerts, and only for
   * the suppliers actually referenced.
   */
  const alerts = (data ?? []) as any[];
  const supplierIds = [
    ...new Set(
      alerts
        .map((a) => a.item?.supplier_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ),
  ];

  if (supplierIds.length > 0) {
    const { data: suppliers } = await db()
      .from("suppliers")
      .select("id, name, contact_name, phone, email")
      .in("id", supplierIds);

    const byId = new Map(
      ((suppliers ?? []) as any[]).map((s) => [s.id, s])
    );

    for (const alert of alerts) {
      if (!alert.item) continue;
      alert.item.supplier = byId.get(alert.item.supplier_id) ?? null;
    }
  }

  return ok({ alerts });
});

/* ---------------- force a recompute ---------------- */
// refresh_alerts is idempotent, so this is safe to fire from the UI button.
//
// Admin-only: recomputing rewrites open alerts across the whole inventory, so
// it is a supervisory action, not something a barista can trigger. Staff can
// still *read* alerts (GET above) — only this mutation is gated.
export const POST = handler(async () => {
  await requireAdmin();

  const { error } = await db().rpc("refresh_alerts");
  if (error) return fail(error.message, 500);

  return ok({ ok: true });
});
