import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Approve or reject a queued item edit (FR-03). Admin only. */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const id = String(body.id || "").trim();

  const malformed = badId(id, "change request");
  if (malformed) return malformed;

  const decision = String(body.decision || "");
  if (decision !== "approve" && decision !== "reject") {
    return fail("Decision must be approve or reject");
  }

  const note = body.note ? String(body.note).slice(0, 500) : null;

  const { data, error } = await db().rpc("review_change_request", {
    p_request_id: id,
    p_actor_id: admin.id,
    p_decision: decision,
    p_note: note,
  });

  if (error) return fail(error.message.replace(/^P0001:\s*/, ""), 409);

  await audit(
    admin,
    decision === "approve" ? "ITEM_CHANGE_APPROVE" : "ITEM_CHANGE_REJECT",
    "item",
    (data as any)?.item_id ?? null,
    { request_id: id, note },
    { ip: clientIp(req), outcome: "success" }
  );

  await db().rpc("refresh_alerts");

  return ok({
    request: data,
    message:
      decision === "approve"
        ? "Change applied to the item"
        : "Change request rejected",
  });
});
