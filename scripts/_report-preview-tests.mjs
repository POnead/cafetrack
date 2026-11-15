/**
 * Export preview — regression tests (in-process).
 *
 *   node scripts/_ts-node.mjs scripts/_report-preview-tests.mjs
 *
 * /api/report-preview and /api/report-export both build their output from the
 * shared builder (src/lib/stock-report-data.ts), so the properties the front
 * end relies on are tested against that builder directly:
 *
 *   - completeness is reported honestly for items and movements,
 *   - the warnings name the cap and the omission,
 *   - filters behave identically regardless of which route asks,
 *   - the export-preview UI's completeness wording maps all three states,
 *     including "unknown" — a probe that could not run is never "Complete".
 *
 * A throwaway PGlite database is seeded here and closed before the app code
 * opens it, so the run is hermetic and never touches .pglite or .pglite-test.
 * The HTTP-level behavior of the endpoint (401 / 400 / 200 envelope) lives in
 * _report-preview-e2e.mjs, which needs the isolated server.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const DB_DIR = mkdtempSync(join(tmpdir(), "cafetrack-preview-test-"));
process.env.CAFETRACK_DB = "local";
process.env.CAFETRACK_DB_DIR = DB_DIR;

let pass = 0;
let fail = 0;
const failures = [];
const tests = [];

function check(label, fn) {
  tests.push({ label, fn });
}
function section(title) {
  tests.push({ section: title });
}

/* ------------------------------------------------------------------ */
/* seed the throwaway database                                          */
/* ------------------------------------------------------------------ */

const HOUR = 1;
const SEED = [
  // [type, age in hours, lines: [sku, itemName, qty]]
  ["restock", 1, [["CT-CF-0001", "Coffee Beans A", 12], ["CT-CF-0002", "Coffee Beans B", 8]]],
  ["checkout", 2, [["CT-CF-0001", "Coffee Beans A", 2]]],
  ["waste", 3, [["CT-ML-0001", "Whole Milk", 1]]],
  ["restock", 24 * 40, [["CT-CF-0003", "Coffee Beans C", 20]]],
];

const SEED_ITEMS = [
  ["CT-CF-0001", "Coffee Beans A", "Coffee", 50],
  ["CT-CF-0002", "Coffee Beans B", "Coffee", 40],
  ["CT-CF-0003", "Coffee Beans C", "Coffee", 30],
  ["CT-CF-0004", "Coffee Beans D", "Coffee", 20],
  ["CT-ML-0001", "Whole Milk", "Milk", 10],
  ["CT-ML-0002", "Condensed Milk", "Milk", 60],
];

async function seed() {
  const pg = new PGlite(DB_DIR);
  const schema = readFileSync(join(root, "db", "schema.local.sql"), "utf8");
  await pg.exec(schema);
  // One verified account so the app-side first-run seed (which would add the
  // stock catalogue too) sees users exist and stands down.
  await pg.query(
    `insert into users (username, password_hash, full_name, role, qr_token, verification_status)
     values ('seed-admin', 'unused-in-tests', 'Seed Admin', 'admin', null, 'verified')`
  );
  await pg.query(`insert into categories (name) values ('Coffee'), ('Milk')`);
  await pg.query(`insert into locations (name) values ('Dry Storage')`);
  for (const [sku, name, category, quantity] of SEED_ITEMS) {
    await pg.query(
      `insert into items (sku, name, category_id, location_id, physical_form, unit,
                          quantity, low_stock_threshold, expiration_date, item_status)
       values ($1, $2,
               (select id from categories where name = $3),
               (select id from locations where name = 'Dry Storage'),
               'solid', 'pcs', $4, 2, null, 'active')`,
      [sku, name, category, quantity]
    );
  }
  for (const [type, ageHours, lines] of SEED) {
    const inserted = await pg.query(
      `insert into transactions (type, actor_name, created_at, note)
       values ($1, 'Seed Barista', now() - ($2 || ' hours')::interval, 'seed')
       returning id`,
      [type, String(ageHours)]
    );
    const transactionId = inserted.rows[0].id;
    for (const [sku, itemName, qty] of lines) {
      await pg.query(
        `insert into transaction_items (transaction_id, item_id, sku, item_name, quantity, qty_before, qty_after)
         values ($1, null, $2, $3, $4, 0, $4)`,
        [transactionId, sku, itemName, qty]
      );
    }
  }
  const coffee = await pg.query(`select id from categories where name = 'Coffee'`);
  const milk = await pg.query(`select id from categories where name = 'Milk'`);
  await pg.close();
  return { coffeeCategoryId: coffee.rows[0].id, milkCategoryId: milk.rows[0].id };
}

const ids = await seed();

/* Imports happen after the environment is set and the database is seeded. */
const {
  buildStockReportData,
  parseStockReportFilters,
  StockReportFilterError,
} = await import("../src/lib/stock-report-data.ts");
const { exportCompletenessLabel } = await import("../src/lib/export-completeness.ts");

async function withCaps(itemCap, movementCap, fn) {
  const previousItem = process.env.CAFETRACK_EXPORT_ITEM_CAP;
  const previousMovement = process.env.CAFETRACK_EXPORT_MOVEMENT_CAP;
  const set = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  };
  set("CAFETRACK_EXPORT_ITEM_CAP", itemCap);
  set("CAFETRACK_EXPORT_MOVEMENT_CAP", movementCap);
  try {
    return await fn();
  } finally {
    set("CAFETRACK_EXPORT_ITEM_CAP", previousItem);
    set("CAFETRACK_EXPORT_MOVEMENT_CAP", previousMovement);
  }
}

/* ================================================================== */
section("parseStockReportFilters");
check("a flat body maps category_id to categoryId", () => {
  const parsed = parseStockReportFilters({
    from: "2026-11-01",
    to: "2026-11-15",
    staff: " Seed Barista ",
    type: "waste",
    category_id: "  cat-123  ",
    tz: "Asia/Manila",
  });
  assert.equal(parsed.from, "2026-11-01");
  assert.equal(parsed.to, "2026-11-15");
  assert.equal(parsed.staff, "Seed Barista");
  assert.equal(parsed.type, "waste");
  assert.equal(parsed.categoryId, "cat-123");
  assert.equal(parsed.tz, "Asia/Manila");
});

check("a { filters: {...} } envelope is unwrapped", () => {
  const parsed = parseStockReportFilters({
    filters: { from: "2026-11-01", to: "2026-11-02", tz: "UTC" },
  });
  assert.equal(parsed.from, "2026-11-01");
  assert.equal(parsed.to, "2026-11-02");
  assert.equal(parsed.tz, "UTC");
});

check("an unrecognised timezone is rejected with a named error", () => {
  assert.throws(
    () => parseStockReportFilters({ tz: "Mars/Olympus_Mons" }),
    (error) =>
      error instanceof StockReportFilterError && /timezone/i.test(error.message)
  );
});

check("an unrecognised timezone in an envelope is rejected too", () => {
  assert.throws(
    () => parseStockReportFilters({ filters: { tz: "Not/AZone" } }),
    StockReportFilterError
  );
});

check("an unknown movement type is ignored, not passed through", () => {
  const parsed = parseStockReportFilters({ type: "hack" });
  assert.equal(parsed.type, "");
});

check("invalid calendar days are dropped, not forwarded", () => {
  const parsed = parseStockReportFilters({ from: "2026-13-99", to: "not-a-day" });
  assert.equal(parsed.from, "");
  assert.equal(parsed.to, "");
});

check("an empty body yields empty filters", () => {
  const parsed = parseStockReportFilters(undefined);
  assert.deepEqual(parsed, {
    from: "",
    to: "",
    staff: "",
    type: "",
    categoryId: "",
    tz: "",
  });
});

section("exportCompletenessLabel — all three states");
check("complete renders Complete", () => {
  assert.equal(exportCompletenessLabel("complete"), "Complete");
});
check("truncated renders Truncated", () => {
  assert.equal(exportCompletenessLabel("truncated"), "Truncated");
});
check("unknown renders Unknown — could not verify", () => {
  assert.equal(exportCompletenessLabel("unknown"), "Unknown — could not verify");
});
check("an unrecognised state falls back to the unknown wording", () => {
  assert.equal(exportCompletenessLabel("something-else"), "Unknown — could not verify");
});

section("buildStockReportData — completeness on a small, seeded catalogue");
check("default caps report complete items and movements", async () => {
  await withCaps(undefined, undefined, async () => {
    const report = await buildStockReportData(
      parseStockReportFilters({ tz: "Asia/Manila" })
    );
    assert.equal(report.completeness.items, "complete");
    assert.equal(report.completeness.movements, "complete");
    assert.equal(report.completeness.itemsScanned, SEED_ITEMS.length);
    assert.equal(report.completeness.movementsScanned, SEED.length);
    assert.equal(report.completeness.itemCap, 10_000);
    assert.equal(report.completeness.movementCap, 5_000);
    assert.deepEqual(
      report.warnings,
      [],
      "no completeness warnings when everything is known to be complete"
    );
  });
});

check("an item cap below the catalogue size reports truncated items", async () => {
  await withCaps(2, undefined, async () => {
    const report = await buildStockReportData(parseStockReportFilters({}));
    assert.equal(report.completeness.items, "truncated");
    assert.equal(report.completeness.itemsScanned, 2);
    assert.equal(report.completeness.itemCap, 2);
    /* movements are unaffected */
    assert.equal(report.completeness.movements, "complete");
    assert.equal(report.completeness.movementCap, 5_000);
    assert.equal(
      report.warnings.length,
      1,
      "exactly one warning, for the truncated section"
    );
    assert.match(
      report.warnings[0],
      /first 2 catalogue items \(ordered by name\)/,
      "the warning names the cap and the order"
    );
    assert.match(report.warnings[0], /Additional items exist and were not included/);
  });
});

check("a movement cap below the ledger size reports truncated movements", async () => {
  await withCaps(undefined, 2, async () => {
    const report = await buildStockReportData(parseStockReportFilters({}));
    assert.equal(report.completeness.movements, "truncated");
    assert.equal(report.completeness.movementsScanned, 2);
    assert.equal(report.completeness.movementCap, 2);
    assert.equal(report.completeness.items, "complete");
    assert.equal(report.warnings.length, 1);
    assert.match(
      report.warnings[0],
      /2 newest matching transactions/,
      "the warning names the cap and the order"
    );
    assert.match(
      report.warnings[0],
      /Additional transactions exist and were not included/
    );
  });
});

check("capping both sections reports both as truncated", async () => {
  await withCaps(2, 2, async () => {
    const report = await buildStockReportData(parseStockReportFilters({}));
    assert.equal(report.completeness.items, "truncated");
    assert.equal(report.completeness.movements, "truncated");
    assert.equal(report.warnings.length, 2);
  });
});

check("exactly at the movement cap with no more rows reports complete", async () => {
  await withCaps(undefined, SEED.length, async () => {
    const report = await buildStockReportData(parseStockReportFilters({}));
    assert.equal(report.completeness.movements, "complete");
    assert.equal(report.completeness.movementsScanned, SEED.length);
    assert.deepEqual(report.warnings, []);
  });
});

check("exactly at the item cap with no more rows reports complete", async () => {
  await withCaps(SEED_ITEMS.length, undefined, async () => {
    const report = await buildStockReportData(parseStockReportFilters({}));
    assert.equal(report.completeness.items, "complete");
    assert.equal(report.completeness.itemsScanned, SEED_ITEMS.length);
    assert.deepEqual(report.warnings, []);
  });
});

check("one row past the movement cap flips complete to truncated", async () => {
  await withCaps(undefined, SEED.length - 1, async () => {
    const report = await buildStockReportData(parseStockReportFilters({}));
    assert.equal(report.completeness.movements, "truncated");
    assert.equal(report.completeness.movementsScanned, SEED.length - 1);
    assert.equal(report.warnings.length, 1);
  });
});

check("an invalid cap configuration throws instead of silently defaulting", async () => {
  await withCaps("abc", undefined, async () => {
    await assert.rejects(() => buildStockReportData(parseStockReportFilters({})), /Invalid CAFETRACK_EXPORT_ITEM_CAP/);
  });
});

section("filter consistency — the preview and the export read the same report");
check("a category filter narrows items but never inflates the scan count", async () => {
  await withCaps(undefined, undefined, async () => {
    const all = await buildStockReportData(parseStockReportFilters({}));
    const coffee = await buildStockReportData(
      parseStockReportFilters({ category_id: ids.coffeeCategoryId })
    );
    assert.equal(all.completeness.itemsScanned, SEED_ITEMS.length);
    assert.equal(coffee.completeness.itemsScanned, SEED_ITEMS.length);
    assert.equal(coffee.items.length, 4, "only the Coffee items are included");
    assert.ok(
      coffee.items.every((item) => item.sku.startsWith("CT-CF-")),
      "every included item is a Coffee item"
    );
    assert.ok(
      coffee.movementLines.every((line) => line.sku.startsWith("CT-CF-")),
      "movement lines are filtered to the same category"
    );
    assert.equal(
      coffee.completeness.itemsScanned,
      all.completeness.itemsScanned,
      "the completeness scan measures the whole catalogue in both calls"
    );
  });
});

check("a movement type filter selects only that type", async () => {
  await withCaps(undefined, undefined, async () => {
    const report = await buildStockReportData(parseStockReportFilters({ type: "waste" }));
    assert.equal(report.completeness.movementsScanned, 1);
    const wasteLines = report.movementLines;
    assert.ok(wasteLines.length > 0);
    assert.ok(wasteLines.every((line) => line.label === "Logged as waste"));
  });
});

check("a staff filter selects only that staff member", async () => {
  await withCaps(undefined, undefined, async () => {
    const included = await buildStockReportData(parseStockReportFilters({ staff: "Seed Barista" }));
    const excluded = await buildStockReportData(parseStockReportFilters({ staff: "Nobody Real" }));
    assert.equal(included.completeness.movementsScanned, SEED.length);
    assert.equal(excluded.completeness.movementsScanned, 0);
    assert.equal(excluded.completeness.movements, "complete");
    assert.equal(excluded.movementLines.length, 0);
  });
});

check("a tz-windowed range excludes movements outside it", async () => {
  const isoDay = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  await withCaps(undefined, undefined, async () => {
    const windowed = await buildStockReportData(
      parseStockReportFilters({ from: isoDay(weekAgo), to: isoDay(today), tz: "Asia/Manila" })
    );
    const all = await buildStockReportData(parseStockReportFilters({ tz: "Asia/Manila" }));
    assert.equal(
      windowed.completeness.movementsScanned,
      3,
      "the 40-day-old restock falls outside the window"
    );
    assert.equal(all.completeness.movementsScanned, 4);
  });
});

check("repeated calls with the same filters produce identical completeness and warnings", async () => {
  await withCaps(2, 2, async () => {
    const filters = parseStockReportFilters({ tz: "Asia/Manila" });
    const first = await buildStockReportData(filters);
    const second = await buildStockReportData(filters);
    assert.deepEqual(first.completeness, second.completeness);
    assert.deepEqual(first.warnings, second.warnings);
  });
});

/* ================================================================== */

for (const entry of tests) {
  if (entry.section) {
    console.log(`\n== ${entry.section} ==`);
    continue;
  }
  try {
    // eslint-disable-next-line no-await-in-loop
    await entry.fn();
    pass++;
    console.log(`  PASS  ${entry.label}`);
  } catch (error) {
    fail++;
    failures.push(entry.label);
    console.error(`  FAIL  ${entry.label}: ${error.message}`);
  }
}

try {
  rmSync(DB_DIR, { recursive: true, force: true });
} catch {
  // on Windows PGlite sometimes holds the directory briefly
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.error(`failures:\n  - ${failures.join("\n  - ")}`);
}
process.exit(fail > 0 ? 1 : 0);
