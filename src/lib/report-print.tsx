/**
 * Opens a print-ready window for the stock report, which the browser then
 * offers to save as a PDF ("Save as PDF" in the print dialog).
 *
 * This follows the same approach as printBarcodeLabelsAsync — a separate
 * window with its own stylesheet — rather than a `@media print` block in
 * globals.css. Two reasons: the app chrome (nav, toasts, buttons) never enters
 * the print document at all, and the report can be printed from a page that
 * has other cards on it without them leaking in. It also means no PDF library
 * and no server round-trip, so it behaves identically in local and Supabase
 * mode.
 */
import { fmtQty, fmtDate, daysUntil } from "@/lib/format";
import { stockStatus } from "@/lib/status";

export type ReportItem = {
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  low_stock_threshold: number;
  expiration_date: string | null;
  category: { name: string } | null;
  location: { name: string } | null;
};

export type ReportMovement = { type: string; count: number; qty: number };

const MOVEMENT_LABEL: Record<string, string> = {
  checkout: "Checked out",
  restock: "Restocked",
  waste: "Logged as waste",
};

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function printStockReport(opts: {
  businessName: string;
  items: ReportItem[];
  movement: ReportMovement[];
  topMovers: { sku: string; name: string; qty: number }[];
  lowCount: number;
  outCount: number;
}) {
  const { businessName, items, movement, topMovers, lowCount, outCount } = opts;
  const generated = new Date().toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) {
    alert("Pop-up blocked. Allow pop-ups for this site to export the report.");
    return;
  }

  /* --- summary tiles --- */
  const tile = (label: string, value: string | number) => `
    <div class="tile">
      <div class="tile-v">${escapeHtml(value)}</div>
      <div class="tile-l">${escapeHtml(label)}</div>
    </div>`;

  const summary =
    tile("Items tracked", items.length) +
    tile("Low stock", lowCount) +
    tile("Out of stock", outCount) +
    tile("Movement lines", movement.reduce((n, m) => n + m.count, 0));

  /* --- inventory table --- */
  const rows = items
    .map((i) => {
      const d = daysUntil(i.expiration_date);
      const status = stockStatus(i.quantity, i.low_stock_threshold);
      return `<tr>
        <td class="mono">${escapeHtml(i.sku)}</td>
        <td><strong>${escapeHtml(i.name)}</strong></td>
        <td>${escapeHtml(i.category?.name ?? "—")}</td>
        <td>${escapeHtml(i.location?.name ?? "—")}</td>
        <td class="num">${escapeHtml(fmtQty(i.quantity, i.unit))}</td>
        <td class="num">${escapeHtml(fmtQty(i.low_stock_threshold, i.unit))}</td>
        <td>${i.expiration_date ? escapeHtml(fmtDate(i.expiration_date)) : "—"}
          ${d !== null && d < 0 ? '<span class="expired">(expired)</span>' : ""}</td>
        <td><span class="pill pill-${status.key}">${escapeHtml(status.label)}</span></td>
      </tr>`;
    })
    .join("");

  /* --- movement summary --- */
  const movementRows = movement
    .map(
      (m) => `<tr>
        <td>${escapeHtml(MOVEMENT_LABEL[m.type] ?? m.type)}</td>
        <td class="num">${m.count}</td>
        <td class="num">${escapeHtml(fmtQty(m.qty))}</td>
      </tr>`
    )
    .join("");

  const moverRows = topMovers.length
    ? topMovers
        .map(
          (t, idx) => `<tr>
            <td class="num">${idx + 1}</td>
            <td class="mono">${escapeHtml(t.sku)}</td>
            <td><strong>${escapeHtml(t.name)}</strong></td>
            <td class="num">${escapeHtml(fmtQty(t.qty))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">No checkouts recorded yet.</td></tr>`;

  win.document.write(`
    <html>
      <head>
        <title>${escapeHtml(businessName)} — Stock Report</title>
        <style>
          body { font-family: system-ui, sans-serif; color: #3D2B1F; padding: 24px; }
          h1 { font-size: 20px; margin: 0 0 2px; }
          h2 { font-size: 14px; margin: 24px 0 8px; text-transform: uppercase;
               letter-spacing: .06em; color: #8B5E3C; }
          .meta { font-size: 12px; color: #8B5E3C; margin-bottom: 16px; }
          .tiles { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
          .tile { border: 1px solid #E8D9CC; border-radius: 10px; background: #FEFAF3;
                  padding: 10px 16px; min-width: 92px; }
          .tile-v { font-size: 20px; font-weight: 700; }
          .tile-l { font-size: 11px; color: #8B5E3C; text-transform: uppercase;
                    letter-spacing: .05em; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th { text-align: left; background: #F6EDE3; padding: 7px 8px;
               border-bottom: 2px solid #E8D9CC; font-size: 11px;
               text-transform: uppercase; letter-spacing: .04em; }
          td { padding: 6px 8px; border-bottom: 1px solid #F0E4D8; vertical-align: top; }
          td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
          .mono { font-family: ui-monospace, monospace; font-size: 11px; color: #96755A; }
          .expired { color: #B42318; }
          .empty { color: #96755A; font-style: italic; }
          .pill { display: inline-block; padding: 2px 8px; border-radius: 999px;
                  font-size: 10px; font-weight: 600; }
          .pill-out { background: #FEE4E2; color: #B42318; }
          .pill-low { background: #FEF0C7; color: #B54708; }
          .pill-ok { background: #DCFAE6; color: #067647; }
          .btn { padding: 8px 16px; border-radius: 999px; border: 1px solid #D99B3F;
                 background: #E8B563; color: #3D2B1F; font-weight: 600;
                 font-size: 14px; cursor: pointer; }
          .hint { font-size: 12px; color: #8B5E3C; margin-bottom: 16px; }
          @page { size: A4; margin: 10mm; }
          @media print {
            .no-print { display: none; }
            body { padding: 0; }
            /* Keep a row from being split across two pages. */
            tr { page-break-inside: avoid; }
            h2 { page-break-after: avoid; }
          }
        </style>
      </head>
      <body>
        <div class="no-print" style="margin-bottom:16px">
          <button class="btn" onclick="window.print()">Print / Save as PDF</button>
          <div class="hint" style="margin:10px 0 0">
            In the print dialog choose <em>Save as PDF</em> as the destination to
            download a PDF instead of printing.
          </div>
        </div>

        <h1>${escapeHtml(businessName)} — Stock Report</h1>
        <div class="meta">Generated ${escapeHtml(generated)} · ${items.length} items</div>

        <div class="tiles">${summary}</div>

        <h2>Inventory</h2>
        <table>
          <thead>
            <tr>
              <th>SKU</th><th>Item</th><th>Category</th><th>Location</th>
              <th class="num">On hand</th><th class="num">Threshold</th>
              <th>Expiry</th><th>Status</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8" class="empty">No items.</td></tr>'}</tbody>
        </table>

        <h2>Movement summary</h2>
        <table>
          <thead><tr><th>Type</th><th class="num">Transactions</th><th class="num">Quantity</th></tr></thead>
          <tbody>${movementRows}</tbody>
        </table>

        <h2>Top movers</h2>
        <table>
          <thead><tr><th class="num">#</th><th>SKU</th><th>Item</th><th class="num">Checked out</th></tr></thead>
          <tbody>${moverRows}</tbody>
        </table>
      </body>
    </html>
  `);

  win.document.close();
}
