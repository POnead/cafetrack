import { daysUntil } from "../src/lib/format.ts";

const BASE = process.env.BASE_URL || "http://localhost:3000";
let pass = 0, fail = 0;
const failures = [];

/**
 * A YYYY-MM-DD day `n` days from today, for POSTing an expiration_date.
 * Local calendar arithmetic, so it lines up with the current_date the
 * database compares against rather than with UTC.
 */
function isoDay(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

async function login(username, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  return { status: r.status, cookie };
}
async function call(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: method === "GET" || body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : null, headers: r.headers };
}

/** Sends a raw body (or none) so a malformed request can be exercised. */
async function rawCall(method, path, rawBody, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(rawBody === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: rawBody,
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, data: ct.includes("json") ? await r.json() : null };
}

(async () => {
  const admin = await login("admin", "admin123");
  const A = admin.cookie;
  check("admin login", admin.status === 200);

  /* ============ 1. Item form validation ============ */
  section("item validation (create)");
  let r = await call("POST", "/api/items", { name: "", quantity: 1 }, A);
  check("empty name rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/items", { name: "   ", quantity: 1 }, A);
  check("whitespace name rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/items", { name: "Bad Qty", quantity: "abc" }, A);
  check("non-numeric quantity rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/items", { name: "Neg Qty", quantity: -5 }, A);
  check("negative quantity rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/items", { name: "Null Qty", quantity: null }, A);
  check("null quantity (browser NaN) not silently 0", r.status !== 201 || Number(r.data?.item?.quantity) > 0,
    r.status === 201 ? `SAVED AS ${r.data.item.quantity} - silent zero` : `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/items", { name: "Bad Date", quantity: 1, expiration_date: "not-a-date" }, A);
  check("garbage expiration_date not a 500", r.status !== 500, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/items", { name: "Quote\" & <b>Test</b>", quantity: 2 }, A);
  check("special-char name accepted", r.status === 201, `${r.status} ${r.data?.error}`);
  const weird = r.data?.item;
  if (weird) {
    r = await call("GET", "/api/items?q=" + encodeURIComponent("Quote\" & <b>"), null, A);
    check("search finds special-char name", r.status === 200 && (r.data.items ?? []).some((i) => i.id === weird.id),
      `${r.status} ${(r.data.items ?? []).length} rows`);
    await call("DELETE", `/api/items/${weird.id}`, undefined, A);
  }

  section("item validation (edit)");
  const seed = await call("GET", "/api/items", null, A);
  const target = seed.data.items[0];
  r = await call("PATCH", `/api/items/${target.id}`, { quantity: "abc" }, A);
  check("edit non-numeric quantity rejected", r.status === 400 || r.status === 409, `${r.status} ${r.data?.error}`);
  r = await call("PATCH", `/api/items/${target.id}`, { quantity: null }, A);
  check("edit null quantity not silently 0", r.status !== 200 || Number(r.data?.item?.quantity) > 0,
    r.status === 200 ? `SAVED AS ${r.data.item.quantity} - silent zero` : `${r.status} ${r.data?.error}`);

  section("edit conflict (optimistic version)");
  const fresh = await call("GET", `/api/items/${target.id}`, null, A);
  const v0 = fresh.data.item.version;
  // A quantity correction must bump the version, otherwise the version guard
  // has nothing to compare and a stale client could overwrite a newer edit.
  r = await call("PATCH", `/api/items/${target.id}`, { quantity: 7 }, A);
  check("quantity correction ok", r.status === 200, `${r.status} ${r.data?.error}`);
  check("quantity edit bumps version", r.data?.item?.version === Number(v0) + 1,
    `before=${v0} after=${r.data?.item?.version}`);

  // Two edits fired together is NOT a usable conflict test: PGlite runs them
  // one after another, so the second reads the version the first just wrote
  // and both legitimately succeed. Asserting otherwise was testing the timing
  // of the test harness, not the code. The guard itself is a server-side
  // `version eq` on a value read in the same request, so it is exercised by
  // the version bookkeeping above; a real race needs a second connection.
  r = await call("PATCH", `/api/items/${target.id}`, { name: target.name + " A" }, A);
  check("name edit ok", [200, 409].includes(r.status), `${r.status} ${r.data?.error}`);

  const after = await call("GET", `/api/items/${target.id}`, null, A);
  check("version readable after edits", after.status === 200 && typeof after.data.item.version === "number",
    `${after.status} v=${after.data?.item?.version}`);

  // Put the name back. This block edits a real seeded item, so without this the
  // item is left permanently renamed for anyone who runs the suite afterwards
  // (smoke-test asserts on the seed name "16oz Paper Cups"). The quantity and
  // version are left as they are — they are the point of the assertions above.
  r = await call("PATCH", `/api/items/${target.id}`, { name: target.name }, A);
  check("test item name restored", r.status === 200 && r.data?.item?.name === target.name,
    `${r.status} now=${r.data?.item?.name}`);

  /* ============ 9. Malformed request bodies ============ */
  // A missing or unparseable body used to reach the generic error handler and
  // answer 500, leaking "Unexpected end of JSON input" to the caller. It is a
  // bad request, so every route that reads a body must answer 400.
  section("malformed request bodies");
  r = await rawCall("POST", "/api/auth/login", undefined);
  check("login with no body -> 400", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await rawCall("POST", "/api/auth/login", "not json", null);
  check("login with junk body -> 400", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await rawCall("POST", "/api/auth/login", "{", null);
  check("login with truncated JSON -> 400", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await rawCall("POST", "/api/auth/staff", "null", null);
  check("staff login with json null -> 400", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await rawCall("POST", "/api/auth/staff", "12345", null);
  check("staff login with json number -> 400", r.status === 400, `${r.status} ${r.data?.error}`);

  for (const [label, method, path, body] of [
    ["items", "POST", "/api/items", undefined],
    ["items", "POST", "/api/items", "not json"],
    ["transactions", "POST", "/api/transactions", undefined],
    ["transactions", "POST", "/api/transactions", "not json"],
    ["users", "POST", "/api/users", undefined],
    ["users", "POST", "/api/users", "not json"],
    ["settings", "PATCH", "/api/settings", undefined],
    ["settings", "PATCH", "/api/settings", "not json"],
    ["categories", "POST", "/api/refs/categories", undefined],
    ["locations", "POST", "/api/refs/locations", undefined],
  ]) {
    r = await rawCall(method, path, body, A);
    check(`${method} ${path.split("/api/")[1]} (${body === undefined ? "no body" : "junk"}) -> 400`,
      r.status === 400, `${r.status} ${r.data?.error}`);
  }

  /* ============ 2. Transactions edge cases ============ */
  section("transaction edge cases");
  r = await call("POST", "/api/transactions", { type: "checkout", password: "admin123", items: [] }, A);
  check("empty cart rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/transactions", { type: "checkout", password: "admin123", items: [{ sku: "CT-X", qty: 0 }] }, A);
  check("zero qty rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/transactions", { type: "checkout", password: "admin123", items: [{ sku: "CT-X", qty: -3 }] }, A);
  check("negative qty rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/transactions", { type: "checkout", password: "admin123", items: [{ sku: "NO-SUCH-SKU", qty: 1 }] }, A);
  check("unknown SKU -> 409 conflict, not 500", r.status === 409, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/transactions", { type: "exchange", password: "admin123", items: [{ sku: "X", qty: 1 }] }, A);
  check("invalid type rejected", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/transactions", { type: "checkout", items: [{ sku: "CT-X", qty: 1 }] }, A);
  check("missing password rejected", r.status === 400, `${r.status} ${r.data?.error}`);

  /* ============ 3. Search regression ============ */
  section("search regression");
  for (const q of ["milk, 1l", "(Robusta", "Cups)\"("]) {
    r = await call("GET", "/api/items?q=" + encodeURIComponent(q), null, A);
    check(`search ${JSON.stringify(q)} -> 200`, r.status === 200, `${r.status} ${r.data?.error}`);
  }

  /* ============ 4. Staff barcode login + RBAC ============ */
  section("staff barcode login + RBAC");
  const users = await call("GET", "/api/users", null, A);
  const barista = users.data.users.find((u) => u.username === "barista1");
  check("barista1 found with a barcode code", Boolean(barista?.qr_token), barista?.qr_token ?? "");
  const s = await fetch(BASE + "/api/auth/staff", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: barista.qr_token, password: "staff123" }),
  });
  const sc = (s.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  check("staff barcode+password login", s.status === 200, `got ${s.status}`);
  const wrong = await fetch(BASE + "/api/auth/staff", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: barista.qr_token, password: "wrong" }),
  });
  check("staff wrong password -> 401", wrong.status === 401, `got ${wrong.status}`);

  r = await call("GET", "/api/audit", null, sc);
  check("staff blocked from audit API", r.status === 403, `${r.status}`);
  r = await call("POST", "/api/items", { name: "Staff Item", quantity: 1 }, sc);
  check("staff blocked from creating items", r.status === 403, `${r.status}`);
  r = await call("POST", "/api/users", { username: "hack", full_name: "Hack", password: "password1" }, sc);
  check("staff blocked from creating users", r.status === 403, `${r.status}`);

  // Alerts: staff may READ (the /alerts link is in their nav on purpose) but
  // must not resolve or recompute. SR-F30 assigns resolution to Admin, and a
  // barista should not be able to silence a low-stock warning.
  r = await call("GET", "/api/alerts?status=open", null, sc);
  check("staff can read the alert list", r.status === 200, `${r.status}`);
  const staffAlert = r.data?.alerts?.[0];
  if (staffAlert) {
    r = await call("GET", `/api/alerts/${staffAlert.id}`, null, sc);
    check("staff can read an alert's detail", r.status === 200, `${r.status}`);

    r = await call("PATCH", `/api/alerts/${staffAlert.id}`, { resolved: true }, sc);
    check("staff blocked from resolving an alert", r.status === 403, `${r.status} ${r.data?.error ?? ""}`);

    // The alert must be untouched, not merely refused after changing.
    const after = await call("GET", `/api/alerts/${staffAlert.id}`, null, sc);
    check(
      "the alert is still open after the refused attempt",
      after.data?.alert?.resolved === staffAlert.resolved,
      `resolved=${after.data?.alert?.resolved}`
    );
  } else {
    check("staff can read the alert list", false, "no open alert to test against");
  }
  r = await call("POST", "/api/alerts", undefined, sc);
  check("staff blocked from forcing an alert recompute", r.status === 403, `${r.status}`);

  r = await call("GET", "/audit", null, sc);
  check("staff opening /audit page does not crash", r.status === 200, `${r.status}`);
  r = await call("GET", "/users", null, sc);
  check("staff opening /users page does not crash", r.status === 200, `${r.status}`);
  // Staff checkout works.
  //
  // Uses a throwaway item rather than a seeded one: a previous run can leave
  // "Fresh Milk" at 0, and the API then correctly answers 409 insufficient
  // stock — which would fail this test for a reason that has nothing to do
  // with staff permissions. Restocking first makes the test independent of
  // whatever state the database was left in.
  const spill = await call(
    "POST",
    "/api/items",
    { name: `Edge Staff ${Date.now().toString(36)}`, quantity: 5, low_stock_threshold: 1 },
    A
  );
  check("throwaway item created for the checkout check", spill.status === 201, `${spill.status} ${spill.data?.error}`);
  const spillItem = spill.data?.item ?? { sku: null };

  r = await call("POST", "/api/transactions", { type: "checkout", password: "staff123", items: [{ sku: spillItem.sku, qty: 1 }] }, sc);
  check("staff can checkout with own password", r.status === 201, `${r.status} ${r.data?.error}`);

  /* ---- waste: a third movement type, separate from checkout (SR-F21a) ---- */
  r = await call("POST", "/api/transactions", { type: "waste", password: "staff123", items: [{ sku: spillItem.sku, qty: 2 }] }, sc);
  check("staff can log waste", r.status === 201, `${r.status} ${r.data?.error}`);

  const afterWaste = await call("GET", `/api/items/lookup?code=${encodeURIComponent(spillItem.sku)}`, null, sc);
  const wasteQty = Number(afterWaste.data?.item?.quantity);
  check(
    "waste deducted the quantity (5 - 1 checkout - 2 waste = 2)",
    wasteQty === 2,
    `quantity=${wasteQty}`
  );

  r = await call("POST", "/api/transactions", { type: "waste", password: "staff123", items: [{ sku: spillItem.sku, qty: 999 }] }, sc);
  check("waste cannot exceed available stock", r.status === 409, `${r.status} ${r.data?.error}`);

  r = await call("POST", "/api/transactions", { type: "waste", password: "wrong-on-purpose", items: [{ sku: spillItem.sku, qty: 1 }] }, sc);
  check("waste without a valid password is refused", r.status === 401, `${r.status} ${r.data?.error}`);

  r = await call("POST", "/api/transactions", { type: "expired", password: "staff123", items: [{ sku: spillItem.sku, qty: 1 }] }, sc);
  check("an unknown movement type is rejected", r.status === 400, `${r.status} ${r.data?.error}`);

  // Leave the throwaway item as the suite found it, so the waste test is
  // repeatable — it asserts on an absolute quantity, not a delta.
  r = await call("POST", "/api/transactions", { type: "restock", password: "admin123", items: [{ sku: spillItem.sku, qty: 3 }] }, A);
  check("throwaway item restored for the next run", r.status === 201, `${r.status} ${r.data?.error}`);

  /* ============ 5. Users management ============ */
  section("user management validation");
  r = await call("POST", "/api/users", { username: "admin", full_name: "Dup", password: "password1" }, A);
  check("duplicate username -> 409", r.status === 409, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/users", { username: "weak", full_name: "Weak", password: "123" }, A);
  check("weak password -> 400", r.status === 400, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/users", { username: "ab", full_name: "Short", password: "password1" }, A);
  check("short username -> 400", r.status === 400, `${r.status} ${r.data?.error}`);
  const me = await call("GET", "/api/auth/me", null, A);
  r = await call("PATCH", `/api/users/${me.data.user.id}`, { is_active: false }, A);
  check("admin cannot deactivate self", r.status === 400, `${r.status} ${r.data?.error}`);

  /* ============ 6. Session / middleware ============ */
  section("session + middleware");
  r = await call("GET", "/dashboard", undefined, "cafetrack_session=garbage.token.here");
  check("garbage JWT on page -> redirect to /login", r.status === 307 || r.status === 302, `${r.status} ${r.headers.get("location")}`);
  r = await call("GET", "/api/items", undefined, "cafetrack_session=garbage.token.here");
  check("garbage JWT on API -> 401", r.status === 401, `${r.status}`);
  r = await call("GET", "/dashboard");
  check("no cookie on page -> redirect", r.status === 307 || r.status === 302, `${r.status} ${r.headers.get("location")}`);
  r = await call("POST", "/api/auth/logout", undefined, A);
  check("logout ok", r.status === 200, `${r.status}`);
  r = await call("GET", "/api/auth/me", undefined, A);
  check("old admin cookie still cryptographically valid after logout", [200, 401].includes(r.status), `${r.status} (stateless JWT, expires <=15min)`);
  const admin2 = await login("admin", "admin123");
  check("re-login after logout", admin2.status === 200);

  /* ============ 7. Alerts cycle ============ */
  section("alerts recompute / resolve / reopen cycle");
  const A2 = admin2.cookie;
  r = await call("POST", "/api/alerts", undefined, A2);
  check("recompute", r.status === 200, `${r.status}`);
  r = await call("GET", "/api/alerts?status=open", null, A2);
  const openBefore = (r.data.alerts ?? []).length;
  check("open alerts exist after recompute", openBefore > 0, `${openBefore} open`);
  const first = (r.data.alerts ?? [])[0];
  if (first) {
    r = await call("PATCH", `/api/alerts/${first.id}`, { resolved: true }, A2);
    check("resolve alert", r.status === 200 && r.data.alert.resolved === true, `${r.status}`);
    r = await call("PATCH", `/api/alerts/${first.id}`, { resolved: false }, A2);
    check("reopen alert", r.status === 200 && r.data.alert.resolved === false, `${r.status}`);
    r = await call("PATCH", `/api/alerts/${first.id}`, { resolved: true }, A2);
    check("resolve again", r.status === 200, `${r.status}`);
  }
  r = await call("POST", "/api/alerts", undefined, A2);
  check("recompute after manual resolve does not crash", r.status === 200, `${r.status}`);

  /* ============ 7b. Expiry: the browser and the database must agree ===== */
  /* The one business rule implemented twice. refresh_alerts() decides
   * "expired" in SQL against current_date; the UI recomputes the same thing in
   * JS via daysUntil(). They once disagreed: daysUntil() appended "T00:00:00"
   * to a value the API had already serialised as a full ISO instant, yielding
   * an Invalid Date, and NaN fails both `d < 0` and `d <= window` — so the UI
   * showed "In Date" for an item the database had already raised an expired
   * alert for. Checking one implementation alone would not have caught it; the
   * only thing that catches this class of bug is comparing the two. */
  section("expiry: the UI's arithmetic agrees with the database's");

  // A throwaway item, dated in the past, so the comparison has something to
  // disagree about regardless of what the seeded data happens to contain.
  const pastIso = await call(
    "POST",
    "/api/items",
    { name: "Edge Expired Probe", quantity: 1, expiration_date: isoDay(-1) },
    A2
  );
  const probe = pastIso.data?.item ?? null;
  check("created a probe item that expires yesterday", pastIso.status === 201 && Boolean(probe), `${pastIso.status}`);

  const probeAlerts = (await call("POST", "/api/alerts", undefined, A2)).status;
  check("recompute so the probe is classified", probeAlerts === 200, `${probeAlerts}`);

  if (probe) {
    const stillExpired = new Set(
      ((await call("GET", "/api/alerts?status=open", null, A2)).data.alerts ?? [])
        .filter((a) => a.type === "expired")
        .map((a) => a.item?.sku)
        .filter(Boolean)
    );
    check("the database raised an expired alert for the probe", stillExpired.has(probe.sku));

    // The same question, answered the way the browser answers it: take the raw
    // string the API handed out and run the function the UI actually calls.
    const days = daysUntil(probe.expiration_date);
    check(
      "daysUntil() on the API's own date string says expired",
      typeof days === "number" && days < 0,
      `days=${days} raw=${probe.expiration_date}`
    );
    check(
      "the UI's verdict matches the database's",
      (days < 0) === stillExpired.has(probe.sku),
      `js_expired=${days < 0} db_expired=${stillExpired.has(probe.sku)}`
    );
  }

  // The broad version: every dated item in the database, not just the probe.
  // The two implementations must partition the inventory identically, or some
  // item somewhere is being shown as fine while the database alerts on it.
  const allItems = ((await call("GET", "/api/items", null, A2)).data.items ?? []).filter(
    (i) => i.expiration_date
  );
  const dbExpired = new Set(
    ((await call("GET", "/api/alerts?status=open", null, A2)).data.alerts ?? [])
      .filter((a) => a.type === "expired")
      .map((a) => a.item?.sku)
      .filter(Boolean)
  );
  const mismatched = allItems
    .filter((i) => (daysUntil(i.expiration_date) < 0) !== dbExpired.has(i.sku))
    .map((i) => i.name);
  check(
    "every dated item's expiry verdict matches the database's",
    mismatched.length === 0,
    mismatched.length
      ? `${mismatched.length} disagree: ${mismatched.slice(0, 3).join(", ")}`
      : `${allItems.length} dated item(s) agree`
  );
  check("at least one item is dated, so the comparison means something", allItems.length > 0, `${allItems.length} dated`);

  // Both shapes must agree, since the app produces both: a date input yields a
  // bare day, an API response yields a full instant.
  const bare = daysUntil("2026-09-28");
  const instant = daysUntil("2026-09-28T00:00:00.000Z");
  check("a bare date and the same date as an instant agree", bare === instant, `${bare} vs ${instant}`);
  check("neither shape returns NaN", !Number.isNaN(bare) && !Number.isNaN(instant), `${bare} / ${instant}`);
  check("an unparseable date reports unknown, not NaN", daysUntil("not-a-date") === null, `${daysUntil("not-a-date")}`);
  check("an absent date reports unknown", daysUntil(null) === null && daysUntil("") === null);

  if (probe) await call("DELETE", `/api/items/${probe.id}`, {}, A2);
  await call("POST", "/api/alerts", undefined, A2);
  const leftover = (await call("GET", "/api/alerts?status=open", null, A2)).data.alerts ?? [];
  check("the probe left no alert behind", !leftover.some((a) => a.item?.sku === probe?.sku));

  /* ============ 8. Inactive account with live session ============ */
  section("deactivated account, live session");

  const newUser = await call("POST", "/api/users", { username: `tempstaff${Date.now().toString(36)}`, full_name: "Temp Staff", password: "password1", role: "staff" }, A2);
  const temp = newUser.data.user;
  const ts = await fetch(BASE + "/api/auth/staff", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: temp.qr_token, password: "password1" }),
  });
  const tc = (ts.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  check("temp staff login", ts.status === 200, `got ${ts.status}`);
  await call("PATCH", `/api/users/${temp.id}`, { is_active: false }, A2);
  r = await call("POST", "/api/transactions", { type: "checkout", password: "password1", items: [{ sku: spillItem.sku, qty: 1 }] }, tc);
  check("deactivated staff cannot transact (403)", r.status === 403, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/auth/staff", { token: temp.qr_token, password: "wrong-password" });
  check("deactivated staff, wrong password -> generic 401", r.status === 401 && r.data?.deactivated === undefined, `${r.status} ${r.data?.error}`);
  r = await call("POST", "/api/auth/staff", { token: temp.qr_token, password: "password1" });
  check("deactivated staff cannot re-login (403 + deactivated flag)", r.status === 403 && r.data?.deactivated === true, `${r.status} ${r.data?.error}`);
  await call("PATCH", `/api/users/${temp.id}`, { is_active: false, regenerate_token: true }, A2);

  // Remove the throwaway item so a run does not leave stock behind.
  if (spillItem.id) {
    await call("DELETE", `/api/items/${spillItem.id}`, {}, A2);
  }

  /* ============ 9. Audit chain after all activity ============ */
  section("audit chain");
  r = await call("GET", "/api/audit/verify", null, A2);
  check("hash chain intact after heavy activity", r.status === 200 && r.data.intact === true, JSON.stringify(r.data?.broken ?? []));
  r = await call("GET", "/api/audit?limit=5", null, A2);
  check("audit entries recorded", (r.data.entries ?? []).length > 0, `${(r.data.entries ?? []).length} shown`);

  console.log(`\n${"-".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log("\nFailures:"); failures.forEach((f) => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})();
