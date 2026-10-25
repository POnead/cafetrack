/**
 * Three-angle face enrolment and the presentations that follow from it.
 *
 *   npm run dev:test        (terminal 1)
 *   npm run test:angles     (terminal 2)
 *
 * No camera and no model: the embeddings a browser would compute are made here,
 * and the suite drives the routes the way the capture screens do. What it covers
 * is the part the pure tests in `test:face` cannot — that the routes store three
 * angles, refuse a frame filed under the wrong one, and require exactly the
 * angles an account holds.
 *
 * The accounts it creates are deleted at the end, and the one setting it changes
 * is put back.
 */
import { assertTestTarget } from "./_guard.mjs";

const BASE = process.env.BASE_URL || "http://localhost:3101";

/* ---------------- fixtures ---------------- */

/** A 1x1 greyscale JPEG. Real bytes, so the magic-byte sniffer agrees. */
const TINY_JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDX0Hyw5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
  ),
  (c) => c.charCodeAt(0)
);

function file(bytes, name, type) {
  return new File([bytes], name, { type });
}

/**
 * A deterministic unit-length embedding.
 *
 * Unit length matters: parseEmbedding refuses a vector whose norm falls outside
 * 0.5-2, and a vector of 128 tiny numbers is exactly the "128 floats with no
 * face behind them" that guard exists for.
 */
function embedding(seed) {
  let state = seed >>> 0;
  const raw = [];
  let sum = 0;
  for (let i = 0; i < 128; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const v = ((state >>> 0) / 0xffffffff) * 2 - 1;
    raw.push(v);
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  return raw.map((v) => v / norm);
}

const PERSON = embedding(101);
const STRANGER = embedding(202);

/* ---------------- plumbing ---------------- */

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

async function call(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : null, headers: r.headers };
}

async function upload(path, form, cookie) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : null };
}

async function adminLogin() {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: process.env.SEED_ADMIN_USERNAME || "admin",
      password: process.env.SEED_ADMIN_PASSWORD || "admin123",
    }),
  });
  return (r.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
}

async function staffLogin(username, password) {
  const r = await fetch(BASE + "/api/auth/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return (r.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
}

/** Enrol one or more angles. `angles` is `{ pose: [embedding, signal, model?] }`. */
function faceForm(angles) {
  const form = new FormData();
  for (const [pose, [vector, signal, model]] of Object.entries(angles)) {
    form.append(`embedding_${pose}`, vector.join(","));
    if (signal !== null && signal !== undefined) form.append(`signal_${pose}`, String(signal));
    if (model) form.append(`model_${pose}`, model);
    form.append(`quality_${pose}`, "0.9");
    form.append(`image_${pose}`, file(TINY_JPEG, `${pose}.jpg`, "image/jpeg"));
  }
  return form;
}

function frame(pose, vector) {
  return { pose, embedding: vector };
}

/* ---------------- run ---------------- */

console.log("\nThree-angle faces");
await assertTestTarget(BASE);

const cookie = await adminLogin();
if (!cookie) {
  console.error("\n  Could not sign in as the seeded admin. Is the server running?\n");
  process.exit(1);
}

const uniq = Date.now().toString(36);
const created = [];

async function makeStaff(label) {
  const r = await call(
    "POST",
    "/api/users",
    {
      username: `${label}${uniq}`,
      password: "staff123",
      first_name: "Ana",
      last_name: "Dela Cruz",
      role: "staff",
    },
    cookie
  );
  const id = r.data?.user?.id;
  if (id) created.push(id);
  return id;
}

const triUser = await makeStaff("angle3");
const legacyUser = await makeStaff("angle1");
const frontOnlyUser = await makeStaff("anglef");
const strangerUser = await makeStaff("angles");

section("enrolment — three angles");

const enrolled = await upload(
  `/api/users/${triUser}/face`,
  faceForm({
    front: [PERSON, 0],
    left: [PERSON, 0.32],
    right: [PERSON, -0.32],
  }),
  cookie
);

check("three angles are accepted", enrolled.status === 200, `${enrolled.status} ${enrolled.data?.error ?? ""}`);
check(
  "and reported back in capture order",
  JSON.stringify(enrolled.data?.angles) === JSON.stringify(["front", "left", "right"]),
  JSON.stringify(enrolled.data?.angles)
);
check("the account is now enrolled", enrolled.data?.user?.face_enabled === true);

section("enrolment — a frame filed under the wrong angle is refused");

// Claiming "left" for a frame whose signal says it is straight on. This is the
// mistake an admin makes while holding a queue, and storing it would compare
// against the wrong expectation for as long as the enrolment lasts.
const wrongAngle = await upload(
  `/api/users/${frontOnlyUser}/face`,
  faceForm({
    front: [PERSON, 0],
    left: [PERSON, 0],
  }),
  cookie
);

check("a straight-on frame in the left slot is refused", wrongAngle.status === 400, `${wrongAngle.status}`);
check(
  "and the refusal names the angle",
  /left/i.test(wrongAngle.data?.error ?? ""),
  wrongAngle.data?.error ?? ""
);
check(
  "the account is not half-enrolled by it",
  (await call("GET", `/api/users/${frontOnlyUser}/face?pose=left`, undefined, cookie)).status !== 200
);

// The same account, enrolled properly with the straight-on photo only.
const frontOnly = await upload(
  `/api/users/${frontOnlyUser}/face`,
  faceForm({ front: [PERSON, 0] }),
  cookie
);
check("a straight-on photo on its own is accepted", frontOnly.status === 200, `${frontOnly.status}`);
check(
  "and the account reports one angle",
  JSON.stringify(frontOnly.data?.angles) === JSON.stringify(["front"]),
  JSON.stringify(frontOnly.data?.angles)
);

section("the stored photos are served per angle");

const leftPhoto = await fetch(`${BASE}/api/users/${triUser}/face?pose=left`, {
  headers: { cookie },
});
check("the left-turn photo is served", leftPhoto.status === 200, `${leftPhoto.status}`);
check(
  "as an image, not as JSON",
  (leftPhoto.headers.get("content-type") || "").startsWith("image/"),
  leftPhoto.headers.get("content-type") ?? ""
);

const front = await fetch(`${BASE}/api/users/${triUser}/face`, { headers: { cookie } });
check("the default is the straight-on photo", front.status === 200);

const unknownPose = await call("GET", `/api/users/${triUser}/face?pose=up`, undefined, cookie);
check("an angle that does not exist is a bad request", unknownPose.status === 400, `${unknownPose.status}`);

section("matching — the presentation the screens send");

await call("PATCH", "/api/settings", { face_login_enabled: "1" }, cookie);

const triStaffCookie = await staffLogin(`angle3${uniq}`, "staff123");
check("the staff member can sign in for the test", Boolean(triStaffCookie));

const threeFrames = await call(
  "POST",
  "/api/auth/face-login",
  {
    identifier: `angle3${uniq}`,
    face_frames: [frame("front", PERSON), frame("left", PERSON), frame("right", PERSON)],
  },
  undefined
);
check("three frames from the enrolled person are accepted", threeFrames.status === 200, `${threeFrames.status} ${threeFrames.data?.error ?? ""}`);

section("matching — a presentation missing an angle is refused");

/*
 * Each refusal uses its own account, because failed face sign-ins are throttled
 * per identifier and a suite that tripped the counter would be testing the
 * throttle instead of the thing it meant to test.
 */
const otherUser = await makeStaff("anglem");
await upload(
  `/api/users/${otherUser}/face`,
  faceForm({ front: [PERSON, 0], left: [PERSON, 0.32], right: [PERSON, -0.32] }),
  cookie
);

const missingSide = await call(
  "POST",
  "/api/auth/face-login",
  { identifier: `anglem${uniq}`, face_frames: [frame("front", PERSON)] },
  undefined
);
check("a three-angle account is not let in on the front frame alone", missingSide.status === 401, `${missingSide.status}`);

section("matching — an incomplete presentation is refused");

const stranger = await makeStaff("anglex");
await upload(
  `/api/users/${stranger}/face`,
  faceForm({ front: [PERSON, 0], left: [PERSON, 0.32], right: [PERSON, -0.32] }),
  cookie
);

const strangerFrames = await call(
  "POST",
  "/api/auth/face-login",
  {
    identifier: `anglex${uniq}`,
    face_frames: [frame("front", STRANGER), frame("left", STRANGER), frame("right", STRANGER)],
  },
  undefined
);
check("a different person is refused", strangerFrames.status === 401, `${strangerFrames.status}`);

section("re-enrolment — the previous angles do not survive it");

/*
 * Replacing a face with a straight-on photo only is a normal thing to do after a
 * change of appearance. If the old side rows survived, the account would keep
 * requiring turned-head frames captured from a face that no longer exists — so
 * the new enrolment replaces the whole set.
 */
const reEnrol = await upload(
  `/api/users/${otherUser}/face`,
  faceForm({ front: [PERSON, 0] }),
  cookie
);
check("a new straight-on photo is accepted", reEnrol.status === 200, `${reEnrol.status}`);
check(
  "and the account now reports one angle",
  JSON.stringify(reEnrol.data?.angles) === JSON.stringify(["front"]),
  JSON.stringify(reEnrol.data?.angles)
);

const staleSide = await fetch(`${BASE}/api/users/${otherUser}/face?pose=left`, {
  headers: { cookie },
});
check("the previous left-turn photo is gone", staleSide.status === 404, `${staleSide.status}`);

const afterReEnrol = await call(
  "POST",
  "/api/auth/face-login",
  { identifier: `anglem${uniq}`, face_frames: [frame("front", PERSON)] },
  undefined
);
check(
  "and the account is checked on one frame again",
  afterReEnrol.status === 200,
  `${afterReEnrol.status} ${afterReEnrol.data?.error ?? ""}`
);

section("matching — the legacy single frame still works");

const legacyEnrol = await upload(
  `/api/users/${legacyUser}/face`,
  (() => {
    const form = new FormData();
    form.append("embedding", PERSON.join(","));
    form.append("image", file(TINY_JPEG, "face.jpg", "image/jpeg"));
    return form;
  })(),
  cookie
);
check("an old-style enrolment is accepted", legacyEnrol.status === 200, `${legacyEnrol.status} ${legacyEnrol.data?.error ?? ""}`);
check(
  "and reports the one angle",
  JSON.stringify(legacyEnrol.data?.angles) === JSON.stringify(["front"]),
  JSON.stringify(legacyEnrol.data?.angles)
);

const legacyLogin = await call(
  "POST",
  "/api/auth/face-login",
  { identifier: `angle1${uniq}`, embedding: PERSON },
  undefined
);
check(
  "and an old-style single frame still signs that account in",
  legacyLogin.status === 200,
  `${legacyLogin.status} ${legacyLogin.data?.error ?? ""}`
);

section("engines — a vector from another engine is never comparable");

/*
 * The strongest form of the check: the stored vector is *byte-identical* to the
 * probe. If it matched, the engine filter is missing; if it does not, the filter
 * works. A near-miss would have been ambiguous, because "close but not close
 * enough" is also what a bad camera looks like.
 */
const crossUser = await makeStaff("anglee");
await upload(
  `/api/users/${crossUser}/face`,
  faceForm({ front: [PERSON, 0, "sface"] }),
  cookie
);

const crossProbe = await call(
  "POST",
  "/api/auth/face-login",
  { identifier: `anglee${uniq}`, embedding: PERSON },
  undefined
);
check(
  "an sface vector does not match a legacy check, even with identical numbers",
  crossProbe.status === 401,
  `${crossProbe.status}`
);

section("migration — an account can hold both engines at once");

/*
 * The whole point of putting the engine in the unique key. A person is
 * re-photographed under the new engine while the cafe still verifies with the
 * old one, and both sets of rows survive: they keep working under the old
 * setting, and are ready for the switch. If the second enrolment replaced the
 * first, this is where a cafe would discover it had locked its floor out.
 */
const bothUser = await makeStaff("angleb");
await upload(
  `/api/users/${bothUser}/face`,
  faceForm({ front: [PERSON, 0], left: [PERSON, 0.32], right: [PERSON, -0.32] }),
  cookie
);
const secondEnrol = await upload(
  `/api/users/${bothUser}/face`,
  faceForm({
    front: [PERSON, 0, "sface"],
    left: [PERSON, 0.32, "sface"],
    right: [PERSON, -0.32, "sface"],
  }),
  cookie
);
check("re-enrolling the same angles under the new engine is accepted", secondEnrol.status === 200, `${secondEnrol.status}`);
check(
  "and both engines' angles are still on the account",
  JSON.stringify(secondEnrol.data?.angles) === JSON.stringify(["front", "left", "right"]),
  JSON.stringify(secondEnrol.data?.angles)
);

const stillLegacy = await call(
  "POST",
  "/api/auth/face-login",
  {
    identifier: `angleb${uniq}`,
    face_frames: [frame("front", PERSON), frame("left", PERSON), frame("right", PERSON)],
  },
  undefined
);
check("the old engine keeps working while the cafe is still on it", stillLegacy.status === 200, `${stillLegacy.status}`);

await call("PATCH", "/api/settings", { face_engine: "sface" }, cookie);
const afterSwitch = await call(
  "POST",
  "/api/auth/face-login",
  {
    identifier: `angleb${uniq}`,
    face_frames: [frame("front", PERSON), frame("left", PERSON), frame("right", PERSON)],
  },
  undefined
);
await call("PATCH", "/api/settings", { face_engine: "legacy" }, cookie);

check("and the new engine works once the cafe switches", afterSwitch.status === 200, `${afterSwitch.status}`);

section("revoking removes every angle");

const revoked = await call("DELETE", `/api/users/${triUser}/face`, undefined, cookie);
check("the face is removed", revoked.status === 200, `${revoked.status}`);
check(
  "the audit payload names the angles that went",
  JSON.stringify(revoked.data?.angles_removed) === JSON.stringify(["front", "left", "right"]),
  JSON.stringify(revoked.data?.angles_removed)
);

const afterRevoke = await fetch(`${BASE}/api/users/${triUser}/face?pose=left`, {
  headers: { cookie },
});
check("a turned-head photo is gone afterwards", afterRevoke.status === 404, `${afterRevoke.status}`);

/* ---------------- cleanup ---------------- */

await call("PATCH", "/api/settings", { face_login_enabled: "0" }, cookie);
for (const id of created) {
  await call("DELETE", `/api/users/${id}`, undefined, cookie);
}

console.log(`\n${"-".repeat(46)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
