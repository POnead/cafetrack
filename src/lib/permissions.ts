import { db } from "./supabase";
import type { SessionUser } from "./auth";

/**
 * Item-management permission (FR-03).
 *
 * Its own module rather than a function in auth.ts, because it needs the
 * database and auth.ts must not import it: supabase -> local-db -> auth is
 * already a chain, and closing it into a loop makes the initialisation order
 * depend on which module the bundler happens to reach first. auth.ts documents
 * the same reasoning for the settings module.
 */

/**
 * Can this person add, edit and delete items directly?
 *
 * Two paths lead to yes, and the difference is deliberate:
 *
 *   - an admin, who always can;
 *   - a staff member an admin granted `can_manage_items`, who therefore skips
 *     the approval step and their changes take effect at once.
 *
 * A staff member without the grant is not refused here. They are allowed to
 * *submit* a new item; the route puts it in the pending state for an admin to
 * approve. That is why this returns a boolean and does not throw — the two cases
 * need different responses, and only the caller knows which one it is handling.
 *
 * Read fresh from the database rather than from the session cookie, so revoking
 * the permission takes effect on the next request instead of at next sign-in.
 */
export async function canManageItems(user: SessionUser): Promise<boolean> {
  if (user.role === "admin") return true;

  const { data } = await db()
    .from("users")
    .select("can_manage_items, is_active")
    .eq("id", user.id)
    .maybeSingle();

  // An account switched off mid-session loses the grant too, rather than keeping
  // write access until its cookie expires.
  return Boolean(data?.is_active && data?.can_manage_items);
}