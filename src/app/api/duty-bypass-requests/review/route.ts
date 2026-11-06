import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { handler, ok, fail, badId, readBody, clientIp } from "@/lib/api";

export const runtime = "nodejs";

function endOfCafeDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const nextMidnightUtc =
    Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1) -
    8 * 60 * 60 * 1000;
  return new Date(nextMidnightUtc).toISOString();
}

export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const id = String(body.id ?? "").trim();
  const malformed = badId(id, "duty bypass request");
  if (malformed) return malformed;

  const decision = String(body.decision ?? "");
  if (decision !== "approve" && decision !== "reject") {
    return fail("Decision must be approve or reject.");
  }
  const note = body.note ? String(body.note).trim().slice(0, 500) : null;
  const approvedUntil = decision === "approve" ? endOfCafeDay(new Date()) : null;

  const { data: request, error } = await db()
    .from("duty_bypass_requests")
    .update({
      status: decision === "approve" ? "approved" : "rejected",
      reviewed_by: admin.id,
      reviewed_at: new Date().toISOString(),
      review_note: note,
      approved_until: approvedUntil,
      photo_data: null,
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, requested_by, requester_name, requester_username, status, approved_until")
    .maybeSingle();

  if (error) {
    console.error("duty bypass request decision failed:", error.message);
    return fail("Could not save this decision.", 500);
  }
  if (!request) return fail("This request is no longer waiting for a decision.", 409);

  await audit(
    admin,
    decision === "approve" ? "DUTY_BYPASS_APPROVE" : "DUTY_BYPASS_REJECT",
    "user",
    request.requested_by,
    {
      request_id: request.id,
      requester_username: request.requester_username,
      note,
      approved_until: request.approved_until,
    },
    { ip: clientIp(req), outcome: "success" }
  );

  return ok({
    request,
    message:
      decision === "approve"
        ? `Face-check bypass approved for ${request.requester_name} until the end of today.`
        : `Face-check bypass declined for ${request.requester_name}.`,
  });
});
