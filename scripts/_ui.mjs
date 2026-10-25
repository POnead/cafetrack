/**
 * CafeTrack browser tests — drives the real UI in Chrome.
 *
 *   npm run dev                     (in one terminal)
 *   npm run test:ui                 (in another)
 *
 * The other suites speak HTTP. This one clicks, types, and looks, because that
 * is the only way to check the things a user actually experiences: that a
 * button is reachable and does what its label says, that the barcode scan field
 * takes focus without being clicked (which is the whole point of the USB
 * scanner), and that a page does not throw JavaScript while it renders.
 *
 * It also records every console error and failed request on every page, which
 * a 200 response cannot tell you about.
 *
 * Uses playwright-core against the Chrome already installed on the machine
 * (channel: "chrome"), so no browser download is needed.
 *
 * Expects a freshly seeded database. Screenshots land in ui-screenshots/.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { assertTestTarget } from "./_guard.mjs";

// "localhost", not "127.0.0.1": Next 16 blocks cross-origin access to its dev
// resources (the HMR socket) from any origin not listed in allowedDevOrigins,
// and localhost is already permitted. Using the IP would log a blocked-request
// warning and stop the page hydrating.
const BASE = process.env.BASE_URL || "http://localhost:3100";

/**
 * The checkout scan field, located by its accessible name.
 *
 * See the note in scripts/_usertour.mjs — matching on placeholder copy meant a
 * routine rewrite of the search field broke both suites at once, and the one
 * failure that mattered (the scan field stopped reclaiming focus) was buried under
 * two that just meant "wording changed".
 */
const scanFieldOn = (page) => page.getByLabel("Scan an item barcode").first();
const SHOTS = "ui-screenshots";

let pass = 0;
let fail = 0;
const failures = [];
const consoleErrors = [];
const failedRequests = [];

/**
 * Non-2xx responses this suite provokes on purpose. Chrome logs a console
 * error for every one, so without this the run would report its own negative
 * tests as application defects. Each is a behaviour the suite is asserting.
 */
const expectedStatusNoise = [
  /status of 404 \(Not Found\)/, // the deliberate bad-scan
  /status of 403 \(Forbidden\)/, // the staff-is-blocked guard check
];

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

mkdirSync(SHOTS, { recursive: true });

// Before the launch, deliberately: the guard calls process.exit when the target
// is a live database, and exiting from inside the try/finally below would skip
// the finally and orphan a headless Chrome.
await assertTestTarget(BASE);

const browser = await chromium.launch({ channel: "chrome", headless: true });

/** A page that records console errors and failed requests as it goes. */
async function newPage(context, label) {
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      if (/Download the React DevTools/i.test(t)) return;
      // Chrome logs a console error for ANY non-2xx fetch. Two of those are
      // this suite's own doing and are the behaviour under test, not a defect:
      // the deliberate bad-scan (404 from /api/items/lookup) and the staff
      // guard check (403 from the admin-only routes). Everything else counts.
      if (expectedStatusNoise.some((re) => re.test(t))) return;
      consoleErrors.push(`[${label}] ${t.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${label}] uncaught: ${e.message.slice(0, 200)}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "failed";
    if (/ERR_ABORTED/.test(f)) return;
    failedRequests.push(`[${label}] ${r.method()} ${r.url()} - ${f}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) failedRequests.push(`[${label}] ${r.status()} ${r.url()}`);
  });
  return page;
}

async function signInAdmin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /admin/i }).click();
  await page.getByPlaceholder(/username/i).first().fill("admin");
  await page.locator('input[type="password"]').first().fill("admin123");
  await page.getByRole("button", { name: /^(login|sign in|log in)$/i }).first().click();
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function signInStaff(page, token) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /staff/i }).click();
  // By aria-label, not by placeholder. The field's placeholder reads "Scan your
  // staff ID" — aimed at someone holding a scanner, not someone reading a test —
  // and the wording has already broken this selector once.
  // Password first, then the code. A scan submits the form immediately — that is
  // the point of the field, since a scanner sends the code and then Enter — so
  // filling the code first would post an empty password and fail.
  await page.locator('input[type="password"]').first().fill("staff123");
  // `#staff-username`, not a label match. See the note in signInStaff in
  // scripts/_usertour.mjs — the staff field has never been called "staff barcode
  // code", and asking for it costs this suite a thirty-second timeout.
  const codeField = page.locator("#staff-username").first();
  await codeField.fill(token);
  // Enter is required. ScanInput holds what was typed as local state and only
  // hands it up on Enter or the Add button, so filling the field alone submits
  // nothing.
  await codeField.press("Enter");
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

try {
  console.log(`CafeTrack browser tests against ${BASE}\n`);

  /* ================================================================= */
  section("SETUP - sign in through the real form");
  /* ================================================================= */
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const admin = await newPage(adminCtx, "admin");

  await admin.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  check("the login page loads", await admin.getByText(/CafeTrack/).first().isVisible());
  check(
    "it offers a staff and an admin mode",
    (await admin.getByRole("button", { name: /staff/i }).count()) > 0 &&
      (await admin.getByRole("button", { name: /admin/i }).count()) > 0
  );
  await admin.screenshot({ path: `${SHOTS}/01-login.png` });

  await signInAdmin(admin);
  check("admin sign-in reaches the dashboard", admin.url().includes("/dashboard"), admin.url());
  await admin.waitForTimeout(1200);
  await admin.screenshot({ path: `${SHOTS}/02-dashboard-admin.png`, fullPage: true });

  /* ================================================================= */
  section("ITEMS - add an ingredient through the form");
  /* ================================================================= */
  const stamp = Date.now().toString(36);
  const itemName = `UI Test Oats ${stamp}`;

  await admin.goto(`${BASE}/items`, { waitUntil: "networkidle" });
  const addBtn = admin.getByRole("button", { name: /add (item|ingredient)|new item/i }).first();
  check("an add-item control is reachable", await addBtn.isVisible());
  await addBtn.click();
  await admin.waitForTimeout(500);

  const nameField = admin.getByPlaceholder(/arabica coffee beans/i).first();
  check("a name field is present", await nameField.isVisible());
  await nameField.fill(itemName);

  // Targeted by label rather than by `input[type="number"]` position: the form
  // has several number inputs, and "the first one" silently changed meaning when
  // the units-per-box field was added above it. A positional selector here made
  // the suite fill a quantity into the wrong field and then fail three steps
  // later with an empty cart, which is a miserable thing to debug.
  const qtyField = admin.getByLabel(/starting quantity|quantity on hand/i).first();
  check("a quantity field is present", await qtyField.isVisible());
  await qtyField.fill("10");

  await admin.screenshot({ path: `${SHOTS}/03-item-form.png` });
  await admin.getByRole("button", { name: /^(create item|save changes|save)/i }).last().click();
  await admin.waitForTimeout(1800);

  const listed = await admin.getByText(itemName).count();
  check("the new ingredient appears in the list", listed > 0, `${listed} match(es)`);
  await admin.screenshot({ path: `${SHOTS}/04-items-list.png`, fullPage: true });

  const rowText = await admin.locator("tr", { hasText: itemName }).first().innerText();
  const sku = (rowText.match(/CT-[A-Z]{3}-[0-9A-F]{4}/) ?? [])[0] ?? "";
  check("the item was assigned a SKU", Boolean(sku), sku || "not found in the row");

  /* ================================================================= */
  section("SCANNER - the barcode input a USB scanner drives");
  /* ================================================================= */
  await admin.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await admin.waitForTimeout(800);
  await admin.screenshot({ path: `${SHOTS}/05-checkout.png`, fullPage: true });

  // The scan field is what a USB scanner types into, and it must hold focus on
  // its own — a barcode gun types and presses Enter with no click at all.
  const scanField = scanFieldOn(admin);
  check("the scan field is present", await scanField.isVisible());

  await admin.evaluate(() => document.body.click());
  await admin.waitForTimeout(1000); // past the 800ms refocus interval
  const focusedWithoutClick = await admin.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("aria-label") === "Scan an item barcode";
  });
  check("it reclaims focus without being clicked", focusedWithoutClick);

  // Type like a scanner: fast, then Enter.
  await scanField.pressSequentially(sku, { delay: 12 });
  await scanField.press("Enter");
  await admin.waitForTimeout(1200);
  const inCart = await admin.getByText(itemName).count();
  check("a scanned code lands in the cart", inCart > 0, `${inCart} match(es)`);
  await admin.screenshot({ path: `${SHOTS}/06-scanned-into-cart.png`, fullPage: true });

  await admin.evaluate(() => document.body.click());
  await admin.waitForTimeout(1000);
  await scanField.pressSequentially("CT-NOPE-0000", { delay: 12 });
  await scanField.press("Enter");
  await admin.waitForTimeout(1200);
  const stillThere = await admin.getByText(itemName).count();
  check("a bad scan does not clear the cart", stillThere > 0);
  const errShown = (await admin.getByText(/no item matches|not an item|staff id/i).count()) > 0;
  check("a bad scan shows a readable error", errShown);
  await admin.screenshot({ path: `${SHOTS}/07-bad-scan-error.png`, fullPage: true });

  /* ================================================================= */
  section("CHECKOUT - confirm a real movement in the browser");
  /* ================================================================= */
  const readQty = async () =>
    admin.evaluate(async (s) => {
      const r = await fetch(`/api/items/lookup?code=${encodeURIComponent(s)}`);
      const d = await r.json();
      return Number(d.item?.quantity);
    }, sku);

  const before = await readQty();
  check("stock before the checkout is 10", before === 10, `now ${before}`);

  const confirmBtn = admin.getByRole("button", { name: /review &amp; commit|review & commit/i }).first();
  check("a confirm control is reachable", await confirmBtn.isVisible());
  await confirmBtn.click();
  await admin.waitForTimeout(700);

  const pwField = admin.locator('input[type="password"]').last();
  check("confirming asks for a password", await pwField.isVisible());
  await pwField.fill("admin123");
  await admin.screenshot({ path: `${SHOTS}/08-confirm-modal.png` });
  await admin.getByRole("button", { name: /^(confirm checkout|confirm restock|confirm waste log)$/i }).last().click();
  await admin.waitForTimeout(2200);
  await admin.screenshot({ path: `${SHOTS}/09-after-checkout.png`, fullPage: true });

  const after = await readQty();
  check("stock dropped in the database", after === 9, `now ${after}`);

  /* ================================================================= */
  section("ALERTS - an admin sees the controls");
  /* ================================================================= */
  await admin.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
  await admin.waitForTimeout(1500);
  await admin.screenshot({ path: `${SHOTS}/10-alerts-admin.png`, fullPage: true });
  check("an admin sees the Recompute control", (await admin.getByRole("button", { name: /recompute/i }).count()) > 0);

  /* ================================================================= */
  section("STAFF - the same pages, with the admin controls absent");
  /* ================================================================= */
  const usersRes = await admin.evaluate(async () => {
    const r = await fetch("/api/users");
    return (await r.json()).users;
  });
  // The seeded account specifically, not merely the first active staff member.
// Every other suite in this repository creates throwaway staff accounts with
// their own passwords, so "the first active staff user" can be one of those — and
// signing in with the seed password then fails for reasons that have nothing to
// do with the UI under test. The seeded name is stable because it comes from
// src/lib/local-db.ts.
const staffUser =
    (usersRes ?? []).find((u) => u.username === "barista1" && u.is_active) ??
    (usersRes ?? []).find((u) => u.role === "staff" && u.is_active);
  check("an active staff account exists to sign in as", Boolean(staffUser), staffUser?.username ?? "none");

  if (staffUser) {
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const staff = await newPage(staffCtx, "staff");

    await signInStaff(staff, staffUser.qr_token);
    check("staff sign-in with a barcode reaches the dashboard", staff.url().includes("/dashboard"), staff.url());
    await staff.waitForTimeout(1200);
    await staff.screenshot({ path: `${SHOTS}/11-dashboard-staff.png`, fullPage: true });

    const navText = await staff.locator("nav, aside, header").first().innerText().catch(() => "");
    check("staff nav does not offer Staff Accounts", !/staff accounts/i.test(navText), navText.replace(/\n/g, " | ").slice(0, 90));
    check("staff nav does not offer Settings", !/^settings$/im.test(navText));
    check("staff nav does not offer the Audit Trail", !/audit trail/i.test(navText));

    await staff.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
    await staff.waitForTimeout(1500);
    await staff.screenshot({ path: `${SHOTS}/12-alerts-staff.png`, fullPage: true });
    check("staff sees no Recompute button", (await staff.getByRole("button", { name: /recompute/i }).count()) === 0);
    check("staff sees no Manage items button", (await staff.getByRole("button", { name: /manage items/i }).count()) === 0);
    check("staff can still read the alert page", (await staff.getByText(/alert/i).count()) > 0);

    // Scoped to a *visible* link under /alerts/. The page renders the list twice
    // — a mobile card and a desktop table — and both carry a View link, so a
    // role-based `.first()` can land on the copy that is display:none. It also
    // asserts the navigation actually happened, because a click that silently
    // does nothing used to fail several lines later for the wrong reason.
    const alertLink = staff.locator('a[href^="/alerts/"]:visible').first();
    if ((await alertLink.count()) > 0) {
      await alertLink.click();
      const navigated = await staff
        .waitForURL(/\/alerts\/[0-9a-f-]{36}/i, { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      check("a View link opens the alert detail page", navigated, staff.url());

      // Wait for the page's own loading state to clear rather than sleeping a
      // fixed interval. The detail page fetches client-side, and on a cold dev
      // server that first compile can outlast any fixed wait — which showed up
      // as a false failure with the page still reading "Loading…".
      await staff
        .getByText(/loading/i)
        .first()
        .waitFor({ state: "hidden", timeout: 20000 })
        .catch(() => {});
      await staff.waitForLoadState("networkidle").catch(() => {});
      await staff.screenshot({ path: `${SHOTS}/13-alert-detail-staff.png`, fullPage: true });
      check("staff sees no Resolve alert button", (await staff.getByRole("button", { name: /resolve alert/i }).count()) === 0);
      check("staff is told resolution is admin-only", (await staff.getByText(/only an administrator/i).count()) > 0, staff.url());
    }

    const guard = await staff.evaluate(async (base) => {
      const out = {};
      for (const p of ["/api/users", "/api/settings", "/api/audit"]) {
        const r = await fetch(base + p);
        out[p] = r.status;
      }
      return out;
    }, BASE);
    check(
      "staff API calls to admin routes are refused",
      Object.values(guard).every((s) => s === 403),
      JSON.stringify(guard)
    );

    await staffCtx.close();
  }

  /* ================================================================= */
  section("RESPONSIVE - the checkout page on a phone");
  /* ================================================================= */
  // Borrows the admin's session — see the note on the parity contexts below for
  // why a second admin login breaks every context that signed in before it.
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    storageState: await adminCtx.storageState(),
  });
  const phone = await newPage(phoneCtx, "phone");
  await phone.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
  await phone.waitForTimeout(1500);
  await phone.screenshot({ path: `${SHOTS}/14-phone-dashboard.png`, fullPage: true });

  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  check("no horizontal overflow at 390px", overflow <= 1, `${overflow}px`);

  await phone.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await phone.waitForTimeout(1200);
  await phone.screenshot({ path: `${SHOTS}/15-phone-checkout.png`, fullPage: true });
  const overflow2 = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  check("checkout does not overflow at 390px", overflow2 <= 1, `${overflow2}px`);
  check("the scan field is usable on a phone", await scanFieldOn(phone).isVisible());
  await phoneCtx.close();

  /* ================================================================= */
  section("RESPONSIVE PARITY — no control that only exists on a phone");
  /* ================================================================= */

  // Every page renders two layouts: a `lg:hidden` card list and a `hidden
  // lg:block` table. They are meant to be the same page, so anything a person
  // can do in one they should be able to do in the other.
  //
  // This exists because that was not true and nothing noticed. The item-management
  // grant and the approval-code control were rendered inside the mobile card
  // only, so on a desktop an admin had no route to either — the "let staff skip
  // the approvals queue" feature was entirely unreachable on a laptop, while the
  // API behind it worked perfectly and every request-level test passed. The
  // failure was invisible to the whole suite because the API was fine and the
  // markup was fine; only the two layouts disagreed.
  //
  // So: collect the controls a person can actually reach at 390px, and require
  // each one to be present at 1440px as well. Duplicates are fine and expected —
  // they are how the two layouts stay in step. A control that exists on only one
  // is a feature nobody on the other screen can use.

  /*
   * Both parity contexts borrow the admin's cookies rather than logging in again.
   *
   * Signing in as admin three times in one run is what broke this suite. Only one
   * session per account is valid at a time — by design, FR-16 — so the second
   * login overwrote `users.session_token` and the original desktop context's
   * cookie stopped validating. Everything after it failed on 401s, and the
   * console check then reported those 401s as uncaught JavaScript errors, which
   * is how a session problem presented as a front-end one.
   *
   * `storageState` copies cookies and localStorage without minting a token, so all
   * three screens are demonstrably the same person rather than three logins.
   */
  const parityCtx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: await adminCtx.storageState(),
  });
  const parityDesktop = await newPage(parityCtx, "parity-desktop");
  await parityDesktop.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });

  const parityCtxPhone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await adminCtx.storageState(),
  });
  const parityPhone = await newPage(parityCtxPhone, "parity-phone");
  await parityPhone.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });

  /** Visible, reachable controls on the page, identified by a stable label. */
  const controlsOn = async (page) =>
    page.evaluate(() => {
      const visible = (el) => {
        const s = getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      };
      const label = (el) => {
        const aria = el.getAttribute("aria-label");
        if (aria) return `${el.tagName.toLowerCase()}[aria=${aria}]`;
        const id = el.getAttribute("id");
        if (id && el.labels?.[0]) return `${el.tagName.toLowerCase()}[for=${id}]`;
        const text = (el.innerText || el.value || el.placeholder || "").replace(/\s+/g, " ").trim();
        return text ? `${el.tagName.toLowerCase()}[${text.slice(0, 40)}]` : "";
      };
      return [...document.querySelectorAll("button, input, select, textarea")]
        .filter(visible)
        .map(label)
        .filter(Boolean);
    });

  // Controls that are legitimately one-breakpoint-only. Kept short on purpose —
  // every entry is a case where having the control on one screen is the correct
  // design, not an oversight.
  //
  // Where the entry names a `because`, that is not an explanation but a
  // requirement: the desktop must actually have that control, or the check
  // fails. An allowlist that takes the assertion's word for it is how a guard
  // quietly stops guarding, so these are verified rather than trusted.
  const EXPECTED_MOBILE_ONLY = [
    {
      re: /^button\[aria=(Open|Close) menu\]$/,
      because: null,
      why: "the sidebar is permanent from lg up, so a drawer toggle has nothing to do",
    },
    {
      // ScanInput renders a small "Add" at every width and a full-width "Add
      // item" under sm: for thumb-sized tapping.
      re: /^button\[Add item\]$/,
      because: /^button\[Add\]$/,
      why: "a larger tap target; the plain 'Add' must still exist at both widths",
    },
  ];

  const PARITY_PAGES = [
    "/dashboard", "/items", "/checkout", "/alerts", "/reports",
    "/approvals", "/users", "/settings", "/audit", "/email",
  ];

  for (const path of PARITY_PAGES) {
    await parityPhone.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await parityPhone.waitForTimeout(700);
    const phoneControls = await controlsOn(parityPhone);

    await parityDesktop.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await parityDesktop.waitForTimeout(700);
    const desktopControls = await controlsOn(parityDesktop);

    // Ignore controls that are legitimately page furniture rather than actions:
    // the search box and filters are duplicated in both layouts but are matched
    // by placeholder/aria, and a handful of labelled inputs legitimately differ
    // in wording between the two. Only *buttons* are compared, because a button
    // is an action a person is being offered, and those must match.
    const phoneButtons = phoneControls.filter((c) => c.startsWith("button["));
    const desktopTexts = new Set(desktopControls);

    // Only a control that is actually absent from the desktop needs an
    // exemption. An entry matching a button that both layouts share is not a
    // phone-only control at all, and treating it as one would test its
    // `because` requirement for no reason.
    const missing = phoneButtons.filter((c) => !desktopTexts.has(c));
    const exempted = missing.filter((c) => EXPECTED_MOBILE_ONLY.some((e) => e.re.test(c)));
    const unaccounted = missing.filter((c) => !EXPECTED_MOBILE_ONLY.some((e) => e.re.test(c)));

    check(
      `${path} — every phone-only action is also on a desktop`,
      unaccounted.length === 0,
      unaccounted.length === 0
        ? `${phoneButtons.length} phone actions, all present` +
          (exempted.length ? ` (${exempted.length} known responsive duplicate)` : "")
        : `missing on desktop: ${unaccounted.slice(0, 4).join(" , ")}`
    );

    // An exemption is honoured only while its stated requirement holds, so
    // removing the desktop counterpart fails here instead of passing quietly.
    for (const c of exempted) {
      const entry = EXPECTED_MOBILE_ONLY.find((e) => e.re.test(c));
      if (!entry?.because) continue;
      const has = [...desktopTexts].some((d) => entry.because.test(d));
      check(
        `${path} — the desktop really does have the control behind "${entry.why}"`,
        has,
        has ? "present" : "MISSING — the exemption no longer applies"
      );
    }
  }

  await parityCtx.close();
  await parityCtxPhone.close();

  /* ================================================================= */
  section("CLEANUP - leave the database as it was found");
  /* ================================================================= */
  // `limit` because `/api/items` pages and defaults to 50 rows; the test item is
  // not on the first page once the database has any history behind it. Same bug
  // the tour had — see its cleanup section.
  const del = await admin.evaluate(async (name) => {
    const list = await (await fetch("/api/items?limit=500")).json();
    const hit = (list.items ?? []).find((i) => i.name === name);
    if (!hit) return "not found";
    const r = await fetch(`/api/items/${hit.id}`, { method: "DELETE" });
    return String(r.status);
  }, itemName);
  check("the test ingredient was removed", del === "200", del);

  await adminCtx.close();

  /* ================================================================= */
  section("CONSOLE - errors and failed requests seen along the way");
  /* ================================================================= */
  check("no uncaught JavaScript errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" // "));
  check("no failed or 5xx requests", failedRequests.length === 0, failedRequests.slice(0, 3).join(" // "));
} catch (e) {
  fail++;
  failures.push(`suite crashed: ${e.message}`);
  console.log(`\n  FAIL  suite crashed: ${e.message}`);
} finally {
  await browser.close();
}

console.log(`\n${"-".repeat(52)}`);
console.log(`${pass} passed, ${fail} failed`);
if (consoleErrors.length) {
  console.log("\nConsole errors:");
  consoleErrors.forEach((e) => console.log(`  - ${e}`));
}
if (failedRequests.length) {
  console.log("\nFailed requests:");
  failedRequests.forEach((e) => console.log(`  - ${e}`));
}
if (fail) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log(`\nScreenshots in ${SHOTS}/`);
process.exit(fail ? 1 : 0);

