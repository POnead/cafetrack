import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { queueDirectEmail } from "@/lib/email";

export const runtime = "nodejs";

type ReportTransaction = {
  type: string;
  transaction_items: {
    sku: string;
    item_name: string;
    quantity: number | string;
  }[] | null;
};

/**
 * Email a stock report to a specified address (FR-11: "send any report by email").
 *
 * The report body is built from the same data the Reports page shows: current
 * stock levels, movement summary, and top movers. The message goes through the
 * same email queue as alerts, so it is retried on the same terms and appears
 * in the delivery log.
 */
export const POST = handler(async (req: Request) => {
  const session = await requireAdmin();
  const body = await readBody(req);

  const to = String(body.to ?? "").trim();
  if (!to) return fail("Enter an email address");

  // Build the report body from current data
  const { data: items, error: itemsErr } = await db()
    .from("items")
    .select(
      `sku, name, quantity, unit, low_stock_threshold, expiration_date,
       category(name), location(name)`
    )
    .eq("item_status", "active")
    .order("name", { ascending: true });

  if (itemsErr) return fail(itemsErr.message, 500);

  const transactionRows: ReportTransaction[] = [];
  const transactionPageSize = 500;
  for (let offset = 0; ; offset += transactionPageSize) {
    const { data, error } = await db()
      .from("transactions")
      .select(
        `id, type, actor_name, created_at,
         transaction_items(sku, item_name, quantity)`
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + transactionPageSize - 1);

    if (error) return fail(error.message, 500);
    const page: ReportTransaction[] = data ?? [];
    transactionRows.push(...page);
    if (page.length < transactionPageSize) break;
  }

  // Build movement summary
  const movement = (["checkout", "restock", "waste"] as const).map((type) => {
    const rows = transactionRows.filter((t) => t.type === type);
    const qty = rows.reduce(
      (n, t) =>
        n + (t.transaction_items ?? []).reduce((m, li) => m + Number(li.quantity), 0),
      0
    );
    return { type, count: rows.length, qty };
  });

  // Build top movers
  const tally = new Map<string, { name: string; qty: number }>();
  for (const t of transactionRows) {
    if (t.type !== "checkout") continue;
    for (const li of t.transaction_items ?? []) {
      const cur = tally.get(li.sku) ?? { name: li.item_name, qty: 0 };
      cur.qty += Number(li.quantity);
      tally.set(li.sku, cur);
    }
  }
  const topMovers = [...tally.entries()]
    .map(([sku, v]) => ({ sku, ...v }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  // Build the email body
  const lines: string[] = [];
  lines.push("CafeTrack Stock Report");
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push("");
  lines.push(`Total items: ${items?.length ?? 0}`);
  lines.push("");

  lines.push("Movement Summary:");
  for (const m of movement) {
    const label =
      m.type === "checkout"
        ? "Checked out"
        : m.type === "restock"
          ? "Restocked"
          : "Waste";
    lines.push(`  ${label}: ${m.count} transactions, ${m.qty} units`);
  }
  lines.push("");

  if (topMovers.length > 0) {
    lines.push("Most Checked Out:");
    for (const m of topMovers) {
      lines.push(`  ${m.name} (${m.sku}): ${m.qty}`);
    }
    lines.push("");
  }

  lines.push("Current Stock:");
  for (const i of items ?? []) {
    const qty = Number(i.quantity);
    const threshold = Number(i.low_stock_threshold);
    const status = qty <= 0 ? "OUT" : qty <= threshold ? "LOW" : "OK";
    lines.push(
      `  [${status}] ${i.name} (${i.sku}): ${qty} ${i.unit} (threshold: ${threshold})`
    );
  }

  const emailBody = lines.join("\n");
  const subject = `CafeTrack Stock Report — ${new Date().toLocaleDateString()}`;

  try {
    await queueDirectEmail(to, subject, emailBody);
  } catch (e: any) {
    return fail(e.message || "Could not queue the report email", 400);
  }

  await audit(
    session,
    "EMAIL_REPORT_SENT",
    "report",
    null,
    { to, subject, itemCount: items?.length ?? 0 },
    { ip: null, outcome: "success" }
  );

  return ok({ queued: true, to });
});
