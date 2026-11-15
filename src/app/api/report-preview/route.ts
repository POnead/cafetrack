import { handler, ok, fail, readBody } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import {
  buildStockReportData,
  parseStockReportFilters,
  StockReportFilterError,
} from "@/lib/stock-report-data";

export const runtime = "nodejs";

/**
 * Read-only preview of a report's completeness metadata.
 *
 * The Reports page uses this to disclose whether the report about to be
 * downloaded is complete or truncated, without re-implementing the report
 * builder on the client. The shared builder remains the single source of
 * truth for both the preview and the downloaded PDF.
 */
export const POST = handler(async (req: Request) => {
  await requireUser();
  const body = await readBody(req);
  let filters;
  try {
    filters = parseStockReportFilters(body);
  } catch (error) {
    if (error instanceof StockReportFilterError) return fail(error.message, 400);
    throw error;
  }

  const report = await buildStockReportData(filters);
  return ok({
    completeness: report.completeness,
    warnings: report.warnings,
    itemsIncluded: report.items.length,
    movementsIncluded: report.movementLines.length,
  });
});