import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { queueDirectEmail, dispatchQueued } from "@/lib/email";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";

/**
 * Send the stock report to an address (FR-11: "the admin can send any report by
 * email").
 *
 * The report is built from the same snapshot the Reports page shows, so what
 * arrives is what was on screen — but it is built server-side from the database
 * rather than trusting a body from the browser. A caller cannot use this to ask
 * for every row in the database or for someone else's address list.
 *
 * Returns only aggregates, never raw user rows, and caps the length it will
 * build. A report for 500 items is already long enough to be an email.
 */
export const POST = handler(async (req: Request) => {
  await requireAdmin();
  const body = await readBody(req);

  const to = String(body.to || "").trim();
  if (!to) return fail("An email address is required");

  const { data: settings } = await db()
    .from("settings")
    .select("value")
    .eq("key", "business_name")
    .maybeSingle();
  const business = settings?.value || "CafeTrack";

  const { data: items, error } = await db()
    .from("items")
    .select("sku, name, quantity, unit, low_stock_threshold, expiration_date")
    .eq("item_status", "active")
    .order("name", { ascending: true })
    .limit(500);

  if (error) return fail(error.message, 500);

  const rows = items ?? [];
  const low = rows.filter(
    (i: any) => Number(i.quantity) <= Number(i.low_stock_threshold)
  );
  const out = low.filter((i: any) => Number(i.quantity) <= 0);

  const soon = rows
    .filter((i: any) => i.expiration_date)
    .map((i: any) => ({ ...i, days: daysUntil(i.expiration_date) }))
    .filter((i: any) => i.days !== null && i.days <= 14)
    .sort((a: any, b: any) => a.days - b.days);

  const lines = [
    `${business} — stock report`,
    `Sent ${new Date().toUTCString()}`,
    "",
    `Items tracked: ${rows.length}`,
    `Low or out of stock: ${low.length} (out of stock: ${out.length})`,
    `Expiring within 14 days: ${soon.length}`,
    "",
  ];

  if (low.length) {
    lines.push("NEEDS RESTOCKING", "-----------------");
    for (const i of low) {
      lines.push(
        `  ${i.sku}  ${i.name}: ${i.quantity} ${i.unit} on hand (threshold ${i.low_stock_threshold})`
      );
    }
    lines.push("");
  }

  if (soon.length) {
    lines.push("EXPIRING SOON", "-------------");
    for (const i of soon) {
      lines.push(`  ${i.sku}  ${i.name}: ${i.expiration_date} (${i.days} day(s))`);
    }
    lines.push("");
  }

  if (!low.length && !soon.length) {
    lines.push("Nothing needs attention right now.");
    lines.push("");
  }

  // Movement counts for the day, to give the mail some context.
  const { data: txns } = await db()
    .from("transactions")
    .select("type")
    .gte("created_at", new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString());

  const byType = { checkout: 0, restock: 0, waste: 0 };
  for (const t of txns ?? []) {
    if (t.type in byType) byType[t.type as keyof typeof byType]++;
  }

  lines.push(
    "TODAY'S MOVEMENTS",
    "-----------------",
    `  checked out: ${byType.checkout}`,
    `  restocked:   ${byType.restock}`,
    `  waste:       ${byType.waste}`,
    "",
    "—",
    `${business}, sent from CafeTrack`
  );

  try {
    await queueDirectEmail(
      to,
      `${business} — stock report (${new Date().toISOString().slice(0, 10)})`,
      lines.join("\n")
    );
  } catch (e: any) {
    return fail(e?.message || "Could not queue the report");
  }

  // Not awaited: the admin is looking at a screen, not waiting on SMTP. The
  // status comes back so the UI can say queued vs sent, and the Email page's
  // log shows what actually went out.
  const result = await dispatchQueued(5);

  return ok({
    to,
    sent: result.sent > 0,
    queued: result.sent === 0,
    items: rows.length,
    low: low.length,
    message:
      result.sent > 0
        ? `Report sent to ${to}`
        : `Report queued for ${to}. Check the Email log — it will send when SMTP is reachable.`,
  });
});

/** Whole days from today until `date`. null for a missing or unparseable date. */
function daysUntil(date: string): number | null {
  const then = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return null;
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((then - start) / 86_400_000);
}