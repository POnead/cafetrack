/**
 * The single Code 128 build of JsBarcode, imported directly.
 *
 * `import JsBarcode from "jsbarcode"` resolves to the package's CommonJS entry,
 * which requires every barcode format it ships — EAN, UPC, CODE39, MSI, ITF,
 * Pharmacode, CODABAR, CODE93, and both renderers. That is about 137KB of
 * source and, because the entry is CJS with no `sideEffects` field, none of it
 * is tree-shaken away.
 *
 * CafeTrack only ever prints CODE128 (see OPTIONS in BarcodeView.tsx), so the
 * single-format build is imported instead. It is 27KB. On /users and /items,
 * which are the two pages that import this module, that is the difference
 * between those pages carrying 13 script chunks and every other page carrying
 * 11.
 *
 * The two builds do not export the same shape: the package entry does
 * `module.exports = JsBarcode`, while the per-format build is a UMD bundle that
 * hangs the function off `.default`. The interop differs by bundler as well.
 * Rather than depend on which, both spellings are accepted here so this stays
 * the only place that has to know.
 */

import JsBarcode from "jsbarcode";

export default JsBarcode;