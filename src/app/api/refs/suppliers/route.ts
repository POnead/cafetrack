import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Reference list used by the item form's Supplier dropdown. */
export const GET = handler(async () => {
  await requireUser();

  const { data, error } = await db()
    .from("suppliers")
    .select("id, name, contact_name, phone, email")
    .order("name", { ascending: true });

  if (error) return fail(error.message, 500);

  return ok({ items: data ?? [] });
});

/* ---------------- create ---------------- */

export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const name = String(body.name || "").trim();
  if (!name) return fail("Supplier name is required");
  if (name.length > 120) return fail("Supplier name must be under 120 characters");

  const contactName =
    body.contact_name != null ? String(body.contact_name).trim() || null : null;
  const phone =
    body.phone != null ? String(body.phone).trim() || null : null;
  const email =
    body.email != null ? String(body.email).trim() || null : null;

  if (contactName && contactName.length > 120)
    return fail("Contact name must be under 120 characters");
  if (phone && phone.length > 40)
    return fail("Phone must be under 40 characters");
  if (email && email.length > 120)
    return fail("Email must be under 120 characters");

  // Names are a user-facing label; treat a duplicate as a conflict
  // rather than letting the database error surface.
  const { data: existing } = await db()
    .from("suppliers")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (existing) return fail("That supplier already exists", 409);

  const { data, error } = await db()
    .from("suppliers")
    .insert({ name, contact_name: contactName, phone, email })
    .select("id, name, contact_name, phone, email")
    .single();

  if (error) return fail(error.message, 500);

  await audit(admin, "SUPPLIER_CREATE", "supplier", data.id, { name });

  return ok({ item: data }, 201);
});