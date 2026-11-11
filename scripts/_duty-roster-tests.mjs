import assert from "node:assert/strict";
import {
  buildDutyRoster,
  cafeDayRange,
  countDutyActivity,
} from "../src/lib/duty-roster.ts";

const staff = [
  { id: "staff-1", name: "Barista One" },
  { id: "staff-2", name: "Barista Two" },
];
const logins = [
  {
    actor_id: "staff-1",
    actor_name: "Barista One",
    action: "LOGIN",
    details: { method: "staff_step2", matched_by: "face" },
    outcome: "success",
    created_at: "2026-11-08T01:00:00.000Z",
  },
  {
    actor_id: "staff-2",
    actor_name: "Barista Two",
    action: "LOGIN",
    details: { method: "password" },
    outcome: "success",
    created_at: "2026-11-08T01:30:00.000Z",
  },
];
const roster = buildDutyRoster({
  staff,
  logins,
  faceVerifications: [
    {
      actor_id: "staff-2",
      actor_name: "Barista Two",
      action: "FACE_VERIFY",
      details: { result: "matched" },
      outcome: "success",
      created_at: "2026-11-08T02:00:00.000Z",
    },
  ],
  faceResetEvents: [],
  transactions: [
    { actor_id: "staff-1", type: "checkout" },
    { actor_id: "staff-1", type: "checkout" },
    { actor_id: "staff-1", type: "restock" },
    { actor_id: "staff-1", type: "waste" },
    { actor_id: "staff-2", type: "restock" },
    { actor_id: "admin-id", type: "checkout" },
  ],
});

assert.equal(roster.length, 2);
assert.deepEqual(
  roster.map(({ name }) => name),
  ["Barista One", "Barista Two"]
);
assert.equal(roster[0].faceVerified, true);
assert.equal(roster[0].checkout, 2);
assert.equal(roster[0].restock, 1);
assert.equal(roster[0].waste, 1);
assert.equal(roster[1].faceVerified, true);
assert.equal(roster[1].checkout, 0);
assert.equal(roster[1].restock, 1);
assert.equal(roster[1].waste, 0);

assert.deepEqual(
  countDutyActivity([
    { actor_id: "staff-1", type: "checkout" },
    { actor_id: "staff-1", type: "checkout" },
    { actor_id: "staff-1", type: "restock" },
    { actor_id: "staff-1", type: "waste" },
    { actor_id: "staff-1", type: "unknown" },
  ]),
  { checkout: 2, restock: 1, waste: 1 }
);

const unsuccessfulLogin = buildDutyRoster({
  staff,
  logins: [{ ...logins[0], outcome: "failed" }],
  faceVerifications: [],
  faceResetEvents: [],
  transactions: [],
});
assert.equal(unsuccessfulLogin.length, 0);

const day = cafeDayRange(new Date("2026-11-07T16:30:00.000Z"));
assert.deepEqual(day, {
  day: "2026-11-08",
  start: "2026-11-07T16:00:00.000Z",
  end: "2026-11-08T16:00:00.000Z",
});

console.log("PASS duty roster aggregates staff sign-in, face verification, and inventory actions");
console.log("PASS failed sign-ins do not appear in the roster");
console.log("PASS staff activity counts checkout, restock, and waste transactions separately");
console.log("PASS cafe-day boundaries use the Manila calendar day");
