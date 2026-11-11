import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, dbFail } from "@/lib/api";
import { clearSessionCache, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const PATCH = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const fullName = String(body.full_name ?? "").trim();
  if (!fullName) return fail("Admin name cannot be empty");
  if (fullName.length > 80) return fail("Admin name must be 80 characters or fewer");

  const { data, error } = await db()
    .from("users")
    .update({ full_name: fullName })
    .eq("id", admin.id)
    .select("id, full_name")
    .maybeSingle();
  if (error) return dbFail(error);
  if (!data) return fail("Admin account not found", 404);

  clearSessionCache();
  await audit(admin, "ADMIN_NAME_UPDATE", "user", admin.id, {
    full_name: data.full_name,
  });
  return ok({ user: data });
});
