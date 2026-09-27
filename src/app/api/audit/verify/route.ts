import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Recomputes the hash chain in the database. An empty result means every
 * entry still matches its predecessor, i.e. nobody edited history.
 */
export const GET = handler(async () => {
  await requireAdmin();

  const { data, error } = await db().rpc("verify_audit_chain");
  if (error) return fail(error.message, 500);

  const broken = (data ?? []) as { broken_seq: number; reason: string }[];

  return ok({ intact: broken.length === 0, broken });
});
