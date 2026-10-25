/**
 * End-to-end probe: image bytes → OCR → rows → extracted fields.
 *
 *   node scripts/_ocr-pipeline.mjs <image> [docType]
 *
 * Not an assertion suite — a debugging harness, because the only way to find out
 * whether a template actually matches a card is to run it against one and read what
 * came back. scripts/_ocr-tests.mjs is what proves the logic; this is what shows
 * the truth about a particular photograph.
 */
import { readFileSync } from "node:fs";
import { createWorker } from "tesseract.js";

import { buildLayout } from "../src/lib/id-verification/ocr/rows.ts";
import { extract } from "../src/lib/id-verification/ocr/extract.ts";

const imagePath = process.argv[2];
const docType = process.argv[3] ?? "philsys";

const worker = await createWorker("eng", 1, {
  cachePath: `${process.cwd()}/.cache/tesseract`,
  logger: () => {},
});

const { data } = await worker.recognize(readFileSync(imagePath), {}, { blocks: true });
await worker.terminate();

/* --- flatten, exactly as engine.ts does it ---------------------------- */

const words = [];
for (const block of data.blocks ?? []) {
  for (const paragraph of block.paragraphs ?? []) {
    for (const line of paragraph.lines ?? []) {
      for (const word of line.words ?? []) {
        if (!word.bbox) continue;
        words.push({
          text: word.text,
          confidence: word.confidence ?? 0,
          x0: word.bbox.x0, y0: word.bbox.y0,
          x1: word.bbox.x1, y1: word.bbox.y1,
        });
      }
    }
  }
}

console.log(`doc type: ${docType}`);
console.log(`words: ${words.length}, page confidence: ${data.confidence}`);

const layout = buildLayout(words);
console.log(`\n=== ${layout.rows.length} reconstructed rows ===`);
layout.rows.forEach((r, i) => {
  console.log(`[${String(i).padStart(2)}] y=${r.y.toFixed(0).padStart(4)} c=${r.confidence.toFixed(0).padStart(3)}  ${r.text}`);
});

const { fields, mrz } = extract(layout, docType);

console.log(`\n=== MRZ ===`);
console.log(mrz ? `${mrz.format} valid=${mrz.valid} name=${mrz.fullName}` : "none found");

console.log(`\n=== EXTRACTED ===`);
for (const [key, value] of Object.entries(fields)) {
  console.log(`${key.padEnd(16)} ${String(value.value).padEnd(28)} [${value.strategy}]`);
  if (value.evidence) console.log(`${" ".repeat(16)} └─ ${value.evidence}`);
}
