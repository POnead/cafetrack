import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Change requests from staff members without item-management permission.
 *
 * `?status=pending` is the admin's review list; `?status=all` is any admin's
 * view of everything. `?requested_by=me` (with optional status) is a staff
 * member seeing the outcome of their own edit requests — the feedback half
 * of the FR-03 loop.
 */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "pending";
  const mine = searchParams.get("requested_by") === "me";

  let query = db()
    .from("item_change_requests")
    .select(
      `id, item_id, requested_by, requested_at, status, reviewed_by, reviewed_at,
       review_note, base_version, name, category_id, location_id, physical_form,
       unit, units_per_box, quantity, low_stock_threshold, expiration_date, correction_reason,
       item:items(id, sku, name)`
    )
    .order("requested_at", { ascending: false });

  if (status === "pending" || status === "approved" || status === "rejected") {
    query = query.eq("status", status);
  }
  if (mine) {
    query = query.eq("requested_by", user.id);
  }

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  return ok({ requests: data ?? [] });
});
