/**
 * Export preview — end-to-end regression tests.
 *
 *   npm run dev:test   (in one terminal)
 *   npm run test:report-preview-e2e
 *
 * Two halves:
 *
 *   HTTP (fetch)  — the /api/report-preview endpoint itself: authentication,
 *                   timezone validation, and the completeness envelope it
 *                   returns. Read-only; writes nothing to the ledger.
 *
 *   Browser (playwright-core, system Chrome) — the completeness wording the
 *                   export preview renders, driven against the real page with
 *                   the preview response mocked so all three states
 *                   (complete / truncated / unknown) and an independently
 *                   mixed pair can be observed. Also proves that a failed
 *                   catalogue load cannot leave partial data on screen.
 *
 * Runs against the isolated test database (npm run dev:test on port 3101).
 * Refuses to run against a live database, like every other suite here.
 */
import { chromium } from "playwright-core";
import { assertTestTarget } from "./_guard.mjs";

const BASE = process.env.BASE_URL || "http://localhost:3101";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "admin123";

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
    console.error(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

async function login(username, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  return {
    status: r.status,
    data: ct.includes("json") ? await r.json().catch(() => null) : null,
    headers: r.headers,
  };
}
async function rawCall(method, path, rawBody, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: rawBody,
    redirect: "manual",
  });
  const ct = r.headers.get("content-type") || "";
  return {
    status: r.status,
    data: ct.includes("json") ? await r.json().catch(() => null) : null,
  };
}

const ADMIN_PREVIEW = {
  completeness: {
    items: "unknown",
    movements: "truncated",
    itemsScanned: 10000,
    movementsScanned: 5000,
    itemCap: 10000,
    movementCap: 5000,
  },
  warnings: [
    "The report includes the first 10,000 catalogue items (ordered by name); whether more exist could not be verified.",
  ],
  itemsIncluded: 10000,
  movementsIncluded: 5000,
};

const SWAPPED_PREVIEW = {
  completeness: {
    items: "truncated",
    movements: "unknown",
    itemsScanned: 10000,
    movementsScanned: 5000,
    itemCap: 10000,
    movementCap: 5000,
  },
  warnings: [],
  itemsIncluded: 10000,
  movementsIncluded: 5000,
};

const isKnownState = (value) => ["complete", "truncated", "unknown"].includes(value);

(async () => {
  await assertTestTarget(BASE);

  /* ================= endpoint over HTTP ================= */

  section("endpoint — authentication and input handling");
  let r = await call("POST", "/api/report-preview", {});
  check("preview without a session is refused (401)", r.status === 401, `${r.status}`);
  check(
    "the refusal carries a non-empty error and the db-mode tag",
    typeof r.data?.error === "string" &&
      r.data.error.length > 0 &&
      typeof r.headers.get("x-cafetrack-db") === "string",
    `error=${r.data?.error} x-cafetrack-db=${r.headers.get("x-cafetrack-db")}`
  );

  r = await call("POST", "/api/report-preview", {}, "cafetrack_session=not-a-real-token");
  check("a garbage session cookie is refused (401)", r.status === 401, `${r.status}`);

  const admin = await login("admin", ADMIN_PASSWORD);
  const cookie = admin.cookie;
  check("admin can sign in", admin.status === 200, `${admin.status}`);

  r = await rawCall("POST", "/api/report-preview", "{not json", cookie);
  check("a malformed JSON body is a 400, not a silent default report", r.status === 400, `${r.status}`);

  r = await call("POST", "/api/report-preview", { tz: "Mars/Olympus_Mons" }, cookie);
  check(
    "an unrecognised timezone is a 400 naming the timezone",
    r.status === 400 && /timezone/i.test(r.data?.error ?? ""),
    `${r.status} ${r.data?.error ?? ""}`
  );

  r = await call("POST", "/api/report-preview", {}, cookie);
  check("a well-formed preview request answers 200", r.status === 200, `${r.status}`);
  if (r.status === 200) {
    const c = r.data?.completeness ?? {};
    check(
      "both sections report a known completeness state",
      isKnownState(c.items) && isKnownState(c.movements),
      `items=${c.items} movements=${c.movements}`
    );
    check(
      "scan counts and caps are finite numbers",
      [c.itemsScanned, c.movementsScanned, c.itemCap, c.movementCap].every(
        (n) => typeof n === "number" && Number.isFinite(n)
      ),
      JSON.stringify(c)
    );
    check("warnings is an array", Array.isArray(r.data?.warnings), typeof r.data?.warnings);
    check(
      "itemsIncluded and movementsIncluded are counts",
      [r.data?.itemsIncluded, r.data?.movementsIncluded].every((n) => Number.isInteger(n) && n >= 0),
      `itemsIncluded=${r.data?.itemsIncluded} movementsIncluded=${r.data?.movementsIncluded}`
    );
    if (isKnownState(c.items) && isKnownState(c.movements)) {
      const unknown = [c.items, c.movements].includes("unknown");
      if (unknown) {
        check(
          "when a section is unknown, its warning says it could not be verified",
          r.data.warnings.some((w) => /could not be verified/i.test(w)),
          JSON.stringify(r.data.warnings)
        );
      } else {
        check(
          "with the default caps on the seeded database, both sections verify complete",
          c.items === "complete" && c.movements === "complete",
          `items=${c.items} movements=${c.movements}`
        );
      }
    }
  }

  /* ================= the preview's UI wording ================= */

  section("browser — completeness wording in the export preview");
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const openPreview = async () => {
    await page.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^export$/i }).first().click();
    await page.getByRole("menuitem", { name: /download pdf/i }).click();
    const dialog = page.getByRole("dialog", { name: /export report/i });
    await dialog.waitFor({ state: "visible", timeout: 15000 });
    await dialog
      .getByText(/verifying report completeness/i)
      .waitFor({ state: "hidden", timeout: 15000 })
      .catch(() => {}); // already settled
    return dialog;
  };
  const dialogText = (dialog) => dialog.textContent();

  // Sign in through the real form, the same way the UI suite does: the form
  // defaults to staff mode, so admin mode has to be selected first.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^admin$/i }).click();
  await page.getByPlaceholder(/username/i).first().fill("admin");
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /^(login|sign in|log in)$/i }).first().click();
  await page
    .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 })
    .catch(() => {});

  let dialog = await openPreview();
  let text = await dialogText(dialog);
  check(
    "the freshly seeded report previews as Complete for both sections",
    /Catalogue items:\s*Complete/.test(text) && /Transactions:\s*Complete/.test(text),
    text.match(/(Catalogue items|Transactions):\s*[^\n(]+/g)?.join(" | ")
  );

  // Mixed mock: items unknown, transactions truncated.
  const mixedHandler = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ADMIN_PREVIEW),
    });
  await page.route("**/api/report-preview", mixedHandler);
  dialog = await openPreview();
  text = await dialogText(dialog);
  check(
    "an unknown catalogue renders 'Unknown — could not verify'",
    /Catalogue items:\s*Unknown — could not verify/.test(text),
    text.match(/Catalogue items:[^\n(]*/)?.[0]
  );
  check(
    "a truncated ledger renders 'Truncated'",
    /Transactions:\s*Truncated/.test(text),
    text.match(/Transactions:[^\n(]*/)?.[0]
  );
  check(
    "the builder's warning is shown, not hidden",
    text.includes("whether more exist could not be verified"),
    ""
  );
  await page.unroute("**/api/report-preview", mixedHandler);

  // Swapped mock: items truncated, transactions unknown — independently.
  const swappedHandler = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SWAPPED_PREVIEW),
    });
  await page.route("**/api/report-preview", swappedHandler);
  dialog = await openPreview();
  text = await dialogText(dialog);
  check(
    "a truncated catalogue renders 'Truncated'",
    /Catalogue items:\s*Truncated/.test(text),
    text.match(/Catalogue items:[^\n(]*/)?.[0]
  );
  check(
    "an unknown ledger renders 'Unknown — could not verify'",
    /Transactions:\s*Unknown — could not verify/.test(text),
    text.match(/Transactions:[^\n(]*/)?.[0]
  );
  await page.unroute("**/api/report-preview", swappedHandler);

  section("browser — a failed catalogue load leaves nothing partial on screen");
  const failedCatalogue = (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "boom" }),
    });
  await page.route(/\/api\/items\?/, failedCatalogue);
  await page.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
  const banner = page.getByRole("alert").filter({ hasText: /full item catalogue/i });
  await banner.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  check("the honest error banner is shown", (await banner.count()) > 0);
  await page.getByRole("tab", { name: /^inventory$/i }).click();
  check(
    "the On-hand table shows its empty state, not part of the catalogue",
    (await page.getByText("No items yet.").count()) > 0
  );
  check(
    "the Export control is disabled while the catalogue is missing",
    await page.getByRole("button", { name: /^export$/i }).first().isDisabled()
  );
  await page.unroute(/\/api\/items\?/, failedCatalogue);

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.error(`failures:\n  - ${failures.join("\n  - ")}`);
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
