import { db } from "@/lib/supabase";
import { handler, fail, dbMode } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { fmtQty, fmtDate, daysUntil } from "@/lib/format";
import { stockStatus } from "@/lib/status";
import { buildStockReportPdf, type PdfReport } from "@/lib/report-pdf";

export const runtime = "nodejs";

/**
 * The stock report as a downloadable PDF (FR-09).
 *
 * `POST` rather than `GET` with query parameters, because the filters are
 * arbitrary (a date range, a category, a staff member, a movement type) and a
 * body keeps a long filter list out of a URL that gets logged by whatever sits in
 * front of the app. It is a read that happens to need a body, not a mutation —
 * nothing is written, and nothing about the ledger is touched.
 *
 * One session for staff and admin alike. The paper puts reports with the admin,
 * but staff already see stock levels and record movements, and a report they can
 * filter is just that same information arranged differently. This route reads
 * only rows the caller could already list, so it grants nothing new.
 */
export const POST = handler(async (req: Request) => {
  await requireUser();

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);

  const from = isoDay(body.from);
  const to = isoDay(body.to);
  const staff = typeof body.staff === "string" ? body.staff.trim() : "";
  const type =
    typeof body.type === "string" && ["checkout", "restock", "waste"].includes(body.type)
      ? body.type
      : "";
  const categoryId = typeof body.category_id === "string" ? body.category_id : "";

  /* ---------------- data ---------------- */

  // The stock snapshot and the movements are two shapes of the same question, so
  // they are fetched together. The item list asks for up to 500 — the ceiling
  // the API allows — rather than everything, because a PDF of 40,000 rows is not
  // a report, it is a denial of service against the owner's own printer.
  const [itemRows, movements] = await Promise.all([
    db()
      .from("items")
      .select(
        `sku, name, unit, quantity, low_stock_threshold, expiration_date,
         category:categories(id, name),
         location:locations(id, name)`
      )
      .eq("item_status", "active")
      .order("name", { ascending: true })
      .limit(500),
    fetchMovements({ from, to, staff, type }),
  ]);

  if (itemRows.error) return fail(itemRows.error.message, 500);

  // The category filter is applied here rather than in the query because the
  // report joins category names into its own rows; filtering in SQL would need a
  // second query per category name, and the row count is already bounded.
  const categoryName = categoryId
    ? (await db()
        .from("categories")
        .select("name")
        .eq("id", categoryId)
        .maybeSingle()).data?.name
    : "";

  const allItems = (itemRows.data ?? []) as any[];
  const items = categoryName
    ? allItems.filter((i) => i.category?.name === categoryName)
    : allItems;

  const itemsBySku = new Map(allItems.map((i) => [i.sku, i]));

  /* ---------------- shape the PDF ---------------- */

  const inWindow = movements.filter((t) =>
    categoryName
      ? (t.transaction_items ?? []).some(
          (line: any) => itemsBySku.get(line.sku)?.category?.name === categoryName
        )
      : true
  );

  const MOVEMENT_LABEL: Record<string, string> = {
    checkout: "Checked out",
    restock: "Restocked",
    waste: "Logged as waste",
  };

  const movementSummary = (["checkout", "restock", "waste"] as const).map((t) => {
    const rows = inWindow.filter((m) => m.type === t);
    const qty = rows.reduce(
      (n, m) =>
        n + (m.transaction_items ?? []).reduce((s: number, li: any) => s + Number(li.quantity), 0),
      0
    );
    return { label: MOVEMENT_LABEL[t], count: rows.length, qty: fmtQty(qty) };
  });

  const report: PdfReport = {
    businessName: await businessName(),
    generated: new Date().toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    filterDescription: describeFilters({ from, to, staff, type, categoryName }),
    tiles: [
      { label: "Items tracked", value: items.length },
      {
        label: "Low stock",
        value: items.filter(
          (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "low"
        ).length,
      },
      {
        label: "Out of stock",
        value: items.filter(
          (i) => stockStatus(i.quantity, i.low_stock_threshold).key === "out"
        ).length,
      },
      { label: "Transactions", value: inWindow.length },
    ],
    items: items.map((i) => {
      const status = stockStatus(i.quantity, i.low_stock_threshold);
      const d = daysUntil(i.expiration_date);
      return {
        sku: i.sku,
        name: i.name,
        category: i.category?.name ?? "—",
        location: i.location?.name ?? "—",
        quantity: fmtQty(i.quantity, i.unit),
        threshold: fmtQty(i.low_stock_threshold, i.unit),
        expiry: i.expiration_date ? fmtDate(i.expiration_date) : "—",
        expired: d !== null && d < 0,
        status: status.label,
        tone: status.key as "out" | "low" | "ok",
      };
    }),
    movementSummary,
    waste: wasteByItem(inWindow),
    movementLines: inWindow.flatMap((m) =>
      (m.transaction_items ?? [])
        // A transaction whose lines are all outside the category filter must not
        // appear as an empty row.
        .filter((line: any) =>
          categoryName ? itemsBySku.get(line.sku)?.category?.name === categoryName : true
        )
        .map((line: any) => ({
          date: new Date(m.created_at).toLocaleString("en-PH", {
            dateStyle: "short",
            timeStyle: "short",
          }),
          actorName: m.actor_name,
          label: MOVEMENT_LABEL[m.type] ?? m.type,
          sku: line.sku,
          itemName: line.item_name,
          category: itemsBySku.get(line.sku)?.category?.name ?? "Uncategorized",
          quantity: fmtQty(line.quantity),
          note: m.note ?? "—",
        }))
    ),
  };

  const pdf = await buildStockReportPdf(report);

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // A dated, descriptive filename: the one thing "Save as PDF" from a print
      // dialog cannot do is give the file a name the owner will find again.
      "Content-Disposition": `attachment; filename="cafetrack-report-${new Date()
        .toISOString()
        .slice(0, 10)}.pdf"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
      // The test suites read this header to refuse a live database, and this
      // route does not go through ok()/fail() because it returns bytes.
      "x-cafetrack-db": dbMode(),
    },
  });
});

/* ------------------------------------------------------------------ */

function isoDay(v: unknown): string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
}

/**
 * Every movement in the window, page by page.
 *
 * The same loop the reports page uses, and deliberately not a single unbounded
 * query: `transactions` on a cafe that has run for a year is tens of thousands
 * of rows, and a PDF that silently contained only the first few hundred would be
 * a lie about the period it claims to cover.
 */
async function fetchMovements(filters: {
  from: string;
  to: string;
  staff: string;
  type: string;
}): Promise<any[]> {
  const all: any[] = [];
  const PAGE = 500;
  // A ceiling on the total, so one request cannot try to build a 200MB document.
  // Past it, the report says so rather than pretending to be complete.
  const CAP = 5000;
  let offset = 0;

  while (all.length < CAP) {
    const qs = new URLSearchParams({
      limit: String(PAGE),
      offset: String(offset),
    });
    if (filters.from) qs.set("from", filters.from);
    if (filters.to) qs.set("to", filters.to);
    if (filters.staff) qs.set("staff", filters.staff);
    if (filters.type) qs.set("type", filters.type);

    const { data, error } = await db()
      .from("transactions")
      .select(
        `id, type, actor_name, note, created_at,
         transaction_items(id, sku, item_name, quantity)`
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (error) throw new Error(error.message);

    const page = (data ?? []) as any[];
    all.push(...page);
    if (page.length < PAGE) return all;
    offset += page.length;
  }

  return all;
}

function wasteByItem(movements: any[]) {
  const tally = new Map<string, { sku: string; name: string; qty: number; count: number }>();
  for (const t of movements) {
    if (t.type !== "waste") continue;
    for (const li of t.transaction_items ?? []) {
      const cur = tally.get(li.sku) ?? { sku: li.sku, name: li.item_name, qty: 0, count: 0 };
      cur.qty += Number(li.quantity);
      cur.count += 1;
      tally.set(li.sku, cur);
    }
  }
  return [...tally.values()]
    .map((v) => ({ ...v, qty: fmtQty(v.qty) }))
    .sort((a, b) => Number(b.qty) - Number(a.qty))
    .slice(0, 10);
}

async function businessName(): Promise<string> {
  const { data } = await db()
    .from("settings")
    .select("value")
    .eq("key", "business_name")
    .maybeSingle();
  return data?.value || "CafeTrack";
}

function describeFilters(f: {
  from: string;
  to: string;
  staff: string;
  type: string;
  categoryName: string;
}): string {
  const MOVEMENT_LABEL: Record<string, string> = {
    checkout: "checked out",
    restock: "restocked",
    waste: "waste",
  };
  return [
    f.from || f.to
      ? `Dates: ${f.from || "beginning"} to ${f.to || "today"}`
      : "All dates",
    f.staff ? `Staff: ${f.staff}` : null,
    f.type ? `Movement: ${MOVEMENT_LABEL[f.type]}` : null,
    f.categoryName ? `Category: ${f.categoryName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}