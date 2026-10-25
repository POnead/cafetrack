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

  // Paging (NFR-05). `audit_log` is append-only and grows forever, so offset
  // paging over the whole table would mean an ever-growing OFFSET scan and a
  // table that eventually refuses to answer. `before` is the seq to start below,
  // which is stable: the chain only ever appends, so a row that has a seq now
  // still has it later, and a page fetched twice returns the same rows.
  //
  // The previous page's `before` is simply the seq of its oldest entry, so the
  // client needs no page numbers — which is also why the UI says "newest 200 of
  // 1,940" rather than pretending it is showing page 1 of 10.
  const beforeRaw = searchParams.get("before");
  const before = Number(beforeRaw);
  // `>= 0` rather than `> 0`: a `before` of 0 is a legitimate request for the
  // rows before the first sequence number, and the honest answer to it is an
  // empty page. Treating it as absent would silently hand back the newest page
  // instead, which looks like the request was ignored.
  const hasBefore =
    beforeRaw !== null && Number.isSafeInteger(before) && before >= 0;

  let query = db()
    .from("audit_log")
    .select(
      // ip_address and outcome are written by lib/audit.ts but were never
      // selected here, so they were stored and then invisible — an ERD column
      // nobody can read is not a feature.
      "seq, actor_id, actor_name, action, entity_type, entity_id, details, ip_address, outcome, created_at"
    )
    .order("seq", { ascending: false })
    .limit(limit + 1);

  if (hasBefore) query = query.lt("seq", before);

  // Two queries in parallel: the newest page of rows, and the total number of
  // rows in the table. The total is what lets the UI say "200 of 388" instead
  // of silently showing a window whose first row looks like a random start.
  const [page, count] = await Promise.all([
    query,
    db()
      .from("audit_log")
      .select("seq", { count: "exact", head: true }),
  ]);

  if (page.error) return fail(page.error.message, 500);
  if (count.error) return fail(count.error.message, 500);

  const rows = (page.data ?? []) as Array<{ seq: number }>;

  // One row over the limit is fetched so this can say "there is another page"
  // without a second count query — the UI needs that answer to decide whether
  // to offer "load older".
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;

  return ok({
    entries,
    total: count.count ?? 0,
    has_more: hasMore,
    // The seq to send back as `before`. Null on the last page.
    next_before: hasMore ? entries[entries.length - 1]?.seq ?? null : null,
  });
});
