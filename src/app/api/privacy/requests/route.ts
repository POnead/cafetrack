import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp, dbFail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const user = await requireUser();
  const { data, error } = await db()
    .from("privacy_requests")
    .select("id,request_type,status,details,requested_at,resolved_at,resolution")
    .eq("user_id", user.id)
    .order("requested_at", { ascending: false });
  if (error) return dbFail(error);
  return ok({ requests: data ?? [] });
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = await readBody(req);
  const requestType = String(body.requestType ?? "").trim();
  const details = String(body.details ?? "").trim();
  if (!["access", "correction", "erasure", "appeal"].includes(requestType)) {
    return fail("Invalid privacy request type");
  }
  if (details.length < 3 || details.length > 2000) {
    return fail("Provide details between 3 and 2000 characters");
  }

  const { data, error } = await db()
    .from("privacy_requests")
    .insert({
      user_id: user.id,
      request_type: requestType,
      details,
    })
    .select("id,request_type,status,details,requested_at")
    .maybeSingle();
  if (error) return dbFail(error);

  await audit(
    user,
    "PRIVACY_REQUEST_SUBMIT",
    "user",
    user.id,
    { request_type: requestType },
    { ip: clientIp(req), outcome: "received" }
  );
  return ok({ request: data }, 201);
});
