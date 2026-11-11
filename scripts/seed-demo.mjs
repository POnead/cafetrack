/**
 * Seed a fresh local PGlite database with realistic cafe items for presentation.
 *
 * Creates (NO users — you add staff manually):
 *   - Categories, locations, suppliers
 *   - 25+ items with quantities, unit prices, expiration dates, stock levels
 *   - Inventory batches with varied expiry (expired, expiring soon, fresh)
 *   - Transaction history (restock, checkout, waste) with audit trail
 *   - Alerts (low stock, out of stock, expired, expiring soon)
 *
 * Prerequisites:
 *   1. Stop the Next.js dev server (PGlite is single-process).
 *   2. Run:  $env:CAFETRACK_DB = "local"
 *            node scripts/seed-demo.mjs
 *   3. Restart the dev server.
 */
import { PGlite } from "@electric-sql/pglite";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const DB_DIR = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");
const pg = new PGlite(DB_DIR);

await pg.waitReady;
console.log(`Connected to PGlite at ${DB_DIR}`);

// Apply schema (idempotent)
await pg.exec(readFileSync(join(process.cwd(), "db", "schema.local.sql"), "utf8"));
console.log("Schema applied.");

const now = new Date();
function isoDay(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function query(sql, params = []) {
  const res = await pg.query(sql, params);
  return res.rows;
}

async function main() {
  console.log("Seeding items and history for presentation...");

  /* ---------------- categories ---------------- */
  const categories = ["Coffee", "Milk", "Syrup", "Powder", "Tea", "Bakery", "Packaging", "Produce", "Dairy", "Dry Goods"];
  for (const name of categories) {
    const existing = await query(`select id from categories where name = $1`, [name]);
    if (existing.length === 0) {
      await query(`insert into categories (name) values ($1)`, [name]);
    }
  }

  /* ---------------- locations ---------------- */
  const locations = ["Dry Storage", "Chiller", "Freezer", "Bar Station", "Pantry", "Walk-in Fridge"];
  for (const name of locations) {
    const existing = await query(`select id from locations where name = $1`, [name]);
    if (existing.length === 0) {
      await query(`insert into locations (name) values ($1)`, [name]);
    }
  }

  /* ---------------- suppliers ---------------- */
  const suppliers = [
    { name: "Bean Brothers Roasters", contact_name: "Ana Reyes", phone: "+63 917 111 2222", email: "orders@beanbrothers.ph" },
    { name: "Fresh Dairy Co.", contact_name: "Luis Santos", phone: "+63 917 333 4444", email: "supply@freshdairy.ph" },
    { name: "Tropical Syrups Inc.", contact_name: "Carmen Lim", phone: "+63 917 555 6666", email: "sales@tropicalsyrups.ph" },
    { name: "Bakers' Choice Distributors", contact_name: "Roberto Garcia", phone: "+63 917 777 8888", email: "hello@bakerschoice.ph" },
    { name: "Island Produce", contact_name: "Divina Cruz", phone: "+63 917 999 0000", email: "produce@island.ph" },
  ];
  const supplierIds = {};
  for (const s of suppliers) {
    const existing = await query(`select id from suppliers where name = $1`, [s.name]);
    if (existing.length > 0) {
      supplierIds[s.name] = existing[0].id;
    } else {
      const rows = await query(
        `insert into suppliers (name, contact_name, phone, email) values ($1,$2,$3,$4) returning id`,
        [s.name, s.contact_name, s.phone, s.email]
      );
      supplierIds[s.name] = rows[0].id;
    }
  }

  /* ---------------- items ---------------- */
  const items = [
    ["Arabica Coffee Beans", "Coffee", "Dry Storage", "solid", "kg", 12, 4, 450.00, "Bean Brothers Roasters", 120, true],
    ["Robusta Coffee Beans", "Coffee", "Dry Storage", "solid", "kg", 3, 5, 380.00, "Bean Brothers Roasters", 90, true],
    ["Fresh Milk", "Milk", "Chiller", "liquid", "L", 8, 6, 95.00, "Fresh Dairy Co.", 4, true],
    ["Condensed Milk", "Milk", "Dry Storage", "liquid", "can", 24, 10, 65.00, "Fresh Dairy Co.", 200, true],
    ["Vanilla Syrup", "Syrup", "Bar Station", "liquid", "bottle", 5, 3, 180.00, "Tropical Syrups Inc.", 300, true],
    ["Caramel Syrup", "Syrup", "Bar Station", "liquid", "bottle", 1, 3, 180.00, "Tropical Syrups Inc.", 280, true],
    ["Matcha Powder", "Powder", "Dry Storage", "powder", "kg", 2, 2, 320.00, "Tropical Syrups Inc.", 2, true],
    ["Cocoa Powder", "Powder", "Dry Storage", "powder", "kg", 6, 3, 210.00, "Tropical Syrups Inc.", 150, true],
    ["Black Tea Leaves", "Tea", "Dry Storage", "solid", "kg", 0, 2, 140.00, "Bean Brothers Roasters", 60, true],
    ["Croissant Dough", "Bakery", "Freezer", "solid", "pack", 15, 5, 55.00, "Bakers' Choice Distributors", -1, true],
    ["16oz Paper Cups", "Packaging", "Dry Storage", "solid", "pcs", 500, 100, 12.00, null, null, false],
    ["Cup Lids", "Packaging", "Dry Storage", "solid", "pcs", 80, 100, 8.00, null, null, false],
    ["Brown Sugar", "Dry Goods", "Pantry", "solid", "kg", 20, 5, 55.00, null, null, false],
    ["Sea Salt", "Dry Goods", "Pantry", "solid", "kg", 10, 3, 40.00, null, null, false],
    ["Fresh Eggs", "Dairy", "Chiller", "solid", "pcs", 60, 24, 6.50, "Fresh Dairy Co.", 14, true],
    ["Butter", "Dairy", "Chiller", "solid", "pack", 8, 4, 120.00, "Fresh Dairy Co.", 30, true],
    ["Whipping Cream", "Dairy", "Chiller", "liquid", "L", 4, 2, 240.00, "Fresh Dairy Co.", 7, true],
    ["Bananas", "Produce", "Walk-in Fridge", "solid", "kg", 5, 10, 80.00, "Island Produce", 5, true],
    ["Strawberries", "Produce", "Walk-in Fridge", "solid", "box", 3, 5, 220.00, "Island Produce", 3, true],
    ["Blueberries", "Produce", "Walk-in Fridge", "solid", "box", 2, 3, 350.00, "Island Produce", 4, true],
    ["Espresso Blend", "Coffee", "Dry Storage", "solid", "kg", 7, 3, 520.00, "Bean Brothers Roasters", 100, true],
    ["Oat Milk", "Milk", "Chiller", "liquid", "L", 6, 4, 150.00, "Fresh Dairy Co.", 10, true],
    ["Hazelnut Syrup", "Syrup", "Bar Station", "liquid", "bottle", 4, 2, 190.00, "Tropical Syrups Inc.", 270, true],
    ["Croissants", "Bakery", "Freezer", "solid", "pack", 20, 8, 45.00, "Bakers' Choice Distributors", 18, true],
  ];

  const itemIds = {};
  for (const [name, cat, loc, form, unit, qty, low, price, supName, expDays, expirable] of items) {
    const catRows = await query(`select id from categories where name = $1`, [cat]);
    const locRows = await query(`select id from locations where name = $1`, [loc]);
    const supId = supName ? supplierIds[supName] : null;
    const expiration_date = expirable ? isoDay(expDays ?? 30) : null;
    // Generate SKU like the original seed: CT-XXX-XXXX
    const sku = `CT-${name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

    const rows = await query(
      `insert into items
         (sku, name, category_id, location_id, physical_form, unit, quantity, low_stock_threshold,
          unit_price, supplier_id, expiration_date, expirable)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id, sku, name, quantity, unit_price, expiration_date`,
      [sku, name, catRows[0]?.id, locRows[0]?.id, form, unit, qty, low, price, supId, expiration_date, expirable]
    );
    itemIds[name] = rows[0];

    const status = qty === 0 ? "OUT OF STOCK" : qty <= low ? "LOW STOCK" : "OK";
    console.log(
      `${rows[0].sku} | ${name} | ₱${price} | ${qty} ${unit} | ${status} | exp ${expiration_date ?? "—"}`
    );
  }

  /* ---------------- inventory batches with mixed expiry ---------------- */
  for (const [name, , , , , qty, low, price, supName, expDays, expirable] of items) {
    if (!expirable) continue;
    const item = itemIds[name];
    const batchCount = randomInt(2, 4);
    for (let b = 0; b < batchCount; b++) {
      const batchQty = Math.floor(qty / batchCount) || 1;
      const roll = randomInt(1, 3);
      const batchExp =
        roll === 1 ? isoDay(-randomInt(1, 10)) : // expired
        roll === 2 ? isoDay(randomInt(1, 7)) :   // expiring soon
                     isoDay(randomInt(8, 60));   // fresh
      await query(
        `insert into inventory_batches
           (item_id, batch_code, received_quantity, remaining_quantity, expiration_date, received_at, source_type)
         values ($1,$2,$3,$3,$4,$5,$6)`,
        [
          item.id,
          `${item.sku.slice(-4)}-${todayStr()}-${String(b + 1).padStart(2, "0")}`,
          batchQty,
          batchExp,
          isoDay(-randomInt(1, 20)),
          "restock",
        ]
      );
    }
  }
  console.log("Created inventory batches with mixed expiry dates");

  /* ---------------- transaction history (movements + audit) ---------------- */
  const admin = (await query(`select id, full_name from users where username = 'admin' limit 1`))[0];
  const actorId = admin?.id ?? null;
  const actorName = admin?.full_name ?? "System";

  const types = ["restock", "checkout", "waste"];
  const notes = [
    "Morning restock", "Lunch rush", "Evening service", "Spill during prep",
    "Quality check", "Customer return", "Daily inventory check", "Supplier delivery",
  ];

  for (let i = 0; i < 50; i++) {
    const type = pick(types);
    const itemName = pick(Object.keys(itemIds));
    const item = itemIds[itemName];
    const qty = randomInt(1, 6);
    const note = pick(notes);

    try {
      await query(
        `select process_transaction($1, $2, $3, $4::jsonb, $5)`,
        [
          type,
          actorId,
          actorName,
          JSON.stringify([{ sku: item.sku, qty, note }]),
          `${note} — ${itemName}`,
        ]
      );
    } catch {
      // Individual transaction failures (e.g. insufficient expired stock for waste)
      // are skipped so the seed can continue.
    }
  }
  console.log("Created transactions (with audit trail)");

  /* ---------------- recompute alerts ---------------- */
  await query(`select refresh_alerts()`);
  console.log("Recomputed alerts");

  /* ---------------- summary ---------------- */
  const itemCount = (await query(`select count(*)::int as n from items`))[0].n;
  const txnCount = (await query(`select count(*)::int as n from transactions`))[0].n;
  const alertCount = (await query(`select count(*)::int as n from alerts`))[0].n;

  console.log(`
========================================
Seed complete!
========================================
Items: ${itemCount}
Transactions: ${txnCount} (with audit trail)
Alerts: ${alertCount}

Categories: ${categories.join(", ")}
Locations: ${locations.join(", ")}

Staff: NOT created — add them manually in Settings → Staff.
Admin: admin / admin123 (already seeded)

Server: http://localhost:3100
Database: .pglite (local PGlite)
========================================
`);
}

main().catch((e) => {
  console.error("Seed failed:", e.message);
  process.exit(1);
});
