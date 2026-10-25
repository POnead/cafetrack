/**
 * End-to-end tests for signing in with an ID card and a face.
 *
 *   BASE_URL=http://localhost:3101 npm run test:id-login
 *
 * ## What these are really for
 *
 * The unit tests in _id-lookup-tests.mjs prove the lookup refuses ambiguity. What
 * they cannot prove is that the *responses* are indistinguishable — that an
 * unknown card, an unreadable card, an ambiguous card and a wrong face all return
 * the same thing. That is the property that stops this endpoint becoming a way to
 * enumerate which cards a café holds, and it is only observable over HTTP.
 *
 * So most of what follows is about the shape of the refusals, not the successes.
 *
 * ## What cannot be tested here
 *
 * A real face. The match needs a live camera and a genuine photograph, and this
 * suite posts a synthetic vector — which is enough to prove every refusal path
 * and the shape of the happy path, but not that the recognition works. The
 * existing face suites cover that half.
 */

const BASE = process.env.BASE_URL || "http://localhost:3100";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n== ${t} ==`);

/** A 1x1 PNG: valid image, no text, so OCR finds nothing and cannot match. */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

/* 128 finite floats, as the browser would send. Well-formed but meaningless, so
   it can never match a stored descriptor — which is exactly what the negative
   cases need. */
const DUMMY_EMBEDDING = Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.05);

let cookie = "";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const first = c.split(";")[0];
    if (first.startsWith("cafetrack_session=")) cookie = first;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, data };
}

function upload(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    fd.append(k, v);
  }
  return fd;
}

async function post(fields) {
  const res = await fetch(`${BASE}/api/auth/id-login`, { method: "POST", body: fields });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, data };
}

/* ------------------------------------------------------------------ set-up */

const login = await call("POST", "/api/auth/login", { username: "admin", password: "admin123" });
if (login.status !== 200) {
  console.error(`\ncould not sign in as admin (status ${login.status}) — is the server running?\n`);
  process.exit(1);
}

section("the availability probe");

const probe = await call("GET", "/api/auth/id-login");
check("the route answers a public probe", probe.status === 200, `status ${probe.status}`);
check(
  "and returns a boolean and nothing else",
  probe.data && typeof probe.data.enabled === "boolean" && Object.keys(probe.data).length === 1,
  JSON.stringify(probe.data)
);

// Switched on so the refusal paths below are reachable at all.
await call("PATCH", "/api/settings", { id_login_enabled: "1" });
const probeOn = await call("GET", "/api/auth/id-login");
check("an admin can switch it on", probeOn.data?.enabled === true, JSON.stringify(probeOn.data));

/* --------------------------------------------------------- refusals first */

section("every refusal says the same thing");

const NOT_ON_FILE = "Unrecognised ID, or that ID is not on file for any account";

{
  const r = await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") }));
  check("an unknown card is refused", r.status === 401, `status ${r.status}`);
  check("with the generic wording", r.data?.error === NOT_ON_FILE, r.data?.error);

  const noCard = await post(upload({ card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") }));
  check("no image at all is refused", noCard.status >= 400, `status ${noCard.status}`);

  const noHash = await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), face_embedding: DUMMY_EMBEDDING.join(",") }));
  check("no fingerprint is refused", noHash.status === 401, `status ${noHash.status}`);
  check("with the same wording as an unknown card", noHash.data?.error === NOT_ON_FILE, noHash.data?.error);

  const junkHash = await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "not-a-fingerprint", face_embedding: DUMMY_EMBEDDING.join(",") }));
  check("a malformed fingerprint is refused", junkHash.status === 401, `status ${junkHash.status}`);
  check("and is indistinguishable from an unknown one", junkHash.data?.error === NOT_ON_FILE, junkHash.data?.error);

  const junkFace = await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: "nonsense" }));
  check("a malformed face vector is refused", junkFace.status === 401, `status ${junkFace.status}`);
  check("and is indistinguishable too", junkFace.data?.error === NOT_ON_FILE, junkFace.data?.error);

  const emptyFace = await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef" }));
  check("no face vector is refused", emptyFace.status === 401, `status ${emptyFace.status}`);
  check("and is indistinguishable", emptyFace.data?.error === NOT_ON_FILE, emptyFace.data?.error);

  const notAnImage = await post(upload({ id_front: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") }));
  check("a file that is not an image is refused", notAnImage.status >= 400, `status ${notAnImage.status}`);
}

/*
 * The property that matters most, stated as a test: no two *identity* refusals may
 * differ. If one did, it would be a way to ask "is this card on file" one guess at
 * a time.
 *
 * Request-shape refusals are deliberately excluded from that group, and the
 * distinction is the point rather than a loophole:
 *
 *   - "no image attached" / "that file is not a JPEG" describe **what the caller
 *     sent**, not the roster. Telling someone their upload did not attach is how
 *     they find out and try again; collapsing it into "unrecognised ID" would cost
 *     a real user a shift's sign-in and buy nothing, because a caller who sends a
 *     valid image always gets the identity answer regardless.
 *
 * So there are two groups below, and each is held to its own rule.
 */
section("the identity refusals do not leak why");

{
  const identity = [
    await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") })),
    await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), face_embedding: DUMMY_EMBEDDING.join(",") })),
    await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: "nonsense" })),
    await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef" })),
    await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "ffffffffffffffff", face_embedding: DUMMY_EMBEDDING.join(",") })),
    await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "not-a-fingerprint", face_embedding: DUMMY_EMBEDDING.join(",") })),
  ];

  const messages = new Set(identity.map((c) => c.data?.error));
  const statuses = new Set(identity.map((c) => c.status));
  const bodies = identity.map((c) => JSON.stringify(c.data ?? {}));

  check(`${identity.length} identity refusals were exercised`, identity.length === 6);
  check("every one returns a single identical message", messages.size === 1, [...messages].join(" | "));
  check("every one returns a single identical status", statuses.size === 1, [...statuses].join(", "));
  check("no body carries an extra field", new Set(bodies).size === 1, String(new Set(bodies).size));

  check(
    "and none of them mentions a distance, a score or a threshold",
    bodies.every((b) => !/\d\.\d{3,}|distance|score|threshold/i.test(b)),
    bodies[0]
  );
  check(
    "and none names a card type or an account",
    bodies.every((b) => !/philsys|lto|passport|account of|belongs to/i.test(b)),
    bodies[0]
  );
}

section("request-shape refusals say what is wrong with the request");

{
  const shape = [
    await post(upload({ card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") })),
    await post(upload({ id_front: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") })),
  ];

  check("a missing image is a 400, not an identity refusal", shape[0].status === 400, String(shape[0].status));
  check("and it names what is missing", /no photo/i.test(shape[0].data?.error ?? ""), shape[0].data?.error);
  check("a file that is not an image is a 400", shape[1].status === 400, String(shape[1].status));
  check("and it says so", /not a jpeg|png|webp|image/i.test(shape[1].data?.error ?? ""), shape[1].data?.error);

  /*
   * The rule these two still have to obey: they may describe the request, never
   * the roster. If one of these ever answered differently for a card that *is* on
   * file, the distinction above would stop being safe.
   */
  check(
    "neither mentions anything about accounts or cards on file",
    shape.every((c) => !/on file|account|card belongs|not recognised|unrecognised/i.test(c.data?.error ?? "")),
    shape.map((c) => c.data?.error).join(" | ")
  );
}

/* ------------------------------------------------------------ switched off */

section("switched off");

await call("PATCH", "/api/settings", { id_login_enabled: "0" });

{
  const off = await call("GET", "/api/auth/id-login");
  check("the probe says it is off", off.data?.enabled === false, JSON.stringify(off.data));

  const refused = await post(upload({ id_front: new Blob([TINY_PNG], { type: "image/png" }), card_hash: "0123456789abcdef", face_embedding: DUMMY_EMBEDDING.join(",") }));
  check("and the route refuses before reading anything", refused.status === 404, `status ${refused.status}`);
}

await call("PATCH", "/api/settings", { id_login_enabled: "1" });

console.log(`\n${"-".repeat(52)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
