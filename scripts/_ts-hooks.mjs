/**
 * A resolver hook that lets Node follow this repo's extensionless imports.
 *
 * ## Why this exists
 *
 * Application code imports its siblings without file extensions — `from "./mrz"`,
 * `from "./rows"` — which is what the bundler expects and what every other file in
 * this repository does. Node's ESM resolver, by design, will not guess: it throws
 * `ERR_MODULE_NOT_FOUND` on `./mrz` even though `mrz.ts` is right there.
 *
 * That has bitten every unit test in this repo. The workaround so far has been to
 * put each tested function in a leaf module with no internal imports, which is a
 * constraint shaped around the test runner rather than around the code.
 *
 * So this fixes the runner instead.
 *
 * ## Usage
 *
 *   node --import ./scripts/_ts-hooks-register.mjs scripts/_ocr-tests.mjs
 *
 * Resolution only — no transform, no type stripping. `node --experimental-strip-types`
 * handles the syntax; this handles the filenames.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (cause) {
    // Only relative specifiers are ours to fix. A bare specifier that failed is a
    // genuinely missing package and should keep its original error.
    if (!specifier.startsWith(".") || /\.[a-z]+$/i.test(specifier)) throw cause;
    if (!context.parentURL) throw cause;

    const base = new URL(specifier, context.parentURL);

    for (const ext of EXTENSIONS) {
      const candidate = `${base.href}${ext}`;
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }

    // `./foo` where the real file is `./foo/index.ts`.
    for (const ext of EXTENSIONS) {
      const candidate = `${base.href}/index${ext}`;
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
    }

    throw cause;
  }
}
