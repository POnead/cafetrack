import PDFDocument from "pdfkit";

/**
 * The stock report as a real PDF file (FR-09).
 *
 * This exists because "Export PDF" that opens the browser's print dialog is not
 * an export. On the cafe's machine that means a click through a dialog whose
 * wording changes between browsers, a default printer it may quietly choose, and
 * a file named after the browser rather than after the report. The paper asks for
 * a PDF that includes the filtered movement details and the current stock
 * snapshot, and a download is the only honest reading of that.
 *
 * Three reasons this is a server route rather than a library on the page:
 *
 *   - pdfkit reads font files and streams; a 500-item report would add hundreds
 *     of kilobytes of generator to every visitor who never exports anything;
 *   - the data is already on the server, so a round trip of re-fetching it in
 *     the browser to render it there would be a second source of truth;
 *   - the CSV export sends the same payload through the same route, so the two
 *     exports cannot describe different data.
 *
 * Pagination is handled by pdfkit itself: `addPage` is called on overflow, and
 * the header row is repeated, so a long report reads as a document rather than a
 * single page with the tail cut off.
 *
 * Colours are the same tokens the screen uses, taken from tailwind.config.ts.
 * PDF has no CSS, so they are written out here rather than shared — a spread of
 * a Tailwind config into a document generator is worse than six literal values.
 */

const COCOA = "#3D2B1F";
const COCOA_MID = "#8B5E3C";
const COCOA_SOFT = "#96755A";
const RULE = "#E8D9CC";
const ROW_RULE = "#F0E4D8";
const TERRACOTTA = "#8A3423";
const OCHRE = "#8A611A";
const SAGE = "#4A6638";
const SAGE_WASH = "#EEF3E9";
const OCHRE_WASH = "#F8F1E2";
const TERRACOTTA_WASH = "#F8EBE7";

/**
 * A4 portrait, in PDF points. Rounded, because a fractional content width makes
 * column widths unroundable: the tables below are whole numbers of points, and
 * 515.28 is not the sum of any sensible set of them.
 */
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 40;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const RUNNING_HEADER_Y = 24;
const RUNNING_HEADER_CONTENT_Y = 62;

/**
 * Every column list has to sum to exactly CONTENT_WIDTH, because the layout walks
 * the columns from the right edge and the leftmost one starts wherever the
 * subtraction leaves it. A row that is ten points short prints a table with a
 * gap; one that is ten points over runs into the margin. Neither is visible in
 * the source, so it is checked on load and names the table that is wrong.
 */
function assertWidths(label: string, widths: number[]) {
  const sum = widths.reduce((a, b) => a + b, 0);
  if (sum !== CONTENT_WIDTH) {
    throw new Error(
      `${label} columns sum to ${sum}, expected ${CONTENT_WIDTH} — the report would be misaligned`
    );
  }
}

/** Below this much room left, start a new page rather than write into the foot. */
const FOOTER_RESERVE = 56;

export type PdfItem = {
  sku: string;
  name: string;
  category: string;
  location: string;
  quantity: string;
  threshold: string;
  expiry: string;
  expired: boolean;
  status: string;
  tone: "out" | "low" | "ok";
};

export type PdfMovementSummary = { label: string; count: number; qty: string };

export type PdfTopMover = { sku: string; name: string; qty: string };

export type PdfExpiry = {
  sku: string;
  name: string;
  category: string;
  location: string;
  quantity: string;
  expiry: string;
  days: number | null;
};

export type PdfMovementLine = {
  date: string;
  actorName: string;
  label: string;
  sku: string;
  itemName: string;
  category: string;
  quantity: string;
  note: string;
};

export type PdfReport = {
  businessName: string;
  generated: string;
  filterDescription: string;
  tiles: { label: string; value: string | number }[];
  items: PdfItem[];
  topMovers: PdfTopMover[];
  soonestExpiry: PdfExpiry[];
  movementSummary: PdfMovementSummary[];
  waste: { sku: string; name: string; qty: string; count: number }[];
  movementLines: PdfMovementLine[];
  warnings: string[];
};

/**
 * Column widths, in points, per table.
 *
 * Written out rather than derived: a table's columns are a design decision, not
 * a function of its content, and the only thing that should decide how wide
 * "Note" is that notes are long and quantities are not.
 */
/**
 * Column widths, in points, per table. Each row must sum to CONTENT_WIDTH (515),
 * or the rightmost column runs off the page or leaves a gap.
 *
 * The sums are asserted at build time rather than trusted: a mistyped total here
 * is invisible until someone opens the PDF, and the failure mode is a table that
 * looks almost right. Three labels also had to be shortened, because a
 * nine-character header at 7.5pt needs about 44pt and no honest column was that
 * wide — "THRESHOLD" became "Min", "QUANTITY" became "Qty" — and the numbers
 * keep their full names.
 */
const ITEM_COLS = [60, 96, 62, 62, 46, 40, 56, 93];
const TOP_COLS = [70, 349, 96];
const EXPIRY_COLS = [60, 133, 85, 90, 45, 60, 42];
const SUMMARY_COLS = [323, 96, 96];
const WASTE_COLS = [60, 199, 156, 100];
const LINE_COLS = [62, 68, 62, 56, 78, 76, 36, 77];

assertWidths("inventory", ITEM_COLS);
assertWidths("most checked out", TOP_COLS);
assertWidths("soonest expiries", EXPIRY_COLS);
assertWidths("movement summary", SUMMARY_COLS);
assertWidths("waste", WASTE_COLS);
assertWidths("movement details", LINE_COLS);

/**
 * Draw the document into a PDF and resolve with the bytes.
 *
 * Resolves rather than returns a stream because the caller wants a Buffer to
 * set as a download: a streamed body works too, but collecting it here keeps
 * the route trivial and lets a failure be caught before any bytes are sent — a
 * half-written PDF that fails midway is a corrupt file the browser will happily
 * save under the right name.
 */
export function buildStockReportPdf(report: PdfReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: `${report.businessName} — Stock Report`,
        Author: "CafeTrack",
        Subject: "Inventory usage and waste report",
        CreationDate: new Date(),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    // An unreadable font or an unwritable stream has to reject rather than hang:
    // a request that never answers is worse than one that answers 500.
    doc.on("error", reject);

    try {
      // Continuation pages get a compact running masthead. Registering this
      // before rendering means pages created by any table share the same chrome.
      doc.on("pageAdded", () => writeRunningHeader(doc, report.businessName));
      writeHeader(doc, report);
      writeTiles(doc, report.tiles);

      writeSectionTitle(doc, "Inventory");
      writeItemTable(doc, report.items, ITEM_COLS);

      writeSectionTitle(doc, "Most checked out");
      writeTopMoversTable(doc, report.topMovers, TOP_COLS);

      writeSectionTitle(doc, "Soonest expiries");
      writeExpiryTable(doc, report.soonestExpiry, EXPIRY_COLS);

      writeSectionTitle(doc, "Movement summary");
      writeSummaryTable(doc, report.movementSummary, SUMMARY_COLS);

      writeSectionTitle(doc, "Waste tracking");
      writeWasteTable(doc, report.waste, WASTE_COLS);

      writeSectionTitle(doc, "Movement details");
      writeMovementTable(doc, report.movementLines, LINE_COLS);

      // Page numbers need the final count, so they are stamped at the end over
      // however many pages there turned out to be.
      stampPageNumbers(doc, report.businessName);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function writeHeader(doc: PDFKit.PDFDocument, report: PdfReport) {
  const top = doc.y;
  doc
    .roundedRect(MARGIN, top, 82, 20, 4)
    .fill(COCOA);
  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(8)
    .text("CAFETRACK", MARGIN + 9, top + 6, {
      width: 64,
      characterSpacing: 0.9,
      lineBreak: false,
    });

  doc
    .fillColor(COCOA_MID)
    .font("Helvetica-Bold")
    .fontSize(8)
    .text(report.businessName.toUpperCase(), MARGIN + 92, top + 6, {
      width: CONTENT_WIDTH - 92,
      align: "right",
      characterSpacing: 0.45,
      lineBreak: false,
      ellipsis: true,
    });

  const titleTop = top + 31;
  doc
    .fillColor(COCOA)
    .font("Helvetica-Bold")
    .fontSize(22)
    .text("Stock report", MARGIN, titleTop, {
      align: "left",
      lineBreak: false,
    });

  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(COCOA_MID)
    .text(report.businessName, MARGIN, titleTop + 27, {
      width: CONTENT_WIDTH,
      lineBreak: false,
      ellipsis: true,
    });

  const metaTop = titleTop + 43;
  const metaGap = 9;
  const metaWidth = (CONTENT_WIDTH - metaGap) / 2;
  const metaValueWidth = metaWidth - 18;
  const metaCards = [
    { label: "GENERATED", value: report.generated },
    { label: "FILTER RANGE", value: report.filterDescription },
  ];
  doc.font("Helvetica").fontSize(8.5);
  const metaHeight = Math.max(
    42,
    ...metaCards.map(
      (meta) =>
        26 +
        doc.heightOfString(meta.value, {
          width: metaValueWidth,
          lineGap: 0,
        })
    )
  );
  metaCards.forEach((meta, index) => {
    const x = MARGIN + index * (metaWidth + metaGap);
    doc
      .roundedRect(x, metaTop, metaWidth, metaHeight, 5)
      .fillAndStroke("#FEFAF3", RULE);
    doc
      .fillColor(COCOA_SOFT)
      .font("Helvetica-Bold")
      .fontSize(6.5)
      .text(meta.label, x + 9, metaTop + 7, {
        width: metaWidth - 18,
        characterSpacing: 0.65,
        lineBreak: false,
      });
    doc
      .fillColor(COCOA)
      .font("Helvetica")
      .fontSize(8.5)
      .text(meta.value, x + 9, metaTop + 19, {
        width: metaValueWidth,
        height: metaHeight - 24,
        lineGap: 0,
      });
  });
  doc.y = metaTop + metaHeight + 9;

  const itemCountTop = doc.y;
  doc
    .fillColor(COCOA_SOFT)
    .font("Helvetica")
    .fontSize(8)
    .text(`${report.items.length} inventory items included`, MARGIN, itemCountTop, {
      lineBreak: false,
    });
  doc.x = MARGIN;
  doc.y = itemCountTop + 13;

  for (const warning of report.warnings) {
    doc
      .roundedRect(MARGIN, doc.y, CONTENT_WIDTH, 19, 3)
      .fill(TERRACOTTA_WASH);
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(TERRACOTTA)
      .text(warning, MARGIN + 8, doc.y + 5, {
        width: CONTENT_WIDTH - 16,
        lineBreak: false,
      });
    doc.y += 23;
  }

  doc.moveDown(0.6);
}

function writeRunningHeader(doc: PDFKit.PDFDocument, businessName: string) {
  const y = RUNNING_HEADER_Y;
  doc
    .roundedRect(MARGIN, y, 65, 16, 3)
    .fill(COCOA);
  doc
    .fillColor("#FFFFFF")
    .font("Helvetica-Bold")
    .fontSize(7)
    .text("CAFETRACK", MARGIN + 6, y + 5, {
      width: 53,
      characterSpacing: 0.6,
      lineBreak: false,
    });
  doc
    .fillColor(COCOA_MID)
    .font("Helvetica-Bold")
    .fontSize(8)
    .text(businessName, MARGIN + 76, y + 4, {
      width: CONTENT_WIDTH - 160,
      lineBreak: false,
      ellipsis: true,
    });
  doc
    .fillColor(COCOA_SOFT)
    .font("Helvetica-Bold")
    .fontSize(7)
    .text("STOCK REPORT", PAGE_WIDTH - MARGIN - 78, y + 5, {
      width: 78,
      align: "right",
      characterSpacing: 0.45,
      lineBreak: false,
    });
  doc
    .moveTo(MARGIN, y + 27)
    .lineTo(PAGE_WIDTH - MARGIN, y + 27)
    .lineWidth(0.7)
    .strokeColor(RULE)
    .stroke();
  doc.x = MARGIN;
  doc.y = RUNNING_HEADER_CONTENT_Y;
}

function writeTiles(doc: PDFKit.PDFDocument, tiles: PdfReport["tiles"]) {
  if (tiles.length === 0) return;

  const width = 122;
  const height = 50;
  const gap = 9;

  // Rows, because four tiles at 116pt plus gaps is 488pt and a fifth would run
  // off the page. Measured rather than assumed so the layout survives a label
  // change that adds a tile.
  const perRow = Math.max(1, Math.floor((CONTENT_WIDTH + gap) / (width + gap)));
  const rows = Math.ceil(tiles.length / perRow);

  for (let r = 0; r < rows; r++) {
    ensure(doc, height + 8);
    const top = doc.y;

    tiles.slice(r * perRow, r * perRow + perRow).forEach((tile, i) => {
      const left = MARGIN + i * (width + gap);

      doc
        .roundedRect(left, top, width, height, 6)
        .lineWidth(0.75)
        .strokeColor(RULE)
        .fillAndStroke("#FEFAF3", RULE);

      const accent = [COCOA_MID, OCHRE, TERRACOTTA, SAGE][
        (r * perRow + i) % 4
      ];
      doc
        .roundedRect(left, top, 3, height, 1.5)
        .fill(accent);

      doc
        .fillColor(COCOA)
        .font("Helvetica-Bold")
        .fontSize(18)
        .text(String(tile.value), left + 11, top + 7, { width: width - 20 });

      doc
        .fillColor(COCOA_MID)
        .font("Helvetica")
        .fontSize(7)
        .text(
          String(tile.label).toUpperCase(),
          left + 11,
          top + 32,
          { width: width - 20, characterSpacing: 0.35, lineBreak: false }
        );
    });

    doc.y = top + height + 6;
  }
}

/**
 * Start a new page if there is not enough room.
 *
 * The one rule every table function goes through, so no section can be the
 * reason the last line of the report is written over the footer.
 */
function ensure(
  doc: PDFKit.PDFDocument,
  needed: number,
  /** Redraws the column headers on the fresh page, for a table continuing. */
  onNewPage?: () => void
) {
  if (doc.y + needed <= PAGE_HEIGHT - MARGIN - FOOTER_RESERVE) return;
  doc.addPage();
  onNewPage?.();
}

/**
 * A section heading.
 *
 * `pageBreakAfter: false` is not a pdfkit option, so the heading stays with its
 * table by construction: `ensure` is called before the heading with room for the
 * heading *and* the first rows, rather than for the heading alone.
 */
function writeSectionTitle(doc: PDFKit.PDFDocument, title: string) {
  // Room for the heading and its first rows, so a heading never lands alone at
  // the foot of a page with its table overleaf.
  ensure(doc, 62);

  // x is restored to the margin. pdfkit's text() draws from the current x, and
  // the last cell of a table leaves it at the right edge of that table — so
  // without this, every heading after the first one is right-aligned wherever
  // the previous table happened to end.
  doc.x = MARGIN;
  const titleTop = doc.y + 4;
  doc
    .fillColor(COCOA)
    .font("Helvetica-Bold")
    .fontSize(10)
    .text(title, MARGIN, titleTop, {
      characterSpacing: 0.15,
      lineBreak: false,
    });
  const ruleY = titleTop + 14;
  doc.rect(MARGIN, ruleY, CONTENT_WIDTH, 1).fill(RULE);
  doc.x = MARGIN;
  doc.y = ruleY + 7;
}

/**
 * Column headers, in reverse.
 *
 * PDF text is drawn left to right from wherever the cursor is, so a right-aligned
 * column is laid out by walking the columns from the right edge and giving each
 * its width. Doing it in one pass from the right means the widths sum to the
 * content width and the last one cannot drift past the margin.
 */
function writeColumnHeaders(
  doc: PDFKit.PDFDocument,
  columns: { label: string; width: number; align?: "left" | "right" }[]
) {
  const y = doc.y;

  doc.rect(MARGIN, y, CONTENT_WIDTH, 19).fill(COCOA);

  let x = PAGE_WIDTH - MARGIN;
  for (let i = columns.length - 1; i >= 0; i--) {
    const col = columns[i];
    x -= col.width;
    doc
      .fillColor("#FFFFFF")
      .font("Helvetica-Bold")
      .fontSize(7)
      .text(col.label.toUpperCase(), x + 4, y + 6, {
        width: col.width - 8,
        align: col.align ?? "left",
        characterSpacing: 0.4,
        lineBreak: false,
      });
  }

  doc.y = y + 19;
}

/**
 * A table body.
 *
 * One function for all four tables rather than four near-identical ones: the
 * paging, the zebra striping, the alignment rules and the rule-under-row are all
 * identical, and the differences are the columns and how a cell turns into
 * text. Duplicating the layout four times is how one of them ends up not
 * repeating its header on page two.
 */
function writeTable(
  doc: PDFKit.PDFDocument,
  opts: {
    columns: { label: string; width: number; align?: "left" | "right" }[];
    widths: number[];
    /** The cells, already turned into text, one array per row. */
    rows: string[][];
    /**
     * Draws a cell itself instead of plain text — for the coloured status word
     * and the expired dates.
     *
     * `top` and `height` are passed because the callback needs to draw relative
     * to the row, and pdfkit's cursor has already moved on by the time a cell is
     * rendered. Getting this wrong is how a status dot ends up on the row below.
     */
    renderCell?: (
      rowIndex: number,
      colIndex: number,
      text: string,
      data: unknown,
      top: number,
      height: number
    ) => void;
    /** The source rows, paired with `rows` by index for `renderCell`. */
    data?: unknown[];
    /**
     * Let cells wrap onto more than one line.
     *
     * Off by default: most cells are short, and a wrapped SKU or number reads
     * worse than a clipped one. On for the tables where a genuinely long value
     * is expected — a note, an item name — because clipping those loses the thing
     * the reader came for.
     */
    wrap?: boolean;
    emptyMessage: string;
  }
) {
  const { columns, widths, rows, renderCell, data, wrap, emptyMessage } = opts;

  if (rows.length === 0) {
    ensure(doc, 30);
    doc
      .fillColor(COCOA_SOFT)
      .font("Helvetica-Oblique")
      .fontSize(9)
      .text(emptyMessage, MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.5);
    return;
  }

  // Drawn once up front, and again by `ensure` on every page break — a table
  // that continues onto page two with no header is the thing that makes a long
  // report unreadable.
  const header = () => writeColumnHeaders(doc, columns);
  header();

  rows.forEach((row, rowIndex) => {
    // Measure first: the tallest cell decides the row height, and a row that
    // needs 30pt but was given 14pt would overlap the one beneath it.
    const measured = measureRow(doc, row, widths, Boolean(wrap));
    ensure(doc, measured + 6, header);

    const top = doc.y;
    const height = Math.max(measured, 14);

    // Zebra striping, every other row. Light enough to stay legible through a
    // monochrome printer, which is how much of this will actually be read.
    if (rowIndex % 2 === 1) {
      doc.rect(MARGIN, top, CONTENT_WIDTH, height).fill("#FDF8F1");
    }

    let x = MARGIN;
    row.forEach((text, colIndex) => {
      const width = widths[colIndex] ?? CONTENT_WIDTH;
      doc.x = x;
      doc.y = top + 3;

      if (renderCell) {
        renderCell(rowIndex, colIndex, text, data?.[rowIndex], top, height);
      } else {
        const align = columns[colIndex]?.align ?? "left";
        doc
          .fillColor(COCOA)
          .font(colIndex === 0 ? "Courier" : "Helvetica")
          .fontSize(colIndex === 0 ? 7.5 : 8.5)
          .text(text, x + 4, top + 3, {
            width: width - 8,
            align,
            // Wrapping is opt-in per table. Without this a clipped SKU is
            // tidier; with it, a note or a long ingredient name stays readable.
            lineBreak: !wrap,
          });
      }

      x += width;
    });

    doc.y = top + height;
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(PAGE_WIDTH - MARGIN, doc.y)
      .lineWidth(0.5)
      .strokeColor(ROW_RULE)
      .stroke();
  });
}

/**
 * The height one row needs, measured rather than guessed.
 *
 * pdfkit cannot measure without writing, so this renders into a throwaway
 * fragment off-page and reads the resulting height back. One wasted layout per
 * row is cheaper than overlapping text, and it is the only way to honour a cell
 * that wraps to two lines.
 */
function measureRow(
  doc: PDFKit.PDFDocument,
  row: string[],
  widths: number[],
  wrap: boolean
): number {
  let tallest = 0;
  row.forEach((text, colIndex) => {
    const width = widths[colIndex] ?? CONTENT_WIDTH;
    // The font and size are the ones `writeTable` uses, so a cell measured in one
    // font and drawn in another would be measured wrong.
    doc.font(colIndex === 0 ? "Courier" : "Helvetica");
    doc.fontSize(colIndex === 0 ? 7.5 : 8.5);
    const h = doc.heightOfString(text || " ", {
      width: width - 8,
      // Must match the drawing options: a row measured with wrapping allowed
      // comes back one line tall, and a two-line note then overlaps the row
      // underneath it.
      lineBreak: wrap,
    });
    if (h > tallest) tallest = h;
  });
  return tallest + 6;
}

/* ------------------------------------------------------------------ */
/* the four tables                                                     */
/* ------------------------------------------------------------------ */

function writeItemTable(doc: PDFKit.PDFDocument, items: PdfReport["items"], widths: number[]) {
  writeTable(doc, {
    columns: [
      { label: "SKU", width: widths[0] },
      { label: "Item", width: widths[1] },
      { label: "Category", width: widths[2] },
      { label: "Location", width: widths[3] },
      { label: "On hand", width: widths[4], align: "right" },
      // Shortened to fit the column, not to save room. The column is 40pt and the
      // word is about 44pt at 7.5pt, which wrapped onto two lines and pushed the
      // header row taller than every other one.
      { label: "Min", width: widths[5], align: "right" },
      { label: "Expiry", width: widths[6] },
      { label: "Status", width: widths[7] },
    ],
    widths,
    emptyMessage: "No items match these filters.",
    rows: items.map((i) => [
      i.sku,
      i.name,
      i.category,
      i.location,
      i.quantity,
      i.threshold,
      i.expired ? `${i.expiry} (expired)` : i.expiry,
      i.status,
    ]),
    data: items,
    // An ingredient name is whatever the owner typed, so it wraps.
    wrap: true,
    renderCell: (rowIndex, colIndex, text, raw, top) => {
      const item = raw as PdfItem;
      const left = MARGIN + widths.slice(0, colIndex).reduce((a, b) => a + b, 0);
      const width = widths[colIndex];
      const right = colIndex === 4 || colIndex === 5;
      // Every cell in a row shares one baseline: the middle of the row, not the
      // top of the text box. Otherwise a wrapped name and a one-line SKU sit at
      // different heights and the row reads as two misaligned lines.
      const y = top + 4;

      // The muted status capsule keeps the inventory state easy to scan in print.
      if (colIndex === 7) {
        const colour =
          item.tone === "out" ? TERRACOTTA : item.tone === "low" ? OCHRE : SAGE;
        const wash =
          item.tone === "out"
            ? TERRACOTTA_WASH
            : item.tone === "low"
              ? OCHRE_WASH
              : SAGE_WASH;
        doc.font("Helvetica-Bold").fontSize(6.5);
        const badgeWidth = Math.min(
          width - 8,
          Math.max(
            43,
            doc.widthOfString(text.toUpperCase(), {
              characterSpacing: 0.25,
            }) + 15
          )
        );
        doc
          .roundedRect(left + 4, y - 1, badgeWidth, 13, 6)
          .fill(wash);
        doc
          .fillColor(colour)
          .font("Helvetica-Bold")
          .fontSize(6.5)
          .text(text.toUpperCase(), left + 10, y + 2, {
            width: badgeWidth - 12,
            align: "left",
            characterSpacing: 0.25,
            lineBreak: false,
          });
        return;
      }

      // An expiry date in the past is the reason an owner is reading this
      // report, so it is coloured rather than left as another grey cell.
      const colour =
        colIndex === 6 && item.expired
          ? TERRACOTTA
          : colIndex === 0
            ? COCOA_SOFT
            : COCOA;

      doc
        .fillColor(colour)
        .font(colIndex === 0 ? "Courier" : "Helvetica")
        .fontSize(colIndex === 0 ? 7.5 : 8.5)
        .text(text, left + 4, y, {
          width: width - 8,
          align: right ? "right" : "left",
          lineBreak: colIndex > 0 && colIndex < 4,
        });
    },
  });
}

function writeTopMoversTable(
  doc: PDFKit.PDFDocument,
  rows: PdfReport["topMovers"],
  widths: number[]
) {
  writeTable(doc, {
    columns: [
      { label: "SKU", width: widths[0] },
      { label: "Item", width: widths[1] },
      { label: "Qty checked out", width: widths[2], align: "right" },
    ],
    widths,
    emptyMessage: "No checkout activity matches these filters.",
    wrap: true,
    rows: rows.map((r) => [r.sku, r.name, r.qty]),
  });
}

function writeExpiryTable(
  doc: PDFKit.PDFDocument,
  rows: PdfReport["soonestExpiry"],
  widths: number[]
) {
  writeTable(doc, {
    columns: [
      { label: "SKU", width: widths[0] },
      { label: "Item", width: widths[1] },
      { label: "Category", width: widths[2] },
      { label: "Location", width: widths[3] },
      { label: "On hand", width: widths[4], align: "right" },
      { label: "Expiry", width: widths[5] },
      { label: "Days", width: widths[6], align: "right" },
    ],
    widths,
    emptyMessage: "No dated items match these filters.",
    wrap: true,
    rows: rows.map((r) => [
      r.sku,
      r.name,
      r.category,
      r.location,
      r.quantity,
      r.expiry,
      r.days === null ? "—" : r.days < 0 ? "Expired" : String(r.days),
    ]),
  });
}

function writeSummaryTable(
  doc: PDFKit.PDFDocument,
  rows: PdfReport["movementSummary"],
  widths: number[]
) {
  writeTable(doc, {
    columns: [
      { label: "Type", width: widths[0] },
      { label: "Transactions", width: widths[1], align: "right" },
      { label: "Quantity", width: widths[2], align: "right" },
    ],
    widths,
    emptyMessage: "No movements match these filters.",
    rows: rows.map((r) => [r.label, String(r.count), r.qty]),
  });
}

function writeWasteTable(
  doc: PDFKit.PDFDocument,
  rows: PdfReport["waste"],
  widths: number[]
) {
  writeTable(doc, {
    columns: [
      { label: "SKU", width: widths[0] },
      { label: "Item", width: widths[1] },
      { label: "Quantity wasted", width: widths[2], align: "right" },
      { label: "Events", width: widths[3], align: "right" },
    ],
    widths,
    emptyMessage: "No waste recorded in this report.",
    rows: rows.map((r) => [r.sku, r.name, r.qty, String(r.count)]),
  });
}

function writeMovementTable(
  doc: PDFKit.PDFDocument,
  rows: PdfReport["movementLines"],
  widths: number[]
) {
  writeTable(doc, {
    columns: [
      { label: "Date", width: widths[0] },
      { label: "Staff", width: widths[1] },
      { label: "Type", width: widths[2] },
      { label: "SKU", width: widths[3] },
      { label: "Item", width: widths[4] },
      { label: "Category", width: widths[5] },
      // "Qty" rather than "Quantity": 36pt of column cannot hold the long word at
      // 7.5pt, and a wrapped header is what put the movement rows out of line.
      { label: "Qty", width: widths[6], align: "right" },
      { label: "Note", width: widths[7] },
    ],
    widths,
    emptyMessage: "No movements match these filters.",
    // A note is free text and an ingredient name is whatever the owner typed, so
    // these cells wrap rather than being clipped — that is the reason someone
    // reads the movement detail at all.
    wrap: true,
    rows: rows.map((r) => [
      r.date,
      r.actorName,
      r.label,
      r.sku,
      r.itemName,
      r.category,
      r.quantity,
      r.note,
    ]),
  });
}

/**
 * Footer on every page.
 *
 * Written last, after the page count is known, by flipping back to each page with
 * `bufferPages`. The alternative — incrementing a counter as pages are added —
 * cannot print "of N" without knowing N.
 */
function stampPageNumbers(doc: PDFKit.PDFDocument, businessName: string) {
  const range = doc.bufferedPageRange();

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    const y = PAGE_HEIGHT - MARGIN - 12;
    doc
      .moveTo(MARGIN, y - 8)
      .lineTo(PAGE_WIDTH - MARGIN, y - 8)
      .lineWidth(0.7)
      .strokeColor(RULE)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(COCOA_SOFT)
      .text(`${businessName} · CafeTrack`, MARGIN, y, {
        width: CONTENT_WIDTH / 2,
        lineBreak: false,
      })
      .text(`Page ${i + 1} of ${range.count}`, MARGIN + CONTENT_WIDTH / 2, y, {
        width: CONTENT_WIDTH / 2,
        align: "right",
        lineBreak: false,
      });
  }
}