import { db } from "./supabase";
import { HttpError, type SessionUser } from "./auth";

/**
 * Append an entry to the hash-chained audit log.
 *
 * `ip_address` and `outcome` are recorded beside the hash, never inside it —
 * see the column comments in db/schema.sql. They are filled in automatically:
 * the client address comes from the request when a route has one, and a denied
 * action is recorded with outcome 'denied' by the routes that reject something.
 *
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
  { critical = true, ip = null, outcome }: {
    critical?: boolean;
    ip?: string | null;
    outcome?: string | null;
  } = {}
) {
  // Defaulting to "success" rather than leaving it null: almost every call here
  // is reached only after the change it describes has already been made, so a
  // blank outcome would mean "unknown" on the majority of rows and make the
  // column useless for the question it exists to answer — which entries did not
  // work. The routes that record a refusal say so explicitly.
  const finalOutcome = outcome ?? "success";

  const { data, error } = await db().rpc("append_audit", {
    p_actor_id: actor?.id ?? null,
    p_actor_name: actor?.fullName ?? "anonymous",
    p_action: action,
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_details: details,
    p_ip_address: ip,
    p_outcome: finalOutcome,
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
