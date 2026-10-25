/**
 * Tests for the second step of staff sign-in.
 *
 *   npm run dev:test          (terminal 1)
 *   CAFETRACK_TEST_STEP2=1 npm run dev:test   (terminal 1)
 *   npm run test:staff-confirm                 (terminal 2)
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
 * The rest is ordinary: wrong face, wrong card, nothing at all, and the
 * "account has no second factor on file" case that mandatory step two creates.
 *
 * Needs the server running with CAFETRACK_TEST_STEP2=1, which is what makes
 * POST /api/auth/staff hand back a ticket instead of a session. Without it the
 * first assertion below fails immediately, and the rest follow.
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

/** A 128-float vector that will not match anything enrolled. */
/**
 * A staff account that has BOTH a face and a card on file.
 *
 * Needed because the fixture used above has neither, and a route that answers
 * "you have nothing to check against" before it ever looks at the reading cannot
 * be tested for what it does with a *wrong* reading. Both are inserted straight
 * into the row by PATCH /api/users, which is also what an admin's enrolment
 * writes — no camera needed, and the vector never has to be a real face because
 * nothing here is matching it against a face, only checking that a mismatch is
 * refused.
 */
async function makeStaffWithFactors() {
  const staff = await makeStaff();

  const adminRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = cookieOf(adminRes);

  // Each gets its own account, because they need different things on file: a
  // card-only fixture cannot test the face path, and a face-only one cannot test
  // the card path. Sharing one account would also let a failure in one enrolment
  // masquerade as a failure in the other.
  const cardOnly = await makeStaff();
  const faceOnly = await makeStaff();

  /*
   * Deliberately not the same username space as the rest of the suite.
   *
   * Step-two throttling is five failures per account, keyed on the username. A
   * fixture shared across sections would therefore spend its own budget during
   * the "wrong readings" section and start answering 429 halfway through the
   * positives, which is a confusing way to fail. Each section needs its own
   * account, and this helper is how they get one.
   */
  void cardOnly;
  void faceOnly;

  // Unused above; kept for the throttle explanation only.

  const cardAdmin = cookieOf(
    await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ADMIN),
    })
  );

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

  /*
   * Comma-separated text, not JSON.
   *
   * parseEmbedding treats a *string* as the text wire format and splits it on
   * commas; only a JSON array takes the array branch. Sending JSON.stringify()
   * here therefore yields components like `[-0.238` which Number() refuses, and
   * the enrolment answers 400 "the face data was missing or malformed". The JSON
   * array form is only correct for the JSON body /api/auth/staff/confirm reads.
   */
  const faceForm = new FormData();
  faceForm.set("embedding", storedFace.join(","));
  faceForm.set("image", await tinyPngBlob(), "face.png");

  const face = await fetch(`${BASE}/api/users/${faceOnly.id}/face`, {
    method: "POST",
    headers: { Cookie: cardAdmin },
    body: faceForm,
  });

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
    cardStatus: card.status,
    faceStatus: face.status,
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
const wrongCard = "f".repeat(16);



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

  const t1 = (await passwordStep(fx.faceOnly)).body.ticket;
  const r1 = await confirm(t1, { face_embedding: wrongFace });
  ok("a wrong face is refused", r1.res.status === 401, `got ${r1.res.status}`);
  ok("and issues no cookie", !r1.cookie.includes("cafetrack_session"));

  const t2 = (await passwordStep(fx.cardOnly)).body.ticket;
  const r2 = await confirm(t2, { card_hash: wrongCard });
  ok("a wrong card is refused", r2.res.status === 401, `got ${r2.res.status}`);

  const t3 = (await passwordStep(fx.cardOnly)).body.ticket;
  const r3 = await confirm(t3, { face_embedding: "not a vector", card_hash: 42 });
  ok("malformed readings are refused", r3.res.status === 401, `got ${r3.res.status}`);

  const t4 = (await passwordStep(fx.faceOnly)).body.ticket;
  const r4 = await confirm(t4);
  ok("an empty frame against an enrolled account is a plain refusal", r4.res.status === 401, `got ${r4.res.status}`);
  ok("and is not confused with the no-second-factor case", r4.body?.no_second_factor !== true);
}

/* ================================================================== */

section("the card on file signs in");

{
  /*
   * A passing case, on its own fixture. Without it the suite only proves the
   * route can say no, and a route that always says no passes every refusal
   * above.
   */
  const own = await makeStaffWithFactors();
  const t = (await passwordStep(own.cardOnly)).body.ticket;
  const r = await confirm(t, { card_hash: own.cardOnly.storedCard });

  ok("the card on file signs in", r.res.status === 200, `got ${r.res.status} ${r.body?.error ?? ""}`);
  ok("a session cookie is issued", r.cookie.includes("cafetrack_session"));
  ok("the match is reported as the card", r.body?.matched_by === "id_card", JSON.stringify(r.body));

  // The end of the whole chain: password, then card, then access.
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: r.cookie } });
  ok("the resulting cookie reads as a session", me.status === 200, `got ${me.status}`);

  // Single use, done properly now that there is a success to burn.
  const second = await confirm(t, { card_hash: own.cardOnly.storedCard });
  ok("the same ticket cannot be used twice", second.res.status === 401, `got ${second.res.status}`);
  ok("and the second attempt issues no cookie", !second.cookie.includes("cafetrack_session"));
}

/* ================================================================== */

section("the enrolled face signs in");

{
  const own = await makeStaffWithFactors();
  const t = (await passwordStep(own.faceOnly)).body.ticket;
  const r = await confirm(t, { face_embedding: storedFace });

  ok("the enrolled face signs in", r.res.status === 200, `got ${r.res.status} ${r.body?.error ?? ""}`);
  ok("a session cookie is issued", r.cookie.includes("cafetrack_session"));
  ok("the match is reported as the face", r.body?.matched_by === "face", JSON.stringify(r.body));
}

{
  /*
   * The panel sends both readings from one frame, so the route must try the
   * second even when the first is present and does not match. This is the case
   * that would break silently if the face comparison short-circuited — which is
   * exactly what a hand holding a card produces, since the portrait on an ID
   * card is often detected as a low-confidence face.
   */
  const own = await makeStaffWithFactors();
  const t = (await passwordStep(own.cardOnly)).body.ticket;
  const r = await confirm(t, {
    face_embedding: wrongFace,
    card_hash: own.cardOnly.storedCard,
  });

  ok("a wrong face does not block a good card", r.res.status === 200, `got ${r.res.status}`);
  ok("and the card is what matched", r.body?.matched_by === "id_card");
}

/* ================================================================== */

section("tickets are superseded, not just spent");

{
  const own = await makeStaffWithFactors();

  const t = (await passwordStep(own.cardOnly)).body.ticket;
  const first = await confirm(t, { card_hash: wrongCard });
  ok("a wrong card on a live ticket is refused", first.res.status === 401, `got ${first.res.status}`);

  const fresh = (await passwordStep(own.cardOnly)).body.ticket;
  ok("a new password step issues a different ticket", fresh !== t);

  /*
   * The old ticket is now dead, and not because anyone spent it: the second
   * password step overwrote the nonce on the row. Restarting after giving up has
   * to invalidate the attempt it replaces, or two live tickets could circulate
   * for one account at once.
   */
  const stale = await confirm(t, { card_hash: own.cardOnly.storedCard });
  ok("a superseded ticket is refused", stale.res.status === 401, `got ${stale.res.status}`);
  ok("even with the correct card", stale.body?.no_second_factor !== true);
  ok(
    "and says so as an expiry, not as a bad card",
    /expired/i.test(stale.body?.error ?? ""),
    stale.body?.error
  );
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