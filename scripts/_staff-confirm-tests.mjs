/**
 * Tests for the second step of staff sign-in.
 *
 *   npm run dev:test           (terminal 1)
 *   npm run test:staff-confirm (terminal 2)
 *
 * ## Why this suite exists separately from test:id-login
 *
 * That one covers the old card-plus-face route, which answers the question "which
 * account is this?" from a card. This route does not ask it: the password already
 * named the account, so the assertions here are about a *known* user and what
 * happens when the wrong thing is put in front of them. Different question,
 * different route, different failure modes.
 *
 * ## The three properties worth the whole file
 *
 *   1. A password alone is not a login. No cookie is issued, and the ticket the
 *      password returns cannot be used as one.
 *   2. A ticket is single use. Winning with it burns it.
 *   3. A ticket cannot survive being presented to the session reader.
 *
 * The rest is ordinary: wrong face, card-only and ID-portrait bypass attempts,
 * retries on a live ticket, and an account with no second factor.
 *
 * The isolated dev server requires the second step by default. Do not start it
 * with CAFETRACK_TEST_BYPASS_STEP2=1 when running this suite.
 */

import { patternPngBlob } from "./_pattern-png.mjs";

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

/** A staff account with a known password and no second factor enrolled. */
async function makeStaff(password = "step2pass123") {
  const adminRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = cookieOf(adminRes);
  if (!adminCookie) throw new Error(`admin login failed: ${adminRes.status}`);

  const username = `s2${Date.now().toString(36).slice(-6)}`;

  const res = await fetch(`${BASE}/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ username, full_name: "Step Two Probe", password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`fixture creation failed: ${body?.error ?? res.status}`);

  return { username, password, id: body.user?.id ?? body.id };
}

/** Step one. Returns the whole response so the cookie can be inspected too. */
async function passwordStep(staff) {
  const res = await fetch(`${BASE}/api/auth/staff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: staff.username, password: staff.password }),
  });
  const body = await res.json();

  /*
   * Fail here rather than letting `undefined` travel onward.
   *
   * Step one refuses for reasons that have nothing to do with the ticket — an ID
   * gate on an unverified account, a throttle — and the first symptom is always
   * downstream, in confirm(), as "that sign-in attempt has expired". That points
   * the investigation at the ticket code when the cause was three lines earlier.
   */
  if (res.status !== 200 || !body?.ticket) {
    throw new Error(
      `password step failed for ${staff.username}: ${res.status} ${body?.error ?? "(no error)"}`
    );
  }

  return { res, body, cookie: cookieOf(res) };
}

async function confirm(ticket, extra = {}) {
  const res = await fetch(`${BASE}/api/auth/staff/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, ...extra }),
  });
  return { res, body: await res.json(), cookie: cookieOf(res) };
}

async function enrollFace(adminCookie, staff, front, left = wrongFace) {
  const form = new FormData();
  for (const [pose, embedding] of [
    ["front", front],
    ["left", left],
    ["right", unitVector(3)],
  ]) {
    form.set(`embedding_${pose}`, embedding.join(","));
    form.set(`image_${pose}`, await tinyPngBlob(), `${pose}.png`);
  }
  return fetch(`${BASE}/api/users/${staff.id}/face`, {
    method: "POST",
    headers: { Cookie: adminCookie },
    body: form,
  });
}

/**
 * A card-only account and independent accounts with enrolled faces.
 *
 * The face fixtures use the same enrollment route as the admin UI with synthetic
 * vectors and tiny images, so the confirmation route can test both positive and
 * negative decisions without a camera. Separate accounts keep intentional
 * mismatch tests from exhausting the per-account retry throttle.
 */
async function makeStaffWithFactors() {
  // Keep the card-only and face-only accounts separate so one factor cannot
  // accidentally mask a failure in the other's checks.
  const cardOnly = await makeStaff();
  const faceOnly = await makeStaff();
  const sideFaceOnly = await makeStaff();
  const borderlineFaceOnly = await makeStaff();
  const otherFaceOnly = await makeStaff();

  const cardAdmin = cookieOf(
    await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN),
    })
  );
  const settingsRes = await fetch(`${BASE}/api/settings`, {
    headers: { Cookie: cardAdmin },
  });
  const settingsBody = await settingsRes.json();
  const engine = settingsBody?.settings?.face_engine === "sface" ? "sface" : "legacy";

  /*
   * A card hash of 16 hex chars is a well-formed 64-bit dHash, and the route
   * stores exactly what the form carries — it does not re-derive one from the
   * image, so the uploaded picture is irrelevant to this value.
   *
   * Deliberately NOT "0123456789abcdef". That is HASH_A in
   * _id-verification-tests.mjs, and it was the first thing anyone would reach
   * for. Sharing it means test:id's "the duplicate check ran and found nothing"
   * fails against a row this suite left behind, reporting a match at 0 of 64 —
   * a collision created by nothing more than two fixtures picking the same
   * memorable string.
   *
   * Any value at least DUPLICATE_DISTANCE bits from HASH_A, HASH_A_AGAIN and
   * HASH_B works. This one differs from all three in every position.
   */
  const storedCard = "a1b2c3d4e5f60718";

  const cardForm = new FormData();
  cardForm.set("card_hash", storedCard);
  cardForm.set("doc_type", "other");
  /*
   * The structured pattern, not the 1x1 above.
   *
   * Note what this does *not* do: it does not affect the stored fingerprint,
   * because card_hash is supplied explicitly above and the route stores that
   * rather than re-deriving one. It is here so the fixture uploads something
   * with structure, which is what a real card looks like, and so the duplicate
   * signal this upload raises is computed from a real image rather than a
   * single pixel.
   */
  cardForm.set("front", patternPngBlob(), "card.png");

  const card = await fetch(`${BASE}/api/users/${cardOnly.id}/id`, {
    method: "POST",
    headers: { Cookie: cardAdmin },
    body: cardForm,
  });

  const foreignFace = unitVector(4);
  const face = await enrollFace(cardAdmin, faceOnly, storedFace);
  const sideFace = await enrollFace(cardAdmin, sideFaceOnly, storedFace);
  const borderlineFace = await enrollFace(cardAdmin, borderlineFaceOnly, storedFace);
  const otherFace = await enrollFace(cardAdmin, otherFaceOnly, foreignFace, unitVector(5));

  /*
   * Approve the card.
   *
   * Uploading a document sets verification_status back to 'unverified', and when
   * the ID gate is switched on — which test:id leaves it — an unverified account
   * is refused at *step one*, before any ticket exists. The symptom from here is
   * baffling: confirm() is handed `undefined` and answers "that sign-in attempt
   * has expired", so the suite blames the ticket rather than the gate.
   *
   * Approving is also what an admin actually does after reading a card, so this
   * is the realistic state rather than a workaround.
   */
  const approve = await fetch(`${BASE}/api/users/${cardOnly.id}/id`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cardAdmin },
    body: JSON.stringify({ decision: "approve", reason: "step2 fixture" }),
  });

  return {
    cardOnly: { ...cardOnly, storedCard },
    faceOnly,
    sideFaceOnly,
    borderlineFaceOnly,
    otherFaceOnly,
    foreignFace,
    engine,
    adminCookie: cardAdmin,
    cardStatus: card.status,
    faceStatus: face.status,
    sideFaceStatus: sideFace.status,
    borderlineFaceStatus: borderlineFace.status,
    otherFaceStatus: otherFace.status,
    approveStatus: approve.status,
  };
}

/**
 * Unit-normalised, because parseEmbedding rejects a vector outside [0.5, 2].
 *
 * That range exists because real face descriptors are unit length, so an
 * embedding of norm 40 is a sign the numbers were mangled in transit rather than
 * a face. It also means a fixture cannot use an arbitrary ramp: sin(i)/2 has a
 * norm of about 5.6 and is refused as malformed, which looks exactly like a
 * broken enrolment and is not one.
 *
 * Normalising here makes these behave like what they stand in for.
 */
function unitVector(seed) {
  const raw = Array.from({ length: 128 }, (_, i) => Math.sin(i * seed));
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

/** Stored against `faceOnly`; sent back verbatim to prove the face path matches. */
const storedFace = unitVector(1);

/** Deliberately different from `storedFace`, so the comparison has to refuse it. */
const wrongFace = unitVector(7);

function atCosineDistance(unit, distance) {
  const index = unit.reduce(
    (best, value, i, values) => Math.abs(value) < Math.abs(values[best]) ? i : best,
    0
  );
  const basis = unit.map((value, i) => (i === index ? 1 : 0) - unit[index] * value);
  const norm = Math.hypot(...basis);
  const orthogonal = basis.map((value) => value / norm);
  const cosine = 1 - distance;
  const sine = Math.sqrt(1 - cosine * cosine);
  return unit.map((value, i) => cosine * value + sine * orthogonal[i]);
}
/**
 * A flat image for the *face* enrolment, which never looks at fingerprints.
 *
 * 1x1 is fine here and is the smallest thing that passes the type and size
 * checks in lib/face-image.ts.
 */
async function tinyPngBlob() {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  return new Blob([bytes], { type: "image/png" });
}

/* ================================================================== */

section("step one is not a login");

const staff = await makeStaff();
const step1 = await passwordStep(staff);

ok("the password is accepted", step1.res.status === 200, `got ${step1.res.status}`);
ok("the route says step two is owed", step1.body?.step2_required === true);
ok("a ticket comes back", typeof step1.body?.ticket === "string" && step1.body.ticket.length > 40);
ok("NO session cookie is issued", !step1.cookie.includes("cafetrack_session"), step1.cookie);

{
  // The decisive one. If this returns 200 the second factor is decorative.
  const res = await fetch(`${BASE}/dashboard`, {
    headers: { Cookie: `cafetrack_session=${step1.body.ticket}` },
    redirect: "manual",
  });
  ok(
    "the ticket is refused as a session on /dashboard",
    res.status >= 300,
    `got ${res.status}, so the ticket IS a session`
  );
}

/* ================================================================== */

section("an account with no second factor on file");

{
  // The state "step two is mandatory" creates. It has to be refused, it has to
  // say *why* rather than blaming the camera, and it must not issue a cookie.
  const r = await confirm(step1.body.ticket);

  ok("an empty frame is refused", r.res.status === 403, `got ${r.res.status}`);
  ok("and issues no cookie", !r.cookie.includes("cafetrack_session"));
  ok(
    "an account with nothing on file is told so specifically",
    r.body?.no_second_factor === true,
    JSON.stringify(r.body)
  );
  ok(
    "and the message names the way out",
    typeof r.body?.error === "string" && /administrator/i.test(r.body.error),
    r.body?.error
  );
}

/* ================================================================== */
section("wrong readings are refused when the account *has* a second factor");

{
  const fx = await makeStaffWithFactors();
  ok("the card fixture stored a card", fx.cardStatus === 200, `got ${fx.cardStatus}`);
  ok("the face fixture enrolled a face", fx.faceStatus === 200, `got ${fx.faceStatus}`);
  ok("the other staff member enrolled a separate face", fx.otherFaceStatus === 200, `got ${fx.otherFaceStatus}`);

  const t1 = (await passwordStep(fx.faceOnly)).body.ticket;
  const r1 = await confirm(t1, { face_embedding: wrongFace });
  ok("a wrong face is refused", r1.res.status === 401, `got ${r1.res.status}`);
  ok("and issues no cookie", !r1.cookie.includes("cafetrack_session"));

  const tForeign = (await passwordStep(fx.faceOnly)).body.ticket;
  const foreign = await confirm(tForeign, { face_embedding: fx.foreignFace });
  ok("another staff member's enrolled face cannot authorize this account", foreign.res.status === 401, `got ${foreign.res.status}`);
  ok("and the cross-account face issues no cookie", !foreign.cookie.includes("cafetrack_session"));

  const tSide = (await passwordStep(fx.sideFaceOnly)).body.ticket;
  const sideOnly = await confirm(tSide, { face_embedding: wrongFace });
  ok("a face matching only this account's side sample is refused", sideOnly.res.status === 401, `got ${sideOnly.res.status}`);

  const borderlineDistance = fx.engine === "sface" ? 0.14 : 0.04;
  const borderline = atCosineDistance(storedFace, borderlineDistance);
  const tBorderline = (await passwordStep(fx.borderlineFaceOnly)).body.ticket;
  const borderlineResult = await confirm(tBorderline, { face_embedding: borderline });
  ok("a borderline face distance is refused", borderlineResult.res.status === 401, `engine ${fx.engine}, got ${borderlineResult.res.status}`);

  const thresholdKey =
    fx.engine === "sface" ? "face_match_threshold_sface" : "face_match_threshold";
  const aboveLimit = fx.engine === "sface" ? 0.101 : 0.034;
  const thresholdUpdate = await fetch(`${BASE}/api/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: fx.adminCookie,
    },
    body: JSON.stringify({ [thresholdKey]: aboveLimit }),
  });
  ok("the settings API rejects thresholds above the security ceiling", thresholdUpdate.status === 400, `got ${thresholdUpdate.status}`);

  const t2 = (await passwordStep(fx.cardOnly)).body.ticket;
  const r2 = await confirm(t2, { card_hash: fx.cardOnly.storedCard });
  ok("a card on file cannot replace an enrolled face", r2.res.status === 403, `got ${r2.res.status}`);
  ok("the account is told to enroll a face", r2.body?.no_face === true, JSON.stringify(r2.body));
  ok("and the card check issues no cookie", !r2.cookie.includes("cafetrack_session"));

  const t3 = (await passwordStep(fx.faceOnly)).body.ticket;
  const r3 = await confirm(t3, { face_embedding: "not a vector", card_hash: 42 });
  ok("malformed face readings are refused", r3.res.status === 401, `got ${r3.res.status}`);

  const t4 = (await passwordStep(fx.faceOnly)).body.ticket;
  const r4 = await confirm(t4);
  ok("an empty frame against an enrolled account is a plain refusal", r4.res.status === 401, `got ${r4.res.status}`);
  ok("and is not confused with the no-second-factor case", r4.body?.no_second_factor !== true);
}

/* ================================================================== */

section("a wrong face cannot pass by matching the ID portrait");

{
  const own = await makeStaffWithFactors();

  /*
   * The exact hole this suite exists to keep shut.
   *
   * Step two used to compare the live frame against the portrait on the account's
   * ID card at `id_face_match_threshold` — 0.55 by default, because a printed
   * portrait is a much harder comparison than two live photographs. At that
   * distance almost every face is "the same person", so a colleague standing at
   * the till could satisfy the step with the password holder's own card portrait
   * as the reference.
   *
   * 0.3 is well inside the old 0.55 acceptance and well outside every genuine
   * band, so this is the reading that used to mint a session. The enrolled face
   * now has to match on its own, and this must be a refusal.
   */
  const impostor = atCosineDistance(storedFace, 0.3);

  const t = (await passwordStep(own.faceOnly)).body.ticket;
  const r = await confirm(t, {
    face_embedding: impostor,
    // The reference vector a browser would have computed from the card on file.
    id_face_embedding: storedFace,
    card_hash: own.cardOnly.storedCard,
  });

  ok("a face that only matches the ID portrait is refused", r.res.status === 401, `got ${r.res.status}`);
  ok("and issues no cookie", !r.cookie.includes("cafetrack_session"));
  ok("and the ID portrait is never reported as the factor", r.body?.matched_by !== "face");
}

{
  const own = await makeStaffWithFactors();
  const t = (await passwordStep(own.faceOnly)).body.ticket;
  const mismatch = await confirm(t, { face_embedding: wrongFace });
  ok("a wrong enrolled-face attempt can be retried", mismatch.res.status === 401, `got ${mismatch.res.status}`);

  const retry = await confirm(t, { face_embedding: storedFace });
  ok("the correct enrolled face succeeds on the same live ticket", retry.res.status === 200, `got ${retry.res.status}`);
  ok("and the match is reported as the enrolled face", retry.body?.matched_by === "face", JSON.stringify(retry.body));
  ok("a session cookie is issued after the retry", retry.cookie.includes("cafetrack_session"));
}

/* ================================================================== */

section("tickets are superseded, not just spent");

{
  const own = await makeStaffWithFactors();

  const t = (await passwordStep(own.faceOnly)).body.ticket;
  const first = await confirm(t, { face_embedding: wrongFace });
  ok("a wrong face on a live ticket is refused", first.res.status === 401, `got ${first.res.status}`);

  const fresh = (await passwordStep(own.faceOnly)).body.ticket;
  ok("a new password step issues a different ticket", fresh !== t);

  /*
   * The old ticket is now dead, and not because anyone spent it: the second
   * password step overwrote the nonce on the row. Restarting after giving up has
   * to invalidate the attempt it replaces, or two live tickets could circulate
   * for one account at once.
   */
  const stale = await confirm(t, { face_embedding: storedFace });
  ok("a superseded ticket is refused", stale.res.status === 401, `got ${stale.res.status}`);
  ok("even with the correct face", stale.body?.no_second_factor !== true);
  ok(
    "and says so as an expiry, not as a bad face",
    /expired/i.test(stale.body?.error ?? ""),
    stale.body?.error
  );
  ok("and marks the ticket as expired", stale.body?.expired === true, JSON.stringify(stale.body));
}


section("rubbish tickets");

{
  for (const bad of ["", "nonsense", "a.b.c", `${step1.body.ticket}tampered`]) {
    const r = await confirm(bad, { face_embedding: wrongFace });
    ok(`a bad ticket is refused: ${JSON.stringify(bad.slice(0, 18))}`, r.res.status === 401, `got ${r.res.status}`);
  }
}

{
  // A session cookie is not a ticket, in this direction too.
  const adminRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminToken = (adminRes.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0].split("=")[1])
    .find((v) => v);

  if (adminToken) {
    const r = await confirm(adminToken, { face_embedding: wrongFace });
    ok("a session token is refused as a ticket", r.res.status === 401, `got ${r.res.status}`);
  }
}

/* ================================================================== */

section("a deactivated account cannot finish");

{
  const doomed = await makeStaff();

  const adminRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = cookieOf(adminRes);

  // `deactivation_reason`, not `reason`. The route requires one, and the field it
  // reads is this one — the shorter name is silently ignored, the account stays
  // active, and the assertion below fails for a reason that has nothing to do
  // with the route under test.
  const patch = await fetch(`${BASE}/api/users/${doomed.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ is_active: false, deactivation_reason: "step2 probe" }),
  });
  ok("the fixture could be deactivated", patch.status === 200, `got ${patch.status}`);

  /*
   * A raw call, not passwordStep().
   *
   * That helper throws on anything but a 200-with-ticket, precisely so a refusal
   * surfaces here rather than three tests later as a mysterious "expired". This
   * section is the one place where a refusal is the thing being asserted, so it
   * has to bypass the guard to observe it.
   */
  const res = await fetch(`${BASE}/api/auth/staff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: doomed.username, password: doomed.password }),
  });
  const body = await res.json();
  const cookie = cookieOf(res);

  // Deactivation is caught in step one, before a ticket is even issued.
  ok("step one refuses a deactivated account", res.status === 403, `got ${res.status}`);
  ok("and issues no ticket", !body?.ticket);
  ok("and issues no cookie", !cookie.includes("cafetrack_session"));
}

/* ================================================================== */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);