/**

/**
 * CafeTrack user-journey tests.
 *
 *   npm run dev                     (in one terminal)
 *   node scripts/_journeys.mjs      (in another)
 *
 * Where _edge-tests.mjs checks that a single request is answered correctly,
 * these drive the whole story a real person performs and assert on the outcome
 * at the end of it: an ingredient is created, depleted, alerted on, restocked
 * and confirmed clear; a new hire is onboarded, works, and is locked out.
 *
 * Expects a freshly seeded database (npm run db:wipe, then npm run dev).
 * Everything it creates it removes again, so a run leaves no residue.
 */

import { assertTestTarget } from "./_guard.mjs";
const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";

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

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function call(method, path, body, cookie) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("json") ? await r.json() : null;
  return { status: r.status, data, headers: r.headers };
}

function cookieOf(res) {
  return res.headers.getSetCookie?.().map((x) => x.split(";")[0]).join("; ") ?? "";
}

async function signInAdmin() {
  return cookieOf(
    await call("POST", "/api/auth/login", {
      username: "admin",
      password: process.env.SEED_ADMIN_PASSWORD || "admin123",
    })
  );
}

async function signInStaff(token, password) {
  return cookieOf(
    await call("POST", "/api/auth/staff", { token, password })
  );
}

/** Current stock for one SKU, or null if it cannot be read. */
async function stockOf(sku, cookie) {
  const r = await call(
    "GET",
    `/api/items/lookup?code=${encodeURIComponent(sku)}`,
    undefined,
    cookie
  );
  return r.status === 200 ? Number(r.data.item.quantity) : null;
}

/**
 * Stored expiry date for one SKU, or null if it has none.
 *
 * Normalised to YYYY-MM-DD: a Postgres `date` comes back over JSON as a full
 * ISO instant ("2026-10-29T00:00:00.000Z"), so comparing it to a plain day
 * would fail on the format rather than on the value. Every page already deals
 * with the instant form via lib/format; here the day is what is being asserted.
 */
async function expiryOf(sku, cookie) {
  const r = await call(
    "GET",
    `/api/items/lookup?code=${encodeURIComponent(sku)}`,
    undefined,
    cookie
  );
  if (r.status !== 200) return null;
  const raw = r.data.item.expiration_date ?? null;
  return raw ? String(raw).slice(0, 10) : null;
}

(async () => {
  await assertTestTarget(BASE);
  console.log(`CafeTrack user journeys against ${BASE}\n`);
  const A = await signInAdmin();
  check("admin signed in", Boolean(A));
  if (!A) {
    console.error("Cannot continue without an admin session.");
    process.exit(1);
  }

  /* ================================================================= */
  section("JOURNEY 1 - a new hire's first day");
  /* ================================================================= */
  const hire = `journey${Date.now().toString(36)}`;
  let r = await call(
    "POST",
    "/api/users",
    { username: hire, full_name: "Journey New Hire", password: "journey123", role: "staff" },
    A
  );
  check("admin created the staff account", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const newHire = r.data?.user ?? {};
  check(
    "the account was issued a barcode",
    typeof newHire.qr_token === "string" && newHire.qr_token.startsWith("CT-STF-"),
    newHire.qr_token ?? "none"
  );

  r = await call(
    "POST",
    "/api/items",
    { name: `Journey Oats ${hire}`, quantity: 10, low_stock_threshold: 3 },
    A
  );
  check("admin added an ingredient", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const oats = r.data?.item ?? {};
  check(
    "the ingredient got a generated SKU",
    typeof oats.sku === "string" && oats.sku.startsWith("CT-"),
    oats.sku ?? "none"
  );

  // The password set at creation above, not the seeded staff password: this
  // journey creates its own account rather than borrowing barista1.
  const S = await signInStaff(newHire.qr_token, "journey123");
  check("the new hire signed in with the barcode", Boolean(S));

  r = await call(
    "POST",
    "/api/transactions",
    { type: "checkout", password: "journey123", items: [{ sku: oats.sku, qty: 2 }] },
    S
  );
  check("the new hire recorded a checkout", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("stock dropped 10 to 8", (await stockOf(oats.sku, S)) === 8, `now ${await stockOf(oats.sku, S)}`);

  // Admin turns the account off while that session is still live.
  r = await call(
    "PATCH",
    `/api/users/${newHire.id}`,
    { is_active: false, deactivation_reason: "End of shift" },
    A
  );
  check("admin deactivated the account with a reason", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  r = await call(
    "POST",
    "/api/transactions",
    { type: "checkout", password: "journey123", items: [{ sku: oats.sku, qty: 1 }] },
    S
  );
  check("the live session is blocked immediately", r.status === 403, `${r.status} ${r.data?.error ?? ""}`);

  r = await call("POST", "/api/auth/staff", { token: newHire.qr_token, password: "journey123" });
  check("they cannot sign back in", r.status === 403 && r.data?.deactivated === true, `${r.status} ${r.data?.error ?? ""}`);
  check("the reason reached the sign-in screen", /End of shift/.test(r.data?.error ?? ""), r.data?.error ?? "");

  /* ================================================================= */
  section("JOURNEY 2 - an ingredient runs out, then is restocked");
  /* ================================================================= */
  r = await call(
    "POST",
    "/api/transactions",
    { type: "checkout", password: "admin123", items: [{ sku: oats.sku, qty: 7 }] },
    A
  );
  check("checked out the remaining stock", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("stock is now 1, below the threshold of 3", (await stockOf(oats.sku, A)) === 1);

  r = await call("POST", "/api/alerts", undefined, A);
  check("alerts recomputed", r.status === 200);

  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const lowAlert = (r.data?.alerts ?? []).find((a) => a.item?.sku === oats.sku);
  check("a low-stock alert was raised for the item", Boolean(lowAlert), lowAlert?.message ?? "none");
  check("it is typed as low_stock, not out_of_stock", lowAlert?.type === "low_stock", lowAlert?.type ?? "");

  r = await call(
    "POST",
    "/api/transactions",
    { type: "checkout", password: "admin123", items: [{ sku: oats.sku, qty: 1 }] },
    A
  );
  check("checked out the last unit", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("stock is now 0", (await stockOf(oats.sku, A)) === 0);

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const outAlert = (r.data?.alerts ?? []).find(
    (a) => a.item?.sku === oats.sku && a.type === "out_of_stock"
  );

  // An open alert escalates in place when the item gets worse: the same alert
  // is re-typed and re-worded rather than a second one being opened, so the
  // list never shows one item twice and the message always states the current
  // severity. The id is unchanged, which is what makes it "in place".
  check("a zero-stock item is alerted as out_of_stock", Boolean(outAlert), outAlert?.message ?? "none");
  check("the message states the current severity", /is out of stock/.test(outAlert?.message ?? ""), outAlert?.message ?? "");
  check(
    "no duplicate alert was opened for the same item",
    (r.data?.alerts ?? []).filter((a) => a.item?.sku === oats.sku).length === 1
  );
  check("the escalated alert kept its identity", outAlert?.id === lowAlert?.id, `${lowAlert?.id} -> ${outAlert?.id}`);

  if (outAlert) {
    r = await call("PATCH", `/api/alerts/${outAlert.id}`, { resolved: true }, A);
    check("admin resolved the alert", r.status === 200 && r.data?.alert?.resolved === true, `${r.status}`);
    check(
      "the resolution records who did it",
      r.data?.alert?.resolved_by === "Cafe Owner",
      r.data?.alert?.resolved_by ?? "none"
    );
  }

  r = await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: oats.sku, qty: 20 }] },
    A
  );
  check("restocked 20 units", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("stock is now 20", (await stockOf(oats.sku, A)) === 20);

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const stillOpen = (r.data?.alerts ?? []).filter((a) => a.item?.sku === oats.sku);
  check("no alerts remain open after restocking", stillOpen.length === 0, `${stillOpen.length} still open`);

  r = await call("GET", "/api/alerts?status=resolved", undefined, A);
  const autoResolved = (r.data?.alerts ?? []).find((a) => a.item?.sku === oats.sku);
  check("the alert is recorded as resolved", Boolean(autoResolved), autoResolved ? `by ${autoResolved.resolved_by}` : "none");

  /* ================================================================= */
  section("JOURNEY 2b - receiving a batch, and dating it");
  /* ================================================================= */
  // Receiving stock is the only moment a new batch's expiry is actually known.
  // Before this existed the restock path carried no date at all, so an item
  // kept whatever date it had and the expiry alerts were driven by a date
  // nobody had entered. These assert the behaviours that matter: a supplied
  // date is applied, an impossible one is refused rather than rolled over, and
  // a blank leaves the existing date be.
  r = await call(
    "POST",
    "/api/items",
    { name: `Journey Perishable ${hire}`, quantity: 4, low_stock_threshold: 1 },
    A
  );
  check("admin added a perishable ingredient", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const perishable = r.data?.item ?? {};

  const firstBatch = day(30);
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: perishable.sku, qty: 10, exp: firstBatch }],
    },
    A
  );
  check("restocked with an expiry date", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check(
    "the date came back on the result",
    r.data?.result?.items?.[0]?.expiration === firstBatch,
    r.data?.result?.items?.[0]?.expiration ?? "none"
  );
  check(
    "the stored expiry is the date that was entered",
    (await expiryOf(perishable.sku, A)) === firstBatch,
    `stored ${await expiryOf(perishable.sku, A)}, entered ${firstBatch}`
  );

  // Postgres rolls 2026-02-30 over into March instead of rejecting it, which
  // would put the expiry alerts on a date nobody typed. It has to be a 400.
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: perishable.sku, qty: 1, exp: "2026-02-30" }],
    },
    A
  );
  check("an impossible date is refused with a 400", r.status === 400, `${r.status} ${r.data?.error ?? ""}`);
  check("the message is about the date", /date/i.test(r.data?.error ?? ""), r.data?.error ?? "");
  check(
    "the refused restock changed nothing",
    (await expiryOf(perishable.sku, A)) === firstBatch,
    `still ${await expiryOf(perishable.sku, A)}`
  );

  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: perishable.sku, qty: 1, exp: "not-a-date" }],
    },
    A
  );
  check("a malformed date is refused with a 400", r.status === 400, `${r.status} ${r.data?.error ?? ""}`);

  // A blank means "keep the date this item already has" — not "clear it".
  r = await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: perishable.sku, qty: 2 }] },
    A
  );
  check("restocked again with no date", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check(
    "a blank date keeps the existing expiry",
    (await expiryOf(perishable.sku, A)) === firstBatch,
    `now ${await expiryOf(perishable.sku, A)}`
  );
  check("and the stock still went up", (await stockOf(perishable.sku, A)) === 16, `now ${await stockOf(perishable.sku, A)}`);

  // Only a restock may date stock. A checkout or a waste log has no new batch
  // arriving, so it must never move the date — otherwise discarding a spoiled
  // item would silently extend its life.
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "checkout",
      password: "admin123",
      items: [{ sku: perishable.sku, qty: 1, exp: day(3650) }],
    },
    A
  );
  check("a checkout carrying a date is accepted", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check(
    "but the checkout did not change the expiry",
    (await expiryOf(perishable.sku, A)) === firstBatch,
    `now ${await expiryOf(perishable.sku, A)}`
  );

  // Two lines in one restock, each with its own date: the date is per line,
  // never per transaction, or a multi-item delivery is recorded wrongly.
  r = await call(
    "POST",
    "/api/items",
    { name: `Journey Second Perishable ${hire}`, quantity: 2, low_stock_threshold: 1 },
    A
  );
  const second = r.data?.item ?? {};
  const aDay = day(40);
  const bDay = day(50);
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [
        { sku: perishable.sku, qty: 1, exp: aDay },
        { sku: second.sku, qty: 1, exp: bDay },
      ],
    },
    A
  );
  check("restocked two items with different dates", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("line one kept its own date", (await expiryOf(perishable.sku, A)) === aDay, `now ${await expiryOf(perishable.sku, A)}`);
  check("line two kept its own date", (await expiryOf(second.sku, A)) === bDay, `now ${await expiryOf(second.sku, A)}`);

  // A date inside the warning window must raise an expiry alert, which is the
  // whole point of recording it: the date is only useful if something reads it.
  const soon = day(2);
  await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: second.sku, qty: 1, exp: soon }] },
    A
  );
  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const expiryAlert = (r.data?.alerts ?? []).find(
    (a) => a.item?.sku === second.sku && a.type === "near_expiry"
  );
  check("a soon-to-expire batch raises an expiry alert", Boolean(expiryAlert), expiryAlert?.message ?? "none");

  r = await call("DELETE", `/api/items/${perishable.id}`, undefined, A);
  check("removed the first perishable ingredient", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);
  r = await call("DELETE", `/api/items/${second.id}`, undefined, A);
  check("removed the second perishable ingredient", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  /* ================================================================= */
  section("JOURNEY 2c - a delivery in whole boxes, into a freezer");
  /* ================================================================= */
  // Suppliers ship cartons, and a freezer is the one place where shelf life on
  // arrival is the deciding factor. Both rules are per-location or per-item
  // data rather than hardcoded, so this journey sets them up explicitly and
  // then takes them back off again, leaving the database as it was found.
  r = await call("POST", "/api/refs/locations", { name: `Journey Freezer ${hire}` }, A);
  check("admin created a freezer location", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const freezer = r.data?.item ?? {};
  check("a new location has no shelf-life rule by default", freezer.min_shelf_life_days == null, `${freezer.min_shelf_life_days}`);

  r = await call(
    "PATCH",
    "/api/refs/locations",
    { id: freezer.id, min_shelf_life_days: 30 },
    A
  );
  check("admin set a 30-day minimum shelf life on it", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);
  check("the rule was stored", r.data?.item?.min_shelf_life_days === 30, `${r.data?.item?.min_shelf_life_days}`);

  r = await call(
    "PATCH",
    "/api/refs/locations",
    { id: freezer.id, min_shelf_life_days: -5 },
    A
  );
  check("a negative minimum shelf life is refused with a 400", r.status === 400, `${r.status} ${r.data?.error ?? ""}`);

  r = await call(
    "POST",
    "/api/items",
    {
      name: `Journey Frozen Peas ${hire}`,
      quantity: 0,
      low_stock_threshold: 10,
      unit: "pcs",
      units_per_box: 12,
      location_id: freezer.id,
    },
    A
  );
  check("admin added a frozen item supplied by the box", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const frozen = r.data?.item ?? {};
  check("the packaging factor was saved", Number(frozen.units_per_box) === 12, `${frozen.units_per_box}`);

  // The core of the box feature: 3 boxes of 12 must land as 36, not 3.
  r = await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: frozen.sku, boxes: 3 }] },
    A
  );
  check("restocked 3 boxes", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("3 boxes of 12 became 36 in stock", (await stockOf(frozen.sku, A)) === 36, `now ${await stockOf(frozen.sku, A)}`);
  check(
    "the result reports the converted amount",
    Number(r.data?.result?.items?.[0]?.added) === 36,
    `added ${r.data?.result?.items?.[0]?.added}`
  );

  // A box count is only meaningful for stock arriving.
  r = await call(
    "POST",
    "/api/transactions",
    { type: "checkout", password: "admin123", items: [{ sku: frozen.sku, boxes: 1 }] },
    A
  );
  check("a checkout cannot be counted by the box", r.status === 409, `${r.status} ${r.data?.error ?? ""}`);

  r = await call(
    "POST",
    "/api/items",
    { name: `Journey Loose Item ${hire}`, quantity: 5, low_stock_threshold: 1 },
    A
  );
  const loose = r.data?.item ?? {};
  r = await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: loose.sku, boxes: 2 }] },
    A
  );
  check("an item with no packaging factor refuses a box count", r.status === 409, `${r.status} ${r.data?.error ?? ""}`);

  r = await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: loose.sku, boxes: 0 }] },
    A
  );
  check("a zero box count is refused with a 400", r.status === 400, `${r.status} ${r.data?.error ?? ""}`);

  // The freezer rule: a batch with too little life left is not worth taking.
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: frozen.sku, qty: 1, exp: day(5) }],
    },
    A
  );
  check("a batch 5 days from expiry is refused by a 30-day freezer", r.status === 409, `${r.status} ${r.data?.error ?? ""}`);
  check("the refusal explains itself", /shelf life/i.test(r.data?.error ?? ""), r.data?.error ?? "");
  check("the refused delivery changed no stock", (await stockOf(frozen.sku, A)) === 36, `now ${await stockOf(frozen.sku, A)}`);

  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: frozen.sku, qty: 1, exp: day(45) }],
    },
    A
  );
  check("a batch 45 days out is accepted", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check("and the stock went up", (await stockOf(frozen.sku, A)) === 37, `now ${await stockOf(frozen.sku, A)}`);
  check("and the date was recorded", (await expiryOf(frozen.sku, A)) === day(45), `now ${await expiryOf(frozen.sku, A)}`);

  // The rule is on the location, so a line with no date is not its business —
  // there is no date to judge, and refusing it would block ordinary restocking.
  r = await call(
    "POST",
    "/api/transactions",
    { type: "restock", password: "admin123", items: [{ sku: frozen.sku, qty: 1 }] },
    A
  );
  check("a restock with no date is not blocked by the rule", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);

  // Turning the rule off must let the same short-dated delivery through.
  await call("PATCH", "/api/refs/locations", { id: freezer.id, min_shelf_life_days: null }, A);
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: frozen.sku, qty: 1, exp: day(5) }],
    },
    A
  );
  check("with the rule cleared the short batch is accepted", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);

  // And an item outside the freezer is unaffected by a freezer's rule.
  await call("PATCH", "/api/refs/locations", { id: freezer.id, min_shelf_life_days: 30 }, A);
  r = await call(
    "POST",
    "/api/transactions",
    {
      type: "restock",
      password: "admin123",
      items: [{ sku: loose.sku, qty: 1, exp: day(1) }],
    },
    A
  );
  check("an item not in the freezer is unaffected by its rule", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);

  r = await call("DELETE", `/api/items/${frozen.id}`, undefined, A);
  check("removed the frozen item", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);
  r = await call("DELETE", `/api/items/${loose.id}`, undefined, A);
  check("removed the loose item", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);
  r = await call("DELETE", `/api/refs/locations/${freezer.id}`, undefined, A);
  check("removed the journey freezer", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  /* ================================================================= */
  section("JOURNEY 3 - a full shift, then what the history says");
  /* ================================================================= */
  const plan = [
    ["checkout", 3],
    ["waste", 1],
    ["restock", 5],
    ["checkout", 2],
  ];
  for (const [type, qty] of plan) {
    const res = await call(
      "POST",
      "/api/transactions",
      { type, password: "admin123", items: [{ sku: oats.sku, qty }], note: `journey ${type}` },
      A
    );
    check(`recorded ${type} of ${qty}`, res.status === 201, `${res.status} ${res.data?.error ?? ""}`);
  }

  // 20 - 3 - 1 + 5 - 2 = 19
  check(
    "stock reflects the whole shift (20 -3 -1 +5 -2 = 19)",
    (await stockOf(oats.sku, A)) === 19,
    `now ${await stockOf(oats.sku, A)}`
  );

  r = await call("GET", "/api/transactions?limit=200", undefined, A);
  // Scoped to this run's SKU, not just the note prefix. Deleting an item leaves
  // its transaction history behind (transaction_items.item_id is set null but
  // the rows remain), so a note-only filter would also match a previous run's
  // movements and every total would come out doubled.
  const mine = (r.data?.transactions ?? []).filter(
    (t) => t.note?.startsWith("journey ") && t.transaction_items?.some((li) => li.sku === oats.sku)
  );
  const totals = mine.reduce((acc, t) => {
    const q = t.transaction_items?.reduce((n, li) => n + Number(li.quantity), 0) ?? 0;
    acc[t.type] = (acc[t.type] ?? 0) + q;
    return acc;
  }, {});
  check("the history shows every shift movement", mine.length === 4, `${mine.length} found`);
  check("checkout totals 5", totals.checkout === 5, `${totals.checkout ?? 0}`);
  check("waste totals 1", totals.waste === 1, `${totals.waste ?? 0}`);
  check("restock totals 5", totals.restock === 5, `${totals.restock ?? 0}`);

  const lines = mine.flatMap((t) => t.transaction_items ?? []);
  const consistent = lines.every((l) => {
    const before = Number(l.qty_before);
    const after = Number(l.qty_after);
    const q = Number(l.quantity);
    return after === before - q || after === before + q;
  });
  check("every line recorded a before/after consistent with its quantity", consistent);

  /* ================================================================= */
  section("JOURNEY 4 - the expiry setting actually changes alerts");
  /* ================================================================= */
  r = await call("PATCH", "/api/settings", { expiry_warning_days: "30" }, A);
  check("set the expiry warning window to 30 days", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  r = await call("PATCH", `/api/items/${oats.id}`, { expiration_date: day(20) }, A);
  check("gave the ingredient an expiry 20 days out", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const wide = (r.data?.alerts ?? []).find(
    (a) => a.item?.sku === oats.sku && a.type === "near_expiry"
  );
  check("20 days out alerts under a 30-day window", Boolean(wide), wide?.message ?? "none");

  r = await call("PATCH", "/api/settings", { expiry_warning_days: "5" }, A);
  check("narrowed the window to 5 days", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const narrow = (r.data?.alerts ?? []).find(
    (a) => a.item?.sku === oats.sku && a.type === "near_expiry"
  );
  check("20 days out no longer alerts under a 5-day window", !narrow, narrow?.message ?? "correctly silent");

  r = await call(
    "POST",
    "/api/items",
    { name: `Journey Expired ${hire}`, quantity: 4, low_stock_threshold: 1, expiration_date: day(-1) },
    A
  );
  check("added an already-expired ingredient", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const expiredItem = r.data?.item ?? {};

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const expiredAlert = (r.data?.alerts ?? []).find(
    (a) => a.item?.sku === expiredItem.sku && a.type === "expired"
  );
  check("an expired item alerts even under a 5-day window", Boolean(expiredAlert), expiredAlert?.message ?? "none");

  // Expiry escalates the same way: an item inside the warning window, then
  // moved past its date, keeps one alert that is re-worded to "expired".
  r = await call(
    "POST",
    "/api/items",
    { name: `Journey Expiring ${hire}`, quantity: 5, low_stock_threshold: 1, expiration_date: day(2) },
    A
  );
  const expiring = r.data?.item ?? {};
  check("added an item that will expire soon", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const soonAlert = (r.data?.alerts ?? []).find(
    (a) => a.item?.sku === expiring.sku && a.type === "near_expiry"
  );
  check("it alerts as expiring soon", Boolean(soonAlert), soonAlert?.message ?? "none");

  r = await call("PATCH", `/api/items/${expiring.id}`, { expiration_date: day(-1) }, A);
  check("moved its expiry into the past", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  await call("POST", "/api/alerts", undefined, A);
  r = await call("GET", "/api/alerts?status=open", undefined, A);
  const nowExpired = (r.data?.alerts ?? []).find((a) => a.item?.sku === expiring.sku);
  check("the same alert escalates to expired", nowExpired?.type === "expired", nowExpired?.type ?? "none");
  check("it kept its identity", nowExpired?.id === soonAlert?.id, `${soonAlert?.id} -> ${nowExpired?.id}`);
  check(
    "still only one alert for the item",
    (r.data?.alerts ?? []).filter((a) => a.item?.sku === expiring.sku).length === 1
  );

  await call("PATCH", "/api/settings", { expiry_warning_days: "7" }, A);

  /* ================================================================= */
  section("JOURNEY 5 - the session timeout reaches the cookie");
  /* ================================================================= */
  r = await call("PATCH", "/api/settings", { session_timeout_minutes: "5" }, A);
  check("set the session timeout to 5 minutes", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  const shortSession = await call("POST", "/api/auth/login", { username: "admin", password: "admin123" });
  const setCookie = shortSession.headers.getSetCookie?.().find((c) => c.startsWith("cafetrack_session="));
  const maxAge = /Max-Age=(\d+)/i.exec(setCookie ?? "")?.[1];
  check("the issued cookie honours the new timeout", Number(maxAge) === 300, `Max-Age=${maxAge ?? "absent"}s`);

  r = await call("GET", "/api/auth/me", undefined, cookieOf(shortSession));
  check("the short session still authenticates", r.status === 200, `${r.status}`);

  r = await call("PATCH", "/api/settings", { session_timeout_minutes: "5000" }, A);
  check("an out-of-range timeout is rejected", r.status === 400, `${r.status} ${r.data?.error ?? ""}`);

  await call("PATCH", "/api/settings", { session_timeout_minutes: "15" }, A);
  r = await call("GET", "/api/settings", undefined, A);
  check(
    "the timeout was restored to 15",
    r.data?.settings?.session_timeout_minutes === "15",
    r.data?.settings?.session_timeout_minutes ?? "?"
  );

  /* ================================================================= */
  section("JOURNEY 6 - the guardrails around shared reference data");
  /* ================================================================= */
  r = await call("GET", "/api/refs/categories", undefined, A);
  const cat = (r.data?.items ?? []).find((c) => c.name === "Coffee");
  check("found the Coffee category", Boolean(cat), cat?.id ?? "missing");

  if (cat) {
    r = await call("POST", "/api/items", {
      name: `Journey Category Holder ${hire}`,
      quantity: 1,
      category_id: cat.id,
    }, A);
    const holder = r.data?.item ?? {};
    check("added an item assigned to that category", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);

    r = await call("DELETE", `/api/refs/categories/${cat.id}`, undefined, A);
    check("deleting an in-use category is refused", r.status === 409, `${r.status} ${r.data?.error ?? ""}`);
    check("the refusal explains why", /still assigned/i.test(r.data?.error ?? ""), r.data?.error ?? "");

    r = await call("GET", "/api/refs/categories", undefined, A);
    check("the category survived the refused delete", (r.data?.items ?? []).some((c) => c.id === cat.id));

    // A throwaway category of its own, so this does not depend on which seeded
    // ingredients happen to reference "Coffee".
    r = await call("POST", "/api/refs/categories", { name: `Journey Cat ${hire}` }, A);
    const spare = r.data?.item ?? r.data?.category ?? {};
    const spareId = spare.id;
    check("created a spare category", r.status === 201 && Boolean(spareId), `${r.status} ${r.data?.error ?? ""}`);

    if (spareId) {
      r = await call("DELETE", `/api/refs/categories/${spareId}`, undefined, A);
      check("an unused category deletes cleanly", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

      r = await call("GET", "/api/refs/categories", undefined, A);
      check("it is gone from the list", !(r.data?.items ?? []).some((c) => c.id === spareId));
    }

    r = await call("DELETE", `/api/items/${holder.id}`, undefined, A);
    check("removed the item holding the category", r.status === 200, `${r.status}`);
  }

  /* ================================================================= */
  section("CLEANUP - leave the database as it was found");
  /* ================================================================= */
  r = await call("DELETE", `/api/items/${oats.id}`, undefined, A);
  check("removed the journey ingredient", r.status === 200, `${r.status}`);

  r = await call("GET", `/api/items/lookup?code=${encodeURIComponent(oats.sku)}`, undefined, A);
  check("it no longer resolves", r.status === 404, `${r.status}`);

  r = await call("DELETE", `/api/items/${expiredItem.id}`, undefined, A);
  check("removed the expired test ingredient", r.status === 200, `${r.status}`);

  r = await call("DELETE", `/api/items/${expiring.id}`, undefined, A);
  check("removed the expiring test ingredient", r.status === 200, `${r.status}`);

  // This account was switched off in journey 1, so it has to come back on
  // before it can be parked off again. Ending on is_active: false is what
  // leaves the database as found.
  r = await call("PATCH", `/api/users/${newHire.id}`, { is_active: true }, A);
  check("the hire was re-activated for cleanup", r.status === 200 && r.data?.user?.is_active === true, `${r.status}`);

  r = await call("PATCH", `/api/users/${newHire.id}`, { is_active: false, regenerate_token: true }, A);
  check("parked the test account inactive", r.status === 200 && r.data?.user?.is_active === false, `${r.status}`);

  r = await call("GET", "/api/audit/verify", undefined, A);
  check(
    "the audit chain is still intact after all of this",
    r.status === 200 && r.data?.intact === true,
    JSON.stringify(r.data?.broken ?? [])
  );

  console.log(`\n${"-".repeat(52)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail ? 1 : 0);
})();
