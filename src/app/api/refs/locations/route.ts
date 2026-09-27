import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";

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
