import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { looksLikeStaffCode } from "@/lib/item-validation";

export const runtime = "nodejs";

/**
 * Resolve a scanned code to an item.
 * Accepts a plain SKU or a URL containing /i/<SKU>.
 */
export const GET = handler(async (req: Request) => {
  await requireUser();

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("code")?.trim();

  if (!raw) return fail("Missing code");

  let sku = raw;
  const urlMatch = raw.match(/\/i\/([A-Za-z0-9\-]+)/);
  if (urlMatch) sku = urlMatch[1];

  const { data, error } = await db()
    .from("items")
    .select(
      `id, sku, name, unit, units_per_box, quantity, low_stock_threshold,
       expiration_date, physical_form,
       category:categories(id, name), location:locations(id, name, min_shelf_life_days)`
    )
    .eq("sku", sku)
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!data) {
    // A staff badge scanned at the counter is the likely mistake, and "no item
    // matches CT-STF-..." reads like a damaged label rather than a wrong page.
    // The message says what the code *is*, never whether that staff id exists.
    if (looksLikeStaffCode(sku)) {
      return fail(
        `"${sku}" is a staff ID, not an item. Scan an item label to record stock, or use a staff code to sign in.`,
        404
      );
    }
    return fail(`No item matches "${sku}"`, 404);
  }

  return ok({ item: data });
});
