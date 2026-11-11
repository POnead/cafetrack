/**
 * Delete ALL staff accounts from the local PGlite database.
 * Leaves the admin account intact.
 *
 * Prerequisites:
 *   1. Stop the Next.js dev server (PGlite is single-process).
 *   2. Run:  $env:CAFETRACK_DB = "local"
 *            node scripts/delete-staff.mjs
 *   3. Restart the dev server.
 */
import { PGlite } from "@electric-sql/pglite";
import { join } from "node:path";

const DB_DIR = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");
const pg = new PGlite(DB_DIR);

await pg.waitReady;
console.log(`Connected to PGlite at ${DB_DIR}`);

async function query(sql, params = []) {
  const res = await pg.query(sql, params);
  return res.rows;
}

const staff = await query(`select id, username, full_name from users where role = 'staff' order by username`);
console.log(`Found ${staff.length} staff account(s):`);
for (const s of staff) {
  console.log(`  ${s.username.padEnd(12)} ${s.full_name}`);
}

for (const s of staff) {
  await query(`delete from users where id = $1`, [s.id]);
  console.log(`Deleted: ${s.username}`);
}

const remaining = await query(`select id, username, role from users order by role, username`);
console.log("\nRemaining accounts:");
for (const s of remaining) {
  console.log(`  ${s.username.padEnd(12)} ${s.role}`);
}

process.exit(0);
