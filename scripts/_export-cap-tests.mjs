import assert from "node:assert/strict";
import {
  itemExportCap,
  movementExportCap,
  DEFAULT_ITEM_EXPORT_CAP,
  DEFAULT_MOVEMENT_EXPORT_CAP,
} from "../src/lib/stock-report-data.ts";

function withEnv(name, value, fn) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

let pass = 0;
let fail = 0;
function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${label}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}

console.log("\nexport caps — defaults");
check("itemExportCap defaults to 10000 when unset", () => {
  withEnv("CAFETRACK_EXPORT_ITEM_CAP", undefined, () => {
    assert.equal(itemExportCap(), DEFAULT_ITEM_EXPORT_CAP);
  });
});
check("movementExportCap defaults to 5000 when unset", () => {
  withEnv("CAFETRACK_EXPORT_MOVEMENT_CAP", undefined, () => {
    assert.equal(movementExportCap(), DEFAULT_MOVEMENT_EXPORT_CAP);
  });
});

console.log("\nexport caps — valid overrides");
check("valid item cap override is accepted", () => {
  withEnv("CAFETRACK_EXPORT_ITEM_CAP", "42", () => {
    assert.equal(itemExportCap(), 42);
  });
});
check("valid movement cap override is accepted", () => {
  withEnv("CAFETRACK_EXPORT_MOVEMENT_CAP", "7", () => {
    assert.equal(movementExportCap(), 7);
  });
});
check("maximum cap 100000 is accepted", () => {
  withEnv("CAFETRACK_EXPORT_ITEM_CAP", "100000", () => {
    assert.equal(itemExportCap(), 100000);
  });
});

console.log("\nexport caps — invalid configuration");
const invalidValues = ["0", "-1", "1.5", "", "abc", "NaN", "Infinity", "100001", "+5", "1e3"];
for (const value of invalidValues) {
  check(`item cap rejects ${JSON.stringify(value)}`, () => {
    withEnv("CAFETRACK_EXPORT_ITEM_CAP", value, () => {
      assert.throws(() => itemExportCap(), /Invalid CAFETRACK_EXPORT_ITEM_CAP/);
    });
  });
  check(`movement cap rejects ${JSON.stringify(value)}`, () => {
    withEnv("CAFETRACK_EXPORT_MOVEMENT_CAP", value, () => {
      assert.throws(() => movementExportCap(), /Invalid CAFETRACK_EXPORT_MOVEMENT_CAP/);
    });
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);