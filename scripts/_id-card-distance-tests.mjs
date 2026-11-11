import assert from "node:assert/strict";
import {
  cardDistanceState,
  cardFitsGuide,
  containedVideoBounds,
} from "../src/lib/id-card-scanner.ts";

function card(x0, y0, x1, y1) {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

assert.equal(cardDistanceState(card(0.1, 0.2, 0.9, 0.8)), "ok");
assert.equal(cardDistanceState(card(0.45, 0.45, 0.55, 0.55)), "too-small");
assert.equal(cardDistanceState(card(0.15, 0.30, 0.85, 0.70)), "ok");
assert.equal(cardDistanceState(card(0.18, 0.18, 0.82, 0.82)), "ok");
assert.equal(cardDistanceState(card(0.01, 0.01, 0.99, 0.99)), "too-close");
assert.equal(cardDistanceState(card(-0.01, 0.05, 0.95, 0.95)), "too-close");

const videoBounds = { left: 0, top: 0, width: 640, height: 480 };
const guideBounds = { left: 100, top: 100, width: 440, height: 280 };
assert.equal(cardFitsGuide(card(0.2, 0.3, 0.8, 0.7), videoBounds, guideBounds), true);
assert.equal(cardFitsGuide(card(0.1, 0.3, 0.8, 0.7), videoBounds, guideBounds), false);

assert.deepEqual(
  containedVideoBounds({ left: 0, top: 0, width: 640, height: 288 }, 16, 9),
  { left: 64, top: 0, width: 512, height: 288 }
);

console.log("ID card distance checks passed.");
