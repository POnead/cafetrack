import { handler, dbMode, clientIp, readBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { buildStockReportPdf } from "@/lib/report-pdf";
import { buildStockReportData, parseStockReportFilters } from "@/lib/stock-report-data";

export const runtime = "nodejs";

/**
 * The stock report as a downloadable PDF (FR-09).
 *
 * The PDF data builder is also used by email reports, so both delivery paths
 * describe the same inventory snapshot and apply the same filters.
 *
 * The download is itself recorded. An export is a copy of the cafe's stock
 * data leaving the app, and "who took a report, with which filters, and when"
 * is exactly the kind of event an owner needs to be able to answer later.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();

  // readBody, not a bare req.json(): it caps the body size and answers invalid
  // JSON with a useful 400 instead of silently exporting a default report.
  const body = await readBody(req);
  const filters = parseStockReportFilters(body);
  const report = await buildStockReportData(filters);
  const pdf = await buildStockReportPdf(report);
  const filename = `cafetrack-report-${new Date().toISOString().slice(0, 10)}.pdf`;

  await audit(
    user,
    "REPORT_EXPORT",
    "report",
    null,
    {
      format: "pdf",
      filters: report.filterDescription,
      item_count: report.items.length,
      report_from: filters.from || null,
      report_to: filters.to || null,
      type: filters.type || null,
    },
    { ip: clientIp(req) }
  );

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
      "x-cafetrack-db": dbMode(),
    },
  });
});
