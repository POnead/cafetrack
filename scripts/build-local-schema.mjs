/**
 * Generates db/schema.local.sql from db/schema.sql for the local PGlite mode.
 *
 * Two substitutions, nothing else:
 *   1. drop `create extension pgcrypto` — not bundled with PGlite, and
 *      gen_random_uuid() is a core function in the PostgreSQL 18 it ships.
 *   2. `encode(digest(x,'sha256'),'hex')` -> `encode(sha256(convert_to(x,'UTF8')),'hex')`
 *      which produces identical hashes, so audit chains stay compatible.
 *
 *      `convert_to`, not `x::bytea`. A text->bytea cast runs the input through
 *      `byteain`, which *parses* the `\xDEADBEEF` hex / backslash-escape
 *      formats -- it is a decoder, not an encoding. Ordinary text such as
 *      `1|GENESIS|admin|ITEM_CREATE|item|abc|{}` is not valid input to it and
 *      the cast throws "invalid input syntax for type bytea". That silently
 *      dropped audit entries whose details JSON contained an escaped quote or
 *      backslash (any item named `Cafe "Special"`, say). `convert_to` is a real
 *      text->bytes conversion and hashes byte-for-byte the same as pgcrypto's
 *      `digest(text,'sha256')`, which is what keeps the two modes compatible.
 *
 * Run with:  node scripts/build-local-schema.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, "..", "db");

const source = readFileSync(join(dbDir, "schema.sql"), "utf8");

const converted = source
  .replace(
    /create extension if not exists "pgcrypto";/,
    "-- pgcrypto is not required locally: gen_random_uuid() and sha256() are\n" +
      "-- core functions in the PostgreSQL build that PGlite ships."
  )
  .replace(
    /encode\(digest\(([\s\S]*?),\s*'sha256'\), 'hex'\)/g,
    "encode(sha256(convert_to(($1), 'UTF8')), 'hex')"
  );

if (/digest\s*\(/.test(converted)) {
  console.error("Refusing to write: a digest() call survived the rewrite.");
  process.exit(1);
}

if (/\bdigest\b/.test(source) === false) {
  console.error("Refusing to write: schema.sql had no digest() calls — has it changed?");
  process.exit(1);
}

// A text::bytea cast decodes hex/escape input rather than converting, and
// throws on ordinary text. Guard against it creeping back in.
if (/::\s*bytea/.test(converted)) {
  console.error("Refusing to write: a ::bytea cast survived the rewrite.");
  process.exit(1);
}

if (!/convert_to\(/.test(converted)) {
  console.error("Refusing to write: no convert_to() calls — has the rewrite changed?");
  process.exit(1);
}

const header = `-- ============================================================
-- CafeTrack — LOCAL schema (PGlite). GENERATED FILE — do not edit by hand.
--
-- Built from db/schema.sql by:  node scripts/build-local-schema.mjs
-- Differences: no pgcrypto extension, core sha256() instead of digest().
-- Hash values are identical to the Supabase schema, so audit chains match.
-- ============================================================

`;

writeFileSync(join(dbDir, "schema.local.sql"), header + converted);
console.log("Wrote db/schema.local.sql");
