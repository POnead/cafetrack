import { handler, fail, dbMode } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { buildStockReportPdf } from "@/lib/report-pdf";
import { buildStockReportData, parseStockReportFilters } from "@/lib/stock-report-data";

export const runtime = "nodejs";

/**
 * The stock report as a downloadable PDF (FR-09).
 *
 * The PDF data builder is also used by email reports, so both delivery paths
 * describe the same inventory snapshot and apply the same filters.
 */
export const POST = handler(async (req: Request) => {
  await requireUser();

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const report = await buildStockReportData(parseStockReportFilters(body));
  const pdf = await buildStockReportPdf(report);
  const filename = `cafetrack-report-${new Date().toISOString().slice(0, 10)}.pdf`;

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
