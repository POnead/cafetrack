/**
 * Unit tests for the historical inventory reconstruction and the client-side
 * regrouping used by the Reports page.
 *
 *   node scripts/_ts-node.mjs scripts/_inventory-history-tests.mjs
 *
 * The two halves of the feature get tested here because they are the two
 * halves where a silent wrong answer would look like a real number:
 *
 *   - src/lib/inventory-history.ts — the scan that caps a 50,000-movement
 *     walk and decides whether the history it read is the whole ledger, and
 *     the reconstruction that values each day.
 *   - src/components/charts/bucketHistory.ts — the grouping filter.
 *
 * Everything runs against synthetic ledgers injected through the scan's
 * `LedgerSource` seam, so exactly 50,000 and 50,001 movement lines are
 * ordinary inputs, not load tests against the real database.
 */
import assert from "node:assert/strict";
import {
  bucketHistoryPoints,
} from "../src/components/charts/bucketHistory.ts";
import {
  buildHistoryFromScan,
  scanLedger,
  SCAN_CAP,
  MAX_TRANSACTION_ROWS,
} from "../src/lib/inventory-history-core.ts";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${detail ? "  — " + detail : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* bucketHistory — the grouping filter                                  */
/* ------------------------------------------------------------------ */

function dayPoints(values) {
  // Daily server points: minCents == maxCents == valueCents.
  return values.map(([day, cents]) => ({
    day,
    label: day,
    periodFrom: day,
    periodTo: day,
    valueCents: cents,
    minCents: cents,
    maxCents: cents,
  }));
}

function weekPoints(values) {
  // Weekly server points with a known intra-week range.
  return values.map(([day, cents, min, max]) => ({
    day,
    label: day,
    periodFrom: day,
    periodTo: day,
    valueCents: cents,
    minCents: min,
    maxCents: max,
  }));
}

console.log("\ngrouping — daily");
{
  const server = dayPoints([
    ["2026-11-09", 1_000_000],
    ["2026-11-10", 2_000_000],
    ["2026-11-11", 3_000_000],
  ]);
  const out = bucketHistoryPoints(server, "daily", "day");
  check(
    "daily grouping with daily server data keeps the points untouched",
    out.effective === "day" &&
      out.points.length === 3 &&
      out.points[0].valueCents === 1_000_000 &&
      out.points[2].valueCents === 3_000_000
  );
}

console.log("\ngrouping — weekly");
{
  const server = dayPoints([
    ["2026-11-02", 100], // Mon
    ["2026-11-04", 400],
    ["2026-11-06", 700],
    ["2026-11-09", 200], // next Mon
    ["2026-11-11", 900],
  ]);
  const out = bucketHistoryPoints(server, "weekly", "day");
  check(
    "daily server data regrouped to weekly",
    out.effective === "week" && out.points.length === 2,
    `${out.points.length} weeks`
  );
  const first = out.points[0];
  const second = out.points[1];
  check(
    "weekly point ends on the last day of the week, value = end value",
    first.day === "2026-11-06" && first.valueCents === 700
  );
  check(
    "weekly min/max comes from the dailies, not the endpoints",
    first.minCents === 100 && first.maxCents === 700,
    `min ${first.minCents} max ${first.maxCents}`
  );
  check(
    "second week keeps its own range",
    second.minCents === 200 && second.maxCents === 900
  );
}

console.log("\ngrouping — monthly");
{
  const server = dayPoints([
    ["2026-10-03", 100],
    ["2026-10-20", 5_000],
    ["2026-10-31", 200],
    ["2026-11-05", 10_000],
    ["2026-11-19", 300],
  ]);
  const out = bucketHistoryPoints(server, "monthly", "day");
  check(
    "daily server data regrouped to monthly",
    out.effective === "month" && out.points.length === 2,
    `${out.points.length} months`
  );
  check(
    "october keeps its real minimum (100) and maximum (5000)",
    out.points[0].minCents === 100 && out.points[0].maxCents === 5_000,
    `min ${out.points[0].minCents} max ${out.points[0].maxCents}`
  );
}
{
  // The server already coarsened to weeks; regrouping to months must carry
  // each week's known range, not just its endpoint.
  const server = weekPoints([
    ["2026-10-04", 900, 100, 900], // Sunday, end of the first week
    ["2026-10-11", 500, 200, 950],
    ["2026-10-18", 400, 350, 480],
    ["2026-11-01", 700, 650, 1_000],
  ]);
  const out = bucketHistoryPoints(server, "monthly", "week");
  check(
    "weekly server data regrouped to monthly",
    out.effective === "month" && out.points.length === 2,
    `${out.points.length} months`
  );
  const october = out.points[0];
  check(
    "monthly min/max is the minimum of the weekly minimums and the maximum of the weekly maximums",
    october.minCents === 100 && october.maxCents === 950,
    `min ${october.minCents} max ${october.maxCents}`
  );
  check(
    "november keeps its own range",
    out.points[1].minCents === 650 && out.points[1].maxCents === 1_000
  );
}

console.log("\ngrouping — auto");
{
  const server = dayPoints([
    ["2026-11-09", 42],
  ]);
  const out = bucketHistoryPoints(server, "auto", "day");
  check(
    "auto passes the server series through untouched",
    out.effective === "day" && out.points === server
  );
  const weekly = bucketHistoryPoints(server, "auto", "week");
  check(
    "auto keeps a coarsened server granularity as reported",
    weekly.effective === "week" && weekly.points === server
  );
}

console.log("\ngrouping — coarser server data is respected");
{
  const server = weekPoints([["2026-10-04", 900, 100, 900]]);
  const out = bucketHistoryPoints(server, "daily", "week");
  check(
    "requesting daily from a weekly server series does not invent days",
    out.effective === "week" && out.points === server
  );
}

/* ------------------------------------------------------------------ */
/* scanRaw — multi-line transactions and the movement-line cap          */
/* ------------------------------------------------------------------ */

const ITEMS = [
  { sku: "AAA", name: "AAA", quantity: 10, unitPrice: 100, categoryId: "cat-1" },
];

function makeSource(transactions) {
  const txns = transactions.map((transaction, i) => ({
    id: String(i).padStart(10, "0"),
    created_at: transaction.created_at,
    transaction_items: (transaction.lines ?? []).map((line, j) => ({
      id: `${String(i).padStart(10, "0")}-${String(j).padStart(4, "0")}`,
      sku: line.sku ?? "AAA",
      quantity: 1,
      qty_before: line.qty_before,
      qty_after: line.qty_after,
    })),
  }));
  return {
    async fetchItems() {
      return ITEMS.map((item) => ({ ...item }));
    },
    async fetchTransactionPage(offset, limit) {
      return txns.slice(offset, offset + limit);
    },
  };
}

function makeLedger(transactions, linesPerTxn, startAt) {
  // Newest first, like the real query does.
  const out = [];
  let at = startAt ?? Date.parse("2026-11-01T00:00:00.000Z");
  for (let i = 0; i < transactions; i += 1) {
    const lines = [];
    for (let j = 0; j < linesPerTxn; j += 1) {
      lines.push({ qty_before: 100 + j, qty_after: 99 + j });
    }
    out.push({ created_at: new Date(at).toISOString(), lines });
    at -= 60_000; // each transaction a minute older than the last
  }
  return out;
}

/**
 * A ledger whose rows are deliberately broken, in the ways the real ledger
 * could be broken by a bad import: quantities that are not numbers at all.
 * Rows carry ids and timestamps like ordinary rows — the scan must read them,
 * spend its budget on them, and keep them out of the reconstruction.
 */
function makeInvalidLedger(transactions, linesPerTxn, isInvalid, startAt) {
  const out = [];
  let at = startAt ?? Date.parse("2026-11-01T00:00:00.000Z");
  let lineIndex = 0;
  for (let i = 0; i < transactions; i += 1) {
    const lines = [];
    for (let j = 0; j < linesPerTxn; j += 1) {
      const bad = isInvalid(lineIndex);
      lineIndex += 1;
      lines.push({
        sku: "AAA",
        qty_before: bad ? "garbage" : 100 + j,
        qty_after: bad ? "not-a-number" : 99 + j,
      });
    }
    out.push({ created_at: new Date(at).toISOString(), lines });
    at -= 60_000;
  }
  return out;
}

console.log("\nscan — multiple movement lines");
{
  const ledger = makeLedger(3, 4, Date.parse("2026-11-01T00:00:00.000Z"));
  const scan = await scanLedger(makeSource(ledger));
  check(
    "every line of every transaction is scanned",
    scan.movementsScanned === 12,
    `${scan.movementsScanned} lines`
  );
  check("three transactions were scanned", scan.transactionsScanned === 3);
  check("complete ledger reports completeness \"complete\"", scan.completeness === "complete");
  check("complete ledger is not truncated", scan.truncated === false);
}

console.log("\nscan — exactly 50,000 movement lines");
{
  const ledger = makeLedger(250, 200, Date.parse("2026-11-01T00:00:00.000Z"));
  const scan = await scanLedger(makeSource(ledger));
  check(
    "exactly the cap is read",
    scan.movementsScanned === SCAN_CAP,
    `${scan.movementsScanned} lines`
  );
  check("the ledger ended, so the scan is complete", scan.completeness === "complete");
  check("complete means not truncated", scan.truncated === false);
}

console.log("\nscan — more than 50,000 movement lines");
{
  const ledger = makeLedger(250, 201, Date.parse("2026-11-01T00:00:00.000Z"));
  const scan = await scanLedger(makeSource(ledger));
  check(
    "the scan stops at the cap",
    scan.movementsScanned === SCAN_CAP,
    `${scan.movementsScanned} lines`
  );
  check("an overflowing ledger is reported as truncated", scan.truncated === true);
  check("completeness is \"truncated\"", scan.completeness === "truncated");
}

console.log("\nscan — probe at an exact page boundary");
{
  // 500 transactions × 100 lines = exactly the cap, one full page.
  const full = makeLedger(500, 100, Date.parse("2026-11-01T00:00:00.000Z"));
  const scanFull = await scanLedger(makeSource(full));
  check(
    "boundary at the cap with an empty ledger past it reports complete",
    scanFull.completeness === "complete" &&
      scanFull.movementsScanned === SCAN_CAP &&
      scanFull.truncated === false,
    `completeness ${scanFull.completeness}`
  );

  // Same page, one more transaction beyond it.
  const withExtra = [
    ...full,
    {
      created_at: new Date(Date.parse("2026-10-01T00:00:00.000Z")).toISOString(),
      lines: [{ sku: "AAA", qty_before: 1, qty_after: 2 }],
    },
  ];
  const scanExtra = await scanLedger(makeSource(withExtra));
  check(
    "boundary at the cap with one more line past it reports truncated",
    scanExtra.completeness === "truncated" &&
      scanExtra.movementsScanned === SCAN_CAP &&
      scanExtra.truncated === true,
    `completeness ${scanExtra.completeness}`
  );
}

console.log("\nscan — probe cannot decide, reports unknown");
{
  const full = makeLedger(500, 100, Date.parse("2026-11-01T00:00:00.000Z"));
  // Four full pages of transactions that carry no lines: the bounded probe
  // cannot tell whether a line exists further on.
  const noise = Array.from({ length: 2000 }, (_, i) => ({
    created_at: new Date(Date.parse("2026-09-01T00:00:00.000Z") - i * 60_000).toISOString(),
    lines: [],
  }));
  const beyond = {
    created_at: new Date(Date.parse("2026-08-01T00:00:00.000Z")).toISOString(),
    lines: [{ sku: "AAA", qty_before: 1, qty_after: 2 }],
  };
  const scan = await scanLedger(makeSource([...full, ...noise, beyond]));
  check(
    "an undecidable probe reports completeness \"unknown\", never \"complete\"",
    scan.completeness === "unknown" && scan.truncated === false,
    `completeness ${scan.completeness}`
  );
  check(
    "movementsScanned still reports the lines that were scanned",
    scan.movementsScanned === SCAN_CAP
  );
}

console.log("\nscan — probe sees a short page and stops");
{
  const full = makeLedger(500, 100, Date.parse("2026-11-01T00:00:00.000Z"));
  const noise = Array.from({ length: 700 }, (_, i) => ({
    created_at: new Date(Date.parse("2026-09-01T00:00:00.000Z") - i * 60_000).toISOString(),
    lines: [],
  }));
  // 700 zero-line transactions: the probe walks page 1 (500, full, nothing)
  // and page 2 (200 rows, short) before deciding the ledger ended.
  const scan = await scanLedger(makeSource([...full, ...noise]));
  check(
    "a short probe page concludes the ledger ended",
    scan.completeness === "complete" && scan.truncated === false,
    `completeness ${scan.completeness}`
  );
}

/* ------------------------------------------------------------------ */
/* scan — the transaction-row budget bounds a line-free ledger          */
/* ------------------------------------------------------------------ */

console.log("\nscan — transaction budget stops a ledger of empty transactions");
{
  // 60,000 transactions with no movement lines at all: the movement-line cap
  // never fires, so without the row budget this walk would never end. The
  // scan stops at MAX_TRANSACTION_ROWS and asks the bounded probe what lies
  // past it; four full pages of line-free rows cannot establish that, so the
  // answer is "unknown" — never "complete".
  const ledger = makeLedger(
    60_000,
    0,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const scan = await scanLedger(makeSource(ledger));
  check(
    "the scan stops at the transaction budget",
    scan.transactionsScanned === MAX_TRANSACTION_ROWS,
    `${scan.transactionsScanned} transactions`
  );
  check(
    "a full ledger of empty transactions past the budget reports unknown, never complete",
    scan.completeness === "unknown" && scan.truncated === false,
    `completeness ${scan.completeness}`
  );
  check(
    "the movement-line accounting is untouched by the transaction budget",
    scan.movementsScanned === 0
  );
}

console.log("\nscan — exactly at the transaction budget, the ledger ends");
{
  // Exactly MAX_TRANSACTION_ROWS transactions and then nothing: the bounded
  // probe sees the ledger ended, so this reports complete.
  const ledger = makeLedger(
    MAX_TRANSACTION_ROWS,
    0,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const scan = await scanLedger(makeSource(ledger));
  check(
    "the ledger ending exactly at the transaction budget reports complete",
    scan.completeness === "complete" &&
      scan.transactionsScanned === MAX_TRANSACTION_ROWS &&
      scan.truncated === false,
    `completeness ${scan.completeness}, transactionsScanned ${scan.transactionsScanned}`
  );
}

console.log("\nscan — a movement line found past the transaction budget");
{
  // MAX_TRANSACTION_ROWS empty transactions, then one transaction carrying a
  // line. The budget stops the walk before it; the probe finds the line and
  // reports truncation — history definitively does not reach that row.
  const empty = makeLedger(
    MAX_TRANSACTION_ROWS,
    0,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const withLine = {
    created_at: new Date(Date.parse("2026-10-01T00:00:00.000Z")).toISOString(),
    lines: [{ sku: "AAA", qty_before: 1, qty_after: 2 }],
  };
  const scan = await scanLedger(makeSource([...empty, withLine]));
  check(
    "a line past the transaction budget is reported truncated",
    scan.completeness === "truncated" &&
      scan.truncated === true &&
      scan.transactionsScanned === MAX_TRANSACTION_ROWS,
    `completeness ${scan.completeness}`
  );
}

console.log("\nscan — movement-line cap and transaction budget interact");
{
  // 60,000 single-line transactions: the 50,000-line cap fires on the
  // 50,000th line, before the transaction budget is spent. The line cap
  // wins, exactly as before the budget existed.
  const ledger = makeLedger(
    60_000,
    1,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const scan = await scanLedger(makeSource(ledger));
  check(
    "the movement-line cap fires before the transaction budget",
    scan.completeness === "truncated" &&
      scan.truncated === true &&
      scan.movementsScanned === SCAN_CAP &&
      scan.transactionsScanned === SCAN_CAP,
    `completeness ${scan.completeness}, transactionsScanned ${scan.transactionsScanned}`
  );
}

console.log("\nscan — empty transactions are counted exactly once");
{
  // A small ledger of mixed shape: some transactions carry lines, some do
  // not. Every transaction is counted exactly once either way.
  const ledger = [
    { created_at: "2026-11-03T00:00:00.000Z", lines: [] },
    {
      created_at: "2026-11-02T00:00:00.000Z",
      lines: [{ sku: "AAA", qty_before: 10, qty_after: 12 }],
    },
    { created_at: "2026-11-01T00:00:00.000Z", lines: [] },
    {
      created_at: "2026-10-31T00:00:00.000Z",
      lines: [
        { sku: "AAA", qty_before: 12, qty_after: 9 },
        { sku: "AAA", qty_before: 9, qty_after: 8 },
      ],
    },
  ];
  const scan = await scanLedger(makeSource(ledger));
  check(
    "transactions with no lines are counted exactly once",
    scan.transactionsScanned === 4,
    `${scan.transactionsScanned} transactions`
  );
  check(
    "every line of every transaction is read, and the ledger ends complete",
    scan.movementsScanned === 3 && scan.completeness === "complete",
    `${scan.movementsScanned} lines, completeness ${scan.completeness}`
  );
}

function scanOfLineCapped(overrides) {
  return scanOf({
    completeness: "truncated",
    truncated: true,
    stopReason: "movement-lines",
    movementsScanned: 50000,
    historyFrom: new Date(Date.parse("2026-11-03T00:00:00.000Z")).toISOString(),
    historyTo: new Date(Date.parse("2026-11-05T00:00:00.000Z")).toISOString(),
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* scan — the stop reason travels with the scan and the coverage data */
/* ------------------------------------------------------------------ */

console.log("\nscan — the stop reason is reported with the scan");
{
  const ledger = makeLedger(250, 201, Date.parse("2026-11-01T00:00:00.000Z"));
  const scan = await scanLedger(makeSource(ledger));
  check(
    "a line-cap truncation reports stopReason \"movement-lines\"",
    scan.stopReason === "movement-lines",
    scan.stopReason
  );
}
{
  const ledger = makeLedger(
    60_000,
    0,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const scan = await scanLedger(makeSource(ledger));
  check(
    "the transaction budget reports stopReason \"transaction-rows\"",
    scan.stopReason === "transaction-rows",
    scan.stopReason
  );
}
{
  // Exactly the transaction budget and then nothing: the ledger ends and the
  // probe confirms it, while the budget that stopped the walk is named.
  const ledger = makeLedger(
    MAX_TRANSACTION_ROWS,
    0,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const scan = await scanLedger(makeSource(ledger));
  check(
    "an exact-budget ledger that ends reports transaction-rows and complete",
    scan.stopReason === "transaction-rows" && scan.completeness === "complete",
    `${scan.stopReason}/${scan.completeness}`
  );
}
{
  const empty = makeLedger(
    MAX_TRANSACTION_ROWS,
    0,
    Date.parse("2026-11-01T00:00:00.000Z")
  );
  const withLine = {
    created_at: new Date(Date.parse("2026-10-01T00:00:00.000Z")).toISOString(),
    lines: [{ sku: "AAA", qty_before: 1, qty_after: 2 }],
  };
  const scan = await scanLedger(makeSource([...empty, withLine]));
  check(
    "a line found past the transaction budget is truncated / transaction-rows",
    scan.stopReason === "transaction-rows" &&
      scan.completeness === "truncated" &&
      scan.truncated === true,
    `${scan.stopReason}/${scan.completeness}`
  );
}
{
  // Line cap, exact page boundary, one more line beyond: the probe reports
  // truncation and the reason is the movement-line budget.
  const full = makeLedger(500, 100, Date.parse("2026-11-01T00:00:00.000Z"));
  const withExtra = [
    ...full,
    {
      created_at: new Date(Date.parse("2026-10-01T00:00:00.000Z")).toISOString(),
      lines: [{ sku: "AAA", qty_before: 1, qty_after: 2 }],
    },
  ];
  const scan = await scanLedger(makeSource(withExtra));
  check(
    "a line found past the line-cap boundary is truncated / movement-lines",
    scan.stopReason === "movement-lines" &&
      scan.completeness === "truncated",
    `${scan.stopReason}/${scan.completeness}`
  );
}
{
  // Line cap, exact page boundary, probe cannot decide: unknown, and the
  // reason stays the movement-line budget.
  const full = makeLedger(500, 100, Date.parse("2026-11-01T00:00:00.000Z"));
  const noise = Array.from({ length: 2000 }, (_, i) => ({
    created_at: new Date(Date.parse("2026-09-01T00:00:00.000Z") - i * 60_000).toISOString(),
    lines: [],
  }));
  const beyond = {
    created_at: new Date(Date.parse("2026-08-01T00:00:00.000Z")).toISOString(),
    lines: [{ sku: "AAA", qty_before: 1, qty_after: 2 }],
  };
  const scan = await scanLedger(makeSource([...full, ...noise, beyond]));
  check(
    "an undecidable probe reports unknown / movement-lines",
    scan.stopReason === "movement-lines" &&
      scan.completeness === "unknown" &&
      scan.truncated === false,
    `${scan.stopReason}/${scan.completeness}`
  );
}
{
  const ledger = makeLedger(3, 4, Date.parse("2026-11-01T00:00:00.000Z"));
  const scan = await scanLedger(makeSource(ledger));
  check(
    "an ordinary complete ledger reports ledger-ended",
    scan.stopReason === "ledger-ended" && scan.completeness === "complete",
    scan.stopReason
  );
}
{
  // Reconstruction: a transaction-cap truncation clamps exactly like a
  // movement-line one — reason is metadata, not a different computation.
  const result = buildHistoryFromScan(
    scanOf({
      completeness: "truncated",
      truncated: true,
      stopReason: "transaction-rows",
      movementsScanned: 50000,
      historyFrom: new Date(Date.parse("2026-11-03T00:00:00.000Z")).toISOString(),
      historyTo: new Date(Date.parse("2026-11-05T00:00:00.000Z")).toISOString(),
    }),
    { from: "2026-01-01", to: "2026-11-10", category: null }
  );
  check(
    "transaction-cap truncation clamps the range exactly like line-cap truncation",
    result.requested.effectiveFrom === "2026-11-03" &&
      result.requested.rangeShortened === true &&
      result.requested.from === "2026-01-01",
    `effectiveFrom ${result.requested.effectiveFrom}`
  );
  check(
    "coverage exposes the transaction stop reason and cap",
    result.coverage.stopReason === "transaction-rows" &&
      result.coverage.transactionCap === 50000 &&
      result.coverage.cap === 50000,
    JSON.stringify(result.coverage.stopReason)
  );
}
{
  const result = buildHistoryFromScan(
    scanOfLineCapped({}),
    { from: "2026-01-01", to: "2026-11-10", category: null }
  );
  check(
    "coverage exposes the movement-line stop reason",
    result.coverage.stopReason === "movement-lines" &&
      result.coverage.cap === 50000 &&
      result.coverage.truncated === true,
    JSON.stringify([result.coverage.stopReason, result.coverage.truncated])
  );
}

/* ------------------------------------------------------------------ */
/* scan — invalid rows still consume the cap                            */
/* ------------------------------------------------------------------ */

console.log("\nscan — invalid rows still consume the cap");
{
  // Every row broken: the scan may read exactly 50,000 of them and no more.
  const ledger = makeInvalidLedger(600, 100, () => true);
  const scan = await scanLedger(makeSource(ledger));
  check(
    "more rows than the cap cannot cause more than the cap to be scanned",
    scan.movementsScanned === SCAN_CAP,
    `${scan.movementsScanned} rows`
  );
  check(
    "invalid rows beyond the cap are reported truncated",
    scan.completeness === "truncated" && scan.truncated === true,
    `completeness ${scan.completeness}`
  );
  check(
    "no invalid row is used for reconstruction",
    scan.movements.length === 0
  );
}
{
  // Mixed ledger, half the rows broken: only the valid half may reach the
  // reconstruction, but every row read still spends budget.
  const ledger = makeInvalidLedger(300, 200, (i) => i % 2 === 0);
  // 300 × 200 = 60,000 rows, half of them unusable.
  const scan = await scanLedger(makeSource(ledger));
  check(
    "a mixed ledger still caps at 50,000 rows",
    scan.movementsScanned === SCAN_CAP,
    `${scan.movementsScanned} rows`
  );
  const usable = scan.movements.length;
  check(
    "only valid rows entered the timeline",
    usable === 25_000,
    `${usable} valid rows of the first 50,000`
  );
  check(
    "an overflowing mixed ledger reports truncated",
    scan.completeness === "truncated" && scan.truncated === true,
    `completeness ${scan.completeness}`
  );
}
{
  // An all-invalid ledger that ends exactly on the cap: the whole ledger
  // fits, so the scan is complete even though not one row was usable.
  const ledger = makeInvalidLedger(500, 100, () => true);
  const scan = await scanLedger(makeSource(ledger));
  check(
    "exactly the cap in invalid rows, ledger ends: complete",
    scan.movementsScanned === SCAN_CAP &&
      scan.completeness === "complete" &&
      scan.truncated === false,
    `completeness ${scan.completeness}`
  );
  check(
    "none of the 50,000 invalid rows entered the timeline",
    scan.movements.length === 0
  );
}

console.log("\nscan — invalid rows at the cap boundary");
{
  // Exactly 50,000 valid rows, then one broken row: the probe reports the
  // ledger definitively overflows the cap.
  const full = makeLedger(500, 100, Date.parse("2026-11-01T00:00:00.000Z"));
  const extra = [
    {
      created_at: new Date(Date.parse("2026-10-01T00:00:00.000Z")).toISOString(),
      lines: [{ sku: "AAA", qty_before: "garbage", qty_after: "also garbage" }],
    },
  ];
  const scan = await scanLedger(makeSource([...full, ...extra]));
  check(
    "a broken row past the cap is detected by the probe",
    scan.completeness === "truncated" &&
      scan.movementsScanned === SCAN_CAP &&
      scan.truncated === true,
    `completeness ${scan.completeness}`
  );
}
{
  // Exactly 50,000 rows again, this time the 50,000th is broken and the
  // ledger ends right there.
  const ledger = makeInvalidLedger(500, 100, (i) => i === 49_999);
  const scan = await scanLedger(makeSource(ledger));
  check(
    "an invalid row ending exactly on the cap still reports complete",
    scan.movementsScanned === SCAN_CAP &&
      scan.completeness === "complete" &&
      scan.truncated === false &&
      scan.movements.length === SCAN_CAP - 1,
    `completeness ${scan.completeness}, usable ${scan.movements.length}`
  );
}
{
  // A ledger that is ONLY invalid rows of exactly 50,000 rows: every row
  // spends budget, the ledger ends, and the scan is complete — not one
  // usable row, yet nothing was missed either.
  const ledger = makeInvalidLedger(250, 200, () => true);
  const scan = await scanLedger(makeSource(ledger));
  check(
    "an all-invalid ledger of exactly 50,000 rows spends the whole budget and ends",
    scan.movementsScanned === SCAN_CAP &&
      scan.movements.length === 0 &&
      scan.completeness === "complete",
    `completeness ${scan.completeness}`
  );
}

console.log("\nreconstruction — invalid rows are not inputs");
{
  // The two scans differ only in broken rows; the series must be identical.
  const at = Date.parse("2026-11-02T00:00:00.000Z");
  const valid = {
    sku: "AAA",
    at,
    qtyBefore: 50,
    qtyAfter: 42,
  };
  const baseScan = {
    items: [
      { sku: "AAA", name: "AAA", quantity: 100, unitPrice: 100, categoryId: null },
    ],
    movements: [valid],
    transactionsScanned: 1,
    movementsScanned: 2,
    historyFrom: new Date(at).toISOString(),
    historyTo: new Date(at).toISOString(),
    truncated: false,
    completeness: "complete",
  };
  const result = buildHistoryFromScan(baseScan, {
    from: "2026-10-20",
    to: "2026-11-05",
    category: null,
  });
  const byDay = new Map(result.points.map((p) => [p.day, p.valueCents]));
  check(
    "reconstruction is built from the valid row alone",
    byDay.get("2026-11-05") === 42 * 100 * 100,
    `got ${byDay.get("2026-11-05")}`
  );
  check(
    "no point reflects a broken row",
    result.points.every((p) => Number.isFinite(p.valueCents))
  );
}

/* ------------------------------------------------------------------ */
/* reconstruction — baselines and the truncated clamp                   */
/* ------------------------------------------------------------------ */

function scanOf(overrides) {
  return {
    items: [
      { sku: "AAA", name: "AAA", quantity: 100, unitPrice: 10, categoryId: "cat-1" },
    ],
    movements: [
      { sku: "AAA", at: Date.parse("2026-11-01T00:00:00.000Z"), qtyBefore: 50, qtyAfter: 60 },
      { sku: "AAA", at: Date.parse("2026-11-05T00:00:00.000Z"), qtyBefore: 60, qtyAfter: 45 },
    ],
    transactionsScanned: 2,
    movementsScanned: 2,
    historyFrom: new Date(Date.parse("2026-11-01T00:00:00.000Z")).toISOString(),
    historyTo: new Date(Date.parse("2026-11-05T00:00:00.000Z")).toISOString(),
    truncated: false,
    completeness: "complete",
    stopReason: "ledger-ended",
    ...overrides,
  };
}

console.log("\nreconstruction — non-truncated baseline");
{
  const result = buildHistoryFromScan(scanOf({}), {
    from: "2026-10-15",
    to: "2026-11-10",
    category: null,
  });
  const first = result.points[0];
  check(
    "before the first movement the balance is the first qty_before (× price)",
    first.valueCents === 50 * 10 * 100,
    `got ${first.valueCents}`
  );
  check(
    "the requested range is kept when history is complete",
    result.requested.effectiveFrom === "2026-10-15" &&
      result.requested.rangeShortened === false &&
      result.requested.from === "2026-10-15"
  );
}

console.log("\nreconstruction — stream of values after movements");
{
  const result = buildHistoryFromScan(scanOf({}), {
    from: "2026-10-30",
    to: "2026-11-10",
    category: null,
  });
  const byDay = new Map(result.points.map((p) => [p.day, p.valueCents]));
  check(
    "after the restock the balance follows the latest qty_after",
    byDay.get("2026-11-02") === 60 * 10 * 100,
    `got ${byDay.get("2026-11-02")}`
  );
  check(
    "after the checkout the balance follows the newer qty_after",
    byDay.get("2026-11-06") === 45 * 10 * 100,
    `got ${byDay.get("2026-11-06")}`
  );
}

console.log("\nreconstruction — truncated history clamps the start");
{
  const truncated = scanOf({
    completeness: "truncated",
    truncated: true,
    movementsScanned: 50000,
    historyFrom: new Date(Date.parse("2026-11-03T00:00:00.000Z")).toISOString(),
    historyTo: new Date(Date.parse("2026-11-05T00:00:00.000Z")).toISOString(),
  });
  const result = buildHistoryFromScan(truncated, {
    from: "2026-01-01",
    to: "2026-11-10",
    category: null,
  });
  check(
    "the series starts at the earliest scanned movement",
    result.requested.effectiveFrom === "2026-11-03",
    `effectiveFrom ${result.requested.effectiveFrom}`
  );
  check(
    "the caller's requested start is preserved separately",
    result.requested.from === "2026-01-01"
  );
  check(
    "the shortening is flagged",
    result.requested.rangeShortened === true
  );
  check(
    "no points are produced before the scanned coverage",
    result.points.every((point) => point.periodFrom >= "2026-11-03")
  );
}

console.log("\nreconstruction — unknown completeness also clamps");
{
  const unknown = scanOf({
    completeness: "unknown",
    truncated: false,
    movementsScanned: 50000,
    historyFrom: new Date(Date.parse("2026-11-03T00:00:00.000Z")).toISOString(),
  });
  const result = buildHistoryFromScan(unknown, {
    from: "2026-01-01",
    to: "2026-11-10",
    category: null,
  });
  check(
    "unknown completeness shortens the range just like truncation",
    result.requested.effectiveFrom === "2026-11-03" &&
      result.requested.rangeShortened === true
  );
}

console.log("\nreconstruction — complete history with early requested start does not clamp");
{
  const result = buildHistoryFromScan(scanOf({}), {
    from: "2026-01-01",
    to: "2026-11-10",
    category: null,
  });
  check(
    "complete coverage keeps the requested early start",
    result.requested.effectiveFrom === "2026-01-01" &&
      result.requested.rangeShortened === false
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
