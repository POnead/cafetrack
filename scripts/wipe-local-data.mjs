/**
 * Wipes site data from the local PGlite database, keeping:
 *   - the admin account (username + password hash untouched)
 *   - categories and locations (reference data the UI dropdowns need)
 *
 * Removes: transaction_items, transactions, alerts, audit_log,
 * login_attempts, items, and every user except `admin`.
 *
 * Run with:  npm run db:wipe    (stop `npm run dev` first — PGlite is
 * single-process, so the running dev server holds the lock.)
 */
import { PGlite } from "@electric-sql/pglite";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");

if (!existsSync(dir)) {
  console.log(`Nothing to wipe — ${dir} does not exist.`);
  process.exit(0);
}

const pg = new PGlite(dir);
await pg.waitReady;

async function count(table) {
  const r = await pg.query(`select count(*)::int as n from ${table}`);
  return Number(r.rows[0]?.n ?? 0);
}

// FK-safe order: children before parents.
const ORDER = [
  "transaction_items",
  "transactions",
  "alerts",
  "audit_log",
  "login_attempts",
  "items",
];

console.log("CafeTrack data wipe");
console.log("-------------------");

for (const table of ORDER) {
  const before = await count(table);
  await pg.query(`delete from ${table}`);
  const after = await count(table);
  console.log(`  ${table.padEnd(18)} ${String(before).padStart(5)} -> ${after}`);
}

const usersBefore = await count("users");
await pg.query(`delete from users where username <> 'admin'`);
const usersAfter = await count("users");
console.log(`  ${"users (keep admin)".padEnd(18)} ${String(usersBefore).padStart(5)} -> ${usersAfter}`);

// Restart bigserial counters (audit seq, login_attempts id, ...) so IDs
// begin at 1 again instead of continuing from the wiped data. Only touched
// while the table is empty: resetting a sequence under live rows would fork
// the audit hash chain (append picks prev by seq, verify walks seq asc).
const SEQS = [
  ["audit_log", "seq"],
  ["login_attempts", "id"],
  ["users", "id"],
  ["items", "id"],
  ["transactions", "id"],
  ["transaction_items", "id"],
  ["alerts", "id"],
];
for (const [table, col] of SEQS) {
  try {
    const r = await pg.query(`select pg_get_serial_sequence($1, $2) as s`, [table, col]);
    const seq = r.rows[0]?.s;
    if (!seq) continue;
    if ((await count(table)) > 0) {
      console.log(`  skip ${table}.${col} sequence - table not empty`);
      continue;
    }
    await pg.query(`select setval($1, 1, false)`, [seq]);
    console.log(`  reset ${table}.${col} sequence -> next id 1`);
  } catch {
    // Table has no serial column / sequence - nothing to restart.
  }
}


const cats = await count("categories");
const locs = await count("locations");
console.log(`\nKept: admin account, ${cats} categories, ${locs} locations.`);
console.log("Start the app with:  npm run dev");

await pg.close();
