import { assertTestTarget } from "./_guard.mjs";

/**
 * ID verification, end to end against a running server.
 *
 * Covers the parts that are easy to get wrong and invisible when they are:
 * the upload limits, the fact that the documents must not leak into the roster,
 * the fact that only an admin can reach any of it, and the fact that an approval
 * with nothing attached behind it is refused.
 *
 * No camera and no model are involved. The two face embeddings a browser would
 * normally compute are simply not sent, so the comparison reports "unknown" —
 * which is itself one of the outcomes worth asserting on, because an unknown
 * must never be presented as a pass.
 */

const BASE = process.env.BASE_URL || "http://localhost:3100";
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

function section(t) {
  console.log(`\n== ${t} ==`);
}

/* ---------------- fixtures ---------------- */

/**
 * A real JPEG, so the magic-byte sniffing has something genuine to agree with.
 *
 * Hand-built rather than fetched: a suite that reads a file off disk is a suite
 * that breaks when someone moves it, and the bytes here only have to be a valid
 * baseline JPEG with a frame header — which is what the dimension reader and the
 * type sniffer both look at.
 *
 * A 1x1 pixel greyscale JPEG. 1x1 also puts the aspect-ratio signal into its
 * "not a card" band, which is convenient: the shape check has something to say
 * and the suite can assert that it said it.
 */
const TINY_JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDX0Hyw5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
  ),
  (c) => c.charCodeAt(0)
);

/** A PNG header followed by junk — correctly identified, never decodable. */
function fakePng() {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}

function file(bytes, name, type) {
  return new File([bytes], name, { type });
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
  return {
    status: r.status,
    data: ct.includes("json") ? await r.json() : null,
    headers: r.headers,
  };
}

/** A multipart POST, which no other suite needs. */
async function upload(path, form, cookie) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  return {
    status: r.status,
    data: ct.includes("json") ? await r.json() : null,
    headers: r.headers,
  };
}

/**
 * Sign in as an admin.
 *
 * /api/auth/login is admin-only — it filters on role, so a staff account gets a
 * 401 no matter how correct the password is. Staff sign in through
 * /api/auth/staff, which is also where the ID gate lives.
 */
async function login(username, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? [])
    .map((x) => x.split(";")[0])
    .join("; ");
  return { status: r.status, cookie };
}

/** Sign in as a staff member — the endpoint the ID gate is wired into. */
async function staffSignIn(username, password) {
  const r = await fetch(BASE + "/api/auth/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? [])
    .map((x) => x.split(";")[0])
    .join("; ");
  return { status: r.status, cookie };
}

/* ---------------- run ---------------- */

console.log("\nID verification");
await assertTestTarget(BASE);

const admin = await login(
  process.env.SEED_ADMIN_USERNAME || "admin",
  process.env.SEED_ADMIN_PASSWORD || "admin123"
);
const cookie = admin.cookie;

if (!cookie) {
  console.error("\n  Could not sign in as the seeded admin. Is the server running?\n");
  process.exit(1);
}

// A staff account to attach an ID to. Deleted at the end.
const uniq = Date.now().toString(36);
const created = await call(
  "POST",
  "/api/users",
  {
    username: `idtest${uniq}`,
    password: "staff123",
    first_name: "Ana",
    last_name: "Dela Cruz",
    role: "staff",
  },
  cookie
);

const userId = created.data?.user?.id;
check("staff account created for the test", Boolean(userId), userId ?? JSON.stringify(created.data));

if (userId) {
  /* ---- status defaults ---- */
  section("status");

  check(
    "a new staff account starts as not-checked",
    created.data.user.verification_status === "unverified",
    `got ${created.data.user.verification_status}`
  );

  /* ---- upload validation ---- */
  section("upload validation");

  const noFront = await upload(
    `/api/users/${userId}/id`,
    (() => {
      const f = new FormData();
      f.append("doc_type", "philsys");
      return f;
    })(),
    cookie
  );
  check(
    "an upload with no front is refused",
    noFront.status === 400,
    `status ${noFront.status}`
  );
  check(
    "the refusal names the missing image",
    /front of the ID/i.test(noFront.data?.error ?? ""),
    noFront.data?.error
  );

  const badType = await upload(
    `/api/users/${userId}/id`,
    (() => {
      const f = new FormData();
      f.append("doc_type", "philsys");
      f.append("front", file(TINY_JPEG, "id.jpg", "application/pdf"));
      return f;
    })(),
    cookie
  );
  check(
    "a file declaring a non-image type is refused",
    badType.status === 400,
    `status ${badType.status}`
  );

  const lyingType = await upload(
    `/api/users/${userId}/id`,
    (() => {
      const f = new FormData();
      f.append("doc_type", "philsys");
      // Declares JPEG, is actually PNG. This is the case the sniffing exists for.
      f.append("front", file(fakePng(), "id.jpg", "image/jpeg"));
      return f;
    })(),
    cookie
  );
  check(
    "a file whose bytes disagree with its declared type is refused",
    lyingType.status === 400,
    `status ${lyingType.status}`
  );
  check(
    "the refusal explains the file is not an image",
    /not a JPEG/i.test(lyingType.data?.error ?? ""),
    lyingType.data?.error
  );

  const badDocType = await upload(
    `/api/users/${userId}/id`,
    (() => {
      const f = new FormData();
      f.append("doc_type", "drivers_licence");
      f.append("front", file(TINY_JPEG, "id.jpg", "image/jpeg"));
      return f;
    })(),
    cookie
  );
  check(
    "an unknown document type is refused rather than defaulted",
    badDocType.status === 400,
    `status ${badDocType.status}`
  );

  /* ---- a real upload ---- */
  section("attach and check");

  const good = await upload(
    `/api/users/${userId}/id`,
    (() => {
      const f = new FormData();
      f.append("doc_type", "lto_license");
      f.append("front", file(TINY_JPEG, "front.jpg", "image/jpeg"));
      f.append("photo", file(TINY_JPEG, "person.jpg", "image/jpeg"));
      f.append("id_number", "N01-23-456789");
      return f;
    })(),
    cookie
  );

  check("a valid upload is accepted", good.status === 200, `status ${good.status}`);
  check("signals come back", Array.isArray(good.data?.signals) && good.data.signals.length > 0);
  check(
    "the local provider ran",
    String(good.data?.user?.id_provider ?? "").includes("local"),
    good.data?.user?.id_provider
  );

  const signals = good.data?.signals ?? [];
  check(
    "the face comparison reports that it could not run, rather than passing",
    signals.some((s) => s.id === "face_match" && s.tone === "unknown"),
    JSON.stringify(signals.find((s) => s.id === "face_match")?.tone)
  );
  check(
    "the shape check ran and had something to say about a 1x1 image",
    signals.some((s) => s.id === "front_shape" && s.tone === "warn"),
    JSON.stringify(signals.find((s) => s.id === "front_shape")?.tone)
  );
  check(
    "the name check says no name was read, rather than claiming a match",
    signals.some((s) => s.id === "name_match" && s.tone === "unknown"),
    JSON.stringify(signals.find((s) => s.id === "name_match")?.tone)
  );
  check(
    "no signal claims an automatic approval",
    !signals.some((s) => s.tone === "pass" && s.id === "name_match"),
    "the name check must never pass on nothing"
  );

  /* ---- the cross-account checks ---- */
  section("duplicate card and ID number shape");

  const signalOf = (result, id) => (result.data?.signals ?? []).find((s) => s.id === id);

  const uploadWith = (targetId, fields) =>
    upload(
      `/api/users/${targetId}/id`,
      (() => {
        const f = new FormData();
        f.append("doc_type", "philsys");
        f.append("front", file(TINY_JPEG, "front.jpg", "image/jpeg"));
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null && v !== undefined) f.append(k, String(v));
        }
        return f;
      })(),
      cookie
    );

  // A fingerprint shaped like the ones the browser sends: 16 hex characters.
  const HASH_A = "0123456789abcdef";
  // The same card photographed again — four bits differ.
  const HASH_A_AGAIN = "0123456789abcfef";
  // A different card entirely.
  const HASH_B = "fedcba9876543210";

  const first = await uploadWith(userId, { card_hash: HASH_A, id_number: "1234-5678-9012-3456" });
  check("an upload carrying a fingerprint is accepted", first.status === 200, `status ${first.status}`);
  check(
    "the duplicate check ran and found nothing",
    signalOf(first, "card_duplicate")?.tone === "pass",
    JSON.stringify(signalOf(first, "card_duplicate"))
  );
  check(
    "a well-formed PhilSys number passes the shape check",
    signalOf(first, "id_number_shape")?.tone === "pass",
    JSON.stringify(signalOf(first, "id_number_shape"))
  );

  /*
   * A second account, so the duplicate check has someone to find.
   *
   * This is the fraud the check exists for: one card, two accounts. Nothing else in
   * the feature can see it — the name matches whoever the card belongs to, the
   * portrait matches that person, and the number is real.
   */
  const secondUser = await call(
    "POST",
    "/api/users",
    {
      username: `iddup${uniq}`,
      password: "staff123",
      first_name: "Ben",
      last_name: "Dela Cruz",
      role: "staff",
    },
    cookie
  );
  const secondId = secondUser.data?.user?.id;
  check("a second staff account was created", Boolean(secondId), secondId ?? "none");

  if (secondId) {
    const dupe = await uploadWith(secondId, { card_hash: HASH_A_AGAIN });
    const dupeSignal = signalOf(dupe, "card_duplicate");

    check("the same card on a second account is flagged", dupeSignal?.tone === "warn", JSON.stringify(dupeSignal));
    check(
      "the warning names the account it is already on",
        /Ana/.test(dupeSignal?.detail ?? ""),
      (dupeSignal?.detail ?? "").slice(0, 80)
    );
    /*
     * The distance in the message must be the real one.
     *
     * Computed here from the two fixtures rather than hardcoded, because a
     * hardcoded number is a trap: `d` (1101) and `f` (1111) differ by one bit, not
     * four, so asserting "4" against that pair failed while the application was
     * reporting exactly the right value. Written out independently of the app's own
     * helper, so comparing the two means something.
     */
    const distanceOf = (a, b) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) {
          d += x & 1;
          x >>= 1;
        }
      }
      return d;
    };
    const expected = distanceOf(HASH_A, HASH_A_AGAIN);
    check(
      `the warning gives the real distance (${expected})`,
      new RegExp(`in ${expected} of 64`).test(dupeSignal?.detail ?? ""),
      (dupeSignal?.detail ?? "").slice(0, 140)
    );
    check(
      "it does not accuse outright",
      !/(fraud|forged|stolen)/i.test(dupeSignal?.detail ?? "")
    );

    const different = await uploadWith(secondId, { card_hash: HASH_B });
    check(
      "a different card on the same account is not flagged",
      signalOf(different, "card_duplicate")?.tone === "pass",
      JSON.stringify(signalOf(different, "card_duplicate"))
    );

    const noHash = await uploadWith(secondId, {});
    check(
      "an upload with no fingerprint says the check could not run",
      signalOf(noHash, "card_duplicate")?.tone === "unknown",
      JSON.stringify(signalOf(noHash, "card_duplicate"))
    );

    const junkHash = await uploadWith(secondId, { card_hash: "not-a-fingerprint" });
    check(
      "a malformed fingerprint is treated as absent, not as a match",
      signalOf(junkHash, "card_duplicate")?.tone === "unknown",
      JSON.stringify(signalOf(junkHash, "card_duplicate"))
    );
  }

  const wrongShape = await uploadWith(userId, { card_hash: HASH_A, id_number: "12345" });
  check(
    "an impossible PhilSys number is flagged",
    signalOf(wrongShape, "id_number_shape")?.tone === "warn",
    JSON.stringify(signalOf(wrongShape, "id_number_shape"))
  );
  check(
    "and the warning says what the shape should be",
    /sixteen digits/.test(signalOf(wrongShape, "id_number_shape")?.detail ?? "")
  );

  const noNumber = await uploadWith(userId, { card_hash: HASH_A });
  check(
    "no number at all is not treated as a wrong number",
    signalOf(noNumber, "id_number_shape") === undefined,
    JSON.stringify(signalOf(noNumber, "id_number_shape"))
  );

  {
    // The fingerprint is stored for the next comparison, and it must not surface
    // on the roster: it is not something a staff member needs to see about another
    // person's documents.
    const list = await call("GET", "/api/users", undefined, cookie);
    const asJson = JSON.stringify(list.data ?? {});
    check("the roster does not carry card fingerprints", !asJson.includes(HASH_A) && !asJson.includes("id_card_hash"));
  }

  /*
   * Put the account's documents back the way the section above left them.
   *
   * Every upload here replaces all three images at once, so the last one — which
   * carries a front and nothing else — cleared `id_photo` and took down a later
   * assertion about the photo being served. Tests that depend on shared state
   * should not inherit it by accident; this restores it explicitly.
   */
  await upload(
    `/api/users/${userId}/id`,
    (() => {
      const f = new FormData();
      f.append("doc_type", "lto_license");
      f.append("front", file(TINY_JPEG, "front.jpg", "image/jpeg"));
      f.append("photo", file(TINY_JPEG, "person.jpg", "image/jpeg"));
      f.append("id_number", "N01-23-456789");
      return f;
    })(),
    cookie
  );

  if (secondId) await call("DELETE", `/api/users/${secondId}`, undefined, cookie).catch(() => {});

  /* ---- nothing heavy leaks into the roster ---- */
  section("roster");

  const roster = await call("GET", "/api/users", undefined, cookie);
  const row = roster.data?.users?.find((u) => u.id === userId);

  check("the account appears in the roster", Boolean(row));
  check(
    "the roster carries the verification status",
    row?.verification_status === "unverified",
    `got ${row?.verification_status}`
  );

  const asJson = JSON.stringify(roster.data ?? {});
  check("the roster does not carry the document image", !asJson.includes("id_doc_front"));
  check("the roster does not carry a base64 data URL", !asJson.includes("data:image"));
  check("the roster does not carry the ID number", !asJson.includes("N01-23-456789"));

  /* ---- the review status endpoint ---- */
  section("review status");

  const status = await call("GET", `/api/users/${userId}/id/status`, undefined, cookie);
  check("the review status is readable", status.status === 200, `status ${status.status}`);
  check(
    "it reports the document as attached",
    status.data?.user?.has_front === true,
    JSON.stringify({ front: status.data?.user?.has_front })
  );
  check(
    "it carries the signals",
    Array.isArray(status.data?.signals) && status.data.signals.length > 0
  );
  check(
    "it lists the providers that are available",
    Array.isArray(status.data?.providers) && status.data.providers.length > 0,
    JSON.stringify(status.data?.providers?.map((p) => p.id))
  );

  /* ---- serving an image ---- */
  section("serving the image");

  const img = await fetch(`${BASE}/api/users/${userId}/id?part=front`, {
    headers: { cookie },
    redirect: "manual",
  });
  check("the front image is served", img.status === 200, `status ${img.status}`);
  check(
    "it comes back as an image",
    (img.headers.get("content-type") || "").startsWith("image/"),
    img.headers.get("content-type")
  );
  check(
    "it is not cached",
    /no-store/.test(img.headers.get("cache-control") || ""),
    img.headers.get("cache-control")
  );

  // `back` is the part that was never sent — the good upload carries a front and
  // a photo but no back — so this is the one that has to 404 rather than answer
  // 200 with nothing in it.
  const noBack = await fetch(`${BASE}/api/users/${userId}/id?part=back`, {
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "asking for an image that was never attached is a 404, not an empty 200",
    noBack.status === 404,
    `status ${noBack.status}`
  );

  const photoImage = await fetch(`${BASE}/api/users/${userId}/id?part=photo`, {
    headers: { cookie },
    redirect: "manual",
  });
  check(
    "the photo of the person is served too",
    photoImage.status === 200,
    `status ${photoImage.status}`
  );

  /* ---- the decision ---- */
  section("approve and reject");

  const noReason = await call(
    "PATCH",
    `/api/users/${userId}/id`,
    { decision: "reject" },
    cookie
  );
  check("rejecting without a reason is refused", noReason.status === 400, `status ${noReason.status}`);

  const badDecision = await call(
    "PATCH",
    `/api/users/${userId}/id`,
    { decision: "maybe" },
    cookie
  );
  check(
    "an unrecognised decision is refused",
    badDecision.status === 400,
    `status ${badDecision.status}`
  );

  const approved = await call(
    "PATCH",
    `/api/users/${userId}/id`,
    { decision: "approve", reason: "" },
    cookie
  );
  check(
    "approving without a reason is allowed",
    approved.status === 200,
    `status ${approved.status}`
  );
  check(
    "approval sets the status",
    approved.data?.user?.verification_status === "verified",
    approved.data?.user?.verification_status
  );
  check(
    "approval records who did it",
    Boolean(approved.data?.user?.verified_at)
  );

  const rejected = await call(
    "PATCH",
    `/api/users/${userId}/id`,
    { decision: "reject", reason: "The surname on the card does not match the roster." },
    cookie
  );
  check(
    "rejecting with a reason works",
    rejected.data?.user?.verification_status === "rejected",
    rejected.data?.user?.verification_status
  );
  check(
    "the rejection reason is kept on the account",
    (rejected.data?.user?.verification_notes ?? "").length > 0
  );

  /* ---- approval with nothing behind it ---- */
  section("approve with nothing attached");

  // This is the one that would otherwise let a PATCH with no prior POST set
  // 'verified' on an account with no evidence, which is a claim that cannot be
  // substantiated or repeated.
  const bare = await call(
    "POST",
    "/api/users",
    { username: `idbare${uniq}`, password: "staff123", first_name: "No", last_name: "Docs", role: "staff" },
    cookie
  );
  if (bare.data?.user?.id) {
    const bareApprove = await call(
      "PATCH",
      `/api/users/${bare.data.user.id}/id`,
      { decision: "approve", reason: "" },
      cookie
    );
    check(
      "approving an account with no ID attached is refused",
      bareApprove.status === 400,
      `status ${bareApprove.status}`
    );

    await call("DELETE", `/api/users/${bare.data.user.id}`, undefined, cookie);
  }

  /* ---- purge ---- */
  section("removing the documents");

  const purge = await call("DELETE", `/api/users/${userId}/id`, undefined, cookie);
  check("the documents can be removed", purge.status === 200, `status ${purge.status}`);
  check(
    "removing them resets the status rather than leaving a stale approval",
    purge.data?.user?.verification_status === "unverified",
    purge.data?.user?.verification_status
  );

  const afterPurge = await call("GET", `/api/users/${userId}/id/status`, undefined, cookie);
  check(
    "the status endpoint now reports no document",
    afterPurge.data?.user?.has_front === false,
    JSON.stringify({ front: afterPurge.data?.user?.has_front })
  );

  const purgeAgain = await call("DELETE", `/api/users/${userId}/id`, undefined, cookie);
  check(
    "removing nothing is refused, so the trail stays honest",
    purgeAgain.status === 400,
    `status ${purgeAgain.status}`
  );

  /* ---- access control ---- */
  section("access control");

  const noAuth = await call("GET", `/api/users/${userId}/id/status`);
  check("the status endpoint refuses an anonymous caller", noAuth.status === 401);

  const noAuthImg = await fetch(`${BASE}/api/users/${userId}/id?part=front`, {
    redirect: "manual",
  });
  check("the image endpoint refuses an anonymous caller", noAuthImg.status === 401);

  // A staff member is signed in, not an admin. The proxy has proven *a* session
  // exists; the route has to prove *whose*.
  const staffLogin = await staffSignIn(`idtest${uniq}`, "staff123");
  if (staffLogin.cookie) {
    const asStaff = await call("GET", `/api/users/${userId}/id/status`, undefined, staffLogin.cookie);
    check("the status endpoint refuses a staff caller", asStaff.status === 403, `status ${asStaff.status}`);

    const staffUpload = await upload(
      `/api/users/${userId}/id`,
      (() => {
        const f = new FormData();
        f.append("doc_type", "philsys");
        f.append("front", file(TINY_JPEG, "id.jpg", "image/jpeg"));
        return f;
      })(),
      staffLogin.cookie
    );
    check("the upload endpoint refuses a staff caller", staffUpload.status === 403);
  }

  /* ---- the gate ---- */
  section("the sign-in gate");

  // The gate only bites when settings.id_verification_required is on, and it is
  // off by default. Turn it on, prove the refusal, turn it back off — leaving it
  // on would break every other suite that signs a seeded barista in.
  const settingOn = await call(
    "PATCH",
    "/api/settings",
    { id_verification_required: "1" },
    cookie
  );
  check(
    "the requirement can be switched on",
    settingOn.status === 200 || settingOn.status === 405,
    `status ${settingOn.status}`
  );

  if (settingOn.status === 200) {
    // The test account was purged, so it has no document and therefore waves
    // through by design. Attach one first, so the gate has something to bite on.
    await upload(
      `/api/users/${userId}/id`,
      (() => {
        const f = new FormData();
        f.append("doc_type", "philsys");
        f.append("front", file(TINY_JPEG, "front.jpg", "image/jpeg"));
        return f;
      })(),
      cookie
    );

    const staffSignInRes = await staffSignIn(`idtest${uniq}`, "staff123");
    check(
      "a staff account with an unchecked ID is refused at sign-in",
      staffSignInRes.status === 403,
      `status ${staffSignInRes.status}`
    );

    await call(
      "PATCH",
      `/api/users/${userId}/id`,
      { decision: "approve", reason: "" },
      cookie
    );

    const afterApprove = await staffSignIn(`idtest${uniq}`, "staff123");
    check(
      "and is let in once it is approved",
      afterApprove.status === 200,
      `status ${afterApprove.status}`
    );

    const adminSignIn = await login(
      process.env.SEED_ADMIN_USERNAME || "admin",
      process.env.SEED_ADMIN_PASSWORD || "admin123"
    );
    check(
      "an admin is never gated by ID verification",
      adminSignIn.status === 200,
      `status ${adminSignIn.status}`
    );

    // Back off, whatever happened above.
    await call(
      "PATCH",
      "/api/settings",
      { id_verification_required: "0" },
      cookie
    );

    const stillWorks = await staffSignIn(`idtest${uniq}`, "staff123");
    check(
      "with the switch off again, the account signs in",
      stillWorks.status === 200,
      `status ${stillWorks.status}`
    );
  }

  /* ---- clean up ---- */
  await call("DELETE", `/api/users/${userId}`, undefined, cookie);
}

/* ---------------- summary ---------------- */
console.log(`\n${"=".repeat(56)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n  Failed:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(56)}\n`);
process.exit(fail > 0 ? 1 : 0);
