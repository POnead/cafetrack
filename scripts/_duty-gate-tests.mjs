/**
 * Legacy duty checks stay disabled; staff login verification uses its own switch.
 *
 *   npm run dev:test       (terminal 1)
 *   npm run test:duty-gate (terminal 2)
 *
 * ## What this suite exists to prove
 *
 * The legacy duty setting must not force staff into `/verify` or block stock
 * routes. The separate login setting controls whether password entry creates a
 * face-check ticket or a normal session.
 *
 * The three steps below are that sentence in order:
 *
 *   1. With the login check off, password sign-in succeeds even if the old duty
 *      setting is on, and stock routes do not return a duty-check refusal.
 *   2. With the login check on, password sign-in returns a ticket and no session,
 *      even if the old duty setting is off.
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

/** Return the password-step result without assuming a session was created. */
async function passwordSignIn(staff) {
  const response = await fetch(`${BASE}/api/auth/staff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: staff.username, password: staff.password }),
  });
  const body = await json(response);
  const cookie = cookieOf(response);
  return { response, body, cookie };
}

/** Password sign-in creates a session when no face check is currently due. */
async function staffSession(staff) {
  const { response, body, cookie } = await passwordSignIn(staff);
  if (!cookie.includes("cafetrack_session")) {
    throw new Error(`password sign-in failed: ${response.status} ${JSON.stringify(body)}`);
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

  section("login face check is independent from legacy duty verification");

  ok("duty verification is switched on", (await patchSetting("face_verification_enabled", "1")).status === 200);
  ok("the login face check is off", (await patchSetting("face_login_enabled", "0")).status === 200);

  staff = await makeStaff();
  const enrolled = await enrollFace(staff, storedFace);
  ok("the fixture enrolled a face", enrolled.status === 200, `got ${enrolled.status}`);

  const passwordOnly = await passwordSignIn(staff);
  ok("turning the login face check off allows password sign-in", passwordOnly.cookie.includes("cafetrack_session"));
  ok("the duty setting does not trigger the login face scan", passwordOnly.body?.step2_required !== true);

  ok("duty verification can be off independently", (await patchSetting("face_verification_enabled", "0")).status === 200);
  ok("the login face check can be turned on", (await patchSetting("face_login_enabled", "1")).status === 200);
  const faceLogin = await passwordSignIn(staff);
  ok("the enabled login check requires the automatic face scan", faceLogin.body?.step2_required === true);
  ok("password alone does not create a session when login face check is on", !faceLogin.cookie.includes("cafetrack_session"));
  const preflight = await post(
    "/api/auth/staff/confirm",
    { ticket: faceLogin.body?.ticket, preflight: true },
    ""
  );
  const preflightBody = await json(preflight);
  ok("the login face scan is required even with duty verification off", preflight.status === 200 && preflightBody?.face_required === true);
  ok("preflight cannot issue a staff session before the face scan", !cookieOf(preflight).includes("cafetrack_session"));

  ok("turning off the login face check bypasses the scan", (await patchSetting("face_login_enabled", "0")).status === 200);
  ok("duty verification can still be enabled separately", (await patchSetting("face_verification_enabled", "1")).status === 200);
  const cookie = await staffSession(staff);
  ok("password sign-in is controlled by the login face setting, not duty check", Boolean(cookie));

  const status = await json(
    await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })
  );
  ok("the legacy duty setting does not report a required check", status?.face?.required === false);

  const readOk = await fetch(`${BASE}/api/transactions?limit=1`, { headers: { Cookie: cookie } });
  ok("reading movements is allowed", readOk.status === 200, `got ${readOk.status}`);

  const initialWrite = await post("/api/transactions", { type: "nope" }, cookie);
  ok("stock routes are not blocked by the legacy duty setting", initialWrite.status === 400, `got ${initialWrite.status}`);

  /* ---------------------------------------------------------------- */

  section("re-enrolling does not turn the legacy duty gate back on");

  /*
   * A new reference photo is not permission to re-enable the removed post-login
   * duty gate. Login face checks remain controlled by their dedicated setting.
   */
  const reEnrolled = await enrollFace(staff, storedFace);
  ok("re-enrolling is accepted", reEnrolled.status === 200, `got ${reEnrolled.status}`);

  const owed = await post("/api/transactions", { type: "nope" }, cookie);
  ok("moving stock reaches route validation, not a duty-face refusal", owed.status === 400, `got ${owed.status}`);

  const owedItem = await post("/api/items", { name: "Gate Probe Item" }, cookie);
  ok("catalogue routes are not blocked by the legacy duty setting", owedItem.status === 400, `got ${owedItem.status}`);

  const stillReads = await fetch(`${BASE}/api/transactions?limit=1`, { headers: { Cookie: cookie } });
  ok("reading movements remains allowed", stillReads.status === 200, `got ${stillReads.status}`);

  /* ---------------------------------------------------------------- */

  section("an admin is never gated");

  const adminWrite = await post("/api/transactions", { type: "nope" }, admin);
  ok(
    "an admin passes the gate and fails on the body instead",
    adminWrite.status === 400,
    `got ${adminWrite.status}`
  );

  /* ---------------------------------------------------------------- */

  section("the old duty setting cannot force a face scan at the next sign-in");

  const nextCookie = await staffSession(staff);
  ok("password sign-in still succeeds with login face check off", Boolean(nextCookie));
  const nextStatus = await json(
    await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: nextCookie } })
  );
  ok("the old duty setting still does not require /verify", nextStatus?.face?.required === false);

  /* ---------------------------------------------------------------- */

  section("the login face-check setting is editable");

  const faceLoginSetting = await patchSetting("face_login_enabled", "1");
  ok("the login face-check option can be enabled", faceLoginSetting.status === 200);
  const faceLoginStatus = await json(await fetch(`${BASE}/api/auth/face-login`));
  ok("the face-login endpoint reports enabled", faceLoginStatus?.enabled === true);
  const loginOff = await patchSetting("face_login_enabled", "0");
  ok("the login face-check option can be disabled", loginOff.status === 200);

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
  /* Leave the shared isolated database as it was found for later suites. */
  if (staff) {
    await fetch(`${BASE}/api/users/${staff.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin },
      body: JSON.stringify({ is_active: false, deactivation_reason: "duty gate suite" }),
    }).catch(() => {});
  }
  await patchSetting("face_verification_enabled", before.face_verification_enabled ?? "0").catch(() => {});
  await patchSetting("face_login_enabled", before.face_login_enabled ?? "0").catch(() => {});
  await patchSetting("face_duty_hours", before.face_duty_hours ?? "9").catch(() => {});
  await patchSetting("face_require_profile_angles", before.face_require_profile_angles ?? "1").catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
