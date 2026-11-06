/**
 * Extracts the re-runnable SQL from db/schema.sql into a single paste-ready file
 * for applying to a hosted Supabase project.
 *
 *   node scripts/migrate-sql.mjs
 *   npm run db:migrate
 *
 * Why this exists
 * ---------------
 * db/schema.sql is the source of truth and is written to be re-runnable in full,
 * so the simplest way to update a hosted project is to paste the whole file
 * into the Supabase SQL Editor. That works, but it means reading a few hundred
 * lines to find the one function you actually changed.
 *
 * This pulls out statements that are safe to re-run against a live database:
 *
 *   - `create or replace function`  — always safe, replaces the body
 *   - `alter table ... add column if not exists` — safe, existing data kept
 *   - the allow-listed, additive inventory-batch table, indexes, backfill, and
 *     trigger setup — only creates the new batch ledger and opening batches
 *
 * Other tables and indexes are deliberately excluded. In particular, this
 * never re-runs seed inserts or changes existing stock quantities.
 *
 * It never connects to a database. It only reads schema.sql and writes a file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, "..", "db");

const source = readFileSync(join(dbDir, "schema.sql"), "utf8");

/** Pull a `$$ ... $$` (or `$tag$ ... $tag$`) body along with its statement. */
function functionBlock(startIndex) {
  // Find the opening dollar-quote tag that follows "create or replace function".
  // The parameter list sits between them, so the search window has to be wider
  // than a signature-length guess — scan to the end of the statement instead.
  const rest = source.slice(startIndex);
  const tag = /\$\$|\$[a-z_][a-z_0-9]*\$/i.exec(rest);
  if (!tag) return null;

  const open = tag[0];
  const openAt = startIndex + tag.index;
  const closeAt = source.indexOf(open, openAt + open.length);
  if (closeAt === -1) return null;

  const end = source.indexOf(";", closeAt);
  return {
    text: source.slice(startIndex, end + 1).trim(),
    end: end + 1,
  };
}

const functions = [];
const addColumns = [];

function requiredMatch(regex, description) {
  const match = regex.exec(source);
  if (!match) {
    console.error(`Refusing to write: could not find ${description} in db/schema.sql.`);
    process.exit(1);
  }
  return match[0].trim();
}

const batchTable = requiredMatch(
  /create table if not exists inventory_batches \([\s\S]*?\n\);/,
  "the inventory_batches table"
);
const batchIndexes = [
  requiredMatch(
    /create index if not exists idx_inventory_batches_item_remaining[\s\S]*?;/,
    "the inventory-batch item index"
  ),
  requiredMatch(
    /create index if not exists idx_inventory_batches_expiry[\s\S]*?;/,
    "the inventory-batch expiry index"
  ),
];
const openingBatchBackfill = requiredMatch(
  /insert into inventory_batches[\s\S]*?where i\.item_status = 'active'[\s\S]*?;\s*(?=-- Keep direct item creation)/,
  "the idempotent opening-batch backfill"
);
const batchTriggers = [
  requiredMatch(
    /drop trigger if exists items_sync_batch_quantity on items;[\s\S]*?create trigger items_sync_batch_quantity[\s\S]*?execute function sync_item_batch_quantity\(\);/,
    "the item quantity synchronization trigger"
  ),
  requiredMatch(
    /drop trigger if exists items_sync_single_batch_expiration on items;[\s\S]*?create trigger items_sync_single_batch_expiration[\s\S]*?execute function sync_single_batch_expiration\(\);/,
    "the single-batch expiration trigger"
  ),
];
const batchRls = requiredMatch(
  /alter table inventory_batches enable row level security;/,
  "inventory-batch row-level security"
);
const alertUpdatedAtBackfill = [
  requiredMatch(
    /update alerts set updated_at = created_at where updated_at is null;/i,
    "the alert updated_at backfill"
  ),
  requiredMatch(
    /alter table alerts alter column updated_at set default now\(\);/i,
    "the alert updated_at default"
  ),
  requiredMatch(
    /alter table alerts alter column updated_at set not null;/i,
    "the alert updated_at not-null constraint"
  ),
].join("\n");
const alertResolvedReasonBackfill = requiredMatch(
  /update alerts\s+set resolved_reason = 'Previously resolved; no reason was recorded\.'\s+where resolved = true and resolved_reason is null;/i,
  "the alert resolved_reason backfill"
);
const nonExpiringPackagingBackfill = requiredMatch(
  /update items\s+set expirable = false\s+where lower\(name\) in \('16oz paper cups', 'cup lids'\)\s+and expirable = true\s+and expiration_date is null;/i,
  "the non-expiring packaging item backfill"
);
const seededExpirableItemsBackfill = requiredMatch(
  /update items\s+set expirable = true\s+where lower\(name\) in \(\s+'arabica coffee beans',\s+'robusta coffee beans',\s+'fresh milk',\s+'condensed milk',\s+'vanilla syrup',\s+'caramel syrup',\s+'matcha powder',\s+'cocoa powder',\s+'black tea leaves',\s+'croissant dough'\s+\)\s+and expirable = false;/i,
  "the seeded expirable item backfill"
);
const datedBatchExpirableBackfill = requiredMatch(
  /update items i\s+set expirable = true\s+where i\.expirable = false\s+and lower\(i\.name\) not in \('16oz paper cups', 'cup lids'\)\s+and exists\s+\(\s+select 1\s+from inventory_batches b\s+where b\.item_id = i\.id\s+and b\.expiration_date is not null\s+\);/i,
  "the dated-batch expirable item backfill"
);

// Walk the file once, collecting only the two safe statement kinds.
let i = 0;
while (i < source.length) {
  const at = source.indexOf("create or replace function", i);
  const columnAt = source.indexOf("add column if not exists", i);

  if (at === -1 && columnAt === -1) break;

  // Take whichever comes first, so the scan stays in file order.
  if (at !== -1 && (columnAt === -1 || at < columnAt)) {
    const block = functionBlock(at);
    if (!block) break;
    const name = /^create or replace function\s+([a-z_0-9]+)/i.exec(block.text)?.[1];
    functions.push({ name: name ?? "unknown", text: block.text });
    i = block.end;
  } else {
    // Rewind to the start of the whole `alter table` statement.
    const lineStart = source.lastIndexOf("alter table", columnAt);
    const lineEnd = source.indexOf(";", columnAt);
    addColumns.push({
      text: source.slice(lineStart, lineEnd + 1).trim(),
    });
    i = lineEnd + 1;
  }
}

if (functions.length === 0) {
  console.error("No functions found in db/schema.sql — has its format changed?");
  process.exit(1);
}

if (addColumns.length === 0) {
  console.error("No add-column migrations found — expected the users deactivation trail.");
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);

const out = `-- ============================================================
-- CafeTrack — schema updates to apply to a hosted project
-- Generated by: npm run db:migrate  (do not edit by hand)
-- Source:      db/schema.sql
-- Generated:   ${stamp}
-- ============================================================
--
-- HOW TO USE
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file
--   -> Run. It is safe to run more than once.
--
-- The inventory-batch section is an additive migration. It creates a new
-- ledger, copies each active item's current stock/date into one opening batch
-- only when that item has no batch yet, and does not change item quantities.
--

-- ---------- batch inventory structure ----------
${batchTable}

${batchIndexes.join("\n\n")}

${openingBatchBackfill}

${batchRls}

-- ---------- columns added since the first release ----------
-- Safe on a live database: the column is added only if it is not already there,
-- and existing rows are left untouched.
${addColumns.map((a) => a.text).join("\n")}

${alertUpdatedAtBackfill}

${alertResolvedReasonBackfill}

${nonExpiringPackagingBackfill}

${seededExpirableItemsBackfill}

${datedBatchExpirableBackfill}

-- ---------- stored functions ----------
-- create or replace keeps the existing function id and re-points it at the new
-- body, so anything already calling it keeps working.
${functions
  .map((f) => `-- ${f.name}()\n${f.text}`)
  .join("\n\n")}

-- ---------- batch inventory triggers ----------
${batchTriggers.join("\n\n")}

-- ---------- after applying ----------
-- Force the current state to be recomputed so the new logic takes effect on
-- anything that is already flagged:
--
--   select refresh_alerts();
`;

const target = join(dbDir, "migrate.sql");
writeFileSync(target, out, "utf8");

console.log(`Wrote db/migrate.sql\n`);
console.log(`  ${addColumns.length} column migration(s)`);
console.log(`  ${functions.length} function(s): ${functions.map((f) => f.name).join(", ")}`);
console.log(`\nPaste it into the Supabase SQL Editor and run.`);
