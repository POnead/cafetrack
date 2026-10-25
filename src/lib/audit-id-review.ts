import { audit } from "./audit";
import { clientIp } from "./api";
import type { SessionUser } from "./auth";

/**
 * The audit entry for an approve/reject decision.
 *
 * Its own module for one reason that is worth stating plainly.
 *
 * **The audit log is append-only and hash-chained.** `append_audit` takes an
 * exclusive lock on the table and links each entry to the one before it, so an
 * entry cannot be edited or removed without breaking `verify_audit_chain` — which
 * is the point, and which also means anything written there is permanent by
 * design.
 *
 * That makes it the wrong place for a national ID number, a name read off a
 * government card, or a face-similarity figure. None of those need to be in the
 * log to answer "who decided this account was verified, when, and on what". What
 * belongs there is the decision, the reason, and a count of what the checks
 * said. The evidence stays on the user row, where an admin with the right to see
 * it can, and where it can also be removed.
 *
 * Keeping that rule in one small function rather than inline in the route means
 * the second caller cannot get it wrong by forgetting.
 */

export type IdReviewAuditInput = {
  admin: SessionUser;
  req: Request;
  user: { id: string; username: string; full_name: string };
  decision: "approve" | "reject";
  reason: string;
  previousStatus: string | null;
  provider: string | null;
  /** Tally of the stored signals, so the log says what the admin was looking at. */
  signalCounts?: { pass: number; warn: number; fail: number; unknown: number };
};

export async function auditIdReview(input: IdReviewAuditInput): Promise<void> {
  const { admin, req, user, decision, reason, previousStatus, provider } = input;

  await audit(
    admin,
    decision === "approve" ? "USER_ID_VERIFY_APPROVE" : "USER_ID_VERIFY_REJECT",
    "user",
    user.id,
    {
      username: user.username,
      full_name: user.full_name,
      previous_status: previousStatus,
      reason: reason || null,
      // Which engine produced the evidence, so a stored decision can be read
      // years later with the right context. Not the evidence itself.
      provider,
      // How many checks passed, warned, failed or could not run. Enough to tell
      // an "approved despite two warnings" from a clean approval, without
      // recording the similarity numbers that produced them.
      ...(input.signalCounts ?? {}),
    },
    { ip: clientIp(req) }
  );
}
