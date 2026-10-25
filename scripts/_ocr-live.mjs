/**
 * Live check: the real provider, the real engine, a real image.
 *
 *   npm run test:ocr-live [image] [docType]
 *
 * ## Why this is not in `test:all`
 *
 * It needs the 5MB language file, which is downloaded from a CDN on first run, and
 * each check costs a second or two of CPU. That is fine occasionally and wrong for
 * every commit. The logic it exercises is covered without the engine by
 * scripts/_ocr-tests.mjs — this covers the seam between them, which is the part
 * unit tests cannot reach: that `runOcr` hands `buildLayout` the shape it expects,
 * and that the provider's signals survive the round trip.
 *
 * Run it after changing anything in ./ocr/engine.ts or ./local-ocr.ts.
 */

import { localOcrProvider } from "../src/lib/id-verification/local-ocr.ts";
import { disposeWorker, languageModelPresent } from "../src/lib/id-verification/ocr/engine.ts";

const imagePath = process.argv[2];
const docType = process.argv[3] ?? "philsys";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
};

console.log(`image:    ${imagePath}`);
console.log(`doc type: ${docType}\n`);

check("the language model is on disk", languageModelPresent());
check("the provider reports itself available", localOcrProvider.available());

if (!imagePath) {
  console.log("\nno image given — availability only.");
  console.log(`\n${pass} passed, ${fail} failed`);
  await disposeWorker();
  process.exit(fail > 0 ? 1 : 0);
}

const { readFileSync } = await import("node:fs");
const bytes = new Uint8Array(readFileSync(imagePath));

const started = Date.now();
const result = await localOcrProvider.verify({
  front: { bytes, type: "image/png" },
  photo: null,
  back: null,
  docType,
  expectedName: "Juan Dela Cruz",
  cardEmbedding: null,
  photoEmbedding: null,
});
const elapsed = Date.now() - started;

console.log(`\nran in ${(elapsed / 1000).toFixed(1)}s\n`);
console.log("=== SIGNALS ===");
for (const s of result.signals) {
  console.log(`[${s.tone.toUpperCase().padEnd(7)}] ${s.label}`);
  console.log(`         ${s.detail}\n`);
}

console.log("=== FIELDS PASSED TO THE ORCHESTRATOR ===");
console.log(JSON.stringify(result.fields, null, 2));

check("it produced signals", result.signals.length > 0);
check("a summary signal is present", result.signals.some((s) => s.id === "ocr_summary"));
check(
  "only anchored reads reach fields",
  Object.values(result.fields).every((v) => typeof v === "string")
);

await disposeWorker();

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
