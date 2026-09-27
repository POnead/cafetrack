/**
 * CafeTrack smoke test — exercises every API route against a running server.
 *
 *   npm run dev                     (in one terminal)
 *   node scripts/smoke-test.mjs     (in another)
 *
 * Works in both local (PGlite) and Supabase modes. It creates one test item
 * and one test staff account, then removes them again.
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

const ADMIN = {
  username: "admin",
  password: process.env.SEED_ADMIN_PASSWORD || "admin123",
};
const STAFF_PASSWORD = "testpass123";

let cookie = "";
let pass = 0;
let fail = 0;

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie[0].split(";")[0];

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("json") ? await res.json() : null;
  return { status: res.status, data, headers: res.headers };
}

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  console.log(`CafeTrack smoke test against ${BASE}\n`);

  section("unauthenticated access is refused");
  cookie = "";
  let res = await call("GET", "/api/items");
  check("GET /api/items -> 401", res.status === 401, `got ${res.status}`);

  section("admin sign-in");
  res = await call("POST", "/api/auth/login", ADMIN);
  check("POST /api/auth/login -> 200", res.status === 200, `got ${res.status}`);
  check("session is an admin", res.data?.user?.role === "admin", res.data?.user?.fullName || "");
  check("cookie was issued", cookie.startsWith("cafetrack_session="));

  res = await call("GET", "/api/auth/me");
  check("GET /api/auth/me -> 200", res.status === 200 && res.data?.user?.username === "admin");

  section("reference data");
  res = await call("GET", "/api/refs/categories");
  const categoryCount = res.data?.items?.length ?? 0;
  check("GET /api/refs/categories", res.status === 200 && categoryCount > 0, `${categoryCount} rows`);

  res = await call("GET", "/api/refs/locations");
  const locationCount = res.data?.items?.length ?? 0;
  check("GET /api/refs/locations", res.status === 200 && locationCount > 0, `${locationCount} rows`);

  section("inventory");
  res = await call("GET", "/api/items");
  const items = res.data?.items ?? [];
  check("GET /api/items", res.status === 200 && items.length > 0, `${items.length} rows`);
  check(
    "row embeds category + location objects",
    items[0]?.category?.name !== undefined && "location" in (items[0] ?? {}),
    `${items[0]?.name ?? "?"} / ${items[0]?.category?.name ?? "?"}`
  );

  const seededSku = items.find((i) => i.sku)?.sku;
  res = await call("GET", `/api/items/lookup?code=${encodeURIComponent(seededSku)}`);
  check("GET /api/items/lookup", res.status === 200 && res.data?.item?.sku === seededSku, seededSku);

  // Regression: search terms containing PostgREST-reserved characters
  // (comma, parentheses, quotes) used to return HTTP 500 or wrong results.
  res = await call("GET", "/api/items?q=" + encodeURIComponent("Paper Cups"));
  check(
    "GET /api/items?q finds a match",
    res.status === 200 && (res.data?.items ?? []).some((i) => i.name === "16oz Paper Cups"),
    (res.data?.items ?? []).length + " rows"
  );

  res = await call("GET", "/api/items?q=" + encodeURIComponent("milk, 1l"));
  check("search with a comma -> 200", res.status === 200, "got " + res.status);

  res = await call("GET", "/api/items?q=" + encodeURIComponent('Cups)"('));
  check("search with quotes/parens -> 200", res.status === 200, "got " + res.status);

  // A malformed uuid used to reach Postgres and come back as a 500.
  res = await call("GET", "/api/items/not-a-uuid");
  check(
    "GET /api/items/:id with a malformed id -> 400",
    res.status === 400,
    `got ${res.status}`
  );

  res = await call("GET", "/api/alerts/not-a-uuid");
  check(
    "GET /api/alerts/:id with a malformed id -> 400",
    res.status === 400,
    `got ${res.status}`
  );

  res = await call("POST", "/api/items", {
    name: "Smoke Test Item",
    category_id: null,
    location_id: null,
    physical_form: "solid",
    unit: "pcs",
    quantity: 10,
    low_stock_threshold: 2,
    expiration_date: null,
  });
  const newItem = res.data?.item;
  check("POST /api/items -> 201", res.status === 201, newItem?.sku || JSON.stringify(res.data));
  check("generated a SKU", typeof newItem?.sku === "string" && newItem.sku.startsWith("CT-"));

  res = await call("PATCH", `/api/items/${newItem?.id}`, { name: "Smoke Test Item v2" });
  check("PATCH /api/items/:id", res.status === 200 && res.data?.item?.name === "Smoke Test Item v2");

  section("stock movements");
  res = await call("POST", "/api/transactions", {
    type: "restock",
    password: ADMIN.password,
    note: "smoke test restock",
    items: [{ sku: newItem?.sku, qty: 5 }],
  });
  check(
    "POST /api/transactions restock -> 201",
    res.status === 201,
    `after=${res.data?.result?.items?.[0]?.after}`
  );
  check("quantity went 10 -> 15", Number(res.data?.result?.items?.[0]?.after) === 15);

  res = await call("POST", "/api/transactions", {
    type: "checkout",
    password: "definitely-wrong",
    items: [{ sku: newItem?.sku, qty: 1 }],
  });
  check("wrong password is rejected -> 401", res.status === 401, res.data?.error || "");

  res = await call("POST", "/api/transactions", {
    type: "checkout",
    password: ADMIN.password,
    items: [{ sku: newItem?.sku, qty: 99999 }],
  });
  check("overselling is rejected -> 409", res.status === 409, res.data?.error || "");

  res = await call("POST", "/api/transactions", {
    type: "checkout",
    password: ADMIN.password,
    items: [{ sku: newItem?.sku, qty: 3 }],
  });
  check(
    "POST /api/transactions checkout -> 201",
    res.status === 201,
    `after=${res.data?.result?.items?.[0]?.after}`
  );

  res = await call("GET", "/api/transactions?limit=5");
  const txns = res.data?.transactions ?? [];
  check("GET /api/transactions", res.status === 200 && txns.length > 0, `${txns.length} rows`);
  check("history embeds transaction_items array", Array.isArray(txns[0]?.transaction_items));

  section("alerts");
  res = await call("POST", "/api/alerts");
  check("POST /api/alerts (recompute) -> 200", res.status === 200);

  res = await call("GET", "/api/alerts?status=open");
  const alerts = res.data?.alerts ?? [];
  check("GET /api/alerts?status=open", res.status === 200, `${alerts.length} open`);
  check("seeded data raises alerts", alerts.length > 0);
  check("alert embeds its item", alerts[0]?.item?.name !== undefined, alerts[0]?.item?.name || "");

  if (alerts.length) {
    const alertId = alerts[0].id;

    res = await call("GET", `/api/alerts/${alertId}`);
    check(
      "GET /api/alerts/:id -> alert + item + history",
      res.status === 200 &&
        res.data?.alert?.id === alertId &&
        Array.isArray(res.data?.history) &&
        res.data?.history?.some((h) => h.id === alertId),
      `${res.status} ${res.data?.error ?? ""}`
    );
    check(
      "detail carries the item behind the alert",
      Boolean(res.data?.item?.sku ?? res.data?.alert?.item?.sku),
      res.data?.item?.sku ?? res.data?.alert?.item?.sku ?? "none"
    );

    res = await call("GET", "/api/alerts/00000000-0000-0000-0000-000000000000");
    check("GET /api/alerts/:id unknown -> 404", res.status === 404, `got ${res.status}`);

    res = await call("PATCH", `/api/alerts/${alertId}`, { resolved: true });
    check("PATCH /api/alerts/:id resolve", res.status === 200 && res.data?.alert?.resolved === true);
  }

  section("audit trail");
  res = await call("GET", "/api/audit?limit=100");
  const entries = res.data?.entries ?? [];
  check("GET /api/audit", res.status === 200 && entries.length > 0, `${entries.length} entries`);
  check(
    "movements were recorded",
    entries.some((e) => e.action === "STOCK_RESTOCK") &&
      entries.some((e) => e.action === "STOCK_CHECKOUT")
  );

  res = await call("GET", "/api/audit/verify");
  check(
    "GET /api/audit/verify -> chain intact",
    res.status === 200 && res.data?.intact === true,
    JSON.stringify(res.data?.broken ?? [])
  );

  section("user management");
  res = await call("GET", "/api/users");
  const users = res.data?.users ?? [];
  check("GET /api/users", res.status === 200 && users.length >= 3, `${users.length} accounts`);
  check("password hashes are never returned", users.every((u) => !("password_hash" in u)));

  res = await call("PATCH", "/api/users/not-a-uuid", { is_active: false });
  check(
    "PATCH /api/users/:id with a malformed id -> 400",
    res.status === 400,
    `got ${res.status}`
  );

  res = await call("POST", "/api/users", {
    full_name: "Smoke Tester",
    // Unique per run so the script can be re-run without a 409 on the username.
    username: `smoketest${Date.now().toString(36)}`,
    password: STAFF_PASSWORD,
    role: "staff",
  });
  const staffUser = res.data?.user;
  check("POST /api/users -> 201", res.status === 201, staffUser?.username || JSON.stringify(res.data));
  check(
    "staff account got a barcode code",
    typeof staffUser?.qr_token === "string" && staffUser.qr_token.startsWith("CT-STF-"),
    staffUser?.qr_token || ""
  );

  section("staff role is restricted");
  const adminCookie = cookie;

  cookie = "";
  res = await call("POST", "/api/auth/staff", {
    token: staffUser?.qr_token,
    password: STAFF_PASSWORD,
  });
  check("POST /api/auth/staff -> 200", res.status === 200, res.data?.user?.fullName || res.data?.error || "");
  check("staff session role", res.data?.user?.role === "staff");

  res = await call("GET", "/api/users");
  check("staff cannot list users -> 403", res.status === 403, `got ${res.status}`);

  res = await call("GET", "/api/items");
  check("staff can still read items", res.status === 200);

  section("clean up");
  cookie = adminCookie;
  res = await call("GET", "/api/auth/me");
  check("admin session restored", res.status === 200 && res.data?.user?.role === "admin");

  res = await call("DELETE", `/api/items/${newItem?.id}`);
  check("DELETE /api/items/:id", res.status === 200, `got ${res.status}`);

  res = await call("PATCH", `/api/users/${staffUser?.id}`, {
    is_active: false,
    regenerate_token: true,
  });
  check(
    "deactivate + rotate the test account",
    res.status === 200 && res.data?.user?.is_active === false
  );

  section("deactivation reason reaches the sign-in screen");
  // The token was rotated above, so the original one no longer identifies anyone.
  const rotatedToken = res.data?.user?.qr_token;
  check(
    "rotating issued a new staff token",
    typeof rotatedToken === "string" && rotatedToken !== staffUser?.qr_token,
    rotatedToken || ""
  );

  res = await call("PATCH", `/api/users/${staffUser?.id}`, { is_active: true });
  check(
    "re-activate the test account",
    res.status === 200 && res.data?.user?.is_active === true,
    `got ${res.status}`
  );

  res = await call("PATCH", `/api/users/${staffUser?.id}`, {
    is_active: false,
    deactivation_reason: "Replaced by a new hire",
  });
  check(
    "deactivate with a reason is stored",
    res.status === 200 &&
      res.data?.user?.is_active === false &&
      res.data?.user?.deactivation_reason === "Replaced by a new hire" &&
      Boolean(res.data?.user?.deactivated_at),
    `${res.status} ${res.data?.user?.deactivation_reason ?? res.data?.error ?? ""}`
  );

  res = await call("POST", "/api/auth/staff", {
    token: rotatedToken,
    password: STAFF_PASSWORD,
  });
  check(
    "staff sign-in blocked and the reason is returned (403)",
    res.status === 403 &&
      res.data?.deactivated === true &&
      res.data?.deactivation_reason === "Replaced by a new hire" &&
      /Reason: Replaced by a new hire/.test(res.data?.error ?? ""),
    `${res.status} ${res.data?.error ?? ""}`
  );

  res = await call("POST", "/api/auth/staff", {
    token: rotatedToken,
    password: "definitely-wrong",
  });
  check(
    "a wrong password stays generic (no reason leak)",
    res.status === 401 && res.data?.deactivated === undefined,
    `${res.status} ${res.data?.error ?? ""}`
  );

  res = await call("POST", "/api/auth/staff", {
    token: "CT-STF-DOESNOTEXIST",
    password: STAFF_PASSWORD,
  });
  check(
    "an unknown token stays generic",
    res.status === 401 && res.data?.deactivated === undefined,
    `${res.status} ${res.data?.error ?? ""}`
  );

  res = await call("PATCH", `/api/users/${staffUser?.id}`, { is_active: true });
  check(
    "re-activating clears the stored reason",
    res.status === 200 &&
      res.data?.user?.is_active === true &&
      res.data?.user?.deactivation_reason === null &&
      res.data?.user?.deactivated_at === null,
    JSON.stringify(res.data?.user?.deactivation_reason)
  );

  res = await call("POST", "/api/auth/staff", {
    token: rotatedToken,
    password: STAFF_PASSWORD,
  });
  check("sign-in works again after re-activation", res.status === 200, `got ${res.status}`);

  // The staff sign-in above replaced the shared cookie with a staff session,
  // so put the admin session back before the final park.
  cookie = adminCookie;

  // Park the test account the way the suite found it: inactive, token rotated.
  res = await call("PATCH", `/api/users/${staffUser?.id}`, {
    is_active: false,
    regenerate_token: true,
  });
  check("test account parked inactive again", res.status === 200 && res.data?.user?.is_active === false);

  res = await call("GET", `/api/items/lookup?code=${encodeURIComponent(newItem?.sku ?? "x")}`);
  check("deleted item no longer resolves -> 404", res.status === 404);

  section("sign-in throttling");
  // A throwaway account, so the throttle is exercised without locking out
  // anyone the rest of the suite depends on.
  const throttleUser = (
    await call("POST", "/api/users", {
      username: `throttle${Date.now().toString(36)}`,
      full_name: "Throttle Check",
      password: STAFF_PASSWORD,
      role: "staff",
    })
  ).data?.user;
  check(
    "created a throwaway account to throttle",
    Boolean(throttleUser?.qr_token),
    throttleUser?.username || ""
  );

  if (throttleUser?.qr_token) {
    const token = throttleUser.qr_token;
    const adminCookieThrottle = cookie;
    const wrong = async () =>
      (await call("POST", "/api/auth/staff", { token, password: "wrong-on-purpose" })).status;

    const firstRun = [];
    for (let i = 0; i < 4; i++) firstRun.push(await wrong());
    check(
      "four wrong passwords are still answered normally",
      firstRun.every((s) => s === 401),
      firstRun.join(",")
    );

    const good = await call("POST", "/api/auth/staff", { token, password: STAFF_PASSWORD });
    check(
      "the right password still works, and clears the counter",
      good.status === 200,
      `got ${good.status}`
    );

    const secondRun = [];
    for (let i = 0; i < 4; i++) secondRun.push(await wrong());
    check(
      "a success reset the counter, so four more are fine",
      secondRun.every((s) => s === 401),
      secondRun.join(",")
    );

    // Five consecutive failures are answered normally; the sixth is refused.
    const fifth = await call("POST", "/api/auth/staff", {
      token,
      password: "wrong-on-purpose",
    });
    check("the fifth failure is still answered", fifth.status === 401, `got ${fifth.status}`);

    const blocked = await call("POST", "/api/auth/staff", {
      token,
      password: "wrong-on-purpose",
    });
    check("the sixth attempt is throttled", blocked.status === 429, `got ${blocked.status}`);

    const retryAfter = blocked.headers?.get?.("retry-after");
    check("429 carries a Retry-After header", Number(retryAfter) > 0, retryAfter || "none");

    // The sign-in above replaced the shared cookie with a staff session.
    cookie = adminCookieThrottle;

    const adminStillIn = await call("POST", "/api/auth/login", ADMIN);
    check(
      "the lockout is scoped to that one account",
      adminStillIn.status === 200,
      `got ${adminStillIn.status}`
    );

    // Park the throwaway account: inactive, with a rotated code.
    await call("PATCH", `/api/users/${throttleUser.id}`, {
      is_active: false,
      regenerate_token: true,
    });
  }

  section("sign out");
  res = await call("POST", "/api/auth/logout");
  check("POST /api/auth/logout -> 200", res.status === 200);

  cookie = "";
  res = await call("GET", "/api/items");
  check("session is gone -> 401", res.status === 401, `got ${res.status}`);

  console.log(`\n${"-".repeat(46)}`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSmoke test crashed:", e.message);
  process.exit(1);
});
