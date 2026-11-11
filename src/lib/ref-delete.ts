import { db } from "@/lib/supabase";
import { fail, dbFail } from "@/lib/api";
import { requireAdmin, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";

/**
 * Shared delete for a settings reference list.
 *
 * The reference may already be linked to inventory. Checking first lets the
 * API refuse the deletion with a useful explanation instead of silently
 * changing or hiding that relationship.
 *
 * `limit(1)` keeps it to a single-row probe; the local adapter supports it.
 */
export async function deleteRef(opts: {
  table: string;
  column: string;
  id: string;
  noun: string;
  action: string;
  reason: unknown;
  confirmPassword: unknown;
}) {
  const { table, column, id, noun, action } = opts;
  const admin = await requireAdmin();
  const reason = String(opts.reason ?? "").trim();
  const confirmPassword = String(opts.confirmPassword ?? "");

  if (!reason) return fail("Give a reason for removing this record", 400);
  if (reason.length > 500) return fail("The removal reason must be 500 characters or fewer", 400);
  if (!confirmPassword) return fail("Enter your password to confirm removal", 400);

  const { data: adminRow, error: adminError } = await db()
    .from("users")
    .select("password_hash")
    .eq("id", admin.id)
    .maybeSingle();

  if (adminError) return dbFail(adminError, { context: "reference delete lookup" });
  if (
    !adminRow?.password_hash ||
    !verifyPassword(confirmPassword, adminRow.password_hash)
  ) {
    return fail("That password is not correct", 401);
  }

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
  if (error) return dbFail(error, { context: "reference delete" });

  await audit(admin, action, noun, id, { name: row.name, reason });

  return null;
}
