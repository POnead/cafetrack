import { db } from "./supabase";
import { HttpError, type SessionUser } from "./auth";

/**
 * Append an entry to the hash-chained audit log.
 * The hashing + chaining happens inside a Postgres function so it's atomic.
 *
 * `critical` (the default) makes a failed append throw. The audit trail is a
 * stated security guarantee, so answering "done" for a change that was never
 * recorded is worse than a 500 — the caller is at least told the truth. Note
 * the protected write is usually already committed by the time we get here
 * (the routes call audit() *after* the change), so the message says the change
 * may have landed but went unrecorded.
 *
 * `critical: false` is for calls that record something the request must not be
 * held up for — sign-in attempts and sign-out. Throwing there would turn a
 * rejected password into a 500 and, on sign-out, would skip clearing the
 * session cookie, locking the person out of the app they were leaving.
 */
export async function audit(
  actor: SessionUser | null,
  action: string,
  entityType: string | null,
  entityId: string | null,
  details: Record<string, unknown> = {},
  { critical = true }: { critical?: boolean } = {}
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
    console.error(
      `audit append failed for ${action}` +
        (entityType ? ` on ${entityType}` : "") +
        (entityId ? ` ${entityId}` : "") +
        ":",
      error.message
    );
    if (critical) {
      throw new HttpError(
        500,
        `Could not write the audit record for ${action}. The change may have ` +
          "been applied without being recorded — check and retry."
      );
    }
    return null;
  }
  return data;
}
