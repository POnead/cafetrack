import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";

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
       item:items(sku, name, unit, quantity, low_stock_threshold, expiration_date)`
    )
    .order("created_at", { ascending: false })
    .limit(500);

  if (status === "open") query = query.eq("resolved", false);
  if (status === "resolved") query = query.eq("resolved", true);

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  return ok({ alerts: data ?? [] });
});

/* ---------------- force a recompute ---------------- */
// refresh_alerts is idempotent, so this is safe to fire from the UI button.
export const POST = handler(async () => {
  await requireUser();

  const { error } = await db().rpc("refresh_alerts");
  if (error) return fail(error.message, 500);

  return ok({ ok: true });
});
