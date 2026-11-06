import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { handler, ok, fail } from "@/lib/api";

export const runtime = "nodejs";

export const GET = handler(async (req: Request) => {
  await requireAdmin();
  const { searchParams } = new URL(req.url);

  if (searchParams.get("pending_count") === "1") {
    const { count, error } = await db()
      .from("duty_bypass_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    if (error) return fail(error.message, 500);
    return ok({ pendingCount: count ?? 0 });
  }

  const status = searchParams.get("status") ?? "pending";
  let query = db()
    .from("duty_bypass_requests")
    .select(
      "id, requested_by, requester_name, requester_username, reason, photo_data, " +
      "requested_at, status, reviewed_by, reviewed_at, review_note, approved_until"
    )
    .order("requested_at", { ascending: false });

  if (status === "pending" || status === "approved" || status === "rejected") {
    query = query.eq("status", status);
  } else if (status !== "all") {
    return fail("Status must be pending, approved, rejected, or all.");
  }

  const { data, error } = await query;
  if (error) return fail(error.message, 500);
  return ok({ requests: data ?? [] });
});
