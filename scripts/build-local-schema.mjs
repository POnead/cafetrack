/**
 * Generates db/schema.local.sql from db/schema.sql for the local PGlite mode.
 *
 * Two substitutions, nothing else:
 *   1. drop `create extension pgcrypto` — not bundled with PGlite, and
 *      gen_random_uuid() is a core function in the PostgreSQL 18 it ships.
 *   2. `encode(digest(x,'sha256'),'hex')` -> `encode(sha256(x::bytea),'hex')`
 *      which produces identical hashes, so audit chains stay compatible.
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
    "encode(sha256(($1)::bytea), 'hex')"
  );

if (/digest\s*\(/.test(converted)) {
  console.error("Refusing to write: a digest() call survived the rewrite.");
  process.exit(1);
}

if (/\bdigest\b/.test(source) === false) {
  console.error("Refusing to write: schema.sql had no digest() calls — has it changed?");
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
