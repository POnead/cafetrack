/**
 * The duty check is a gate on the server, not a screen.
 *
 *   npm run dev:test       (terminal 1)
 *   npm run test:duty-gate (terminal 2)
 *
 * ## What this suite exists to prove
 *
 * The feature's whole claim is "you cannot move stock until you have shown your
 * face". A redirect in the browser cannot make that true: `/api/transactions` is
 * one fetch away. So the assertion that matters is not that the verify screen
 * appears â€” it is that the *routes* refuse a session that still owes a check,
 * and then stop refusing once the check has happened.
 *
 * The three steps below are that sentence in order:
 *
 *   1. A live staff session, inside the app, with a check owed, is refused a
 *      `403` by every route that moves stock or changes the catalogue â€” and is
 *      still allowed to read.
 *   2. The refusal is the duty message, not a permission error, so the shell can
 *      send the person to the camera rather than to their manager.
 *   3. An admin override opens the window, and the *same session* gets through.
 *
 * ## Why re-enrolling is what makes a check owed
 *
 * There is no "expire the window now" endpoint, and adding one for a test would
 * be a hole. Enrolment already does the job on purpose: a fresh photograph is
 * not a pass, so it clears `last_face_verified_at` (see the comment in the
 * enrolment route). That is exactly the mid-shift state this suite needs â€” a
 * session that was fine a moment ago and is not any more.
 *
 * ## The fixtures
 *
 * Synthetic unit vectors, enrolled through the same route the admin UI uses.
 * No camera and no model, and the vectors are mathematically the same problem:
 * a stored descriptor and a presented one. The face itself is `test:face`,
 * `test:sface` and `test:angles`' business.
 */

import { assertTestTarget } from "./_guard.mjs";

const BASE = process.env.BASE_URL || "http://localhost:3101";
const ADMIN = { username: "admin", password: "admin123" };

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n--- ${title}`);
}

function cookieOf(res) {
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** A deterministic unit vector: any two seeds are different people. */
function unitVector(seed) {
  const raw = Array.from({ length: 128 }, (_, i) => Math.sin(i * seed));
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

async function tinyPngBlob() {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return new Blob([bytes], { type: "image/png" });
}

async function adminCookie() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const cookie = cookieOf(res);
  if (!cookie.includes("cafetrack_session")) {
    throw new Error(`admin sign-in failed: ${res.status} ${await res.text()}`);
  }
  return cookie;
}

async function makeStaff() {
  const username = `gate${Date.now().toString(36).slice(-6)}`;
  const password = "gatepass123";
  const res = await fetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: admin },
    body: JSON.stringify({ username, full_name: "Gate Probe", password }),
  });
  const body = await json(res);
  if (!res.ok) throw new Error(`staff fixture failed: ${res.status} ${body?.error ?? ""}`);
  return { id: body.user?.id ?? body.id, username, password };
}

/**
 * Enrol the three angles the route requires.
 *
 * The sides are distinct vectors purely so the account is a normal three-angle
 * enrolment; this suite never presents them. No `signal_*` fields are sent, so
 * the pose-band checks stay out of the way â€” those are `test:angles`.
 */
async function enrollFace(staff, front) {
  const form = new FormData();
  for (const [pose, embedding] of [
    ["front", front],
    ["left", unitVector(2)],
    ["right", unitVector(3)],
  ]) {
    form.set(`embedding_${pose}`, embedding.join(","));
    form.set(`image_${pose}`, await tinyPngBlob(), `${pose}.png`);
  }
  return fetch(`${BASE}/api/users/${staff.id}/face`, {
    method: "POST",
    headers: { Cookie: admin },
    body: form,
  });
}

/** Step one and step two, with the face the account has on file. */
async function staffSession(staff, embedding) {
  const step1 = await fetch(`${BASE}/api/auth/staff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: staff.username, password: staff.password }),
  });
  const ticket = (await json(step1))?.ticket;
  if (!ticket) throw new Error(`step one failed for ${staff.username}: ${step1.status}`);

  const step2 = await fetch(`${BASE}/api/auth/staff/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, face_embedding: embedding }),
  });
  const cookie = cookieOf(step2);
  if (!cookie.includes("cafetrack_session")) {
    throw new Error(`step two failed: ${step2.status} ${await step2.text()}`);
  }
  return cookie;
}

async function patchSetting(key, value) {
  return fetch(`${BASE}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: admin },
    body: JSON.stringify({ [key]: value }),
  });
}

async function settings() {
  return (await json(await fetch(`${BASE}/api/settings`, { headers: { Cookie: admin } })))
    ?.settings ?? {};
}

const post = (path, body, cookie) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

/* ================================================================== */

await assertTestTarget(BASE);

const admin = await adminCookie();
const before = await settings();
const storedFace = unitVector(1);

let staff = null;

try {
  /* ---------------------------------------------------------------- */

  section("a staff member with a check owed");

  ok("face verification is switched on", (await patchSetting("face_verification_enabled", "1")).status === 200);

  staff = await makeStaff();
  const enrolled = await enrollFace(staff, storedFace);
  ok("the fixture enrolled a face", enrolled.status === 200, `got ${enrolled.status}`);

  // Signing in passes the check and opens a window, as it should.
  const cookie = await staffSession(staff, storedFace);
  ok("the staff member can sign in", Boolean(cookie));

  const readOk = await fetch(`${BASE}/api/transactions?limit=1`, { headers: { Cookie: cookie } });
  ok("reading movements is allowed", readOk.status === 200, `got ${readOk.status}`);

  /* ---------------------------------------------------------------- */

  section("a fresh photograph is not a pass");

  /*
   * The state the feature is about: the person is signed in, the account has a
   * face, and the duty window is not open â€” because the photo they are checked
   * against is newer than the last time they looked at the camera.
   */
  const reEnrolled = await enrollFace(staff, storedFace);
  ok("re-enrolling is accepted", reEnrolled.status === 200, `got ${reEnrolled.status}`);

  const owed = await post("/api/transactions", { type: "nope" }, cookie);
  const owedBody = await json(owed);
  ok("moving stock is refused", owed.status === 403, `got ${owed.status}`);
  ok(
    "and the refusal is the duty message, not a permission error",
    /Confirm your face for this duty/.test(owedBody?.error ?? ""),
    owedBody?.error
  );

  const owedItem = await post("/api/items", { name: "Gate Probe Item" }, cookie);
  ok("adding an ingredient is refused", owedItem.status === 403, `got ${owedItem.status}`);

  const stillReads = await fetch(`${BASE}/api/transactions?limit=1`, { headers: { Cookie: cookie } });
  ok("reading is still allowed while a check is owed", stillReads.status === 200, `got ${stillReads.status}`);

  /* ---------------------------------------------------------------- */

  section("an admin is never gated");

  const adminWrite = await post("/api/transactions", { type: "nope" }, admin);
  ok(
    "an admin passes the gate and fails on the body instead",
    adminWrite.status === 400,
    `got ${adminWrite.status}`
  );

  /* ---------------------------------------------------------------- */

  section("the override opens the window for the same session");

  const override = await fetch(`${BASE}/api/users/${staff.id}/face`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: admin },
    body: JSON.stringify({ reason: "duty gate suite" }),
  });
  ok("the override is accepted", override.status === 200, `got ${override.status}`);

  const afterOverride = await post("/api/transactions", { type: "nope" }, cookie);
  ok(
    "the same session now reaches the body validation",
    afterOverride.status === 400,
    `got ${afterOverride.status}`
  );

  const itemAfter = await post("/api/items", { name: "" }, cookie);
  ok(
    "and adding an ingredient reaches its own validation too",
    itemAfter.status === 400,
    `got ${itemAfter.status}`
  );

  /* ---------------------------------------------------------------- */

  section("the turned-head switch exists and is a switch");

  const off = await patchSetting("face_require_profile_angles", "0");
  ok("it can be turned off", off.status === 200, `got ${off.status}`);
  ok("and reads back off", (await settings()).face_require_profile_angles === "0");

  const back = await patchSetting("face_require_profile_angles", "1");
  ok("and back on", back.status === 200, `got ${back.status}`);
  ok("and reads back on", (await settings()).face_require_profile_angles === "1");

  const nonsense = await patchSetting("face_require_profile_angles", "banana");
  ok("a non-boolean value is refused", nonsense.status === 400, `got ${nonsense.status}`);
} finally {
  /*
   * Leave the shared isolated database as it was found. Every later suite in
   * `test:all` runs against the same one, and duty verification left switched on
   * would refuse `test:journeys` its staff sessions for reasons that have
   * nothing to do with what it is testing.
   */
  if (staff) {
    await fetch(`${BASE}/api/users/${staff.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin },
      body: JSON.stringify({ is_active: false, deactivation_reason: "duty gate suite" }),
    }).catch(() => {});
  }
  await patchSetting("face_verification_enabled", before.face_verification_enabled ?? "0").catch(() => {});
  await patchSetting("face_duty_hours", before.face_duty_hours ?? "9").catch(() => {});
  await patchSetting("face_require_profile_angles", before.face_require_profile_angles ?? "1").catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

