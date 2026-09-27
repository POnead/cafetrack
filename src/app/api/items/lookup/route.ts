import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";

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
      `id, sku, name, unit, quantity, low_stock_threshold, expiration_date, physical_form,
       category:categories(id, name), location:locations(id, name)`
    )
    .eq("sku", sku)
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!data) return fail(`No item matches "${sku}"`, 404);

  return ok({ item: data });
});
