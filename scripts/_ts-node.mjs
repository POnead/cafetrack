/**
 * Runs a test script that imports application TypeScript.
 *
 *   node scripts/_ts-node.mjs scripts/_ocr-tests.mjs
 *
 * ## Why this wrapper exists
 *
 * Three things have to be true before Node can import the application's
 * TypeScript directly, and spelling all three on every `npm` script line is how
 * one of them gets left off:
 *
 *   1. `--experimental-strip-types` — to parse the TypeScript syntax.
 *   2. the resolver hook in _ts-hooks.mjs — because the app's own imports are
 *      extensionless (`from "./mrz"`), which Node will not guess at.
 *   3. `--disable-warning=...` — so the above two do not print a warning banner
 *      over the test output.
 *
 * Each of those flags is a third of the length of the command, and all three are
 * required together. So they live here.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = process.argv[2];

if (!script) {
  console.error("usage: node scripts/_ts-node.mjs <script.mjs>");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const register = path.join(here, "_ts-hooks-register.mjs");

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--disable-warning=ExperimentalWarning",
    // A `file://` URL, not a path. `--import` goes through the ESM loader, which
    // on Windows rejects a bare `C:\...` as an unsupported URL scheme — the error
    // names the protocol as `c:` and gives no hint that the fix is a URL.
    //
    // The entry script stays a plain path, because that argument is resolved
    // against the working directory rather than through the loader, and handing
    // it a URL makes Node try to load the URL *as a relative specifier*.
    "--import",
    pathToFileURL(register).href,
    path.resolve(script),
    ...process.argv.slice(3),
  ],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);
