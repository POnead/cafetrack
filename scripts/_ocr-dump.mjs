/**
 * Diagnostic: what does the OCR engine actually see on a real card?
 *
 *   node scripts/_ts-node.mjs scripts/_ocr-dump.mjs <image> <docType>
 *
 * Dumps the raw words with coordinates, the rows the layout builder groups them
 * into, and what extract() makes of them. This exists because a failing read is
 * almost never visible from the signal alone: the signal says "nothing was read"
 * or "matched on shape", and both of those are equally true whether the text was
 * never seen, was seen and rejected, or was seen and mis-grouped.
 *
 * The engine is the same one the app uses, on the same image, so anything this
 * prints is what production would have seen.
 */

import { runOcr, disposeWorker, languageModelPresent } from "../src/lib/id-verification/ocr/engine.ts";
import { buildLayout } from "../src/lib/id-verification/ocr/rows.ts";
import { extract, isTrustworthy } from "../src/lib/id-verification/ocr/extract.ts";
import { templateFor } from "../src/lib/id-verification/ocr/templates.ts";

const imagePath = process.argv[2];
const docType = process.argv[3] ?? "philsys";

if (!languageModelPresent()) {
  console.error("the language model is not on disk; run npm run test:ocr-live first");
  process.exit(2);
}

console.log(`image:    ${imagePath}`);
console.log(`doc type: ${docType}\n`);

const template = templateFor(docType);
console.log(`template: ${template.label}`);
console.log(`stackedValueAboveLabel: ${Boolean(template.stackedValueAboveLabel)}`);
console.log(`noise: ${template.noise.map(String).join("  ")}\n`);

const bytes = new Uint8Array((await import("node:fs")).readFileSync(imagePath));
const run = await runOcr(bytes);

console.log(`engine confidence: ${Math.round(run.confidence)}%`);
console.log(`words: ${run.words.length}\n`);

console.log("=== RAW WORDS (text | x0 | y0 | x1 | y1 | confidence) ===");
for (const w of run.words) {
  console.log(
    `  ${JSON.stringify(w.text).padEnd(22)} x0=${String(Math.round(w.x0)).padStart(5)} ` +
      `y0=${String(Math.round(w.y0)).padStart(5)} x1=${String(Math.round(w.x1)).padStart(5)} ` +
      `y1=${String(Math.round(w.y1)).padStart(5)} c=${Math.round(w.confidence)}`
  );
}

const layout = buildLayout(run.words);

console.log(`\n=== LAYOUT ROWS (${layout.rows.length}) ===`);
for (const [i, row] of layout.rows.entries()) {
  console.log(`  [${i}] ${JSON.stringify(row.text)}`);
  console.log(`      words: ${row.words.map((w) => w.text).join(" | ")}`);
}

const { fields, mrz } = extract(layout, docType);

console.log(`\n=== EXTRACTED ===`);
for (const [key, value] of Object.entries(fields)) {
  const trusted = isTrustworthy(value);
  console.log(
    `  ${key.padEnd(16)} = ${JSON.stringify(value.value)}  ` +
      `strategy=${value.strategy} confidence=${Math.round(value.confidence)} ` +
      `trustworthy=${trusted}`
  );
  console.log(`      evidence: ${value.evidence}`);
}

console.log(`\nMRZ: ${mrz ? "parsed" : "none"}`);

await disposeWorker();