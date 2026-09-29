import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { FieldError, parseMinShelfLifeDays } from "@/lib/item-validation";

export const runtime = "nodejs";

/** Reference list used by the filters on the inventory page. */
export const GET = handler(async () => {
  await requireUser();

  const { data, error } = await db()
    .from("locations")
    .select("id, name, min_shelf_life_days")
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

  // A negative value would be a `check` constraint violation, which reaches the
  // caller as a 500 from a plain bad request, so it is refused as a 400 here.
  let minShelfLife: number | null;
  try {
    minShelfLife = parseMinShelfLifeDays(body.min_shelf_life_days);
  } catch (e: any) {
    if (e instanceof FieldError) return fail(e.message, 400);
    throw e;
  }

  const { data: existing } = await db()
    .from("locations")
    .select("id")
    .eq("name", name)
    .maybeSingle();
  if (existing) return fail("That location already exists", 409);

  const { data, error } = await db()
    .from("locations")
    .insert({ name, min_shelf_life_days: minShelfLife })
    .select("id, name, min_shelf_life_days")
    .single();

  if (error) return fail(error.message, 500);

  await audit(admin, "LOCATION_CREATE", "location", data.id, {
    name,
    min_shelf_life_days: minShelfLife,
  });

  return ok({ item: data }, 201);
});

// Deleting a location lives in ./[id]/route.ts — this path has no id segment.

/* ---------------- update ---------------- */

/**
 * Change a location's name or its minimum shelf life.
 *
 * Needed because the shelf-life rule is stored on the location: without this an
 * admin could set it on create but never change their mind, which would mean
 * recreating the location and re-filing every item in it.
 */
export const PATCH = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const id = String(body.id || "").trim();
  if (!id) return fail("Location id is required", 400);

  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) return fail("Location name is required");
    if (name.length > 60) return fail("Location name must be under 60 characters");
    patch.name = name;
  }

  if (body.min_shelf_life_days !== undefined) {
    try {
      patch.min_shelf_life_days = parseMinShelfLifeDays(body.min_shelf_life_days);
    } catch (e: any) {
      if (e instanceof FieldError) return fail(e.message, 400);
      throw e;
    }
  }

  if (Object.keys(patch).length === 0) return fail("Nothing to update", 400);

  const { data: before } = await db()
    .from("locations")
    .select("id, name, min_shelf_life_days")
    .eq("id", id)
    .maybeSingle();
  if (!before) return fail("Location not found", 404);

  const { data, error } = await db()
    .from("locations")
    .update(patch)
    .eq("id", id)
    .select("id, name, min_shelf_life_days")
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!data) return fail("Location not found", 404);

  await audit(admin, "LOCATION_UPDATE", "location", data.id, {
    from: { name: before.name, min_shelf_life_days: before.min_shelf_life_days },
    to: { name: data.name, min_shelf_life_days: data.min_shelf_life_days },
  });

  return ok({ item: data });
});
