import { db } from "@/lib/supabase";
import { handler, ok, fail, badId } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { providerSummary, type IdSignal } from "@/lib/id-verification";

export const runtime = "nodejs";

/**
 * Everything the review screen needs about one account's ID, in one call.
 *
 * Separate from /api/users/[id]/id because that route's GET serves image *bytes*
 * and this one serves *metadata*. Folding them together would mean the review
 * screen either fetched every image to read a status, or fetched a status and
 * had to guess whether the images were already loaded.
 *
 * The signals and extracted fields are here rather than on the staff list. They
 * are small, but they are only read when someone is actually reviewing, and the
 * list is fetched on every page load by a page an admin opens constantly.
 *
 * Admin-only for the same reason the images are: the proxy establishes that a
 * session exists, not which account it is, so this would otherwise let any
 * staff member read any other staff member's ID details.
 */

const REVIEW_COLUMNS =
  "id, full_name, username, role, is_active, verification_status, id_doc_type, " +
  "id_doc_number, id_fields, id_signals, id_provider, verification_notes, " +
  "verified_at, verified_by, id_doc_front is not null as has_front, " +
  "id_doc_back is not null as has_back, id_photo is not null as has_photo";

export const GET = handler(
  async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("users")
      .select(REVIEW_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("User not found", 404);

    return ok({
      user: data,
      // Same defensive parse as the review route: a null or hand-edited column
      // renders an empty list rather than failing the screen.
      signals: Array.isArray(data.id_signals) ? (data.id_signals as IdSignal[]) : [],
      fields: (data.id_fields ?? {}) as Record<string, string | null>,
      // Which engines are available *now*, so the upload form can say what will
      // run before anything is attached rather than after.
      providers: await providerSummary(),
    });
  }
);
