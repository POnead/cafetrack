import {
  activeFailureStamps,
  FAILURE_STREAK_RESET_MS,
} from "../src/lib/failure-streak.ts";

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
  }
}

const now = Date.now();
const rows = [
  { success: false, at: now - 1_000 },
  { success: false, at: now - 2_000 },
  { success: true, at: now - 3_000 },
  { success: false, at: now - 4_000 },
];

check(
  "only failures after the most recent success count",
  activeFailureStamps(rows, now).length === 2
);
check(
  "a failure streak remains active just before the 24-hour idle reset",
  activeFailureStamps(
    [{ success: false, at: now - FAILURE_STREAK_RESET_MS + 1 }],
    now
  ).length === 1
);
check(
  "a failure exactly 24 hours old starts a fresh streak",
  activeFailureStamps(
    [{ success: false, at: now - FAILURE_STREAK_RESET_MS }],
    now
  ).length === 0
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
