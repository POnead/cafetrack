import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { canManageItems, approvalCodeMatches } from "@/lib/permissions";
import { audit } from "@/lib/audit";
import { randomBytes } from "node:crypto";
import {
  FieldError,
  requireQuantity,
  parseThreshold,
  parseExpiryDate,
  parsePhysicalForm,
  parseUnitsPerBox,
  assertRefExists,
} from "@/lib/item-validation";

export const runtime = "nodejs";

/* ---------------- list ---------------- */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const categoryId = searchParams.get("category");
  const lowOnly = searchParams.get("low") === "1";

  // `status=active` (the default) hides anything still awaiting approval, so the
  // inventory a staff member sees is stock and only stock. `status=pending` is
  // the approvals list, and `status=all` is the admin's view of everything
  // including rejected submissions.
  const status = searchParams.get("status") ?? "active";
  const submittedByMe = searchParams.get("submitted_by") === "me";

  let query = db()
    .from("items")
    .select(
      `id, sku, name, physical_form, unit, units_per_box, quantity,
       low_stock_threshold, expiration_date, version, item_status,
       submitted_by, submitted_at, reviewed_by, reviewed_at, review_note,
       created_at, updated_at,
       category:categories(id, name),
       location:locations(id, name, min_shelf_life_days)`
    )
    .order("name", { ascending: true });

  if (status === "active" || status === "pending" || status === "rejected") {
    query = query.eq("item_status", status);
  }
  // A staff member's own submissions, across every state — this is how they
  // see whether a pending item was approved or rejected.
  if (submittedByMe) {
    query = query.eq("submitted_by", user.id);
  }

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
  // FR-03. Two roles, two behaviours, from one endpoint:
  //
  //   admin, or staff granted can_manage_items -> saved as active, immediately
  //     usable.
  //   any other staff member -> saved as pending. It is real, it is audited, and
  //     it appears on the Approvals list, but it is not stock until an admin
  //     approves it, so it raises no alerts and cannot be moved.
  const user = await requireUser();
  const manages = await canManageItems(user);
  const body = await readBody(req);

  // FR-03: a staff member with the admin-given code gets their submission
  // through immediately, without a queue stop.
  const viaCode = !manages && (await approvalCodeMatches(user, body.approval_code));
  const trusted = manages || viaCode;

  const name = String(body.name || "").trim();
  if (!name) return fail("Item name is required");

  // Quantity is required and must be a real number — never defaulted. A missing
  // or blank value used to become 0, which silently emptied the item.
  let quantity: number;
  let lowStock: number;
  let expiry: string | null;
  let physicalForm: string;
  let unitsPerBox: number | null;
  try {
    quantity = requireQuantity(body.quantity, "Quantity");
    lowStock = parseThreshold(body.low_stock_threshold ?? 5, "Low-stock threshold");
    expiry = parseExpiryDate(body.expiration_date);
    physicalForm = parsePhysicalForm(body.physical_form);
    unitsPerBox = parseUnitsPerBox(body.units_per_box);
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

  const itemStatus = trusted ? "active" : "pending";

  const { data, error } = await db()
    .from("items")
    .insert({
      sku,
      name,
      category_id: categoryId,
      location_id: locationId,
      physical_form: physicalForm,
      unit: body.unit || "pcs",
      units_per_box: unitsPerBox,
      quantity,
      low_stock_threshold: lowStock,
      expiration_date: expiry,
      item_status: itemStatus,
      // Only a submission needs provenance. An item added by someone who could
      // add it directly is not waiting on anyone, so recording it as submitted
      // would imply a review that never happened. Exception: a code-verified
      // staff submission skips the queue, but it was still their submission —
      // the record keeps who did it.
      submitted_by: manages ? null : user.id,
      submitted_at: manages ? null : new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return fail(error.message, 500);

  await audit(user, "ITEM_CREATE", "item", data.id, {
    sku: data.sku,
    name: data.name,
    quantity: data.quantity,
    unit: data.unit,
    item_status: itemStatus,
    via_code: viaCode,
  }, { ip: clientIp(req) });

  // A pending item is invisible to refresh_alerts by design, so this is safe to
  // call either way — it simply does nothing for an unapproved submission.
  await db().rpc("refresh_alerts");

  return ok(
    {
      item: data,
      // Spelled out rather than left for the client to infer, because the two
      // cases mean very different things to the person who just submitted.
      pending_approval: !trusted,
      message: manages
        ? `Item created — SKU ${data.sku}`
        : viaCode
          ? `Item created — SKU ${data.sku}. Approved immediately via your code.`
          : `Submitted for approval — SKU ${data.sku}. An admin must approve it before it can be used.`,
    },
    201
  );
});
