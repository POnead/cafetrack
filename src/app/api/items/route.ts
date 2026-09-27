import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { randomBytes } from "node:crypto";
import {
  FieldError,
  requireQuantity,
  parseThreshold,
  parseExpiryDate,
  parsePhysicalForm,
  assertRefExists,
} from "@/lib/item-validation";

export const runtime = "nodejs";

/* ---------------- list ---------------- */
export const GET = handler(async (req: Request) => {
  await requireUser();

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const categoryId = searchParams.get("category");
  const lowOnly = searchParams.get("low") === "1";

  let query = db()
    .from("items")
    .select(
      `id, sku, name, physical_form, unit, quantity, low_stock_threshold,
       expiration_date, version, created_at, updated_at,
       category:categories(id, name),
       location:locations(id, name)`
    )
    .order("name", { ascending: true });

  if (q) {
    // PostgREST treats commas, parentheses and double quotes as filter
    // syntax, so the pattern is quoted and its metacharacters escaped.
    // Without this a query like q=milk, 1l mis-parses: the local adapter
    // answered HTTP 500 and Supabase would build a silently wrong filter.
    const pattern = '"%' + q.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '%"';
    query = query.or("name.ilike." + pattern + ",sku.ilike." + pattern);
  }
  if (categoryId) {
    query = query.eq("category_id", categoryId);
  }

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  let items = data ?? [];
  if (lowOnly) {
    items = items.filter(
      (i: any) => Number(i.quantity) <= Number(i.low_stock_threshold)
    );
  }

  return ok({ items });
});

/* ---------------- create ---------------- */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const name = String(body.name || "").trim();
  if (!name) return fail("Item name is required");

  // Quantity is required and must be a real number — never defaulted. A missing
  // or blank value used to become 0, which silently emptied the item.
  let quantity: number;
  let lowStock: number;
  let expiry: string | null;
  let physicalForm: string;
  try {
    quantity = requireQuantity(body.quantity, "Quantity");
    lowStock = parseThreshold(body.low_stock_threshold ?? 5, "Low-stock threshold");
    expiry = parseExpiryDate(body.expiration_date);
    physicalForm = parsePhysicalForm(body.physical_form);
  } catch (e: any) {
    if (e instanceof FieldError) return fail(e.message);
    throw e;
  }

  // Resolve the reference ids before anything is written. The columns have
  // foreign keys, so Postgres would reject an unknown id — but by throwing,
  // which the caller would see as a 500. This keeps it a 400 with a message a
  // person can act on.
  let categoryId: string | null;
  let locationId: string | null;
  try {
    categoryId = await assertRefExists(body.category_id, "Category", async (id) => {
      const { data } = await db()
        .from("categories")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      return Boolean(data);
    });
    locationId = await assertRefExists(body.location_id, "Location", async (id) => {
      const { data } = await db()
        .from("locations")
        .select("id")
        .eq("id", id)
        .maybeSingle();
      return Boolean(data);
    });
  } catch (e: any) {
    if (e instanceof FieldError) return fail(e.message);
    throw e;
  }

  // SKU generation: CT-<CATEGORY>-<RANDOM4>
  let categoryLabel = "GEN";
  if (categoryId) {
    const { data: cat } = await db()
      .from("categories")
      .select("name")
      .eq("id", categoryId)
      .maybeSingle();
    if (cat?.name) {
      categoryLabel = cat.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "GEN";
    }
  }

  let sku = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = `CT-${categoryLabel}-${randomBytes(2).toString("hex").toUpperCase()}`;
    const { data: existing } = await db()
      .from("items")
      .select("id")
      .eq("sku", candidate)
      .maybeSingle();
    if (!existing) {
      sku = candidate;
      break;
    }
  }
  if (!sku) return fail("Could not generate a unique SKU, try again", 500);

  const { data, error } = await db()
    .from("items")
    .insert({
      sku,
      name,
      category_id: categoryId,
      location_id: locationId,
      physical_form: physicalForm,
      unit: body.unit || "pcs",
      quantity,
      low_stock_threshold: lowStock,
      expiration_date: expiry,
    })
    .select()
    .single();

  if (error) return fail(error.message, 500);

  await audit(admin, "ITEM_CREATE", "item", data.id, {
    sku: data.sku,
    name: data.name,
    quantity: data.quantity,
    unit: data.unit,
  });

  await db().rpc("refresh_alerts");

  return ok({ item: data }, 201);
});
