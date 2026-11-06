import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { eventBus, Events } from "@/lib/events";

export const runtime = "nodejs";

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
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const { id } = await params;

    const malformed = badId(id, "alert");
    if (malformed) return malformed;

    const selectAlert = (includeUpdatedAt: boolean, includeReason: boolean) =>
      db()
        .from("alerts")
        .select(
          `id, type, message, resolved, resolved_by, resolved_at,
           created_at${includeUpdatedAt ? ", updated_at" : ""}${
             includeReason ? ", resolved_reason" : ""
           }, item_id,
           item:items(sku, name, unit, quantity, low_stock_threshold, expiration_date)`
        )
        .eq("id", id)
        .maybeSingle();
    let includeUpdatedAt = true;
    let includeReason = true;
    let { data: alert, error } = await selectAlert(
      includeUpdatedAt,
      includeReason
    );
    while (error) {
      if (isMissingUpdatedAtColumn(error) && includeUpdatedAt) {
        includeUpdatedAt = false;
      } else if (isMissingResolvedReasonColumn(error) && includeReason) {
        includeReason = false;
      } else {
        return fail(error.message, 500);
      }
      ({ data: alert, error } = await selectAlert(
        includeUpdatedAt,
        includeReason
      ));
    }

    if (!alert) return fail("Alert not found", 404);
    alert.updated_at = alert.updated_at ?? alert.created_at;
    alert.resolved_reason = alert.resolved_reason ?? null;

    // Category, location and physical form live on the item row.
    let item: unknown = null;
    let history: unknown[] = [];

    if (alert.item_id) {
      const [itemRes, historyResult] = await Promise.all([
        db()
          .from("items")
          .select(
            `id, sku, name, physical_form, unit, quantity, low_stock_threshold,
             expiration_date, version, updated_at,
             category:categories(id, name), location:locations(id, name),
             supplier:suppliers(id, name, contact_name, phone, email)`
          )
          .eq("id", alert.item_id)
          .maybeSingle(),
        db()
          .from("alerts")
          .select(
            "id, type, message, resolved, resolved_by, resolved_at, resolved_reason, created_at, updated_at"
          )
          .eq("item_id", alert.item_id)
          .order("updated_at", { ascending: false })
          .limit(25),
      ]);
      let historyRes = historyResult;
      let historyHasUpdatedAt = true;
      let historyHasReason = true;
      while (
        isMissingUpdatedAtColumn(historyRes.error) ||
        isMissingResolvedReasonColumn(historyRes.error)
      ) {
        if (isMissingUpdatedAtColumn(historyRes.error)) {
          historyHasUpdatedAt = false;
        }
        if (isMissingResolvedReasonColumn(historyRes.error)) {
          historyHasReason = false;
        }
        historyRes = await db()
          .from("alerts")
          .select(
            `id, type, message, resolved, resolved_by, resolved_at${
              historyHasReason ? ", resolved_reason" : ""
            }, created_at${historyHasUpdatedAt ? ", updated_at" : ""}`
          )
          .eq("item_id", alert.item_id)
          .order(historyHasUpdatedAt ? "updated_at" : "created_at", {
            ascending: false,
          })
          .limit(25);
      }

      if (itemRes.error) return fail(itemRes.error.message, 500);
      if (historyRes.error) return fail(historyRes.error.message, 500);
      item = itemRes.data ?? null;
      history = (historyRes.data ?? []).map((row: any) => ({
        ...row,
        updated_at: row.updated_at ?? row.created_at,
        resolved_reason: row.resolved_reason ?? null,
      }));
    }

    return ok({ alert, item, history });
  }
);

/** Resolve or re-open a single alert. */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    // Resolving is an admin action (FR-08). The GET above stays open to staff so
    // they can see why an item is unavailable, but a barista must not be able to
    // silence a low-stock or expiry alert that an admin still needs to act on.
    const user = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "alert");
    if (malformed) return malformed;
    const body = await readBody(req);
    const resolved = body.resolved !== false;
    const reason =
      typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
    if (resolved && !reason) {
      return fail("Add a reason before resolving this alert");
    }
    const updatedAt = new Date().toISOString();

    const updates = resolved
      ? {
          resolved: true,
          resolved_by: user.fullName,
          resolved_at: updatedAt,
          resolved_reason: reason,
          updated_at: updatedAt,
        }
      : {
          resolved: false,
          resolved_by: null,
          resolved_at: null,
          resolved_reason: null,
          updated_at: updatedAt,
        };
    let { data, error } = await db()
      .from("alerts")
      .update(updates)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (isMissingUpdatedAtColumn(error)) {
      const legacyUpdates = resolved
        ? {
            resolved: true,
            resolved_by: user.fullName,
            resolved_at: updatedAt,
            resolved_reason: reason,
          }
        : {
            resolved: false,
            resolved_by: null,
            resolved_at: null,
            resolved_reason: null,
          };
      ({ data, error } = await db()
        .from("alerts")
        .update(legacyUpdates)
        .eq("id", id)
        .select()
        .maybeSingle());
      if (data) data.updated_at = data.created_at;
    }

    if (isMissingResolvedReasonColumn(error)) {
      return fail(
        "Apply the alerts database migration before resolving alerts with a reason",
        500
      );
    }
    if (error) return fail(error.message, 500);
    if (!data) return fail("Alert not found", 404);

    await audit(
      user,
      resolved ? "ALERT_RESOLVE" : "ALERT_REOPEN",
      "alert",
      data.id,
      {
        type: data.type,
        message: data.message,
        reason: resolved ? reason : null,
      }
    );
    eventBus.emit(Events.ALERTS_CHANGED, { type: "recomputed", count: 1 });

    return ok({ alert: data });
  }
);
