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

  const { data, error } = await db()
    .from("audit_log")
    .select(
      "seq, actor_id, actor_name, action, entity_type, entity_id, details, created_at"
    )
    .order("seq", { ascending: false })
    .limit(limit);

  if (error) return fail(error.message, 500);

  return ok({ entries: data ?? [] });
});
