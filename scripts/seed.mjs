/**
 * CafeTrack seed script.
 * Usage:  npm run seed
 * Creates a default admin, a demo staff account, categories, locations, and sample items.
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes, scryptSync } from "node:crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const unset = (v) => !v || /your-project-ref|xxxx|^your-|change-me/i.test(String(v).trim());

if (unset(url) || unset(key)) {
  console.error(
    "Supabase is not configured yet.\n\n" +
      "Open .env.local and replace the placeholder NEXT_PUBLIC_SUPABASE_URL and\n" +
      "SUPABASE_SERVICE_ROLE_KEY with the real values from\n" +
      "Supabase > Project Settings > API.\n\n" +
      "Then run the SQL in db/schema.sql in the Supabase SQL Editor before seeding."
  );
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 64).toString("hex")}`;
}

function staffToken() {
  return "CT-STF-" + randomBytes(5).toString("hex").toUpperCase();
}

function skuFor(cat) {
  return `CT-${cat}-${randomBytes(2).toString("hex").toUpperCase()}`;
}

async function main() {
  console.log("Seeding CafeTrack...\n");

  const adminPw = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const staffPw = process.env.SEED_STAFF_PASSWORD || "staff123";

  // --- users ---
  const adminToken = null;
  const baristaToken = staffToken();

  const users = [
    {
      username: "admin",
      password_hash: hashPassword(adminPw),
      full_name: "Cafe Owner",
      role: "admin",
      qr_token: adminToken,
    },
    {
      username: "barista1",
      password_hash: hashPassword(staffPw),
      full_name: "Juan Dela Cruz",
      role: "staff",
      qr_token: baristaToken,
    },
    {
      username: "barista2",
      password_hash: hashPassword(staffPw),
      full_name: "Maria Santos",
      role: "staff",
      qr_token: staffToken(),
    },
  ];

  const { error: userErr } = await db.from("users").upsert(users, { onConflict: "username" });
  if (userErr) throw userErr;
  console.log("✓ users");
  console.log(`    admin    / ${adminPw}   (username + password)`);
  console.log(`    barista1 / ${staffPw}   (barcode code below + password)`);
  console.log(`    barista1 barcode code: ${baristaToken}\n`);

  // --- categories ---
  const categoryNames = ["Coffee", "Milk", "Syrup", "Powder", "Tea", "Bakery", "Packaging"];
  await db.from("categories").upsert(
    categoryNames.map((name) => ({ name })),
    { onConflict: "name" }
  );
  const { data: cats } = await db.from("categories").select("id, name");
  const catId = Object.fromEntries((cats || []).map((c) => [c.name, c.id]));
  console.log("✓ categories");

  // --- locations ---
  const locationNames = ["Dry Storage", "Chiller", "Freezer", "Bar Station"];
  await db.from("locations").upsert(
    locationNames.map((name) => ({ name })),
    { onConflict: "name" }
  );
  const { data: locs } = await db.from("locations").select("id, name");
  const locId = Object.fromEntries((locs || []).map((l) => [l.name, l.id]));
  console.log("✓ locations");

  // --- items ---
  const today = new Date();
  const inDays = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const items = [
    { name: "Arabica Coffee Beans", cat: "Coffee", loc: "Dry Storage", form: "solid", unit: "kg", qty: 12, low: 4, exp: inDays(120) },
    { name: "Robusta Coffee Beans", cat: "Coffee", loc: "Dry Storage", form: "solid", unit: "kg", qty: 3, low: 5, exp: inDays(90) },
    { name: "Fresh Milk", cat: "Milk", loc: "Chiller", form: "liquid", unit: "L", qty: 8, low: 6, exp: inDays(4) },
    { name: "Condensed Milk", cat: "Milk", loc: "Dry Storage", form: "liquid", unit: "can", qty: 24, low: 10, exp: inDays(200) },
    { name: "Vanilla Syrup", cat: "Syrup", loc: "Bar Station", form: "liquid", unit: "bottle", qty: 5, low: 3, exp: inDays(300) },
    { name: "Caramel Syrup", cat: "Syrup", loc: "Bar Station", form: "liquid", unit: "bottle", qty: 1, low: 3, exp: inDays(280) },
    { name: "Matcha Powder", cat: "Powder", loc: "Dry Storage", form: "powder", unit: "kg", qty: 2, low: 2, exp: inDays(2) },
    { name: "Cocoa Powder", cat: "Powder", loc: "Dry Storage", form: "powder", unit: "kg", qty: 6, low: 3, exp: inDays(150) },
    { name: "Black Tea Leaves", cat: "Tea", loc: "Dry Storage", form: "solid", unit: "kg", qty: 0, low: 2, exp: inDays(60) },
    { name: "Croissant Dough", cat: "Bakery", loc: "Freezer", form: "solid", unit: "pack", qty: 15, low: 5, exp: inDays(-1) },
    { name: "16oz Paper Cups", cat: "Packaging", loc: "Dry Storage", form: "solid", unit: "pcs", qty: 500, low: 100, exp: null },
    { name: "Cup Lids", cat: "Packaging", loc: "Dry Storage", form: "solid", unit: "pcs", qty: 80, low: 100, exp: null },
  ];

  const itemRows = items.map((i) => ({
    sku: skuFor(i.cat.slice(0, 3).toUpperCase()),
    name: i.name,
    category_id: catId[i.cat] || null,
    location_id: locId[i.loc] || null,
    physical_form: i.form,
    unit: i.unit,
    quantity: i.qty,
    low_stock_threshold: i.low,
    expiration_date: i.exp,
  }));

  const { error: itemErr } = await db.from("items").insert(itemRows);
  if (itemErr && !String(itemErr.message).includes("duplicate")) throw itemErr;
  console.log("✓ items");

  // --- initial alert pass ---
  const { error: alertErr } = await db.rpc("refresh_alerts");
  if (alertErr) console.warn("  (refresh_alerts failed:", alertErr.message, ")");
  else console.log("✓ alerts generated");

  // --- seed audit entry ---
  await db.rpc("append_audit", {
    p_actor_id: null,
    p_actor_name: "system",
    p_action: "SEED",
    p_entity_type: "system",
    p_entity_id: null,
    p_details: { note: "Initial database seed", users: users.length, items: itemRows.length },
  });
  console.log("✓ audit log initialized\n");

  console.log("Done. Start the app with:  npm run dev");
}

main().catch((e) => {
  console.error("\nSeed failed:", e.message || e);
  process.exit(1);
});
