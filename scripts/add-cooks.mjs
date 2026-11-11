/**
 * Reset staff accounts in the local PGlite database.
 *
 * Deletes old staff accounts (barista1, barista2) and creates:
 *   - cook1 — Mark Andrei Obedencio (Line Cook)
 *   - cook6 — Prince Deano Rodriguez (Prep Cook)
 *
 * Prerequisites:
 *   1. Stop the Next.js dev server (PGlite is single-process).
 *   2. Run:  $env:CAFETRACK_DB = "local"
 *            node scripts/add-cooks.mjs
 *   3. Restart the dev server.
 */
import { PGlite } from "@electric-sql/pglite";
import { join } from "node:path";
import { createHash, randomBytes, scryptSync } from "node:crypto";

const DB_DIR = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");
const pg = new PGlite(DB_DIR);

await pg.waitReady;
console.log(`Connected to PGlite at ${DB_DIR}`);

async function query(sql, params = []) {
  const res = await pg.query(sql, params);
  return res.rows;
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function newStaffToken() {
  return "CT-STF-" + randomBytes(16).toString("hex").toUpperCase();
}

const PASSWORD_HASH = hashPassword("staff123");

/* ---------------- delete old staff accounts ---------------- */
const oldStaff = await query(`select id, username from users where role = 'staff'`);
for (const s of oldStaff) {
  await query(`delete from users where id = $1`, [s.id]);
  console.log(`Deleted old staff: ${s.username}`);
}

/* ---------------- create cook1 and cook6 ---------------- */
const cooks = [
  { username: "cook1", full_name: "Mark Andrei Obedencio", position: "Line Cook" },
  { username: "cook6", full_name: "Prince Deano Rodriguez", position: "Prep Cook" },
];

for (const cook of cooks) {
  const existing = await query(`select id from users where username = $1`, [cook.username]);
  if (existing.length > 0) {
    console.log(`${cook.username} already exists, skipping.`);
    continue;
  }

  const qrToken = newStaffToken();

  await query(
    `insert into users
       (username, full_name, password_hash, role, qr_token, can_manage_items,
        position, verification_status, is_active, created_at)
     values ($1,$2,$3,'staff',$4,$5,$6,'unverified',true,now())
     returning id, username, qr_token`,
    [
      cook.username,
      cook.full_name,
      PASSWORD_HASH,
      qrToken,
      cook.position === "Line Cook",
      cook.position,
    ]
  );
  console.log(`Created ${cook.username} — ${cook.full_name} (barcode: ${qrToken})`);
}

console.log("\nDone. Staff accounts now:");
const allStaff = await query(`select username, full_name, role, qr_token from users where role = 'staff' order by username`);
for (const s of allStaff) {
  console.log(`  ${s.username.padEnd(12)} ${s.full_name.padEnd(30)} ${s.qr_token}`);
}

process.exit(0);
