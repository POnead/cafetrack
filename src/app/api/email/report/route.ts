import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { queueDirectEmail, dispatchSoon } from "@/lib/email";
import { buildStockReportPdf } from "@/lib/report-pdf";
import { buildStockReportData, parseStockReportFilters } from "@/lib/stock-report-data";

export const runtime = "nodejs";

/**
 * Email the same filtered stock report PDF as the Reports page export. The
 * attachment is persisted with the queued message, so retries deliver the
 * original snapshot rather than regenerating it from newer inventory.
 */
export const POST = handler(async (req: Request) => {
  const session = await requireAdmin();
  const body = await readBody(req);

  const to = String(body.to ?? "").trim();
  if (!to) return fail("Enter an email address");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return fail("That does not look like an email address");
  }

  const report = await buildStockReportData(parseStockReportFilters(body));
  const pdf = await buildStockReportPdf(report);
  const date = new Date();
  const filename = `cafetrack-report-${date.toISOString().slice(0, 10)}.pdf`;
  const subject = `CafeTrack Stock Report — ${date.toLocaleDateString()}`;
  const emailBody = [
    `${report.businessName} Stock Report`,
    `Generated: ${report.generated}`,
    `Items included: ${report.items.length}`,
    `Movement summary: ${report.movementSummary
      .map(({ label, count, qty }) => `${label}: ${count} transactions, ${qty} units`)
      .join("; ")}`,
    `Filters: ${report.filterDescription}`,
    ...report.warnings.map((warning) => `Warning: ${warning}`),
    "",
    "The complete inventory and movement report is attached as a PDF.",
  ].join("\n");

  try {
    await queueDirectEmail(to, subject, emailBody, [
      {
        filename,
        contentType: "application/pdf",
        contentBase64: pdf.toString("base64"),
      },
    ]);
  } catch (e: any) {
    return fail(e.message || "Could not queue the report email", 400);
  }

  dispatchSoon();

  await audit(
    session,
    "EMAIL_REPORT_SENT",
    "report",
    null,
    { to, subject, itemCount: report.items.length, filters: report.filterDescription },
    { ip: null, outcome: "success" }
  );

  return ok({ queued: true, to });
});
