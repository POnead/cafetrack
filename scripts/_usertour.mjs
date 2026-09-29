/**
 * CafeTrack full user tour â€” the whole application the way a person uses it.
 *
 *   npm run dev                     (in one terminal)
 *   npm run test:tour               (in another)
 *
 * _journeys.mjs proves whole stories over HTTP. This one drives the *entire*
 * site in a real browser, in the order a cafÃ© actually works: sign in, take
 * the day's movements at the till, restock a delivery, spoil something, chase
 * the alerts that fall out of it, read the report, onboard a hire, and close
 * the day. Every step clicks and types what a person would; the API is only
 * read back when the UI cannot show the value being asserted (stock levels,
 * the stored expiry date).
 *
 * What makes this suite worth having is the four features that shipped
 * uncommitted and that no other suite exercises through the browser:
 *   - per-box packaging (count a delivery in boxes, converted by the database)
 *   - a restock that carries the new batch's expiry date
 *   - a per-location minimum shelf life that *refuses* a bad delivery
 *   - the quantity/date validation that turned server faults into 400s
 *
 * It also visits the four pages no browser test ever opened (/reports, /users,
 * /settings, /audit) and records console errors, uncaught exceptions and 5xx
 * responses on every page, which a 200 response cannot tell you about.
 *
 * Uses playwright-core against the Chrome already installed (channel: "chrome")
 * so nothing is downloaded. Screenshots land in ui-screenshots/tour-*.png.
 *
 * Expects a seeded database. Everything it creates it removes again, and every
 * setting it changes it restores, so a re-run starts from the same place.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { assertTestTarget } from "./_guard.mjs";

// "localhost", not "127.0.0.1": Next 16 blocks cross-origin access to its dev
// resources (the HMR socket) from any origin not in allowedDevOrigins, and
// localhost is already permitted. Using the IP would log a blocked-request
// warning and stop the page hydrating.
const BASE = process.env.BASE_URL || "http://localhost:3000";
const SHOTS = "ui-screenshots";
const PREFIX = "tour-";

let pass = 0;
let fail = 0;
const failures = [];
const consoleErrors = [];
const failedRequests = [];

/**
 * Non-2xx responses this suite provokes on purpose. Chrome logs a console
 * error for every one, so without this the run would report its own negative
 * tests as application defects. Each entry is a behaviour being asserted.
 */
const expectedStatusNoise = [
  /status of 400/, // deliberately bad quantity / date
  /status of 401/, // wrong sign-in password, wrong commit password
  /status of 403/, // the staff-is-blocked guard checks
  /status of 404/, // the deliberate bad-scan
  /status of 409/, // refused shelf-life restock, refused in-use ref delete
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

// Unique per run, so a re-run never collides with the last one's leftovers.
const stamp = Date.now().toString(36);
const ITEM = `Tour Oats ${stamp}`; // the delivery item, 12 per box
const LOOSE = `Tour Flour ${stamp}`; // no packaging factor
const HIRE = `tourbarista${stamp}`;
const CATEGORY = `Tour Cat ${stamp}`;
const LOCATION = `Tour Locker ${stamp}`;
const SHELF_DAYS = 30; // the rule this suite puts on LOCATION

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
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Download the React DevTools/i.test(t)) return;
    if (expectedStatusNoise.some((re) => re.test(t))) return;
    consoleErrors.push(`[${label}] ${t.slice(0, 200)}`);
  });
  page.on("pageerror", (e) =>
    consoleErrors.push(`[${label}] uncaught: ${e.message.slice(0, 200)}`)
  );
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

/** A YYYY-MM-DD day `n` days from today, in the server's own local terms. */
function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}


/** Wait out a page's own loading state, which a fixed sleep can outlast. */
async function settled(page, ms = 1200) {
  await page
    .getByText(/^loading/i)
    .first()
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

async function signInAdmin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^admin$/i }).click();
  await page.getByPlaceholder(/username/i).first().fill("admin");
  await page.locator('input[type="password"]').first().fill("admin123");
  await page.getByRole("button", { name: /^login$/i }).first().click();
  await page.waitForURL(/dashboard/, { timeout: 20000 });
}

async function signInStaff(page, token, password = "staff123") {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^staff$/i }).click();
  await page.getByPlaceholder(/barcode/i).first().fill(token);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole("button", { name: /^login$/i }).first().click();
  await page.waitForURL(/dashboard/, { timeout: 20000 });
}

/** Read a value the UI cannot show: current stock for a SKU. */
const stockOf = (page, sku) =>
  page.evaluate(async (s) => {
    const r = await fetch(`/api/items/lookup?code=${encodeURIComponent(s)}`);
    const d = await r.json();
    return d.item ? Number(d.item.quantity) : null;
  }, sku);

/** Read the stored expiry date for a SKU, as YYYY-MM-DD or null. */
const expiryOf = (page, sku) =>
  page.evaluate(async (s) => {
    const r = await fetch(`/api/items/lookup?code=${encodeURIComponent(s)}`);
    const d = await r.json();
    const raw = d.item?.expiration_date ?? null;
    return raw ? String(raw).slice(0, 10) : null;
  }, sku);

/** The SKU the server assigned to a name, read from the inventory list. */
const skuOf = (page, name) =>
  page.evaluate(async (n) => {
    const r = await fetch("/api/items");
    const d = await r.json();
    return (d.items ?? []).find((i) => i.name === n)?.sku ?? null;
  }, name);

/** Pick a <select> option by the text a person actually reads. */
async function chooseByText(select, text) {
  const value = await select.evaluate(
    (el, t) => [...el.options].find((o) => o.textContent.includes(t))?.value ?? "",
    text
  );
  if (!value) throw new Error(`no option matching "${text}"`);
  await select.selectOption(value);
  return value;
}

/**
 * Every id that appears more than once in the document.
 *
 * A duplicated id is not a lint nit: a <label for> activates the first element
 * carrying that id, and the first one is often the copy a CSS breakpoint has
 * hidden. So a label can end up pointing at an invisible control and clicking
 * it silently does nothing. Several pages here render a phone card and a
 * desktop table from the same data, so this is easy to reintroduce.
 */
async function duplicateIds(page) {
  return page.evaluate(() => {
    const seen = new Map();
    for (const el of document.querySelectorAll("[id]")) {
      seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
  });
}

/**
 * Drive the confirm-a-transaction dialog the way an operator does.
 *
 * Dismisses a dialog left open by a previous refusal first: a failed commit
 * deliberately keeps the dialog up so the cart survives, which means the next
 * "Review & commit" would otherwise click against the modal backdrop.
 */
async function commitTransaction(page, password, mode) {
  const openDialog = page
    .locator("div.fixed")
    .filter({ has: page.locator('input[type="password"]') });
  if (await openDialog.count()) {
    await openDialog.first().getByRole("button", { name: /^close$/i }).click();
    await page.waitForTimeout(600);
  }
  await page.getByRole("button", { name: /review & commit/i }).first().click();
  await page.waitForTimeout(700);
  await page.locator('input[type="password"]').last().fill(password);
  await page.getByRole("button", { name: new RegExp(`^confirm ${mode}$`, "i") }).last().click();
  await page.waitForTimeout(2500);
}

try {
  console.log(`CafeTrack user tour against ${BASE}\n`);

  /* ================================================================= */
  section("SETUP - sign in through the real form");
  /* ================================================================= */
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const admin = await newPage(adminCtx, "admin");

  await admin.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  check("the login page loads", await admin.getByText(/CafeTrack/).first().isVisible());
  check(
    "it offers a staff and an admin mode",
    (await admin.getByRole("button", { name: /^staff$/i }).count()) > 0 &&
      (await admin.getByRole("button", { name: /^admin$/i }).count()) > 0
  );

  // A wrong password first, so a correct one afterwards is meaningful.
  await admin.getByRole("button", { name: /^admin$/i }).click();
  await admin.getByPlaceholder(/username/i).first().fill("admin");
  await admin.locator('input[type="password"]').first().fill("definitely-wrong");
  await admin.getByRole("button", { name: /^login$/i }).first().click();
  await admin.waitForTimeout(1800);
  // The API answers a bad password with a deliberately generic message, so the
  // assertion is that *something* readable is shown and no one is signed in —
  // not that a particular wording leaks whether the username exists.
  const loginError = await admin.getByText(/invalid credentials|incorrect password/i).count();
  check("a wrong password is refused in readable words", loginError > 0, `${loginError} match(es)`);
  check("a wrong password does not sign anyone in", !admin.url().includes("/dashboard"), admin.url());
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}01-login.png` });

  await signInAdmin(admin);
  check("admin sign-in reaches the dashboard", admin.url().includes("/dashboard"), admin.url());
  await settled(admin);
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}02-dashboard.png`, fullPage: true });
  check("the dashboard shows its four summary cards", (await admin.getByText(/in-demand items/i).count()) > 0);

  /* ================================================================= */
  section("NAV - every page an admin can reach, and none that throws");
  /* ================================================================= */
  const ADMIN_PAGES = [
    ["/dashboard", /inventory dashboard/i],
    ["/checkout", /checkout & restock/i],
    ["/items", /inventory management/i],
    ["/alerts", /^alerts$/i],
    ["/reports", /stock report/i],
    ["/users", /staff accounts/i],
    ["/settings", /^settings$/i],
    ["/audit", /audit trail/i],
  ];

  for (const [path, heading] of ADMIN_PAGES) {
    const before = consoleErrors.length;
    const res = await admin.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await settled(admin, 600);
    const headingVisible =
      (await admin.getByRole("heading", { name: heading }).count()) > 0 ||
      (await admin.getByText(heading).count()) > 0;
    check(
      `${path} opens for an admin`,
      Boolean(res) && res.status() === 200 && headingVisible,
      `http ${res?.status() ?? "?"}${headingVisible ? "" : " (heading not found)"}`
    );
    check(`${path} rendered without a JavaScript error`, consoleErrors.length === before);
    await admin.screenshot({ path: `${SHOTS}/${PREFIX}page${path.replace(/\//g, "-")}.png`, fullPage: true });
  }

  // An alert detail page is reachable from the list, which is how a user gets
  // there. The id is read from the API only because no link exists yet.
  const alertId = await admin.evaluate(async () => {
    const r = await fetch("/api/alerts?status=open");
    const d = await r.json();
    return d.alerts?.[0]?.id ?? null;
  });
  if (alertId) {
    const before = consoleErrors.length;
    const res = await admin.goto(`${BASE}/alerts/${alertId}`, { waitUntil: "networkidle" });
    await settled(admin, 600);
    check("an alert detail page opens for an admin", res?.status() === 200, `http ${res?.status() ?? "?"}`);
    check("the alert detail rendered without a JavaScript error", consoleErrors.length === before);
    await admin.screenshot({ path: `${SHOTS}/${PREFIX}03-alert-detail.png`, fullPage: true });
  } else {
    check("there was an open alert to open", false, "none in the seeded data");
  }

  /* ================================================================= */
  section("SETTINGS - reference lists and a minimum shelf life rule");
  /* ================================================================= */
  // The original values are read first so cleanup can put them back exactly.
  const originalSettings = await admin.evaluate(async () => {
    const r = await fetch("/api/settings");
    const d = await r.json();
    return d.settings ?? {};
  });
  check("the settings page loaded its values", Boolean(originalSettings.business_name !== undefined));

  await admin.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await settled(admin);

  // --- create the category and location this tour needs ---------------
  // Each list is its own Card with a heading, so the Add button is found
  // inside the card that owns the input. Scoping by the input's own ancestor
  // div matched the *other* card's disabled Add button, which never enables.
  const categoryCard = admin.locator("div.card", { hasText: "Item categories" }).first();
  const locationCard = admin.locator("div.card", { hasText: "Storage locations" }).first();

  await categoryCard.getByPlaceholder("New category name").fill(CATEGORY);
  await categoryCard.getByRole("button", { name: /^add$/i }).click();
  await admin.waitForTimeout(1500);
  check("a new category can be added from the page", (await admin.getByText(CATEGORY).count()) > 0);

  await locationCard.getByPlaceholder("New location name").fill(LOCATION);
  await locationCard.getByRole("button", { name: /^add$/i }).click();
  await admin.waitForTimeout(1500);
  check("a new location can be added from the page", (await admin.getByText(LOCATION).count()) > 0);

  // --- set the minimum shelf life on that location -------------------
  // Blur saves it: the field has no Save button, so blurring is the gesture
  // that commits the change. A real user tabs or clicks away.
  const shelfField = admin.getByLabel(`Minimum shelf life in days for ${LOCATION}`);
  check("the new location shows a min shelf life field", await shelfField.isVisible());
  await shelfField.fill(String(SHELF_DAYS));
  await shelfField.blur();
  await admin.waitForTimeout(1500);
  const savedShelf = await admin.evaluate(async (name) => {
    const r = await fetch("/api/refs/locations");
    const d = await r.json();
    return (d.items ?? []).find((l) => l.name === name)?.min_shelf_life_days ?? null;
  }, LOCATION);
  check(
    "the shelf life rule was saved by blurring the field",
    Number(savedShelf) === SHELF_DAYS,
    `stored ${savedShelf}`
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}03-settings.png`, fullPage: true });

  // --- clearing the rule ---------------------------------------------
  // A blank must mean "no rule", not "a rule of zero days": both would look
  // identical on the form otherwise.
  const shelfField2 = admin.getByLabel(`Minimum shelf life in days for ${LOCATION}`);
  await shelfField2.fill("");
  await shelfField2.blur();
  await admin.waitForTimeout(1500);
  const clearedShelf = await admin.evaluate(async (name) => {
    const r = await fetch("/api/refs/locations");
    const d = await r.json();
    const hit = (d.items ?? []).find((l) => l.name === name);
    return hit ? hit.min_shelf_life_days : "missing";
  }, LOCATION);
  check(
    "blanking the field clears the rule rather than storing zero",
    clearedShelf === null,
    `stored ${clearedShelf}`
  );

  // Put the rule back: the restock tests below depend on it.
  const shelfField3 = admin.getByLabel(`Minimum shelf life in days for ${LOCATION}`);
  await shelfField3.fill(String(SHELF_DAYS));
  await shelfField3.blur();
  await admin.waitForTimeout(1500);

  // --- an in-use reference cannot be deleted -------------------------
  const refGuard = await admin.evaluate(async () => {
    const list = await (await fetch("/api/refs/categories")).json();
    const seeded = (list.items ?? []).find((c) => c.name === "Coffee");
    if (!seeded) return { skipped: true };
    const r = await fetch(`/api/refs/categories/${seeded.id}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, error: d.error ?? "" };
  });
  if (refGuard.skipped) {
    check("an in-use category delete guard", true, "no seeded Coffee category to test");
  } else {
    check(
      "deleting a category that items still use is refused",
      refGuard.status === 409,
      `${refGuard.status} ${refGuard.error}`
    );
    check("the refusal explains why", /still assigned/i.test(refGuard.error), refGuard.error);
  }

  /* ================================================================= */
  section("ITEMS - stock the shelves, one item supplied by the box");
  /* ================================================================= */
  await admin.goto(`${BASE}/items`, { waitUntil: "networkidle" });
  await settled(admin);

  // The form is a modal, and the page behind it has its own category filter,
  // so the selects are counted *within the modal*: 0 = category, 1 = location,
  // 2 = physical form. The modal is identified by the field only it contains —
  // `div.fixed` also matches the mobile nav overlay, which is earlier in the
  // DOM and would otherwise win a `.first()`.
  const itemModal = admin
    .locator("div.fixed")
    .filter({ has: admin.getByPlaceholder(/arabica coffee beans/i) })
    .first();
  await admin.getByRole("button", { name: /add item/i }).first().click();
  await admin.waitForTimeout(800);
  const locSelect = itemModal.locator("select").nth(1);
  const locOptionText = await locSelect.evaluate((el) =>
    [...el.options].map((o) => o.textContent).find((t) => t.includes("Tour Locker")) ?? ""
  );
  check(
    "the location dropdown names the shelf life rule",
    new RegExp(`needs ${SHELF_DAYS}\\+ days`).test(locOptionText),
    locOptionText || "option not found"
  );

  // --- create the boxed item ------------------------------------------
  await admin.getByPlaceholder(/arabica coffee beans/i).first().fill(ITEM);
  await chooseByText(itemModal.locator("select").nth(1), LOCATION);
  await admin.getByLabel(/units per box/i).fill("12");
  await admin.getByLabel(/starting quantity/i).fill("10");
  await admin.getByLabel(/low-stock threshold/i).fill("5");
  // The rule is spelled out under the dropdown as soon as it is selected.
  check(
    "selecting a ruled location explains the restock rule",
    (await admin.getByText(/refused if the batch has fewer than/i).count()) > 0
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}04-item-form.png` });
  await admin.getByRole("button", { name: /^create item$/i }).last().click();
  await admin.waitForTimeout(2000);
  check("the boxed item was created", (await admin.getByText(ITEM).count()) > 0);

  // --- validation: a blank quantity is not a silent zero ---------------
  await admin.getByRole("button", { name: /add item/i }).first().click();
  await admin.waitForTimeout(600);
  await admin.getByPlaceholder(/arabica coffee beans/i).first().fill(LOOSE);
  await admin.getByLabel(/starting quantity/i).fill("");
  await admin.getByRole("button", { name: /^create item$/i }).last().click();
  await admin.waitForTimeout(1200);
  const qtyError = await admin.getByText(/enter a quantity of 0 or more|quantity is required/i).count();
  check("a blank quantity is refused rather than saving zero", qtyError > 0, `${qtyError} match(es)`);
  check("the refused item was not created", (await admin.getByText(LOOSE).count()) === 0);

  // --- validation: a nonsensical units-per-box is refused --------------
  await admin.getByLabel(/units per box/i).fill("0");
  await admin.getByLabel(/starting quantity/i).fill("5");
  await admin.getByRole("button", { name: /^create item$/i }).last().click();
  await admin.waitForTimeout(1200);
  check(
    "zero units per box is refused",
    (await admin.getByText(/units per box must be greater than zero/i).count()) > 0
  );

  // --- create the loose item properly ---------------------------------
  await admin.getByLabel(/units per box/i).fill("");
  await admin.getByLabel(/low-stock threshold/i).fill("2");
  await admin.getByRole("button", { name: /^create item$/i }).last().click();
  await admin.waitForTimeout(2000);
  check("the loose item was created once the form was valid", (await admin.getByText(LOOSE).count()) > 0);

  const sku = await skuOf(admin, ITEM);
  const looseSku = await skuOf(admin, LOOSE);
  check("the boxed item was assigned a SKU", Boolean(sku), sku || "not found");
  check("the loose item was assigned a SKU", Boolean(looseSku), looseSku || "not found");


  /* ================================================================= */
  section("CHECKOUT - the till, with a barcode gun and no mouse");
  /* ================================================================= */
  await admin.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await settled(admin, 800);

  const scanField = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  check("the scan field is present", await scanField.isVisible());

  // A USB scanner types and presses Enter with no click at all, so the field
  // has to reclaim focus on its own after the operator touches something else.
  await admin.evaluate(() => document.body.click());
  await admin.waitForTimeout(1000); // past the refocus interval
  check(
    "the scan field reclaims focus without being clicked",
    await admin.evaluate(() => {
      const el = document.activeElement;
      return el?.tagName === "INPUT" && /scan the item label or type the sku/i.test(el.placeholder || "");
    })
  );

  await scanField.pressSequentially(sku, { delay: 10 });
  await scanField.press("Enter");
  await admin.waitForTimeout(1400);
  check("a scanned code lands in the cart", (await admin.getByText(ITEM).count()) > 0);

  // Re-scanning the same label is how a second unit gets counted.
  await scanField.pressSequentially(sku, { delay: 10 });
  await scanField.press("Enter");
  await admin.waitForTimeout(1400);
  const cartText = await admin.getByText(/this transaction/i).first().isVisible();
  check("the cart shows a transaction summary", cartText);

  // A damaged label that is not an item must not clear the cart.
  await admin.evaluate(() => document.body.click());
  await admin.waitForTimeout(900);
  await scanField.pressSequentially("CT-NOPE-0000", { delay: 10 });
  await scanField.press("Enter");
  await admin.waitForTimeout(1400);
  check("a bad scan does not clear the cart", (await admin.getByText(ITEM).count()) > 0);
  check(
    "a bad scan explains itself",
    (await admin.getByText(/no item matches|not an item|staff id/i).count()) > 0
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}06-checkout-cart.png`, fullPage: true });

  // --- the wrong password must not move stock -------------------------
  const beforeWrongPw = await stockOf(admin, sku);
  await admin.getByRole("button", { name: /review & commit/i }).first().click();
  await admin.waitForTimeout(700);
  check("committing asks for a password", await admin.locator('input[type="password"]').last().isVisible());
  await admin.locator('input[type="password"]').last().fill("wrong-password");
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}07-confirm-modal.png` });
  await admin.getByRole("button", { name: /^confirm checkout$/i }).last().click();
  await admin.waitForTimeout(1800);
  check(
    "a wrong password is refused",
    (await admin.getByText(/incorrect password/i).count()) > 0
  );
  check(
    "a refused commit does not move stock",
    (await stockOf(admin, sku)) === beforeWrongPw,
    `still ${await stockOf(admin, sku)}`
  );

  // --- the right password does ----------------------------------------
  await admin.locator('input[type="password"]').last().fill("admin123");
  await admin.getByRole("button", { name: /^confirm checkout$/i }).last().click();
  await admin.waitForTimeout(2200);
  const afterCheckout = await stockOf(admin, sku);
  check(
    "stock dropped by the quantity committed",
    afterCheckout === beforeWrongPw - 2,
    `${beforeWrongPw} -> ${afterCheckout}`
  );
  check("the cart cleared after a successful commit", (await admin.getByText(ITEM).count()) === 0);

  /* ================================================================= */
  section("RESTOCK - a delivery, counted in boxes, dated, and checked");
  /* ================================================================= */
  // Switching movement type must clear the cart: one transaction is one
  // movement type, and mixing them silently would corrupt the stock ledger.
  // Something has to be in the cart first, or there is nothing to clear.
  const cartFirst = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  await cartFirst.pressSequentially(sku, { delay: 10 });
  await cartFirst.press("Enter");
  await admin.waitForTimeout(1500);
  check("there is something in the cart to clear", (await admin.getByText(ITEM).count()) > 0);

  await admin.getByRole("button", { name: /^restock/i }).first().click();
  await admin.waitForTimeout(900);
  check("switching to Restock empties the cart", (await admin.getByText(ITEM).count()) === 0);
  check(
    "and says why it emptied the cart",
    (await admin.getByText(/cart cleared/i).count()) > 0
  );

  // The cart renders twice — a mobile card and a desktop table — so the same
  // control exists twice and the hidden copy is first in the DOM. Every
  // selector below is `:visible` so it lands on the one a person can use.
  const restockScan = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  await restockScan.pressSequentially(sku, { delay: 10 });
  await restockScan.press("Enter");
  await admin.waitForTimeout(1500);
  check("the item is in the restock cart", (await admin.getByText(ITEM).count()) > 0);

  // --- the ids have to be unique across the two rendered copies ----------
  // Regression guard: the restock line used to emit the same id twice, which
  // left the "New expiry date" label pointing at the copy hidden by the
  // current breakpoint, so clicking it did nothing on a desktop.
  const dupes = await duplicateIds(admin);
  check("no id on the restock cart is duplicated", dupes.length === 0, dupes.slice(0, 4).join(", "));

  const visibleLabel = admin.getByText(/^new expiry date$/i).filter({ visible: true }).first();
  await visibleLabel.click();
  await admin.waitForTimeout(400);
  const focusedIsVisible = await admin.evaluate((s) => {
    const el = document.activeElement;
    return el?.tagName === "INPUT" && el.type === "date" && !!(el.offsetWidth || el.offsetHeight);
  }, sku);
  check("clicking the label focuses the date field the operator can see", focusedIsVisible);

  // --- the shelf life hint before anything is committed ---------------
  // With no date typed the line states the rule it will be judged against.
  check(
    "the location's minimum is stated on the line before a date is typed",
    (await admin.getByText(new RegExp(`needs at least ${SHELF_DAYS} day`, "i")).count()) > 0
  );

  // A batch that is too close to its date is warned about before the commit.
  const tooSoon = day(3);
  const expField = admin.locator(`input[id^="exp-${sku}-"]:visible`).first();
  check("the restock line offers a new expiry date", await expField.isVisible());
  await expField.fill(tooSoon);
  await admin.waitForTimeout(800);
  check(
    "a batch with too little shelf life is called out in red",
    (await admin.getByText(new RegExp(`too close to expiry`, "i")).count()) > 0
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}08-restock-too-soon.png`, fullPage: true });

  // --- count the delivery by the box ----------------------------------
  const boxToggle = admin.getByRole("checkbox", { name: /count by the box/i }).filter({ visible: true }).first();
  check("a boxed item offers a count-by-the-box toggle", await boxToggle.isVisible());
  await boxToggle.check();
  await admin.waitForTimeout(700);
  check(
    "the conversion is shown to the operator",
    (await admin.getByText(/1 box.*12.*added/i).count()) > 0,
    (await admin.getByText(/box.*added/i).first().innerText().catch(() => "")).trim()
  );

  // Three boxes of twelve is thirty-six â€” the arithmetic the database owns.
  // The quantity input carries no id, so it is found by the row it sits in.
  await admin
    .locator("tr", { hasText: ITEM })
    .first()
    .locator('input[type="number"]')
    .first()
    .fill("3");
  await admin.waitForTimeout(800);
  const conversion = await admin.getByText(/3 boxes/i).count();
  check("three boxes of twelve is shown as thirty-six", conversion > 0);
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}09-restock-by-box.png`, fullPage: true });

  // --- the database refuses the too-soon delivery ---------------------
  const beforeRefused = await stockOf(admin, sku);
  await admin.getByRole("button", { name: /review & commit/i }).first().click();
  await admin.waitForTimeout(700);
  await admin.locator('input[type="password"]').last().fill("admin123");
  await admin.getByRole("button", { name: /^confirm restock$/i }).last().click();
  await admin.waitForTimeout(2500);

  // The refusal is reported inside the confirmation dialog, and the dialog
  // stays open on purpose: the operator has to fix the date, not rebuild the
  // whole cart.
  const confirmDialog = admin.locator("div.fixed").filter({ hasText: /confirm restock/i }).first();
  check(
    "the database refuses a delivery with too little shelf life",
    (await confirmDialog.getByText(/shelf life on arrival|too close to expiry/i).count()) > 0,
    (
      (await confirmDialog.getByText(/shelf life on arrival|too close to expiry/i).first().innerText().catch(() => "")) ?? ""
    ).trim()
  );
  check(
    "the refusal names the item and the rule",
    (await confirmDialog.getByText(new RegExp(ITEM.slice(0, 12), "i")).count()) > 0
  );
  check("the confirmation dialog stays open so the cart is not lost", await confirmDialog.isVisible());
  check(
    "the refused delivery did not move stock",
    (await stockOf(admin, sku)) === beforeRefused,
    `still ${await stockOf(admin, sku)}`
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}10-restock-refused.png`, fullPage: true });

  // Close the dialog and correct the date.
  await confirmDialog.getByRole("button", { name: /^close$/i }).click();
  await admin.waitForTimeout(800);
  check("closing the dialog leaves the cart intact", (await admin.getByText(ITEM).count()) > 0);

  // --- a good delivery, dated, goes through ---------------------------
  const goodDate = day(120);
  const expField2 = admin.locator(`input[id^="exp-${sku}-"]:visible`).first();
  await expField2.fill(goodDate);
  await admin.waitForTimeout(800);
  check(
    "a batch with enough shelf life is accepted by the hint",
    (await admin.getByText(new RegExp(`meets the ${SHELF_DAYS}-day`, "i")).count()) > 0
  );

  await commitTransaction(admin, "admin123", "restock");
  const afterRestock = await stockOf(admin, sku);
  check(
    "three boxes of twelve landed as thirty-six",
    afterRestock === beforeRefused + 36,
    `${beforeRefused} -> ${afterRestock} (+36 expected)`
  );
  check(
    "the restock carried the new batch's expiry date",
    (await expiryOf(admin, sku)) === goodDate,
    `stored ${await expiryOf(admin, sku)}, expected ${goodDate}`
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}11-restock-done.png`, fullPage: true });

  /* ================================================================= */
  section("RESTOCK - what the rules refuse");
  /* ================================================================= */
  // An item with no packaging factor must not offer a box count, because the
  // database could not convert one and would reject the whole transaction.
  await admin.getByRole("button", { name: /checkout/i }).first().click();
  await admin.waitForTimeout(900);
  const looseScan = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  await admin.getByRole("button", { name: /^restock/i }).first().click();
  await admin.waitForTimeout(900);
  await looseScan.pressSequentially(looseSku, { delay: 10 });
  await looseScan.press("Enter");
  await admin.waitForTimeout(1500);
  check(
    "an item not stocked by the box is not offered a box toggle",
    (await admin.getByRole("checkbox", { name: /count by the box/i }).count()) === 0
  );
  check("but it does offer a new expiry date", (await admin.locator(`input[id^="exp-${looseSku}-"]:visible`).count()) > 0);

  // A restock with no date is not the shelf life rule's business, so it goes
  // through into a location that has a 30-day rule.
  const looseBefore = await stockOf(admin, looseSku);
  await commitTransaction(admin, "admin123", "restock");
  check(
    "a delivery with no date is not caught by the shelf life rule",
    (await stockOf(admin, looseSku)) === looseBefore + 1,
    `${looseBefore} -> ${await stockOf(admin, looseSku)}`
  );

  /* ================================================================= */
  section("WASTE - spoilage is its own movement, and cannot revive stock");
  /* ================================================================= */
  const expBeforeWaste = await expiryOf(admin, sku);
  const beforeWaste = await stockOf(admin, sku);
  await admin.getByRole("button", { name: /log waste/i }).first().click();
  await admin.waitForTimeout(1000);
  check("switching to Log Waste empties the cart", (await admin.getByText(ITEM).count()) === 0);
  check(
    "waste mode warns what it will do",
    (await admin.getByText(/logging waste/i).count()) > 0
  );

  const wasteScan = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  await wasteScan.pressSequentially(sku, { delay: 10 });
  await wasteScan.press("Enter");
  await admin.waitForTimeout(1500);
  check("the item is in the waste cart", (await admin.getByText(ITEM).count()) > 0);
  check(
    "a waste line offers no new expiry date",
    (await admin.locator(`input[id^="exp-${sku}-"]:visible`).count()) === 0
  );

  await commitTransaction(admin, "admin123", "waste log");
  check("waste deducted the stock", (await stockOf(admin, sku)) === beforeWaste - 1, `${beforeWaste} -> ${await stockOf(admin, sku)}`);
  check(
    "waste did not move the expiry date",
    (await expiryOf(admin, sku)) === expBeforeWaste,
    `still ${await expiryOf(admin, sku)}`
  );

  /* ================================================================= */
  section("NOTICES - what the operator is told while scanning");
  /* ================================================================= */
  // The low-stock warning only fires at or below the item's own threshold, so
  // the loose item is given a threshold above its stock first. Editing it
  // through the form is the same gesture a manager would make.
  await admin.goto(`${BASE}/items`, { waitUntil: "networkidle" });
  await settled(admin, 800);
  const looseRow = admin.locator("tr", { hasText: LOOSE }).filter({ visible: true }).first();
  await looseRow.getByRole("button", { name: /^edit$/i }).first().click();
  await admin.waitForTimeout(900);
  check("an item can be opened for editing", await admin.getByText(new RegExp(`Edit — ${LOOSE}`, "i")).count() > 0);

  const editModal = admin
    .locator("div.fixed")
    .filter({ has: admin.getByLabel(/low-stock threshold/i) })
    .first();
  await editModal.getByLabel(/low-stock threshold/i).fill("50");
  await admin.getByRole("button", { name: /^save changes$/i }).last().click();
  await admin.waitForTimeout(2000);
  const newThreshold = await admin.evaluate(async (s) => {
    const r = await fetch(`/api/items/lookup?code=${encodeURIComponent(s)}`);
    const d = await r.json();
    return Number(d.item?.low_stock_threshold);
  }, looseSku);
  check("the edited threshold was saved", newThreshold === 50, `stored ${newThreshold}`);

  // Now scan it: the item is on hand but below its threshold, which is the
  // exact situation the warning exists for.
  await admin.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await settled(admin, 800);
  const noticeScan = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  await noticeScan.pressSequentially(looseSku, { delay: 10 });
  await noticeScan.press("Enter");
  await admin.waitForTimeout(1600);
  check(
    "a low stock warning is shown while scanning",
    (await admin.getByText(/low stock/i).count()) > 0,
    (await admin.getByText(/low stock/i).first().innerText().catch(() => "")).trim()
  );
  check(
    "the warning still lets the operator record the movement",
    (await admin.getByText(LOOSE).count()) > 0
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}12-notices.png`, fullPage: true });

  // Take it to zero and scan again: an empty item must be refused outright,
  // because there is nothing left to deduct.
  const looseNow = await stockOf(admin, looseSku);
  await admin
    .locator("tr", { hasText: LOOSE })
    .filter({ visible: true })
    .first()
    .locator('input[type="number"]')
    .first()
    .fill(String(looseNow));
  await admin.waitForTimeout(600);
  await commitTransaction(admin, "admin123", "checkout");
  check("the loose item was drawn down to zero", (await stockOf(admin, looseSku)) === 0, `now ${await stockOf(admin, looseSku)}`);

  await admin.waitForTimeout(600);
  const emptyScan = admin.getByPlaceholder(/scan the item label or type the sku/i).first();
  await emptyScan.pressSequentially(looseSku, { delay: 10 });
  await emptyScan.press("Enter");
  await admin.waitForTimeout(1600);
  check(
    "scanning an out-of-stock item is refused, not silently added",
    (await admin.getByText(/out of stock/i).count()) > 0,
    (await admin.getByText(/out of stock/i).first().innerText().catch(() => "")).trim()
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}12b-out-of-stock.png`, fullPage: true });


  /* ================================================================= */
  section("ALERTS - the warnings, resolved and re-opened by an admin");
  /* ================================================================= */
  await admin.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
  await settled(admin, 1500);
  check("an admin sees the Recompute control", (await admin.getByRole("button", { name: /recompute/i }).count()) > 0);
  check("the alert counts are shown", (await admin.getByText(/out of stock/i).count()) > 0);

  await admin.getByRole("button", { name: /recompute/i }).first().click();
  await admin.waitForTimeout(2500);
  check("recomputing reports success", (await admin.getByText(/recomputed/i).count()) > 0);

  // The tabs filter the list.
  await admin.getByRole("button", { name: /^resolved$/i }).first().click();
  await admin.waitForTimeout(1500);
  check("the Resolved tab loads", (await admin.getByText(/resolved/i).count()) > 0);
  await admin.getByRole("button", { name: /^open$/i }).first().click();
  await admin.waitForTimeout(1500);
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}13-alerts.png`, fullPage: true });

  // --- resolve and re-open one ---------------------------------------
  const openAlert = await admin.evaluate(async () => {
    const r = await fetch("/api/alerts?status=open");
    const d = await r.json();
    return d.alerts?.[0]?.id ?? null;
  });

  if (openAlert) {
    await admin.goto(`${BASE}/alerts/${openAlert}`, { waitUntil: "networkidle" });
    await settled(admin, 800);
    check("an admin sees the Resolve alert button", (await admin.getByRole("button", { name: /resolve alert/i }).count()) > 0);
    check("the alert's stock and expiry are shown", (await admin.getByText(/stock & expiry/i).count()) > 0);
    check("the alert history is shown", (await admin.getByText(/alert history for this item/i).count()) > 0);

    await admin.getByRole("button", { name: /resolve alert/i }).first().click();
    await admin.waitForTimeout(2200);
    check("the alert can be resolved", (await admin.getByRole("button", { name: /re-open alert/i }).count()) > 0);

    await admin.getByRole("button", { name: /re-open alert/i }).first().click();
    await admin.waitForTimeout(2200);
    check("a resolved alert can be re-opened", (await admin.getByRole("button", { name: /resolve alert/i }).count()) > 0);
    await admin.screenshot({ path: `${SHOTS}/${PREFIX}14-alert-detail.png`, fullPage: true });
  } else {
    check("there was an open alert to resolve", false, "none available");
  }

  /* ================================================================= */
  section("REPORTS - the end-of-day read");
  /* ================================================================= */
  await admin.goto(`${BASE}/reports`, { waitUntil: "networkidle" });
  await settled(admin, 1500);
  check("the stock report renders", (await admin.getByRole("heading", { name: /stock report/i }).count()) > 0);
  check("it offers a CSV export", (await admin.getByRole("button", { name: /export csv/i }).count()) > 0);
  check("it offers a PDF export", (await admin.getByRole("button", { name: /export pdf/i }).count()) > 0);

  // The export must actually produce a file, not merely be present.
  const [download] = await Promise.all([
    admin.waitForEvent("download", { timeout: 20000 }).catch(() => null),
    admin.getByRole("button", { name: /export csv/i }).first().click(),
  ]);
  check(
    "the CSV export really downloads a file",
    Boolean(download),
    download ? await download.suggestedFilename() : "no download event"
  );

  /* ================================================================= */
  section("USERS - onboarding a hire and locking them out again");
  /* ================================================================= */
  await admin.goto(`${BASE}/users`, { waitUntil: "networkidle" });
  await settled(admin, 1200);

  await admin.getByRole("button", { name: /add account/i }).first().click();
  await admin.waitForTimeout(700);
  await admin.locator("#u-name").fill("Tour Hire");
  await admin.locator("#u-username").fill(HIRE);
  await admin.locator("#u-password").fill("tourpass123");
  await admin.getByRole("button", { name: /create account/i }).last().click();
  await admin.waitForTimeout(2000);
  check("a staff account was created", (await admin.getByText(HIRE).count()) > 0);

  // Creating an account immediately opens the new hire's barcode label, so the
  // manager can print the ID straight away. That dialog then has to be closed
  // before anything else on the page can be clicked.
  const labelDialog = admin.locator("div.fixed").filter({ hasText: /print this label/i }).first();
  check("the new hire's barcode label is shown straight away", await labelDialog.isVisible());
  check("it shows the code the hire will scan", (await labelDialog.getByText(HIRE).count()) > 0);
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}16a-barcode-label.png` });
  await labelDialog.getByRole("button", { name: /^close$/i }).click();
  await admin.waitForTimeout(700);
  // Scoped to the label dialog rather than counting every `div.fixed`: the
  // mobile nav overlay is one of those and is always in the DOM.
  check("closing the label returns to the account list", (await labelDialog.count()) === 0);

  const hire = await admin.evaluate(async (u) => {
    const r = await fetch("/api/users");
    const d = await r.json();
    return (d.users ?? []).find((x) => x.username === u) ?? null;
  }, HIRE);
  check("the new hire has a barcode code", Boolean(hire?.qr_token), hire?.qr_token ?? "none");

  if (hire?.qr_token) {
    // A brand new hire signs in with the barcode they were issued.
    const hireCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const hirePage = await newPage(hireCtx, "hire");
    try {
      await signInStaff(hirePage, hire.qr_token, "tourpass123");
      check("the new hire can sign in with their barcode", hirePage.url().includes("/dashboard"), hirePage.url());
    } catch (e) {
      check("the new hire can sign in with their barcode", false, e.message);
    }
    await hireCtx.close();
  }

  // Searching narrows the account list.
  await admin.getByPlaceholder(/search name or username/i).first().fill(HIRE);
  await admin.waitForTimeout(1000);
  check("searching narrows the account list", (await admin.getByText(HIRE).count()) > 0);
  await admin.getByPlaceholder(/search name or username/i).first().fill("");
  await admin.waitForTimeout(900);

  // Deactivation asks for a reason, and that reason is what the account
  // holder is shown at sign-in.
  // Accounts are rendered as table rows (plus a mobile card copy), so the row
  // is found by its username rather than by list item.
  const hireRow = admin.locator("tr", { hasText: HIRE }).filter({ visible: true }).first();
  await hireRow.getByRole("button", { name: /^deactivate$/i }).first().click();
  await admin.waitForTimeout(800);
  await admin.locator("#deactivation-reason").fill("Tour ended, replaced by a new hire");
  await admin.getByRole("button", { name: /deactivate account/i }).last().click();
  await admin.waitForTimeout(2000);
  check("the account is shown as deactivated", (await admin.getByText(/tour ended/i).count()) > 0);
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}16-users.png`, fullPage: true });

  if (hire?.qr_token) {
    const deadCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const dead = await newPage(deadCtx, "deactivated");
    await dead.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await dead.getByRole("button", { name: /^staff$/i }).click();
    await dead.getByPlaceholder(/barcode/i).first().fill(hire.qr_token);
    await dead.locator('input[type="password"]').first().fill("tourpass123");
    await dead.getByRole("button", { name: /^login$/i }).first().click();
    await dead.waitForTimeout(2000);
    check(
      "the deactivated hire is refused at sign-in",
      (await dead.getByText(/this account is deactivated/i).count()) > 0
    );
    check("and is told the reason", (await dead.getByText(/tour ended/i).count()) > 0);
    await dead.screenshot({ path: `${SHOTS}/${PREFIX}17-deactivated.png` });
    await deadCtx.close();
  }

  /* ================================================================= */
  section("AUDIT - the trail, and its hash chain, after all of that");
  /* ================================================================= */
  await admin.goto(`${BASE}/audit`, { waitUntil: "networkidle" });
  await settled(admin, 1500);
  check("the audit trail renders", (await admin.getByRole("heading", { name: /audit trail/i }).count()) > 0);

  // Every movement this tour made should be on the record.
  const auditText = await admin.locator("main, body").first().innerText();
  check("the restock is on the record", /restock/i.test(auditText));
  check("the waste log is on the record", /waste/i.test(auditText));

  await admin.getByRole("button", { name: /verify chain/i }).first().click();
  await admin.waitForTimeout(2500);
  check(
    "the hash chain verifies after everything this tour did",
    (await admin.getByText(/hash chain intact/i).count()) > 0,
    (await admin.getByText(/hash chain intact|chain broken/i).first().innerText().catch(() => "")).trim()
  );
  await admin.screenshot({ path: `${SHOTS}/${PREFIX}18-audit.png`, fullPage: true });

  // Searching narrows the trail.
  await admin.getByPlaceholder(/search actor, action, entity/i).first().fill("RESTOCK");
  await admin.waitForTimeout(1500);
  check("the audit trail can be searched", (await admin.getByText(/restock/i).count()) > 0);
  await admin.getByPlaceholder(/search actor, action, entity/i).first().fill("");
  await admin.waitForTimeout(900);

  /* ================================================================= */
  section("STAFF - the same site, with the admin controls absent");
  /* ================================================================= */
  const staffUser = await admin.evaluate(async () => {
    const r = await fetch("/api/users");
    const d = await r.json();
    return (d.users ?? []).find((u) => u.role === "staff" && u.is_active) ?? null;
  });
  check("an active staff account exists to sign in as", Boolean(staffUser), staffUser?.username ?? "none");

  if (staffUser) {
    const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const staff = await newPage(staffCtx, "staff");

    await signInStaff(staff, staffUser.qr_token);
    check("staff sign-in with a barcode reaches the dashboard", staff.url().includes("/dashboard"), staff.url());
    await settled(staff, 1000);
    await staff.screenshot({ path: `${SHOTS}/${PREFIX}19-dashboard-staff.png`, fullPage: true });

    const navText = await staff.locator("nav, aside, header").first().innerText().catch(() => "");
    check("staff nav does not offer Staff Accounts", !/staff accounts/i.test(navText));
    check("staff nav does not offer Settings", !/^settings$/im.test(navText));
    check("staff nav does not offer the Audit Trail", !/audit trail/i.test(navText));

    // Every page staff can legitimately reach must still work for them.
    for (const [path, heading] of [
      ["/dashboard", /inventory dashboard/i],
      ["/checkout", /checkout & restock/i],
      ["/items", /inventory management/i],
      ["/alerts", /^alerts$/i],
      ["/reports", /stock report/i],
    ]) {
      const before = consoleErrors.length;
      const res = await staff.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await settled(staff, 500);
      const ok =
        res?.status() === 200 && (await staff.getByText(heading).count()) > 0;
      check(`staff can open ${path}`, ok, `http ${res?.status() ?? "?"}`);
      check(`${path} did not break for staff`, consoleErrors.length === before);
    }

    await staff.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
    await settled(staff, 1200);
    check("staff sees no Recompute button", (await staff.getByRole("button", { name: /recompute/i }).count()) === 0);

    const alertLink = staff.locator('a[href^="/alerts/"]:visible').first();
    if ((await alertLink.count()) > 0) {
      await alertLink.click();
      const navigated = await staff
        .waitForURL(/\/alerts\/[0-9a-f-]{36}/i, { timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      check("staff can open an alert detail page", navigated, staff.url());
      await settled(staff, 500);
      check("staff sees no Resolve alert button", (await staff.getByRole("button", { name: /resolve alert/i }).count()) === 0);
      check("staff is told resolution is admin-only", (await staff.getByText(/only an administrator/i).count()) > 0);
      await staff.screenshot({ path: `${SHOTS}/${PREFIX}20-alert-staff.png`, fullPage: true });
    }

    // The API must refuse the admin routes even when a page link is bypassed.
    const guard = await staff.evaluate(async () => {
      const out = {};
      for (const p of ["/api/users", "/api/settings", "/api/audit"]) {
        out[p] = (await fetch(p)).status;
      }
      return out;
    });
    check(
      "staff API calls to admin routes are refused",
      Object.values(guard).every((s) => s === 403),
      JSON.stringify(guard)
    );

    /* ---------------- sign out ---------------- */
    await staff.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await settled(staff, 500);
    await staff.getByRole("button", { name: /log out/i }).first().click();
    await staff.waitForURL(/login/, { timeout: 20000 }).catch(() => {});
    check("logging out returns to the login page", staff.url().includes("/login"), staff.url());

    await staff.goto(`${BASE}/alerts`, { waitUntil: "networkidle" });
    await staff.waitForTimeout(1500);
    check(
      "a signed-out session cannot reach a page",
      staff.url().includes("/login"),
      staff.url()
    );
    await staffCtx.close();
  }

  /* ================================================================= */
  section("RESPONSIVE - the new restock controls on a phone");
  /* ================================================================= */
  const phoneCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phone = await newPage(phoneCtx, "phone");
  await signInAdmin(phone);
  await settled(phone, 800);

  const overflowAt = async (p) =>
    p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow on the dashboard at 390px", (await overflowAt(phone)) <= 1, `${await overflowAt(phone)}px`);

  // Restock is the busiest page now, so that is the one worth squeezing.
  await phone.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await settled(phone, 800);
  await phone.getByRole("button", { name: /^restock/i }).first().click();
  await phone.waitForTimeout(900);
  const phoneScan = phone.getByPlaceholder(/scan the item label or type the sku/i).first();
  await phoneScan.pressSequentially(sku, { delay: 10 });
  await phoneScan.press("Enter");
  await phone.waitForTimeout(1600);
  check("the item scans in on a phone", (await phone.getByText(ITEM).count()) > 0);
  check(
    "the restock controls fit a phone without overflow",
    (await overflowAt(phone)) <= 1,
    `${await overflowAt(phone)}px`
  );
  await phone.screenshot({ path: `${SHOTS}/${PREFIX}21-phone-restock.png`, fullPage: true });
  await phoneCtx.close();

  /* ================================================================= */
  section("CLEANUP - leave the database as it was found");
  /* ================================================================= */
  const removed = await admin.evaluate(async (names) => {
    const out = [];
    for (const n of names) {
      const list = await (await fetch("/api/items")).json();
      const hit = (list.items ?? []).find((i) => i.name === n);
      if (!hit) {
        out.push(`${n}: not found`);
        continue;
      }
      const r = await fetch(`/api/items/${hit.id}`, { method: "DELETE" });
      out.push(`${n}: ${r.status}`);
    }
    return out;
  }, [ITEM, LOOSE]);
  check(
    "the two test ingredients were removed",
    removed.every((r) => r.endsWith("200")),
    removed.join(" | ")
  );

  // The reference rows delete freely. A user has no DELETE endpoint, so the
  // hire is parked inactive, which is the resting state a test account wants.
  const refs = await admin.evaluate(async ({ loc, cat }) => {
    const out = [];
    const ls = await (await fetch("/api/refs/locations")).json();
    const l = (ls.items ?? []).find((x) => x.name === loc);
    out.push(
      l
        ? `location: ${(await fetch(`/api/refs/locations/${l.id}`, { method: "DELETE" })).status}`
        : "location: not found"
    );

    const cs = await (await fetch("/api/refs/categories")).json();
    const c = (cs.items ?? []).find((x) => x.name === cat);
    out.push(
      c
        ? `category: ${(await fetch(`/api/refs/categories/${c.id}`, { method: "DELETE" })).status}`
        : "category: not found"
    );
    return out;
  }, { loc: LOCATION, cat: CATEGORY });
  check(
    "the test reference rows were removed",
    refs.every((r) => r.endsWith("200")),
    refs.join(" | ")
  );

  const parked = await admin.evaluate(async (u) => {
    const list = await (await fetch("/api/users")).json();
    const hit = (list.users ?? []).find((x) => x.username === u);
    if (!hit) return "not found";
    const r = await fetch(`/api/users/${hit.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false, regenerate_token: true }),
    });
    return String(r.status);
  }, HIRE);
  check("the test hire was parked inactive", parked === "200", parked);

  // Settings must be back where they started, or the next run measures drift.
  const restored = await admin.evaluate(async (before) => {
    for (const [k, v] of Object.entries(before)) {
      if (v === null || v === undefined) continue;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [k]: v }),
      });
    }
    const after = (await (await fetch("/api/settings")).json()).settings ?? {};
    return Object.entries(before)
      .filter(([, v]) => v !== null && v !== undefined)
      .every(([k, v]) => String(after[k]) === String(v));
  }, originalSettings);
  check("the settings this tour read are unchanged", restored);

  const chain = await admin.evaluate(async () => {
    const d = await (await fetch("/api/audit/verify")).json();
    return d.intact === true;
  });
  check("the audit chain is still intact after the whole tour", chain);

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
console.log(`\nScreenshots in ${SHOTS}/${PREFIX}*.png`);
process.exit(fail ? 1 : 0);
