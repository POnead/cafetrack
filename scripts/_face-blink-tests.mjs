import assert from "node:assert/strict";
import {
  classifyEyeBlink,
  withXnnpackInfoFiltered,
} from "../src/lib/face-blink.ts";

assert.equal(classifyEyeBlink({ left: 0.82, right: 0.76 }), "closed");
assert.equal(classifyEyeBlink({ left: 0.08, right: 0.17 }), "open");
assert.equal(classifyEyeBlink({ left: 0.7, right: 0.22 }), "transition");
assert.equal(classifyEyeBlink({ left: 0.45, right: 0.48 }), "transition");

const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => loggedErrors.push(args);
const testConsoleError = console.error;
try {
  await withXnnpackInfoFiltered(async () => {
    assert.notEqual(console.error, testConsoleError);
    console.error("INFO: Created TensorFlow Lite XNNPACK delegate for CPU.");
    console.error("A real MediaPipe error.");
  });
  assert.deepEqual(loggedErrors, [["A real MediaPipe error."]]);
  assert.equal(console.error, testConsoleError);

  console.error("Error after MediaPipe initialization.");
  assert.deepEqual(loggedErrors.at(-1), ["Error after MediaPipe initialization."]);

  await assert.rejects(
    withXnnpackInfoFiltered(async () => {
      assert.notEqual(console.error, testConsoleError);
      throw new Error("Initialization failed.");
    }),
    /Initialization failed/
  );
  assert.equal(console.error, testConsoleError);
} finally {
  console.error = originalConsoleError;
}

console.log("4 MediaPipe blink-state checks and XNNPACK log filtering passed.");
