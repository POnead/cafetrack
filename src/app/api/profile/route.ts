import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, dbFail } from "@/lib/api";
import { clearSessionCache, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const session = await requireUser();
  if (session.role !== "staff") {
    return fail("This page is for staff only.", 403);
  }
  /*
   * `has_id_doc` is a boolean, not the document itself. The ID images are
   * hundreds of kilobytes each and only an admin may read them through
   * /api/users/[id]/id; this route just needs to know whether there is one so
   * My Profile can show an ID card instead of an empty section.
   */
  const { data, error } = await db()
    .from("users")
    .select(
      "id, username, full_name, role, position, start_date, recovery_email, is_active, " +
        "qr_token, verification_status, id_doc_type, id_doc_expiry, verified_at, " +
        "id_doc_front is not null as has_id_doc"
    )
    .eq("id", session.id)
    .maybeSingle();

  if (error) return dbFail(error);
  if (!data || data.is_active === false) return fail("Account not found", 404);
  return ok({
    profile: {
      ...data,
      full_name: data.full_name || "Admin",
      role: session.role,
    },
  });
});

export const PATCH = handler(async (req: Request) => {
  const session = await requireUser();
  if (session.role !== "staff") {
    return fail("This page is for staff only.", 403);
  }
  const body = await readBody(req);
  const fullName = String(body.full_name ?? "").trim();
  if (!fullName) return fail("Name cannot be empty");
  if (fullName.length > 80) return fail("Name must be 80 characters or fewer");

  const { data, error } = await db()
    .from("users")
    .update({ full_name: fullName })
    .eq("id", session.id)
    .eq("is_active", true)
    .select("id, username, full_name")
    .maybeSingle();
  if (error) return dbFail(error);
  if (!data) return fail("Account not found or inactive", 404);

  clearSessionCache();
  await audit(session, "PROFILE_NAME_UPDATE", "user", session.id, {
    full_name: data.full_name,
  });
  return ok({ profile: data });
});
