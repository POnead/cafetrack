import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { dispatchSoon } from "@/lib/email";

export const runtime = "nodejs";

/**
 * Approve or reject a submitted item (FR-03).
 *
 * Staff without `can_manage_items` can put an ingredient in, but it sits in the
 * pending state until this endpoint says otherwise. Approving is the moment the
 * item becomes real stock, so it fires refresh_alerts here — otherwise a
 * low-quantity ingredient an admin just approved would stay invisible to the
 * alert system until the next unrelated movement.
 *
 * Refuses an item that is not pending, so a double-click cannot stamp a second
 * reviewer over the first.
 */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const id = String(body.id || "").trim();

  const malformed = badId(id, "item");
  if (malformed) return malformed;

  const decision = String(body.decision || "");
  if (decision !== "approve" && decision !== "reject") {
    return fail("Decision must be approve or reject");
  }

  const note = body.note ? String(body.note).slice(0, 500) : null;

  const { data, error } = await db().rpc("review_item", {
    p_item_id: id,
    p_actor_id: admin.id,
    p_decision: decision,
    p_note: note,
  });

  // review_item raises a readable message for the two refusals that matter, so
  // they arrive as 409s rather than server faults.
  if (error) return fail(error.message.replace(/^P0001:\s*/, ""), 409);

  await audit(
    admin,
    decision === "approve" ? "ITEM_APPROVE" : "ITEM_REJECT",
    "item",
    id,
    {
      sku: (data as any)?.sku,
      name: (data as any)?.name,
      note,
    },
    { ip: clientIp(req), outcome: "success" }
  );

  // An approved item can now be short or expiring, so let the alert pass run.
  await db().rpc("refresh_alerts");

  // A freshly approved item may deserve an email if it is already low or
  // near-expiry; this is the moment those alerts get raised.
  dispatchSoon();

  return ok({
    item: data,
    message:
      decision === "approve"
        ? `${(data as any)?.name} is approved and now counted as stock`
        : `${(data as any)?.name} was rejected`,
  });
});