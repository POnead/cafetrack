import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Reference list used by the filters on the inventory page. */
export const GET = handler(async () => {
  await requireUser();

  const { data, error } = await db()
    .from("locations")
    .select("id, name")
    .order("name", { ascending: true });

  if (error) return fail(error.message, 500);

  return ok({ items: data ?? [] });
});

/* ---------------- create ---------------- */

export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const name = String(body.name || "").trim();
  if (!name) return fail("Location name is required");
  if (name.length > 60) return fail("Location name must be under 60 characters");

  const { data: existing } = await db()
    .from("locations")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (existing) return fail("That location already exists", 409);

  const { data, error } = await db()
    .from("locations")
    .insert({ name })
    .select("id, name")
    .single();

  if (error) return fail(error.message, 500);

  await audit(admin, "LOCATION_CREATE", "location", data.id, { name });

  return ok({ item: data }, 201);
});

// Deleting a location lives in ./[id]/route.ts — this path has no id segment.
