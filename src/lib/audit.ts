import { db } from "./supabase";
import type { SessionUser } from "./auth";

/**
 * Append an entry to the hash-chained audit log.
 * The hashing + chaining happens inside a Postgres function so it's atomic.
 */
export async function audit(
  actor: SessionUser | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> = {}
) {
  const { data, error } = await db().rpc("append_audit", {
    p_actor_id: actor?.id ?? null,
    p_actor_name: actor?.fullName ?? "anonymous",
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_details: details,
  });

  if (error) {
    console.error("audit append failed:", error.message);
    return null;
  }
  return data;
}
