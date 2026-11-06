import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
const day = (value) =>
  value == null
    ? null
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).slice(0, 10);
const offsetDay = (offset) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

async function move(type, items) {
  const { rows } = await db.query(
    "select process_transaction($1, null, 'Batch test', $2::jsonb, null) as result",
    [type, JSON.stringify(items)]
  );
  return rows[0].result;
}

try {
  const schema = readFileSync("db/schema.local.sql", "utf8");
  await db.exec(schema);

  const { rows: incorrectExpirableItems } = await db.query(
    `insert into items (sku, name, quantity, expirable)
     values ('BATCH-MATCHA-FLAG', 'Matcha Powder', 1, false),
            ('BATCH-DATED-FLAG', 'Dated Legacy Item', 1, false),
            ('BATCH-CUPS-FLAG', '16oz Paper Cups', 1, false)
     returning id, name`
  );
  const datedLegacy = incorrectExpirableItems.find(
    (item) => item.name === "Dated Legacy Item"
  );
  await db.query(
    "update inventory_batches set expiration_date = $1 where item_id = $2",
    [offsetDay(20), datedLegacy.id]
  );
  await db.exec(schema);
  const { rows: correctedExpirableItems } = await db.query(
    "select name, expirable from items where id = any($1::uuid[])",
    [incorrectExpirableItems.map((item) => item.id)]
  );
  assert.equal(
    correctedExpirableItems.find((item) => item.name === "Matcha Powder").expirable,
    true,
    "known expirable catalog items with incorrect flags are corrected"
  );
  assert.equal(
    correctedExpirableItems.find((item) => item.name === "Dated Legacy Item").expirable,
    true,
    "items with dated batches are corrected to expirable"
  );
  assert.equal(
    correctedExpirableItems.find((item) => item.name === "16oz Paper Cups").expirable,
    false,
    "non-expiring packaging remains non-expirable"
  );

  await db.query("alter table items disable trigger items_sync_batch_quantity");
  const { rows: legacyItem } = await db.query(
    "insert into items (sku, name, quantity, expiration_date) values ('BATCH-LEGACY', 'Legacy Batch Test', 4, $1) returning id",
    [offsetDay(15)]
  );
  await db.query("alter table items enable trigger items_sync_batch_quantity");
  await db.exec(schema);

  let { rows: openingBatch } = await db.query(
    "select received_quantity, remaining_quantity, source_type from inventory_batches where item_id = $1",
    [legacyItem[0].id]
  );
  assert.equal(openingBatch.length, 1, "migration backfills existing stock once");
  assert.equal(Number(openingBatch[0].received_quantity), 4);
  assert.equal(openingBatch[0].source_type, "opening");
  await db.exec(schema);
  ({ rows: openingBatch } = await db.query(
    "select id from inventory_batches where item_id = $1",
    [legacyItem[0].id]
  ));
  assert.equal(openingBatch.length, 1, "reapplying schema does not duplicate batches");

  const firstExpiry = offsetDay(20);
  const nextExpiry = offsetDay(50);
  const { rows: inserted } = await db.query(
    "insert into items (sku, name, quantity, expiration_date) values ($1, $2, 10, $3) returning id",
    ["BATCH-TEST", "Batch Test", firstExpiry]
  );
  const itemId = inserted[0].id;

  let { rows: batches } = await db.query(
    "select id, batch_code, remaining_quantity, expiration_date from inventory_batches where item_id = $1 order by received_at, id",
    [itemId]
  );
  assert.equal(batches.length, 1, "opening stock creates one batch");
  assert.equal(Number(batches[0].remaining_quantity), 10);

  const restock = await move("restock", [
    { sku: "BATCH-TEST", qty: 8, exp: nextExpiry },
  ]);
  assert.equal(Number(restock.items[0].after), 18);

  ({ rows: batches } = await db.query(
    "select id, batch_code, remaining_quantity, expiration_date from inventory_batches where item_id = $1 order by expiration_date, received_at",
    [itemId]
  ));
  assert.equal(batches.length, 2, "each restock creates its own batch");
  assert.notEqual(batches[0].batch_code, batches[1].batch_code);
  assert.ok(batches.every((batch) => batch.batch_code.startsWith("CTB-")));
  assert.ok(
    batches.every((batch) => batch.batch_code.length === 20),
    "batch barcodes use compact unique codes that fit a label"
  );
  assert.equal(day(batches[0].expiration_date), firstExpiry);
  assert.equal(day(batches[1].expiration_date), nextExpiry);

  const { rows: correctionLots } = await db.query(
    "select id, batch_code, remaining_quantity, expiration_date from inventory_batches where item_id = $1 order by received_at, id",
    [itemId]
  );
  const correctionReason = "Physical count found a damaged unit";
  const { rows: correctedItemResult } = await db.query(
    `select to_jsonb(x) as item
       from correct_item_batch_counts(
         $1,
         (select version from items where id = $1),
         '{}'::jsonb,
         $2::jsonb,
         $3
       ) as x`,
    [
      itemId,
      JSON.stringify([
        {
          batch_id: correctionLots[0].id,
          quantity: Number(correctionLots[0].remaining_quantity) - 1,
        },
        {
          batch_id: correctionLots[1].id,
          quantity: Number(correctionLots[1].remaining_quantity) + 2,
        },
      ]),
      correctionReason,
    ]
  );
  assert.equal(Number(correctedItemResult[0].item.quantity), 19);
  const { rows: correctedLots } = await db.query(
    "select batch_code, received_quantity, remaining_quantity, expiration_date, source_type, adjustment_reason from inventory_batches where item_id = $1 order by received_at, id",
    [itemId]
  );
  assert.equal(Number(correctedLots[0].remaining_quantity), 9);
  assert.equal(Number(correctedLots[0].received_quantity), 10);
  const adjustmentLot = correctedLots.find((batch) => batch.source_type === "adjustment");
  assert.ok(adjustmentLot, "the positive correction is recorded as an adjustment batch");
  assert.equal(
    Number(adjustmentLot.remaining_quantity),
    2,
    "an increase creates a separate adjustment batch rather than rewriting the receipt"
  );
  assert.equal(adjustmentLot.adjustment_reason, correctionReason);
  assert.equal(
    day(adjustmentLot.expiration_date),
    day(correctionLots[1].expiration_date),
    "an adjustment batch preserves the corrected batch's expiration date"
  );

  const { rows: queuedCorrection } = await db.query(
    `insert into item_change_requests
       (item_id, base_version, batch_adjustments, correction_reason)
     values (
       $1,
       (select version from items where id = $1),
       $2::jsonb,
       'Admin-approved batch count'
     )
     returning id`,
    [
      itemId,
      JSON.stringify([
        {
          batch_id: correctionLots[0].id,
          quantity: Number(correctionLots[0].remaining_quantity) - 2,
          batch_code: correctionLots[0].batch_code,
        },
      ]),
    ]
  );
  const { rows: reviewedCorrection } = await db.query(
    "select to_jsonb(x) as request from review_change_request($1, null, 'approve', null) as x",
    [queuedCorrection[0].id]
  );
  assert.equal(reviewedCorrection[0].request.status, "approved");
  const { rows: approvedBatchCount } = await db.query(
    "select quantity from items where id = $1",
    [itemId]
  );
  assert.equal(
    Number(approvedBatchCount[0].quantity),
    18,
    "approving a staff batch correction applies it to the correct item total"
  );

  const checkout = await move("checkout", [
    { sku: "BATCH-TEST", qty: 6 },
  ]);
  assert.equal(checkout.items[0].batches.length, 1);
  assert.equal(day(checkout.items[0].batches[0].expiration_date), firstExpiry);
  assert.equal(Number(checkout.items[0].batches[0].quantity), 6);
  const { rows: checkoutHistoryLine } = await db.query(
    "select expiration_date, batch_allocations from transaction_items where transaction_id = $1",
    [checkout.transaction_id]
  );
  assert.equal(
    day(checkoutHistoryLine[0].expiration_date),
    firstExpiry,
    "checkout history uses the selected batch expiration date"
  );
  assert.equal(
    day(checkoutHistoryLine[0].batch_allocations[0].expiration_date),
    firstExpiry,
    "checkout history batch details match the selected batch"
  );

  const manualCheckout = await move("checkout", [
    {
      sku: "BATCH-TEST",
      qty: 4,
      batch_allocations: [
        { batch_id: batches[0].id, qty: 2 },
        { batch_id: batches[1].id, qty: 2 },
      ],
    },
  ]);
  assert.equal(manualCheckout.items[0].batches.length, 2);
  assert.deepEqual(
    manualCheckout.items[0].batches.map((allocation) =>
      Number(allocation.quantity)
    ),
    [2, 2],
    "manual allocation can split checkout across chosen batches"
  );
  const { rows: manualHistoryLine } = await db.query(
    "select expiration_date, batch_allocations from transaction_items where transaction_id = $1",
    [manualCheckout.transaction_id]
  );
  assert.equal(
    manualHistoryLine[0].expiration_date,
    null,
    "multi-batch checkout does not claim one item-level expiration date"
  );

  await assert.rejects(
    move("waste", [{ sku: "BATCH-TEST", qty: 2 }]),
    /insufficient expired stock for automatic waste/
  );
  await assert.rejects(
    move("waste", [
      {
        sku: "BATCH-TEST",
        qty: 2,
        batch_id: batches[1].id,
        note: "This is not a waste reason",
      },
    ]),
    /reason is required to waste non-expired batch/
  );

  const targetedWaste = await move("waste", [
    {
      sku: "BATCH-TEST",
      qty: 2,
      batch_id: batches[1].id,
      waste_reason: "Damaged during handling",
    },
  ]);
  assert.equal(targetedWaste.items[0].batches[0].batch_id, batches[1].id);
  const { rows: targetedWasteHistory } = await db.query(
    "select t.type, ti.note from transactions t join transaction_items ti on ti.transaction_id = t.id where t.id = $1",
    [targetedWaste.transaction_id]
  );
  assert.equal(targetedWasteHistory[0].type, "waste");
  assert.equal(targetedWasteHistory[0].note, "Damaged during handling");

  await db.query("update items set quantity = quantity + 3 where id = $1", [
    itemId,
  ]);
  let { rows: synchronized } = await db.query(
    "select i.quantity, sum(b.remaining_quantity) as batch_total from items i join inventory_batches b on b.item_id = i.id where i.id = $1 group by i.id",
    [itemId]
  );
  assert.equal(Number(synchronized[0].quantity), 9);
  assert.equal(Number(synchronized[0].batch_total), 9);

  await db.query("update items set quantity = quantity - 1 where id = $1", [
    itemId,
  ]);
  ({ rows: synchronized } = await db.query(
    "select i.quantity, sum(b.remaining_quantity) as batch_total from items i join inventory_batches b on b.item_id = i.id where i.id = $1 group by i.id",
    [itemId]
  ));
  assert.equal(Number(synchronized[0].quantity), 8);
  assert.equal(Number(synchronized[0].batch_total), 8);

  const { rows: expiredItem } = await db.query(
    "insert into items (sku, name, quantity, expiration_date) values ('BATCH-EXPIRED', 'Expired Batch Test', 2, $1) returning id",
    [offsetDay(-1)]
  );
  await move("restock", [
    { sku: "BATCH-EXPIRED", qty: 5, exp: nextExpiry },
  ]);
  const { rows: expiredLot } = await db.query(
    "select id, batch_code from inventory_batches where item_id = $1 and expiration_date < current_date and remaining_quantity > 0",
    [expiredItem[0].id]
  );
  assert.equal(expiredLot.length, 1);
  await assert.rejects(
    move("checkout", [
      {
        sku: "BATCH-EXPIRED",
        qty: 1,
        batch_allocations: [{ batch_id: expiredLot[0].id, qty: 1 }],
      },
    ]),
    /expired on .* cannot be checked out/
  );
  const freshCheckout = await move("checkout", [
    { sku: "BATCH-EXPIRED", qty: 1 },
  ]);
  assert.equal(
    day(freshCheckout.items[0].batches[0].expiration_date),
    nextExpiry,
    "checkout skips expired batches"
  );
  const { rows: remainingExpiredLot } = await db.query(
    "select remaining_quantity from inventory_batches where id = $1",
    [expiredLot[0].id]
  );
  assert.equal(
    Number(remainingExpiredLot[0].remaining_quantity),
    2,
    "checkout leaves expired stock untouched"
  );
  await assert.rejects(
    move("checkout", [{ sku: "BATCH-EXPIRED", qty: 5 }]),
    /insufficient non-expired stock/
  );
  const { rows: expiredLotAfterFailedAuto } = await db.query(
    "select remaining_quantity from inventory_batches where id = $1",
    [expiredLot[0].id]
  );
  assert.equal(
    Number(expiredLotAfterFailedAuto[0].remaining_quantity),
    2,
    "Auto FEFO refuses a quantity that would require expired stock"
  );
  await db.query("select refresh_alerts()");
  const { rows: expiredAlert } = await db.query(
    "select type, message from alerts where item_id = $1 and resolved = false and type in ('expired','near_expiry')",
    [expiredItem[0].id]
  );
  assert.equal(expiredAlert.length, 1);
  assert.equal(expiredAlert[0].type, "expired");
  assert.ok(expiredAlert[0].message.includes(expiredLot[0].batch_code));
  assert.match(expiredAlert[0].message, /4(?:\.0+)? pcs remains usable/);

  const { rows: lowStockItem } = await db.query(
    "insert into items (sku, name, quantity, low_stock_threshold, expirable) values ('BATCH-LOW', 'Low Stock Test', 4, 5, false) returning id"
  );
  await db.query("select refresh_alerts()");
  const { rows: initialLowAlert } = await db.query(
    "select id, message, created_at from alerts where item_id = $1 and type = 'low_stock' and resolved = false",
    [lowStockItem[0].id]
  );
  assert.equal(initialLowAlert.length, 1, "low stock creates an alert");
  await db.query("update items set quantity = 3 where id = $1", [
    lowStockItem[0].id,
  ]);
  await db.query(
    "update alerts set updated_at = '2000-01-01T00:00:00Z' where id = $1",
    [initialLowAlert[0].id]
  );
  await db.query("select refresh_alerts()");
  const { rows: updatedLowAlert } = await db.query(
    "select message, created_at, updated_at from alerts where id = $1",
    [initialLowAlert[0].id]
  );
  assert.match(updatedLowAlert[0].message, /3(?:\.0+)? pcs left/);
  assert.equal(
    new Date(updatedLowAlert[0].created_at).getTime(),
    new Date(initialLowAlert[0].created_at).getTime(),
    "refreshing an alert preserves its original raised timestamp"
  );
  assert.ok(
    new Date(updatedLowAlert[0].updated_at).getTime() >
      new Date(initialLowAlert[0].created_at).getTime(),
    "refreshing an alert advances its updated timestamp"
  );
  await move("restock", [{ sku: "BATCH-LOW", qty: 4 }]);
  await db.query("select refresh_alerts()");
  const { rows: resolvedLowAlert } = await db.query(
    "select resolved, resolved_by, resolved_reason from alerts where id = (select id from alerts where item_id = $1 and type = 'low_stock' order by created_at desc limit 1)",
    [lowStockItem[0].id]
  );
  assert.equal(resolvedLowAlert[0].resolved, true);
  assert.equal(resolvedLowAlert[0].resolved_by, "Batch test");
  assert.match(resolvedLowAlert[0].resolved_reason, /Stock replenished by Batch test via restock/);

  await move("waste", [
    { sku: "BATCH-EXPIRED", qty: 2, batch_id: expiredLot[0].id },
  ]);
  await db.query("select refresh_alerts()");
  const { rows: clearedExpiredAlert } = await db.query(
    "select resolved, resolved_by, resolved_reason from alerts where item_id = $1 and type = 'expired' order by created_at desc limit 1",
    [expiredItem[0].id]
  );
  assert.equal(clearedExpiredAlert[0].resolved, true);
  assert.equal(clearedExpiredAlert[0].resolved_by, "Batch test");
  assert.match(
    clearedExpiredAlert[0].resolved_reason,
    /Expired\/near-expiry stock logged as waste by Batch test/
  );

  const { rows: wasteGuardItem } = await db.query(
    "insert into items (sku, name, quantity, expiration_date) values ('BATCH-WASTE-GUARD', 'Waste Guard Test', 2, $1) returning id",
    [offsetDay(-1)]
  );
  await move("restock", [
    { sku: "BATCH-WASTE-GUARD", qty: 5, exp: nextExpiry },
  ]);
  const { rows: wasteGuardBatches } = await db.query(
    "select id, expiration_date from inventory_batches where item_id = $1 and remaining_quantity > 0 order by expiration_date",
    [wasteGuardItem[0].id]
  );
  const autoExpiredWaste = await move("waste", [
    { sku: "BATCH-WASTE-GUARD", qty: 2 },
  ]);
  assert.equal(
    autoExpiredWaste.items[0].batches[0].batch_id,
    wasteGuardBatches[0].id,
    "automatic waste consumes expired batches only"
  );
  await assert.rejects(
    move("waste", [{ sku: "BATCH-WASTE-GUARD", qty: 1 }]),
    /insufficient expired stock for automatic waste/
  );
  await assert.rejects(
    move("waste", [
      { sku: "BATCH-WASTE-GUARD", qty: 1, batch_id: wasteGuardBatches[1].id },
    ]),
    /reason is required to waste non-expired batch/
  );
  const confirmedFreshWaste = await move("waste", [
    {
      sku: "BATCH-WASTE-GUARD",
      qty: 1,
      batch_id: wasteGuardBatches[1].id,
      waste_reason: "Container was damaged",
    },
  ]);
  assert.equal(
    confirmedFreshWaste.items[0].batches[0].batch_id,
    wasteGuardBatches[1].id
  );
  const { rows: wasteGuardHistory } = await db.query(
    "select t.type, ti.note from transactions t join transaction_items ti on ti.transaction_id = t.id where t.id = $1",
    [confirmedFreshWaste.transaction_id]
  );
  assert.equal(
    wasteGuardHistory[0].type,
    "waste",
    "a waste movement is stored with type waste, not checkout"
  );
  assert.equal(wasteGuardHistory[0].note, "Container was damaged");
  const reasonCompatibilityWaste = await move("waste", [
    {
      sku: "BATCH-WASTE-GUARD",
      qty: 1,
      batch_id: wasteGuardBatches[1].id,
      note: "Broken packaging",
      waste_reason: "Broken packaging",
    },
  ]);
  const { rows: reasonCompatibilityHistory } = await db.query(
    "select note from transaction_items where transaction_id = $1",
    [reasonCompatibilityWaste.transaction_id]
  );
  assert.equal(
    reasonCompatibilityHistory[0].note,
    "Broken packaging",
    "legacy note fallback stores the reason once"
  );

  const { rows: beforeFailedMove } = await db.query(
    "select quantity from items where id = $1",
    [itemId]
  );
  await assert.rejects(
    move("checkout", [{ sku: "BATCH-TEST", qty: 999 }]),
    /insufficient non-expired stock/
  );
  const { rows: afterFailedMove } = await db.query(
    "select quantity from items where id = $1",
    [itemId]
  );
  assert.equal(
    Number(afterFailedMove[0].quantity),
    Number(beforeFailedMove[0].quantity),
    "a refused movement does not change item totals"
  );

  await assert.rejects(
    move("checkout", [
      {
        sku: "BATCH-TEST",
        qty: 3,
        batch_allocations: [{ batch_id: batches[1].id, qty: 2 }],
      },
    ]),
    /selected batch quantities total/
  );
  await assert.rejects(
    move("checkout", [
      {
        sku: "BATCH-TEST",
        qty: 2,
        batch_allocations: [
          { batch_id: batches[1].id, qty: 1 },
          { batch_id: batches[1].id, qty: 1 },
        ],
      },
    ]),
    /selected more than once/
  );

  await assert.rejects(
    db.query("update items set expiration_date = $1 where id = $2", [
      offsetDay(80),
      itemId,
    ]),
    /multiple active batches/
  );

  const { rows: singleItem } = await db.query(
    "insert into items (sku, name, quantity, expiration_date) values ('BATCH-SINGLE', 'Single Batch Test', 3, $1) returning id",
    [firstExpiry]
  );
  await db.query("update items set expiration_date = $1 where id = $2", [
    nextExpiry,
    singleItem[0].id,
  ]);
  const { rows: singleBatch } = await db.query(
    "select expiration_date from inventory_batches where item_id = $1 and remaining_quantity > 0",
    [singleItem[0].id]
  );
  assert.equal(day(singleBatch[0].expiration_date), nextExpiry);

  const { rows: expiredTotal } = await db.query(
    "select quantity from items where id = $1",
    [expiredItem[0].id]
  );
  assert.equal(Number(expiredTotal[0].quantity), 4);
  console.log(
    "PASS: opening and restock batches, per-batch corrections and approvals, FEFO checkout, waste validation, rollback, and expiry synchronization"
  );
} finally {
  await db.close();
}
