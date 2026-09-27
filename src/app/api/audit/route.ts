import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

/** Hash-chained audit trail, newest first. */
export const GET = handler(async (req: Request) => {
  await requireAdmin();

  const { searchParams } = new URL(req.url);
  const requested = Number(searchParams.get("limit") ?? 100);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 100, 1),
    500
  );

  // Two queries in parallel: the newest page of rows, and the total number of
  // rows in the table. The total is what lets the UI say "200 of 388" instead
  // of silently showing a window whose first row looks like a random start.
  const [page, count] = await Promise.all([
    db()
      .from("audit_log")
      .select(
        "seq, actor_id, actor_name, action, entity_type, entity_id, details, created_at"
      )
      .order("seq", { ascending: false })
      .limit(limit),
    db()
      .from("audit_log")
      .select("seq", { count: "exact", head: true }),
  ]);

  if (page.error) return fail(page.error.message, 500);
  if (count.error) return fail(count.error.message, 500);

  return ok({ entries: page.data ?? [], total: count.count ?? 0 });
});
