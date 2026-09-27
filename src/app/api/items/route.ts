import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireAdmin, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { randomBytes } from "node:crypto";

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
  const body = await req.json();

  const name = String(body.name || "").trim();
  if (!name) return fail("Item name is required");

  const quantity = Number(body.quantity ?? 0);
  if (Number.isNaN(quantity) || quantity < 0) return fail("Invalid quantity");

  const lowStock = Number(body.low_stock_threshold ?? 5);

  // SKU generation: CT-<CATEGORY>-<RANDOM4>
  let categoryLabel = "GEN";
  if (body.category_id) {
    const { data: cat } = await db()
      .from("categories")
      .select("name")
      .eq("id", body.category_id)
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
      category_id: body.category_id || null,
      location_id: body.location_id || null,
      physical_form: body.physical_form || "solid",
      unit: body.unit || "pcs",
      quantity,
      low_stock_threshold: Number.isNaN(lowStock) ? 5 : lowStock,
      expiration_date: body.expiration_date || null,
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
