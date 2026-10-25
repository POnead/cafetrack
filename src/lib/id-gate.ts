import { db } from "./supabase";
import { getIdVerificationRequired } from "./settings";

/**
 * Whether a staff account has to clear ID verification before it can sign in.
 *
 * This is lib/face-gate.ts's sibling and it answers the same kind of question —
 * "is this person cleared to be at the till?" — for the document check rather
 * than the face one. Kept separate because the two switches are independent: a
 * cafe may reasonably want one, the other, both or neither, and folding them
 * together would mean trialling one silently switches everyone to the other.
 *
 * ## Three things resolve to "let them in"
 *
 * **Admins.** Never gated, for the same reason `verificationRequired` in
 * lib/face.ts waves them through: an admin is the person who grants permissions,
 * approves items and resets passwords. Gating one would mean locking the only
 * account that can fix a broken enrolment — and worse, the only account that
 * could approve the ID that is blocking it.
 *
 * **The switch is off.** The default. An account can be verified whatever this
 * says; it only becomes a *requirement* when an admin turns it on.
 *
 * **No ID was ever attached.** An account an admin chose not to put a document
 * on must not become permanently unreachable. This is the one that is a genuine
 * judgement call rather than a free choice: it means the gate cannot be used to
 * *demand* an ID from someone who has not got one — only to stop an account
 * whose document was attached and rejected, or attached and never looked at.
 * That is the trade, and it is the right way round, because the failure mode of
 * the opposite choice is a real person who cannot work.
 */
export type IdGate = {
  required: boolean;
  cleared: boolean;
  status: string;
  /** Present only when `required && !cleared`, for the message at sign-in. */
  message?: string;
};

export async function getIdGate(user: {
  id: string;
  role: string;
  is_active?: boolean;
  verification_status?: string | null;
  id_doc_front?: string | null;
}): Promise<IdGate> {
  const status = String(user.verification_status ?? "unverified");

  if (!(await getIdVerificationRequired())) {
    return { required: false, cleared: true, status };
  }

  if (user.role !== "staff") {
    return { required: true, cleared: true, status };
  }

  if (status === "verified") {
    return { required: true, cleared: true, status };
  }

  // Nothing was ever attached — see the note above.
  if (!user.id_doc_front) {
    return { required: true, cleared: true, status };
  }

  return {
    required: true,
    cleared: false,
    status,
    message:
      status === "rejected"
        ? "This account's ID was not accepted. Ask an administrator to review it."
        : "This account's ID has not been checked yet. Ask an administrator to review it.",
  };
}

/**
 * Read the two columns the gate needs, for a sign-in route that has the account
 * row already.
 *
 * Thin on purpose: the staff sign-in routes select `*`, so they already hold
 * both values and calling this would be a wasted query. It exists for a caller
 * that has only an id.
 */
export async function getIdGateFor(userId: string): Promise<IdGate | null> {
  const { data } = await db()
    .from("users")
    .select("id, role, is_active, verification_status, id_doc_front")
    .eq("id", userId)
    .maybeSingle();

  if (!data) return null;
  return getIdGate(data as Parameters<typeof getIdGate>[0]);
}
