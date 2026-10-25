/**
 * Find mojibake — UTF-8 that was decoded as Windows-1252 and written back out.
 *
 *   node scripts/_mojibake.mjs [paths...]
 *
 * ## Why this needed writing
 *
 * A file in this repo contained `Edit — Foo` where it should have contained
 * `Edit — Foo`. The bytes were correct UTF-8 (`E2 80 94`); they had been decoded
 * as Windows-1252 and re-encoded, turning one em-dash into three characters. The
 * test then failed against a page that was rendering exactly the right thing, and
 * the assertion looked like it was checking for a dash.
 *
 * The tell is any of the characters Windows-1252 puts in the C1 range — `€` `™` `œ`
 * `š` `Ÿ` and friends — or `Ã`/`Â`/`â` followed by one of them. All of them are
 * individually legal in a source file, so nothing lints, type-checks or fails until
 * a string comparison quietly disagrees.
 *
 * The fix is always to decode the bytes as latin1 and re-encode as utf8:
 *
 *   Buffer.from(text, 'latin1').toString('utf8')
 *
 * This script finds the places. It does not fix them, because a human has to decide
 * whether each one is mojibake or a character that genuinely looks like one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The signature of mojibake: one of the three lead characters that only appear
 * when UTF-8 is decoded as Windows-1252, immediately followed by another
 * non-ASCII character.
 *
 * `â`, `Ã` and `Â` are ordinary letters and appear in words like *café*'s
 * neighbourhood — but in real source they are always followed by an ASCII letter
 * or by nothing at all. They are never followed by `€`, `™`, `œ` or a curly quote,
 * because that combination is what a three-byte UTF-8 sequence turns into when it
 * is read one byte at a time as a single-byte encoding.
 *
 * The first version of this file listed the C1 characters on their own, which
 * matched 1075 lines of perfectly good em-dashes and curly quotes and told us
 * nothing. Narrowing it to the *sequence* is what makes it a detector rather than
 * a spelling checker.
 */
const SUSPECT = /[âÃÂ][-￿]|[ï]¿½|�/;

const ROOTS = process.argv.slice(2);
const roots = ROOTS.length ? ROOTS : ["src", "scripts", "db"];
const EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".sql", ".json", ".mjs"]);

let findings = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".git")) {
        continue;
      }
      walk(full);
      continue;
    }

    const dot = entry.name.lastIndexOf(".");
    if (dot === -1) continue;

    const ext = entry.name.slice(dot);
    if (!EXTS.has(ext)) continue;

    let text;
    try {
      if (statSync(full).size > 2_000_000) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!SUSPECT.test(line)) continue;

      const bad = [...line]
        .filter((c) => SUSPECT.test(c))
        .map((c) => `${c} U+${c.charCodeAt(0).toString(16).toUpperCase()}`);

      findings++;
      console.log(`${full}:${i + 1}`);
      console.log(`  ${line.trim().slice(0, 110)}`);
      console.log(`  suspect: ${bad.join(", ")}`);

      // Show what it almost certainly should be.
      const fixed = Buffer.from(line, "latin1").toString("utf8");
      if (fixed !== line && !SUSPECT.test(fixed)) {
        console.log(`  likely intended: ${fixed.trim().slice(0, 110)}`);
      }
      console.log();
    }
  }
}

for (const root of roots) {
  try {
    if (statSync(root).isDirectory()) walk(root);
    else walk(root);
  } catch {
    // A path that does not exist is not an error worth reporting here.
  }
}

if (findings === 0) {
  console.log("No mojibake found in:", roots.join(", "));
} else {
  console.log(`----------------------------------------------`);
  console.log(`${findings} line(s) with suspect characters`);
  console.log(`Fix with: Buffer.from(line, 'latin1').toString('utf8')`);
}
