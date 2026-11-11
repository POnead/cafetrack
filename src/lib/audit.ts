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
 * ## Ordering, honestly
 *
 * The hashing + chaining happens inside a Postgres function so a single append
 * is atomic. But the *mutation being described* is a separate PostgREST request,
 * and PostgREST has no cross-request transaction, so the routes call audit()
 * after the change. A hard database outage between the two means the change
 * lands unrecorded. Closing that gap fully would mean moving every mutation
 * into a Postgres function that audits internally — a rewrite out of proportion
 * for a single-café deployment — so what is done here is the next best thing:
 *
 *   - the append is retried against the errors that actually happen most
 *     (a race on the exclusive lock the chain takes, a connection that died
 *     mid-request), which is where the gaps were realistically being lost;
 *   - a retry can, in the rare "committed but the response was lost" case,
 *     produce a *duplicate* entry rather than a missing one. On a hash chain
 *     that is the right failure direction: a duplicate is visible in the log,
 *     a gap is not.
 *
 * `critical` (the default) makes a failed append throw. The audit trail is a
 * stated security guarantee, so answering "done" for a change that was never
 * recorded is worse than a 500 — the caller is at least told the truth. Note
 * the protected write is usually already committed by the time we get here
 * (the routes call audit() *after* the change), so the message warns against
 * blindly re-submitting the request: a retried checkout would move the stock
 * twice while the first one is already committed.
 *
 * `critical: false` is for calls that record something the request must not be
 * held up for — sign-in attempts and sign-out. Throwing there would turn a
 * rejected password into a 500 and, on sign-out, would skip clearing the
 * session cookie, locking the person out of the app they were leaving.
 */

/** Postgres error codes a second attempt plausibly fixes. */
const RETRYABLE_CODES = new Set([
  "40001", // serialization_failure — two appends raced on a snapshot
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "53300", // too_many_connections
  "53400", // configuration_limit_reached (connection slots)
  "08000", // connection_exception …
  "08001", // connection_does_not_exist
  "08003", // connection_does_not_exist
  "08006", // connection_failure — died mid-request
  "08007", // connection_unknown
]);

function isTransientAuditError(error: {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}): boolean {
  if (!error) return false;
  if (RETRYABLE_CODES.has(String(error.code ?? ""))) return true;
  // Local mode and network-layer failures surface without a Postgres code:
  // match the words they actually say rather than the families they don't.
  return /deadlock|lock timeout|serializ|connection|fetch failed|network|reset by peer|timeout/i.test(
    `${error.message ?? ""} ${error.details ?? ""}`
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How hard to fight for one entry. Two retries is ~1s in the worst case. */
const MAX_ATTEMPTS = 3;

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

  let lastError: {
    code?: string | null;
    message?: string | null;
    details?: string | null;
  } | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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

    if (!error) return data;
    lastError = error;

    const transient = isTransientAuditError(error);
    if (transient && attempt < MAX_ATTEMPTS) {
      // eslint-disable-next-line no-console
      console.warn(
        `audit append for ${action}` +
          (entityType ? ` on ${entityType}` : "") +
          (entityId ? ` ${entityId}` : "") +
          ` hit a transient error ("${error.message ?? "unknown"}"); retrying ` +
          `(${attempt}/${MAX_ATTEMPTS - 1})`
      );
      await sleep(attempt * 250);
      continue;
    }
    break;
  }

  const error = lastError;
  console.error(
    `audit append failed for ${action}` +
      (entityType ? ` on ${entityType}` : "") +
      (entityId ? ` ${entityId}` : "") +
      " after " +
      MAX_ATTEMPTS +
      " attempt(s):",
    error?.message
  );
  if (critical) {
    throw new HttpError(
      500,
      `Could not write the audit record for ${action}. The change may have ` +
        "been applied without being recorded — do not simply re-submit the " +
        "same request, as the change itself may already have gone through. " +
        "Check the affected record first."
    );
  }
  return null;
}
