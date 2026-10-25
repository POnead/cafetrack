import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { readStep2Ticket } from "@/lib/auth/step2-ticket";

export const runtime = "nodejs";

/**
 * Return the ID card image for a valid step-two ticket.
 *
 *   GET /api/auth/staff/id-image?ticket=...
 *
 * The browser fetches this to compute the face embedding from the stored ID
 * card portrait. That embedding is then sent to /api/auth/staff/confirm for
 * comparison against the live camera frame.
 *
 * The ticket is validated first — an expired or invalid ticket returns 401.
 * The image is returned as a data URL so the browser can load it directly
 * into an <img> element without additional processing.
 */
export const GET = handler(async (req: Request) => {
  const url = new URL(req.url);
  const ticket = url.searchParams.get("ticket") ?? "";

  if (!ticket) {
    return fail("Missing ticket", 400);
  }

  const step2 = await readStep2Ticket(ticket);
  if (!step2) {
    return fail("Invalid or expired ticket", 401);
  }

  const { data: user, error } = await db()
    .from("users")
    .select("id_doc_front, step2_nonce")
    .eq("id", step2.userId)
    .maybeSingle();

  if (error) {
    console.error("id-image lookup failed:", error.message);
    return fail("Database error", 503);
  }

  if (!user?.step2_nonce || user.step2_nonce !== step2.nonce) {
    return fail("Invalid or expired ticket", 401);
  }

  if (!user.id_doc_front) {
    return fail("No ID card on file", 404);
  }

  return ok({ image: user.id_doc_front });
});
