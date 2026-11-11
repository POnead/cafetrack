import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { buildStockReportPdf } from "../src/lib/report-pdf.ts";

const itemRows = Array.from({ length: 140 }, (_, index) => ({
  sku: `SKU-${String(index + 1).padStart(4, "0")}`,
  name: `Pantry item ${index + 1}`,
  category: index % 2 ? "Bakery" : "Dry goods",
  location: index % 2 ? "Chiller" : "Store room",
  quantity: `${index + 1} kg`,
  threshold: "5 kg",
  expiry: index % 2 ? "2026-12-01" : "—",
  expired: false,
  status: index % 3 === 0 ? "Low stock" : "In stock",
  tone: index % 3 === 0 ? "low" : "ok",
}));

const movementLines = Array.from({ length: 90 }, (_, index) => ({
  date: `11/${String((index % 28) + 1).padStart(2, "0")}/2026`,
  actorName: `Staff ${index % 8 + 1}`,
  label: index % 2 ? "Checked out" : "Restocked",
  sku: `SKU-${String(index + 1).padStart(4, "0")}`,
  itemName: `Pantry item ${index + 1}`,
  category: index % 2 ? "Bakery" : "Dry goods",
  quantity: `${index + 1} kg`,
  note: index === 89 ? "Final movement note to confirm the last row is retained." : "—",
}));

const report = {
  businessName: "Merrylane Cafe Foodhub",
  generated: "Nov 6, 2026, 6:45 PM",
  filterDescription: "Oct 1 – Nov 6, 2026 · All staff · All movement types",
  tiles: [
    { label: "Items tracked", value: 140 },
    { label: "Low stock", value: 47 },
    { label: "Out of stock", value: 3 },
    { label: "Transactions", value: 90 },
  ],
  items: itemRows,
  topMovers: [{ sku: "SKU-0001", name: "Pantry item 1", qty: "42 kg" }],
  soonestExpiry: [{
    sku: "SKU-0002",
    name: "Pantry item 2",
    category: "Dry goods",
    location: "Store room",
    quantity: "2 kg",
    expiry: "2026-12-01",
    days: 25,
  }],
  movementSummary: [
    { label: "Checked out", count: 45, qty: "125 kg" },
    { label: "Restocked", count: 40, qty: "210 kg" },
    { label: "Logged as waste", count: 5, qty: "8 kg" },
  ],
  waste: [{ sku: "SKU-0003", name: "Pantry item 3", qty: "8 kg", count: 2 }],
  movementLines,
  warnings: ["Historical transaction notes are unavailable."],
};

const originalReport = JSON.stringify(report);
const pdf = await buildStockReportPdf(report);
assert.ok(pdf.subarray(0, 8).toString("ascii").startsWith("%PDF-"));
assert.equal(pdf.subarray(-6).toString("ascii").trim(), "%%EOF");

const source = pdf.toString("latin1");
const pageCount = Number(source.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/)?.[1]);
assert.equal(
  (source.match(/\/Type\s*\/Page\b/g) ?? []).length,
  pageCount,
  "all rendered page objects should be represented in the page tree"
);
assert.ok(pageCount > 1, "long reports should paginate instead of clipping");

const text = [];
for (const match of source.matchAll(/stream\r?\n/g)) {
  const start = match.index + match[0].length;
  const end = source.indexOf("endstream", start);
  if (end < 0) continue;
  try {
    text.push(inflateSync(pdf.subarray(start, end)).toString("latin1"));
  } catch {
    // Ignore non-Flate streams; only PDF text streams are relevant here.
  }
}
const rendered = text
  .map((stream) =>
    [...stream.matchAll(/<([0-9a-f]+)>/gi)]
      .map((match) => Buffer.from(match[1], "hex").toString("latin1"))
      .join("")
  )
  .join("\n");
const normalizedRendered = rendered.replace(/\s+/g, "").toUpperCase();
for (const expected of [
  "CAFETRACK",
  "Merrylane Cafe Foodhub",
  "Stock report",
  "FILTER RANGE",
  "Nov 6, 2026",
  "Historical transaction notes are unavailable.",
  "Items tracked",
  "Movement summary",
  "Waste tracking",
  "Movement details",
  "Category",
  "Location",
  "On hand",
  "Status",
  "Transactions",
  "Events",
  "Staff",
  "Note",
  "Low stock",
  "SKU-0001",
  "Pantry item 140",
  "Final movement note",
  "Page 1 of",
  `Page ${pageCount} of ${pageCount}`,
]) {
  assert.ok(
    normalizedRendered.includes(expected.replace(/\s+/g, "").toUpperCase()),
    `PDF text should include "${expected}"`
  );
}
assert.ok(
  (normalizedRendered.match(/CAFETRACK/g) ?? []).length >= pageCount,
  "every page should retain its CafeTrack running header"
);
assert.equal(JSON.stringify(report), originalReport, "rendering must not mutate report data");

console.log(`PDF report regression checks passed (${pageCount} pages).`);
