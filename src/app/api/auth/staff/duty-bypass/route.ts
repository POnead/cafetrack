import { db } from "@/lib/supabase";
import { audit } from "@/lib/audit";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { readStep2Ticket } from "@/lib/auth/step2-ticket";

export const runtime = "nodejs";

const MAX_PHOTO_BYTES = 300 * 1024;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

function schemaNotInstalled(message: string): boolean {
  return (
    /duty_bypass_requests.*(does not exist|not found|schema cache)/i.test(message) ||
    /(?:relation|table).*duty_bypass_requests.*(?:does not exist|not found|schema cache)/i.test(
      message
    )
  );
}

function schemaSetupFailure() {
  return fail(
    "Face-check requests are not enabled on this database yet. Ask an administrator to apply the updated db/schema.sql, then try again.",
    503
  );
}

export const POST = handler(async (req: Request) => {
  const body = await readBody(req);
  const ticketToken = String(body.ticket ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  const photoData = String(body.photo_data ?? "");

  if (!ticketToken) return fail("Sign-in attempt expired. Enter your password again.", 401, { expired: true });
  if (reason.length < 5 || reason.length > 500) {
    return fail("Please enter a reason between 5 and 500 characters.");
  }

  const photoMatch = JPEG_DATA_URL.exec(photoData);
  if (!photoMatch) return fail("Take a new photo before sending the request.");
  const photoBytes = Buffer.from(photoMatch[1], "base64");
  if (photoBytes.length === 0 || photoBytes.length > MAX_PHOTO_BYTES) {
    return fail("The photo is too large. Retake it and try again.");
  }

  const ticket = await readStep2Ticket(ticketToken);
  if (!ticket) return fail("Sign-in attempt expired. Enter your password again.", 401, { expired: true });

  const { data: user, error: userError } = await db()
    .from("users")
    .select("id, username, full_name, role, is_active, step2_nonce")
    .eq("id", ticket.userId)
    .eq("role", "staff")
    .maybeSingle();

  if (userError) {
    console.error("duty bypass request account lookup failed:", userError.message);
    return fail("Could not verify this sign-in. Try again.", 503);
  }
  if (!user || !user.is_active) return fail("This staff account is not active.", 403);
  if (!user.step2_nonce || user.step2_nonce !== ticket.nonce) {
    return fail("Sign-in attempt expired. Enter your password again.", 401, { expired: true });
  }

  const database = db();
  const { data: existing, error: pendingError } = await database
    .from("duty_bypass_requests")
    .select("id")
    .eq("requested_by", user.id)
    .eq("status", "pending")
    .maybeSingle();

  if (pendingError) {
    console.error("duty bypass pending request lookup failed:", pendingError.message);
    if (schemaNotInstalled(pendingError.message)) return schemaSetupFailure();
    return fail("Could not check for an existing request.", 503);
  }
  if (existing) return fail("You already have a face-check request waiting for an admin.", 409);

  const { data: request, error: insertError } = await database
    .from("duty_bypass_requests")
    .insert({
      requested_by: user.id,
      requester_name: user.full_name,
      requester_username: user.username,
      reason,
      photo_data: photoData,
    })
    .select("id, status, requested_at")
    .single();

  if (insertError) {
    if (/duty_bypass_requests_one_pending_per_user|duplicate key/i.test(insertError.message)) {
      return fail("You already have a face-check request waiting for an admin.", 409);
    }
    console.error("duty bypass request insert failed:", insertError.message);
    if (schemaNotInstalled(insertError.message)) return schemaSetupFailure();
    return fail("Could not send the request. Try again.", 500);
  }

  await audit(
    { id: user.id, username: user.username, fullName: user.full_name, role: "staff" },
    "DUTY_BYPASS_REQUEST",
    "user",
    user.id,
    { request_id: request.id, reason },
    { ip: clientIp(req), outcome: "success" }
  );

  return ok({ request, message: "Your request was sent to an administrator." }, 201);
});
