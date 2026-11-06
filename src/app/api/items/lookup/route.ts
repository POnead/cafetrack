import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { looksLikeStaffCode } from "@/lib/item-validation";

export const runtime = "nodejs";

/**
 * Resolve a scanned code to an item.
 * Accepts a plain SKU or a URL containing /i/<SKU>.
 * Batch labels resolve to their exact lot; older SKU-date labels remain
 * supported as product labels for compatibility.
 */
export const GET = handler(async (req: Request) => {
  await requireUser();

  const { searchParams } = new URL(req.url);
  const raw = searchParams.get("code")?.trim();

  if (!raw) return fail("Missing code");

  let scannedBatch: {
    id: string;
    batch_code: string;
    received_quantity: number;
    remaining_quantity: number;
    expiration_date: string | null;
    received_at: string;
  } | null = null;
  if (raw.toUpperCase().startsWith("CTB-")) {
    const { data: batch, error: batchError } = await db()
      .from("inventory_batches")
      .select("id, batch_code, item_id, received_quantity, remaining_quantity, expiration_date, received_at")
      .eq("batch_code", raw.toUpperCase())
      .maybeSingle();

    if (batchError) return fail(batchError.message, 500);
    if (!batch) return fail(`No inventory batch matches "${raw}"`, 404);
    scannedBatch = {
      id: batch.id,
      batch_code: batch.batch_code,
      received_quantity: Number(batch.received_quantity),
      remaining_quantity: Number(batch.remaining_quantity),
      expiration_date: batch.expiration_date,
      received_at: batch.received_at,
    };

    const { data: batchItem, error: itemError } = await db()
      .from("items")
      .select(
        `id, sku, name, unit, units_per_box, quantity, low_stock_threshold,
         expiration_date, expirable, physical_form, item_status,
         category:categories(id, name), location:locations(id, name, min_shelf_life_days),
         batches:inventory_batches(id, batch_code, received_quantity, remaining_quantity, expiration_date, received_at)`
      )
      .eq("id", batch.item_id)
      .maybeSingle();

    if (itemError) return fail(itemError.message, 500);
    if (!batchItem) return fail("The item for this batch no longer exists", 404);
    if (batchItem.item_status === "pending") {
      return fail(
        `${batchItem.name} is waiting for admin approval and cannot be used yet`,
        409
      );
    }
    return ok({
      item: batchItem,
      batchExpiry: batch.expiration_date,
      scannedBatch,
    });
  }

  let sku = raw;
  let batchExpiry: string | null = null;
  const urlMatch = raw.match(/\/i\/([A-Za-z0-9\-]+)/);
  if (urlMatch) sku = urlMatch[1];

  // A barcode printed with an expiry date looks like "CT-CAT-ABCD-2026-04-01".
  // Split on the last YYYY-MM-DD pattern so the SKU stays intact.
  const dateMatch = sku.match(/(.+)-(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) {
    sku = dateMatch[1];
    batchExpiry = dateMatch[2];
  }

  const { data, error } = await db()
    .from("items")
    .select(
      `id, sku, name, unit, units_per_box, quantity, low_stock_threshold,
       expiration_date, expirable, physical_form, item_status,
       category:categories(id, name), location:locations(id, name, min_shelf_life_days),
       batches:inventory_batches(id, batch_code, received_quantity, remaining_quantity, expiration_date, received_at)`
    )
    .eq("sku", sku)
    .maybeSingle();

  if (error) return fail(error.message, 500);

  // A pending item exists but is not stock yet (FR-03). Scanning its label at
  // the till has to say why, rather than reporting "no item matches" — the label
  // is real and the operator would reasonably think the scanner is broken.
  if (data && data.item_status === "pending") {
    return fail(
      `${data.name} is waiting for admin approval and cannot be used yet`,
      409
    );
  }

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

  const matchingBatches = batchExpiry
    ? (data.batches ?? []).filter(
        (batch: {
          remaining_quantity: number;
          expiration_date: string | null;
        }) =>
          Number(batch.remaining_quantity) > 0 &&
          batch.expiration_date?.slice(0, 10) === batchExpiry
      )
    : [];
  scannedBatch =
    matchingBatches.length === 1
      ? {
          id: matchingBatches[0].id,
          batch_code: matchingBatches[0].batch_code,
          received_quantity: Number(matchingBatches[0].received_quantity),
          remaining_quantity: Number(matchingBatches[0].remaining_quantity),
          expiration_date: matchingBatches[0].expiration_date,
          received_at: matchingBatches[0].received_at,
        }
      : null;

  return ok({ item: data, batchExpiry, scannedBatch });
});
