/**
 * What shape does tesseract.js v7 actually hand back?
 *
 *   node scripts/_ocr-shape.mjs <image>
 *
 * Written because the whole row-reconstruction layer is built on `words` existing,
 * and in v5+ the default output is `blocks` rather than a flat word list. If that
 * changed again in v7 the provider would silently read nothing, so this prints the
 * real keys rather than trusting the docs.
 */
import { readFileSync } from "node:fs";
import { createWorker } from "tesseract.js";

const path = process.argv[2];
const worker = await createWorker("eng", 1, {
  cachePath: `${process.cwd()}/.cache/tesseract`,
  logger: () => {},
});

const { data } = await worker.recognize(readFileSync(path), {}, { blocks: true });

console.log("=== top-level data keys ===");
console.log(Object.keys(data).join(", "));

console.log("\n=== data.words present? ===");
console.log(Array.isArray(data.words) ? `yes, ${data.words.length} words` : "NO — undefined");

console.log("\n=== blocks ===");
console.log(Array.isArray(data.blocks) ? `${data.blocks.length} blocks` : "none");

const firstLine = data.blocks?.[0]?.paragraphs?.[0]?.lines?.[0];
console.log("\n=== first line ===");
console.log(firstLine ? JSON.stringify(firstLine, null, 2).slice(0, 900) : "none");

const firstWord = firstLine?.words?.[0];
console.log("\n=== first word ===");
console.log(firstWord ? JSON.stringify(firstWord) : "none");

await worker.terminate();
