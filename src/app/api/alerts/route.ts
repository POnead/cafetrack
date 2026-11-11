import { db } from "@/lib/supabase";
import { handler, ok, fail, clientIp, dbFail } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

function isMissingAlertsSeenColumn(error: { message?: string } | null): boolean {
  return Boolean(
    error?.message?.includes("alerts_seen_at") &&
      error.message.toLowerCase().includes("does not exist")
  );
}

function isMissingUpdatedAtColumn(error: { message?: string } | null): boolean {
  return Boolean(
    error?.message?.includes("updated_at") &&
      error.message.toLowerCase().includes("does not exist")
  );
}

function isMissingResolvedReasonColumn(
  error: { message?: string } | null
): boolean {
  return Boolean(
    error?.message?.includes("resolved_reason") &&
      error.message.toLowerCase().includes("does not exist")
  );
}

/* ---------------- list ---------------- */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();

  const { searchParams } = new URL(req.url);
  if (searchParams.get("unread_count") === "1") {
    const { data: account, error: accountError } = await db()
      .from("users")
      .select("alerts_seen_at")
      .eq("id", user.id)
      .maybeSingle();
    if (accountError && !isMissingAlertsSeenColumn(accountError)) {
      return dbFail(accountError, { context: "alerts staff read" });
    }
    if (!accountError && !account) return fail("User account not found", 404);

    const persisted = !accountError;
    let seenAt = persisted ? account.alerts_seen_at : searchParams.get("seen_at");
    if (seenAt && Number.isNaN(Date.parse(seenAt))) {
      return fail("seen_at must be a valid date");
    }
    if (!persisted && !seenAt) seenAt = new Date().toISOString();

    // Open alerts only. A resolved alert is work that was dealt with; counting
    // it as unread meant that resolving one — which bumps its updated_at —
    // raised the badge again for everyone, including staff who had just cleared
    // it and cannot resolve anything themselves.
    let unreadQuery = db()
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .eq("resolved", false);
    if (seenAt) {
      unreadQuery = unreadQuery.gt("updated_at", seenAt);
    }

    let { count, error } = await unreadQuery;
    if (isMissingUpdatedAtColumn(error)) {
      let legacyQuery = db()
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .eq("resolved", false);
      if (seenAt) legacyQuery = legacyQuery.gt("created_at", seenAt);
      ({ count, error } = await legacyQuery);
    }
    if (error) return dbFail(error);
    return ok({ unreadCount: count ?? 0, persisted });
  }

  const status = searchParams.get("status") ?? "all";
  if (!["open", "resolved", "all"].includes(status)) {
    return fail("Status must be open, resolved, or all");
  }
  const requestedLimit = Number(searchParams.get("limit") ?? 500);
  const limit = Math.min(
    Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 500, 1),
    500
  );
  const offsetValue = searchParams.get("offset") ?? "0";
  const offset = Number(offsetValue);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > Number.MAX_SAFE_INTEGER - limit + 1
  ) {
    return fail("Offset must be a non-negative whole number");
  }

  const alertColumns = (
    includeUpdatedAt: boolean,
    includeResolvedReason: boolean
  ) =>
    [
      "id",
      "type",
      "message",
      "resolved",
      "resolved_by",
      "resolved_at",
      ...(includeResolvedReason ? ["resolved_reason"] : []),
      "created_at",
      ...(includeUpdatedAt ? ["updated_at"] : []),
      "item_id",
      "item:items(sku, name, unit, quantity, low_stock_threshold, expiration_date, supplier_id)",
    ].join(", ");
  const queryAlerts = (
    includeUpdatedAt: boolean,
    includeResolvedReason: boolean
  ) => {
    let query = db()
      .from("alerts")
      .select(alertColumns(includeUpdatedAt, includeResolvedReason))
      .order(includeUpdatedAt ? "updated_at" : "created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    if (status === "open") query = query.eq("resolved", false);
    if (status === "resolved") query = query.eq("resolved", true);
    return query;
  };

  let includeUpdatedAt = true;
  let includeResolvedReason = true;
  let { data, error } = await queryAlerts(
    includeUpdatedAt,
    includeResolvedReason
  );
  while (error) {
    if (isMissingUpdatedAtColumn(error) && includeUpdatedAt) {
      includeUpdatedAt = false;
    } else if (isMissingResolvedReasonColumn(error) && includeResolvedReason) {
      includeResolvedReason = false;
    } else {
      return dbFail(error, { context: "alerts list" });
    }
    ({ data, error } = await queryAlerts(
      includeUpdatedAt,
      includeResolvedReason
    ));
  }

  /*
   * During a schema rollout, use the raised timestamp and no resolution
   * explanation until the additive alert columns have been applied.
   */
  const alerts = ((data ?? []) as any[]).map((alert) => ({
    ...alert,
    updated_at: alert.updated_at ?? alert.created_at,
    resolved_reason: alert.resolved_reason ?? null,
  }));

  /*
   * Attach the item's supplier, so a low-stock alert can say who to call.
   *
   * The alert row embeds its item, but a second embed inside that item is not a
   * path the local adapter knows how to join, so suppliers are fetched as one
   * extra query and stitched on. Two queries for up to 500 alerts, and only for
   * the suppliers actually referenced.
   */
  const supplierIds = [
    ...new Set(
      alerts
        .map((a) => a.item?.supplier_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ),
  ];

  if (supplierIds.length > 0) {
    const { data: suppliers, error: supplierError } = await db()
      .from("suppliers")
      .select("id, name, contact_name, phone, email")
      .in("id", supplierIds);
    if (supplierError) return dbFail(supplierError, { context: "alerts supplier list" });

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

/* ---------------- mark alerts seen ---------------- */
export const PATCH = handler(async () => {
  const user = await requireUser();
  const seenAt = new Date().toISOString();
  const { data, error } = await db()
    .from("users")
    .update({ alerts_seen_at: seenAt })
    .eq("id", user.id)
    .select("id")
    .maybeSingle();

  if (isMissingAlertsSeenColumn(error)) {
    return ok({ seenAt, persisted: false });
  }
  if (error) return dbFail(error);
  if (!data) return fail("User account not found", 404);

  return ok({ seenAt, persisted: true });
});

/* ---------------- force a recompute ---------------- */
// refresh_alerts is idempotent, so this is safe to fire from the UI button.
//
// Admin-only: recomputing rewrites open alerts across the whole inventory, so
// it is a supervisory action, not something a barista can trigger. Staff can
// still *read* alerts (GET above) — only this mutation is gated.
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();

  const { error } = await db().rpc("refresh_alerts");
  if (error) return dbFail(error);

  await audit(
    admin,
    "ALERTS_RECOMPUTE",
    "alerts",
    null,
    { source: "manual_refresh" },
    { ip: clientIp(req) }
  );

  return ok({ ok: true });
});
