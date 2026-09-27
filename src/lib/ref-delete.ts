import { db } from "@/lib/supabase";
import { fail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

/**
 * Shared delete for a reference list (categories / locations).
 *
 * Both are referenced by `items.<column>_id` with no ON DELETE behaviour, so
 * removing a row that is still assigned would leave those items pointing at
 * nothing — invisible in the UI, since the item page renders a missing
 * reference as "—". So the in-use check is the point of this function.
 *
 * `limit(1)` keeps it to a single-row probe; the local adapter supports it.
 */
export async function deleteRef(opts: {
  table: string;
  column: string;
  id: string;
  label: string;
  noun: string;
  action: string;
}) {
  const { table, column, id, label, noun, action } = opts;
  const admin = await requireAdmin();

  const { data: row } = await db()
    .from(table)
    .select("id, name")
    .eq("id", id)
    .maybeSingle();

  if (!row) return fail(`That ${noun} no longer exists`, 404);

  const { data: used } = await db()
    .from("items")
    .select("id")
    .eq(column, id)
    .limit(1);

  if (used && used.length > 0) {
    return fail(
      `Cannot delete "${row.name}" — items are still assigned to it`,
      409
    );
  }

  const { error } = await db().from(table).delete().eq("id", id);
  if (error) return fail(error.message, 500);

  await audit(admin, action, noun, id, { name: row.name });

  return null;
}
