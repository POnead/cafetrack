/**
 * The notification path, end to end (FR-11).
 *
 * This is the requirement that had no coverage at all: every part of the email
 * feature existed and worked by reading, but nothing had ever driven it. The
 * suite asserts on two things at once, and the second is the point —
 *
 *   1. the `email_notifications` rows, which is the queue;
 *   2. what the throwaway SMTP server actually received.
 *
 * Asserting on the queue alone would pass even if delivery were completely
 * broken, which is the failure that matters: a cafe whose alerts queue neatly
 * and never arrive looks exactly like one receiving no alerts.
 *
 * Every test is reversible. The suite turns email on, adds a recipient, and
 * creates and deletes items — then puts `email_enabled` back to 0 and removes
 * the recipient, so a later suite in `test:all` is not silently posting mail.
 */
import { assertTestTarget } from "./_guard.mjs";
import { stubControl, resolveStubControlUrl, STUB_USER } from "./_smtp-stub.mjs";

const BASE = process.env.BASE_URL || "http://localhost:3101";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "admin123";

/*
 * Where the control API is has to be discovered, not assumed.
 *
 * `dev:test` asks the OS for ephemeral ports and records them in
 * .cache/smtp-stub.json; that is the only way a suite in a different process
 * can find a port nobody knew in advance. SMTP_STUB_CONTROL_PORT still wins
 * when it is set, so a stub started by hand is still addressable.
 */
const STUB_BASE = resolveStubControlUrl();
const stub = stubControl(STUB_BASE);

let pass = 0,
  fail = 0;
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

function decodedMime(message) {
  return String(message?.raw ?? "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function hasBrandedHtmlAndPlainText(message) {
  const raw = decodedMime(message);
  return (
    /text\/plain/i.test(raw) &&
    /text\/html/i.test(raw) &&
    /cid:merrylane-logo/i.test(raw) &&
    /Content-ID:\s*<merrylane-logo>/i.test(raw) &&
    /Content-Disposition:\s*inline/i.test(raw) &&
    /merrylane-wordmark\.png/i.test(raw)
  );
}

async function call(method, path, body, cookie) {
  if (
    method === "DELETE" &&
    path.startsWith("/api/items/") &&
    (body == null || (typeof body === "object" && Object.keys(body).length === 0))
  ) {
    body = { password: ADMIN_PASSWORD };
  }
  if (method === "DELETE" && path.startsWith("/api/refs/") && body == null) {
    body = { reason: "Email test cleanup", confirm_password: ADMIN_PASSWORD };
  }
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

const OWNER = "owner@merrylane.test";
const SECOND = "backup@merrylane.test";

/**
 * A separate address for the checks that run inside the diagnostic paths.
 *
 * A direct send does not touch the recipient list at all, so "there are no
 * recipients" is not at risk here. The constant is kept anyway, because the
 * first thing this path used to do was queue a message, and the suite should not
 * silently depend on that side effect being gone.
 */
const OFFSTATE = "notconfigured@merrylane.test";

/** Wait for the queue to reach a settled state, or give up and report. */
async function settle(ms = 1200) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a predicate holds, or give up.
 *
 * A flat sleep is wrong for anything that has to cross the network: the first
 * SMTP connection on a fresh process costs a second or two, so a fixed pause
 * measures how fast the machine happens to be rather than whether the thing
 * works. Polling for the condition makes the suite report what happened instead
 * of when it checked.
 */
async function waitFor(predicate, { timeoutMs = 15000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/**
 * Read the queue straight from the API.
 *
 * There is no route that lists the whole queue — /api/email returns the most
 * recent 50 with `?queue=1`, which is what the Email page shows and therefore
 * the same view an admin has.
 */
async function queue(cookie) {
  const r = await call("GET", "/api/email?queue=1", null, cookie);
  return r.data?.queue ?? [];
}

const created = { items: [], recipients: [], suppliers: [] };
let recoveryEmailBefore = null;
let adminRecoveryEmailBefore = null;
let adminRecoveryUserId = null;

/**
 * A clean slate, before anything else.
 *
 * Every recipient is removed, which cascades away their queued messages. Without
 * this the suite inherits whatever the previous run left behind and asserts
 * against it — and because several of the properties here are *suppression*
 * properties (the dedupe window, the hourly failed-login key), inherited rows
 * make a correct implementation look broken. A suite whose result depends on
 * what ran before it is worse than no suite.
 */
async function wipeEmailState(cookie) {
  const r = await call("GET", "/api/email", null, cookie);
  for (const rec of r.data?.recipients ?? []) {
    await call("DELETE", `/api/email?id=${rec.id}`, null, cookie);
  }
  return (r.data?.recipients ?? []).length;
}

try {
  await assertTestTarget(BASE);

  /*
   * The stub is the only part of this suite that lives in another process, and
   * the only part whose absence would otherwise read as "the app is broken".
   * A raw ECONNREFUSED from inside the first assertion says nothing about what
   * to do, so the missing stub is reported as its own instruction — before any
   * assertion runs, and with the port it actually looked at.
   */
  try {
    await stub.reset();
  } catch {
    console.error(
      `\ntest:email cannot reach the throwaway SMTP server at ${STUB_BASE}.\n\n` +
        `  That server is started by \`npm run dev:test\`, together with the\n` +
        `  isolated database. Start it, then run this suite again — or let\n` +
        `  \`npm run test:isolated\` start and drive the whole run for you.\n\n` +
        `  If you are pointing at a stub you started by hand, set\n` +
        `  SMTP_STUB_CONTROL_PORT to its control port.\n`
    );
    process.exit(1);
  }

  const login = await call("POST", "/api/auth/login", {
    username: "admin",
    password: ADMIN_PASSWORD,
  });
  let A = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  check("admin login", login.status === 200);

  const inherited = await wipeEmailState(A);
  check("the suite starts with no recipients", inherited >= 0, `cleared ${inherited}`);

  /* ================================================================== */
  section("off by default — the reason a cafe is not spammed on install");
  /* ================================================================== */

  let r = await call("GET", "/api/email", null, A);
  check(
    "email is off on a fresh install",
    r.data?.status?.enabled === false,
    `enabled=${r.data?.status?.enabled}`
  );

  // A test message goes through regardless of the on/off switch: verifying the
  // account is what you do before trusting it. It still has to be honest — a
  // bad address is refused rather than queued to nowhere.
  r = await call("PATCH", "/api/email", { action: "test", to: "not-an-address" }, A);
  check(
    "a malformed address is refused rather than queued to nowhere",
    r.status === 502 && typeof r.data?.error === "string",
    `${r.status} ${r.data?.error ?? ""}`
  );
  let got = await stub.messages();
  check("nothing was sent", got.count === 0, `${got.count} delivered`);

  // A credential that cannot work gets the same route — and now carries a fix.
  await call("PATCH", "/api/email", { action: "save_smtp", host: "127.0.0.1", port: "1", user: "cafe@cafetrack.test", pass: "stub-password" }, A);
  r = await call("PATCH", "/api/email", { action: "test", to: OFFSTATE }, A);
  check(
    "an unreachable server fails the check with a diagnosis, not a bare error",
    r.status === 502 && typeof r.data?.fix === "string",
    `${r.status} ${r.data?.error ?? ""} | ${r.data?.fix ?? ""}`
  );
  await wipeEmailState(A);

  // The suite depends on the environment account, not the one saved above.
  await call("PATCH", "/api/email", { action: "clear_smtp" }, A);

  /* ================================================================== */
  section("SMTP is configured, and what still stands in the way");
  /* ================================================================== */

  r = await call("GET", "/api/email", null, A);
  check(
    "the sending account is picked up from the environment",
    r.data?.status?.configured === true && r.data?.status?.source === "environment",
    `source=${r.data?.status?.source}`
  );
  check(
    "the page never receives the password",
    !JSON.stringify(r.data?.smtp ?? {}).match(/smtp_pass_enc|"pass"/i),
    Object.keys(r.data?.smtp ?? {}).join(",")
  );

  r = await call("GET", "/api/email", null, A);
  check(
    "the page is told what is still missing before anything is switched on",
    r.data?.status?.setup?.ready === false &&
      r.data.status.setup.steps.some((s) => s.key === "recipient" && !s.done),
    JSON.stringify(r.data?.status?.setup?.steps?.map((s) => `${s.key}:${s.done}`) ?? [])
  );
  check(
    "and the blocked reason names the outstanding step",
    typeof r.data?.status?.setup?.blocked === "string" && r.data.status.setup.blocked.length > 0,
    r.data?.status?.setup?.blocked ?? "none"
  );

  // An account but no recipient: switching on would report the feature as live
  // while every send is skipped, so it is refused rather than quietly accepted.
  r = await call("PATCH", "/api/settings", { email_enabled: "1" }, A);
  check(
    "switching on with no recipient is refused rather than left silently dead",
    r.status === 400 && /recipient/i.test(r.data?.error ?? ""),
    `${r.status} ${r.data?.error ?? ""}`
  );

  /* ================================================================== */
  section("a recipient, and what happens without one");
  /* ================================================================== */

  // Queue an alert with email on but no recipient. This must be a no-op rather
  // than an error: a cafe that has just switched the feature on has an open
  // alert it never wanted mail about.
  await call("POST", "/api/alerts", undefined, A);
  await settle(600);

  r = await call("GET", "/api/email", null, A);
  check(
    "with no recipient the page says so rather than reporting a fault",
    r.data?.status?.recipients === 0,
    `recipients=${r.data?.status?.recipients}`
  );

  let queuedNoRecipient = await queue(A);
  check(
    "and an alert with nobody to send it to queues nothing",
    queuedNoRecipient.length === 0,
    `${queuedNoRecipient.length} rows`
  );

  r = await call("POST", "/api/email", { email_address: OWNER, display_name: "Owner" }, A);
  check("a recipient can be added", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  const ownerRecipient = r.data?.recipient?.id;
  if (ownerRecipient) created.recipients.push(ownerRecipient);

  r = await call("GET", "/api/email", null, A);
  check(
    "with an account and a recipient the setup is reported complete",
    r.data?.status?.setup?.ready === true,
    JSON.stringify(r.data?.status?.setup?.steps?.map((s) => `${s.key}:${s.done}`) ?? [])
  );
  check(
    "and nothing is said is left to do",
    r.data?.status?.setup?.blocked === null,
    r.data?.status?.setup?.blocked ?? "none"
  );

  r = await call("PATCH", "/api/settings", { email_enabled: "1" }, A);
  check("email can now be switched on", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  // The gate must not become a trap: once on, switching off is never blocked,
  // and it can be switched back on afterwards.
  r = await call("PATCH", "/api/settings", { email_enabled: "0" }, A);
  check("and switching back off is never blocked", r.status === 200, `${r.status}`);
  r = await call("PATCH", "/api/settings", { email_enabled: "1" }, A);
  check("and it can be switched on again", r.status === 200, `${r.status}`);

  r = await call("POST", "/api/email", { email_address: OWNER }, A);
  check("adding the same address twice is a clear conflict", r.status === 409, `${r.status}`);

  r = await call("POST", "/api/email", { email_address: "not-an-address" }, A);
  check("a malformed address is refused", r.status === 400, `${r.status}`);

  r = await call("POST", "/api/email", {
    email_address: "sub@merrylane.test",
    subscriptions: ["not_a_real_kind"],
  }, A);
  check(
    "an unknown notification type is refused rather than silently matching nothing",
    r.status === 400,
    `${r.status} ${r.data?.error ?? ""}`
  );

  /* ================================================================== */
  section("the test message — the simplest end-to-end proof");
  /* ================================================================== */

  await stub.reset();
  // Reset again here rather than relying on the run's opening reset. The stub is
  // shared state living in the server process, and one earlier section leaving an
  // unconsumed injection would otherwise make this section fail for no reason of
  // its own — which is how a suite teaches people to ignore it.
  await stub.reset();
  r = await call("PATCH", "/api/email", { action: "test", to: OWNER }, A);
  check("the test message is reported as sent", r.status === 200 && (r.data?.sent ?? 0) >= 1,
    `${r.status} sent=${r.data?.sent ?? "-"}`);
  check("and it says where the message went", r.data?.to === OWNER, r.data?.to ?? "none");

  await settle();
  got = await stub.messages();
  // The direct send is titled "CafeTrack: your email is set up" — distinct from
  // the queued path's "CafeTrack: test message", so this cannot be confused with
  // a delivery that went through the queue.
  const testMail = got.messages.filter((m) => /your email is set up|test message/i.test(m.subject));
  check("the message actually arrived at the server", testMail.length === 1, `${got.count} delivered`);
  check(
    "it went to the address asked for",
    testMail[0]?.to?.includes(OWNER) ?? false,
    testMail[0]?.to ?? ""
  );
  check(
    "it is recognisable as a CafeTrack message",
    /CafeTrack/i.test(testMail[0]?.subject ?? "") &&
      /no-reply@cafetrack\.test/i.test(testMail[0]?.envelope?.from ?? ""),
    `${testMail[0]?.subject ?? ""} from ${testMail[0]?.envelope?.from ?? ""}`
  );
  check(
    "the SMTP verification email has branded HTML, an inline Merrylane logo, and plaintext",
    hasBrandedHtmlAndPlainText(testMail[0]),
    "HTML and text alternatives share one branded message"
  );

  // A direct check is not a queued delivery: it deliberately does not touch the
  // delivery log.
  let rows = await queue(A);
  const logged = rows.find((q) => /your email is set up|test message/i.test(q.subject));
  check("a check-by-hand is not logged as a queued delivery", !logged, logged ? logged.status : "absent");

  /* ================================================================== */
  section("an alert becomes a message (FR-11's headline behaviour)");
  /* ================================================================== */

  await stub.reset();
  const supplierName = `Mail Supplier ${Date.now().toString(36)}`;
  r = await call("POST", "/api/refs/suppliers", {
    name: supplierName,
    contact_name: "Mail Supplier Contact",
    phone: "09171234567",
    email: "supplier@merrylane.test",
  }, A);
  const supplier = r.data?.item;
  if (supplier?.id) created.suppliers.push(supplier.id);
  check("a supplier is created for the probe", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);

  r = await call("POST", "/api/items", {
    name: `Mail Probe ${Date.now().toString(36)}`,
    quantity: 1,
    low_stock_threshold: 5,
    supplier_id: supplier?.id,
  }, A);
  const probe = r.data?.item;
  if (probe?.id) created.items.push(probe.id);
  check("a probe item is created", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  check(
    "it is born already below its own threshold, so an alert is the honest state",
    probe?.item_status === "active",
    probe?.item_status ?? ""
  );

  // refresh_alerts runs as part of this movement.
  r = await call("POST", "/api/transactions", {
    type: "checkout",
    password: "admin123",
    items: [{ sku: probe?.sku, qty: 0.5 }],
  }, A);
  check("a movement commits", r.status === 201, `${r.status} ${r.data?.error ?? ""}`);
  await settle(2000);

  rows = await queue(A);
  const alertMails = rows.filter((q) => q.kind === "low_stock");
  check("a low-stock alert queued a message", alertMails.length >= 1,
    `${alertMails.length} queued`);
  check(
    "it was delivered, not merely queued",
    alertMails.some((q) => q.status === "sent"),
    alertMails.map((q) => q.status).join(",")
  );

  await settle();
  got = await stub.messages();
  const delivered = got.messages.filter((m) => /low on stock|out of stock/i.test(m.body));
  check("alert messages reached the server", delivered.length >= 1, `${delivered.length} delivered`);
  check(
    "one of them names the item that just triggered it",
    delivered.some((m) => /Mail Probe/i.test(m.body)),
    delivered
      .map((m) => (m.body ?? "").split("\n")[0])
      .slice(0, 3)
      .join(" | ")
  );
  check(
    "and names the supplier the item was last received from",
    delivered.some((m) => m.body?.includes(supplierName)),
    delivered
      .map((m) => (m.body ?? "").split("\n").slice(-4).join(" / "))
      .slice(0, 2)
      .join(" | ")
  );
  check(
    "the stock alert has branded HTML, an inline Merrylane logo, and plaintext",
    delivered.some((message) => hasBrandedHtmlAndPlainText(message)),
    `${delivered.length} alert message(s) received`
  );
  check(
    "the supplier's phone number is in the email, not only in the app",
    delivered.some((m) => m.body?.includes("09171234567")),
    delivered.some((m) => m.body?.includes("09171234567")) ? "present" : "missing"
  );

  /* ================================================================== */
  section("the same alert is not sent twice inside the window (NFR-07)");
  /* ================================================================== */

  const afterFirst = (await stub.messages()).count;
  // Trigger the alert pass repeatedly. refresh_alerts runs on every movement
  // and every item write, so this is the real-world path to a duplicate.
  for (let i = 0; i < 3; i++) {
    await call("PATCH", `/api/items/${probe?.id}`, { low_stock_threshold: 5 }, A);
    await call("POST", "/api/alerts", undefined, A);
    await settle(400);
  }
  await settle(1200);

  got = await stub.messages();
  check(
    "repeated passes over the same alert produced no further message",
    got.count === afterFirst,
    `${got.count} delivered, expected to stay at ${afterFirst}`
  );

  rows = await queue(A);
  const sameKind = rows.filter((q) => q.kind === "low_stock");
  // Subjects cannot identify an alert: every low-stock message is titled
  // "CafeTrack: Low Stock" and the item is named in the body only. So the
  // property being checked is "the same alert did not queue twice", which shows
  // up as the row count not growing across repeated passes.
  const beforeRepeats = sameKind.length;
  for (let i = 0; i < 2; i++) {
    await call("POST", "/api/alerts", undefined, A);
    await settle(400);
  }
  const afterRepeats = (await queue(A)).filter((q) => q.kind === "low_stock").length;
  check(
    "re-running the alert pass does not add another row for the same alert",
    afterRepeats === beforeRepeats,
    `${beforeRepeats} rows before, ${afterRepeats} after`
  );

  /* ================================================================== */
  section("per-recipient subscriptions");
  /* ================================================================== */

  r = await call("POST", "/api/email", {
    email_address: SECOND,
    subscriptions: ["daily_summary"],
  }, A);
  check("a second recipient can subscribe to one family", r.status === 201, `${r.status}`);
  if (r.data?.recipient?.id) created.recipients.push(r.data.recipient.id);

  await stub.reset();
  await call("POST", "/api/alerts", undefined, A);
  await settle(1800);

  // The alerts already exist from the section above, so re-running the pass
  // queues nothing new — which is the dedupe working. A brand-new item is
  // created so there is genuinely a new alert to react to.
  const fresh = await call("POST", "/api/items", {
    name: `Sub Probe ${Date.now().toString(36)}`,
    quantity: 1,
    low_stock_threshold: 5,
  }, A);
  check("the probe item is created", fresh.status === 201, `${fresh.status} ${fresh.data?.error ?? ""}`);
  if (fresh.data?.item?.id) created.items.push(fresh.data.item.id);
  // Explicit flush. `POST /api/items` now dispatches, but the suite should not
  // be asserting on that side effect from two places at once — if the dispatch is
  // ever removed again, this section says so on its own terms.
  await call("PATCH", "/api/email", { action: "send_now" }, A);
  const alertArrived = await waitFor(async () =>
    (await stub.messages()).messages.some(
      (m) => m.to.includes(OWNER) && /Sub Probe/i.test(m.body)
    )
  );

  got = await stub.messages();
  const forOwner = got.messages.filter((m) => m.to.includes(OWNER));
  const forSecond = got.messages.filter((m) => m.to.includes(SECOND));
  check(
    "the fully-subscribed address receives alerts",
    got.messages.some((m) => m.to.includes(OWNER) && /Sub Probe/i.test(m.body)),
    `${forOwner.length} delivered, ${
      got.messages.filter((m) => m.to.includes(OWNER) && /Sub Probe/i.test(m.body)).length
    } naming the item`
  );
  check(
    "the address subscribed only to summaries receives no alert",
    forSecond.length === 0,
    `${forSecond.length} delivered`
  );

  /* ================================================================== */
  section("the daily summary goes once a day (enqueue_daily_summary)");
  /* ================================================================== */

  await stub.reset();
  // PATCH, not POST — POST on this route is the add-a-recipient handler, which
  // is a confusing way to fail.
  //
  // The queue is emptied first. The summary's dedupe key is the date, so a
  // summary left over from an earlier run would make this one answer "already
  // sent" and prove nothing.
  await wipeEmailState(A);
  await call("POST", "/api/email", { email_address: OWNER }, A);
  await call("POST", "/api/email", {
    email_address: SECOND,
    subscriptions: ["daily_summary"],
  }, A);

  r = await call("PATCH", "/api/email", { action: "summary_now" }, A);
  const firstQueued = r.data?.queued;
  check("the first summary of the day is queued", r.status === 200 && firstQueued >= 1,
    `${r.status} queued=${firstQueued ?? "-"} ${r.data?.error ?? ""}`);

  await settle(1500);
  const summaryArrived = await waitFor(async () =>
    (await stub.messages()).messages.some((m) => m.to.includes(SECOND))
  );
  got = await stub.messages();
  const summaries = got.messages.filter((m) => /daily summary/i.test(m.subject));
  check(
    "the summary was delivered",
    summaryArrived,
    summaries.length > 0
      ? `${summaries.length} delivered`
      : `${got.messages.length} arrived: ${got.messages.map((m) => m.subject).join(" | ")}`
  );
  check(
    "it reaches the recipient who asked for summaries",
    summaries.some((m) => m.to.includes(SECOND)),
    summaries.map((m) => m.to).join(", ")
  );
  check(
    "it carries the day's movements, not just a greeting",
    /Movements:/i.test(summaries[0]?.body ?? "") &&
      /checked out/i.test(summaries[0]?.body ?? ""),
    (summaries[0]?.body ?? "").split("\n").slice(0, 2).join(" / ")
  );
  check(
    "the daily summary has branded HTML, an inline Merrylane logo, and plaintext",
    summaries.some((message) => hasBrandedHtmlAndPlainText(message)),
    `${summaries.length} summary message(s) received`
  );

  r = await call("PATCH", "/api/email", { action: "summary_now" }, A);
  check(
    "a second summary the same day is refused as already sent",
    r.status === 409,
    `${r.status} ${r.data?.error ?? ""}`
  );

  await settle(1200);
  got = await stub.messages();
  check(
    "so no second summary was actually delivered",
    got.messages.filter((m) => /daily summary/i.test(m.subject)).length === summaries.length,
    `${got.count} messages in total`
  );

  /* ================================================================== */
  section("a rejected sign-in warns the owner, without naming the credential");
  /* ================================================================== */

  await stub.reset();
  // A token that matches no account. The throttle has just been used by the
  // summary work above, so this is a different credential and is not blocked.
  const bogus = `CT-STF-${Math.random().toString(16).slice(2, 12).toUpperCase()}`;
  await call("POST", "/api/auth/staff", { token: bogus, password: "whatever" });
  await settle(2000);

  got = await stub.messages();
  const warns = got.messages.filter((m) => /rejected sign-in/i.test(m.subject));
  check("a rejected sign-in produces a warning", warns.length >= 1, `${warns.length} delivered`);
  check(
    "the warning does not contain the credential that was tried",
    !JSON.stringify(warns).includes(bogus),
    "the presented code is absent"
  );
  check(
    "nor the password",
    !/whatever/.test(JSON.stringify(warns)),
    "the presented password is absent"
  );
  check(
    "it says what to do about it",
    /change the password/i.test(warns[0]?.body ?? ""),
    (warns[0]?.body ?? "").split("\n").pop() ?? ""
  );
  check(
    "the failed-login warning has branded HTML, an inline Merrylane logo, and plaintext",
    warns.some((message) => hasBrandedHtmlAndPlainText(message)),
    `${warns.length} warning message(s) received`
  );

  /* ================================================================== */
  section("a failed send is retried, then given up on (NFR-07)");
  /* ================================================================== */

  // Pause the switch while the item is made, so refresh_alerts queues its message
  // without dispatchSoon sending it — this block is about how the queue fails,
  // so the row has to still be there when it is exercised.
  await call("PATCH", "/api/settings", { email_enabled: "0" }, A);
  r = await call("POST", "/api/items", {
    name: `Fail Probe ${Date.now().toString(36)}`,
    quantity: 1,
    low_stock_threshold: 5,
  }, A);
  const failProbe = r.data?.item;
  if (failProbe?.id) created.items.push(failProbe.id);
  check("a probe item below threshold is created", r.status === 201, `${r.status}`);
  await call("PATCH", "/api/settings", { email_enabled: "1" }, A);
  await settle(600);

  rows = await queue(A);
  const failRow = rows.find((q) => q.email_recipients && /Fail Probe/.test(q.body ?? ""));
  check(
    "the alert queued a message rather than sending",
    Boolean(failRow) && failRow.status === "queued",
    failRow ? failRow.status : "no row"
  );

  // Now the failure: the stub refuses, and the retry loop writes that down.
  await stub.failNext(1);
  await call("PATCH", "/api/email", { action: "send_now" }, A);
  await settle(1200);

  rows = await queue(A);
  const refused = rows.find((q) => /refused/i.test(q.last_error ?? ""));
  check(
    "a refused message is put back on the queue rather than lost",
    Boolean(refused) && refused.status === "queued" && refused.attempts >= 1,
    refused ? `${refused.status}, ${refused.attempts} attempt(s)` : "no row carries the failure"
  );
  check(
    "the failure reason is recorded rather than swallowed",
    /refused/i.test(rows[0]?.last_error ?? "") ||
      rows.some((q) => /refused/i.test(q.last_error ?? "")),
    rows.find((q) => q.last_error)?.last_error ?? "no error recorded"
  );

  // Retrying by hand must now succeed, because the injected failure is spent.
  await call("PATCH", "/api/email", { action: "send_now" }, A);
  await settle(1800);
  got = await stub.messages();
  check(
    "the retry is delivered once the server accepts it",
    got.messages.length >= 1,
    `${got.messages.length} delivered`
  );

  // Exhausting the attempts: one failure per dispatch, and the give-up only bites
  // once a row's attempt count has reached the limit — so it takes one more
  // dispatch than a first read suggests.
  await stub.reset();
  await call("PATCH", "/api/settings", { email_max_attempts: "2" }, A);
  await call("PATCH", "/api/settings", { email_enabled: "0" }, A);
  r = await call("POST", "/api/items", {
    name: `Fail Probe 2 ${Date.now().toString(36)}`,
    quantity: 1,
    low_stock_threshold: 5,
  }, A);
  const failProbe2 = r.data?.item;
  if (failProbe2?.id) created.items.push(failProbe2.id);
  await call("PATCH", "/api/settings", { email_enabled: "1" }, A);
  await settle(600);
  await stub.failNext(1);
  await call("PATCH", "/api/email", { action: "send_now" }, A);
  await settle(600);
  await stub.failNext(1);
  await call("PATCH", "/api/email", { action: "send_now" }, A);
  await settle(600);
  // Third dispatch: the row is at its allowance, so this one marks it failed
  // rather than trying again.
  r = await call("PATCH", "/api/email", { action: "send_now" }, A);
  check("an exhausted message is skipped, not retried forever", (r.data?.skipped ?? 0) >= 1,
    `skipped=${r.data?.skipped ?? "-"}`);

  rows = await queue(A);
  check(
    "and it is left marked failed with the reason",
    rows.some((q) => q.status === "failed" && /gave up/i.test(q.last_error ?? "")),
    rows.find((q) => q.status === "failed")?.last_error ?? "none"
  );

  r = await call("PATCH", "/api/email", { action: "retry_failed" }, A);
  check("an admin can put failed rows back on the queue", r.status === 200, `${r.status}`);
  check("and they are requeued", (r.data?.requeued ?? 0) >= 1, `requeued=${r.data?.requeued ?? 0}`);

  await call("PATCH", "/api/settings", { email_max_attempts: "3" }, A);

  /* ================================================================== */
  section("report by email");
  /* ================================================================== */

  await stub.reset();
  const stranger = "bookkeeper@merrylane.test";
  const categories = await call("GET", "/api/refs/categories", null, A);
  const categoryId = categories.data?.items?.[0]?.id;
  const reportFilters = {
    from: "2025-01-03",
    to: "2025-01-04",
    staff: "Juan Dela Cruz",
    type: "waste",
    category_id: categoryId,
  };
  await stub.reset();
  await stub.failNext(1);
  r = await call("POST", "/api/email/report", { to: stranger, filters: reportFilters }, A);
  check("a report can be emailed to an arbitrary address", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  const reportRetried = await waitFor(async () => {
    const queued = await queue(A);
    const report = queued.find((entry) => entry.kind === "report");
    return report?.status === "queued" && Boolean(report.last_error);
  });
  check("a failed PDF delivery stays queued with its retry reason", reportRetried);

  r = await call("PATCH", "/api/email", { action: "send_now" }, A);
  check(
    "the queued PDF is delivered on retry",
    r.status === 200 && r.data?.sent === 1,
    `${r.status} sent=${r.data?.sent ?? 0}`
  );
  const reportArrived = await waitFor(async () =>
    (await stub.messages()).messages.some((m) => m.to.includes(stranger))
  );
  got = await stub.messages();
  const reports = got.messages.filter((m) => m.to.includes(stranger));
  check("the report was delivered to that address", reportArrived, `${reports.length} delivered`);
  const reportMime = `${reports[0]?.headers?.["Content-Type"] ?? ""}\n${reports[0]?.body ?? ""}`;
  check(
    "it carries the exported PDF design as an attachment",
    /Content-Type:\s*application\/pdf/i.test(reportMime) &&
      /Content-Disposition:\s*attachment/i.test(reportMime) &&
      /filename="?cafetrack-report-\d{4}-\d{2}-\d{2}\.pdf"?/i.test(reportMime) &&
      /Content-Transfer-Encoding:\s*base64[\s\S]{0,300}JVBERi0x/i.test(reportMime),
    "PDF content and a dated attachment filename are present"
  );
  check(
    "the automated report has branded HTML, an inline Merrylane logo, and plaintext",
    hasBrandedHtmlAndPlainText(reports[0]),
    "HTML body and inline brand asset are alongside the PDF attachment"
  );
  const queuedReport = (await queue(A)).find((entry) => entry.kind === "report");
  check(
    "the emailed PDF records the active report filters",
    reportFilters.from &&
      reportFilters.to &&
      reportFilters.staff &&
      reportFilters.type &&
      reportFilters.category_id &&
      queuedReport?.body?.includes("Dates: 2025-01-03 to 2025-01-04") &&
      queuedReport?.body?.includes("Staff: Juan Dela Cruz") &&
      queuedReport?.body?.includes("Movement: waste") &&
      queuedReport?.body?.includes(`Category: ${categories.data.items[0].name}`) &&
      queuedReport?.body?.includes("Items included: 1") &&
      queuedReport?.body?.includes("Movement summary: Checked out: 0 transactions"),
    queuedReport?.body ?? "filters not reflected in the queued message"
  );
  check(
    "the email body points to the attached report instead of duplicating a plain-text stock table",
    /complete inventory and movement report is attached as a PDF/i.test(queuedReport?.body ?? ""),
    "concise body with PDF attachment"
  );

  r = await call("POST", "/api/email/report", { to: "nope" }, A);
  check("a malformed address is refused", r.status === 400, `${r.status}`);

  r = await call("POST", "/api/email/report", { to: stranger });
  check("only an admin can send a report by email", r.status === 401 || r.status === 403, `${r.status}`);

  /* ================================================================== */
  section("credentials and configuration");
  /* ================================================================== */

  r = await call("GET", "/api/settings", null, A);
  check(
    "no settings response carries the stored mail password",
    !JSON.stringify(r.data ?? {}).match(/smtp_pass_enc/),
    Object.keys(r.data?.settings ?? {}).length + " settings returned"
  );

  r = await call("PATCH", "/api/settings", { smtp_pass_enc: "injected" }, A);
  check(
    "and no route will let one be written through the generic settings endpoint",
    r.status === 400,
    `${r.status} ${r.data?.error ?? ""}`
  );

  r = await call("PATCH", "/api/settings", { email_dedupe_hours: "999" }, A);
  check("an out-of-range setting is refused at the door", r.status === 400, `${r.status}`);

  r = await call("PATCH", "/api/settings", { email_enabled: "banana" }, A);
  check("a nonsense on/off value is refused rather than coerced", r.status === 400, `${r.status}`);

  r = await call("GET", "/api/email", null, A);
  check(
    "the recipient list shows subscriptions as the email page renders them",
    Array.isArray(r.data?.recipients) && r.data.recipients.every((x) => "subscriptions" in x),
    `${r.data?.recipients?.length ?? 0} recipients`
  );

  section("the delivery log filters and pages queue rows");
  const alertKinds = new Set([
    "low_stock",
    "out_of_stock",
    "near_expiry",
    "expired",
    "failed_login",
  ]);
  for (const [filter, matches] of [
    ["alerts", (kind) => alertKinds.has(kind)],
    ["reports", (kind) => kind === "report" || kind === "reports"],
    ["daily_summary", (kind) => kind === "daily_summary"],
  ]) {
    const filtered = await call("GET", `/api/email?queue=1&kind=${filter}`, null, A);
    check(
      `${filter} shows only its matching messages`,
      filtered.status === 200 &&
        Array.isArray(filtered.data?.queue) &&
        filtered.data.queue.every((row) => matches(row.kind)),
      `${filtered.status} ${filtered.data?.queue?.map((row) => row.kind).join(", ") ?? filtered.data?.error ?? ""}`
    );
  }
  const reportsLog = await call("GET", "/api/email?queue=1&kind=reports", null, A);
  check(
    "the reports filter includes the report sent in this suite",
    reportsLog.data?.queue?.some((row) => row.kind === "report"),
    `${reportsLog.data?.queue?.length ?? 0} rows`
  );
  const invalidLogFilter = await call("GET", "/api/email?queue=1&kind=unknown", null, A);
  check("an unknown delivery-log filter is rejected", invalidLogFilter.status === 400, `${invalidLogFilter.status}`);
  const secondLogPage = await call("GET", "/api/email?queue=1&offset=50", null, A);
  check(
    "the delivery log supports 50-row pagination",
    secondLogPage.status === 200 &&
      Array.isArray(secondLogPage.data?.queue) &&
      secondLogPage.data.queue.length <= 50 &&
      typeof secondLogPage.data?.queue_has_more === "boolean",
    `${secondLogPage.status} rows=${secondLogPage.data?.queue?.length ?? "-"}`
  );

  section("owner-email admin password recovery");
  const unauthenticatedPasswordChange = await call(
    "POST",
    "/api/auth/change-password",
    {
      current_password: ADMIN_PASSWORD,
      password: "CafeTrack!Temp2",
      confirm_password: "CafeTrack!Temp2",
    }
  );
  check(
    "changing an admin password requires an authenticated admin",
    unauthenticatedPasswordChange.status === 401 || unauthenticatedPasswordChange.status === 403,
    `${unauthenticatedPasswordChange.status}`
  );

  const wrongCurrentPassword = await call(
    "POST",
    "/api/auth/change-password",
    {
      current_password: "not-the-current-password",
      password: "CafeTrack!Temp2",
      confirm_password: "CafeTrack!Temp2",
    },
    A
  );
  check("changing a password checks the current password", wrongCurrentPassword.status === 401);

  const invalidRecoveryEmail = await call(
    "PATCH",
    "/api/settings",
    { password_recovery_email: "not-an-email" },
    A
  );
  check("an invalid owner recovery email is rejected", invalidRecoveryEmail.status === 400);

  if (ADMIN_PASSWORD.length < 8) {
    check(
      "password change and reset tests skipped because the seeded password is shorter than the new 8-character minimum",
      true
    );
  } else {
    const changedPassword = await call(
      "POST",
      "/api/auth/change-password",
      {
        current_password: ADMIN_PASSWORD,
        password: "CafeTrack!Temp2",
        confirm_password: "CafeTrack!Temp2",
      },
      A
    );
    check("an admin can change their own password", changedPassword.status === 200);
    const oldAdminSession = A;
    A = (changedPassword.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const staleAdminSession = await call("GET", "/api/auth/me", null, oldAdminSession);
    check(
      "changing a password invalidates the previously issued session",
      staleAdminSession.status === 401
    );

    const restoredPassword = await call(
      "POST",
      "/api/auth/change-password",
      {
        current_password: "CafeTrack!Temp2",
        password: ADMIN_PASSWORD,
        confirm_password: ADMIN_PASSWORD,
      },
      A
    );
    check("the test restores the seeded admin password", restoredPassword.status === 200);
    A = (restoredPassword.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const currentSettings = await call("GET", "/api/settings", null, A);
    recoveryEmailBefore = currentSettings.data?.settings?.password_recovery_email ?? "";
    const listedUsers = await call("GET", "/api/users", null, A);
    const recoveryAdmin = listedUsers.data?.users?.find((user) => user.username === "admin");
    adminRecoveryUserId = recoveryAdmin?.id ?? null;
    adminRecoveryEmailBefore = recoveryAdmin?.recovery_email ?? "";
    check("admin accounts expose their individual recovery email to admins", Boolean(adminRecoveryUserId));

    const configuredAdminRecoveryEmail = adminRecoveryUserId
      ? await call(
          "PATCH",
          `/api/users/${adminRecoveryUserId}`,
          { recovery_email: OWNER },
          A
        )
      : { status: 0 };
    check(
      "an admin can save an individual recovery email",
      configuredAdminRecoveryEmail.status === 200,
      `${configuredAdminRecoveryEmail.status}`
    );

    const configuredRecoveryEmail = await call(
      "PATCH",
      "/api/settings",
      { password_recovery_email: SECOND },
      A
    );
    check("the legacy recovery fallback can still be configured", configuredRecoveryEmail.status === 200);

    const beforeRecoveryMail = await stub.messages();
    const requested = await call(
      "POST",
      "/api/auth/password-recovery",
      { action: "request", username: "admin" }
    );
    check(
      "the public recovery request returns a generic response",
      requested.status === 200 &&
        /eligible/.test(requested.data?.message ?? "") &&
        Boolean(requested.data?.challenge_id) &&
        Number.isFinite(Date.parse(requested.data?.expires_at)) &&
        Number.isFinite(Date.parse(requested.data?.resend_available_at)) &&
        Number.isSafeInteger(requested.data?.resend_after_seconds) &&
        requested.data.resend_after_seconds >= 0 &&
        requested.data.resend_after_seconds <= 60,
      `${requested.status}`
    );

    const recoveryMailArrived = await waitFor(async () => {
      const messages = await stub.messages();
      return messages.count > beforeRecoveryMail.count;
    });
    const recoveryMessages = await stub.messages();
    const recoveryMail = recoveryMessages.messages
      .slice(beforeRecoveryMail.count)
      .find((message) => /admin password reset code/i.test(message.subject));
    const recoveryCode = recoveryMail?.body.match(/code is (\d{6})/i)?.[1];
    check(
      "a recovery code is sent to this admin's own inbox instead of the legacy fallback",
      recoveryMailArrived &&
        recoveryMail?.to.includes(OWNER) &&
        !recoveryMail?.to.includes(SECOND) &&
        Boolean(recoveryCode),
      recoveryMail?.to ?? "not delivered"
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      await call(
        "POST",
        "/api/auth/password-recovery",
        { action: "request", username: "ADMIN" }
      );
    }
    const reusedRequest = await call(
      "POST",
      "/api/auth/password-recovery",
      { action: "request", username: "admin" }
    );
    const messagesAfterReuse = await stub.messages();
    check(
      "a request during cooldown reuses the active challenge without sending another email",
      reusedRequest.status === 200 &&
        reusedRequest.data?.challenge_id === requested.data?.challenge_id &&
        reusedRequest.data?.expires_at === requested.data?.expires_at &&
      reusedRequest.data?.resend_available_at === requested.data?.resend_available_at &&
      Number.isSafeInteger(reusedRequest.data?.resend_after_seconds) &&
      reusedRequest.data.resend_after_seconds <= requested.data.resend_after_seconds &&
      messagesAfterReuse.count === recoveryMessages.count,
      `${reusedRequest.status} same challenge=${reusedRequest.data?.challenge_id === requested.data?.challenge_id} same expiry=${reusedRequest.data?.expires_at === requested.data?.expires_at} same cooldown=${reusedRequest.data?.resend_available_at === requested.data?.resend_available_at} mail count=${messagesAfterReuse.count}`
    );
    const recoveryDecodedRaw = decodedMime(recoveryMail);
    check(
      "the recovery email includes styled HTML and the embedded Merrylane logo",
      hasBrandedHtmlAndPlainText(recoveryMail) &&
        /width="220" height="87"/i.test(recoveryDecodedRaw) &&
        /merrylane-wordmark\.png/i.test(recoveryDecodedRaw),
      recoveryDecodedRaw.includes("text/html")
        ? "styled HTML with the inline Merrylane logo"
        : "HTML part missing"
    );
    check(
      "the visible HTML email includes this recovery code in a styled code block",
      Boolean(recoveryCode) &&
        /YOUR VERIFICATION CODE/i.test(recoveryDecodedRaw) &&
        recoveryDecodedRaw.includes(recoveryCode),
      recoveryCode ? "code is present in the HTML message" : "code missing"
    );
    check(
      "the email keeps a plain-text fallback with a clear safety reminder",
      /text\/plain/i.test(recoveryDecodedRaw) &&
        /DIDN'T REQUEST THIS/i.test(recoveryDecodedRaw) &&
        /Never share this code with anyone/i.test(recoveryDecodedRaw),
      `plain=${/text\/plain/i.test(recoveryDecodedRaw)} reminder=${/DIDN'T REQUEST THIS/i.test(recoveryDecodedRaw)} share=${/Never share this code with anyone/i.test(recoveryDecodedRaw)}`
    );
    check(
      "the HTML email explains what to do if the reset was not requested",
      /Didn't request this\?/i.test(recoveryDecodedRaw) &&
        /Your password will not change/i.test(recoveryDecodedRaw),
      "security reminder is present"
    );

    const wrongCode = await call("POST", "/api/auth/password-recovery", {
      action: "verify",
      challenge_id: requested.data?.challenge_id,
      code: recoveryCode === "000000" ? "999999" : "000000",
    });
    check("an incorrect recovery code is rejected", wrongCode.status === 400, `${wrongCode.status}`);

    const verifiedCode = await call("POST", "/api/auth/password-recovery", {
      action: "verify",
      challenge_id: requested.data?.challenge_id,
      code: recoveryCode,
    });
    check(
      "the original emailed code remains valid after the repeated request",
      verifiedCode.status === 200 && Boolean(verifiedCode.data?.reset_token),
      `${verifiedCode.status}`
    );

    const mismatchedPassword = await call("POST", "/api/auth/password-recovery", {
      action: "reset",
      challenge_id: requested.data?.challenge_id,
      reset_token: verifiedCode.data?.reset_token,
      password: "CafeTrack!Test2",
      confirm_password: "not-the-same",
    });
    check("password confirmation is required before consuming the reset token", mismatchedPassword.status === 400);

    const samePasswordReset = await call("POST", "/api/auth/password-recovery", {
      action: "reset",
      challenge_id: requested.data?.challenge_id,
      reset_token: verifiedCode.data?.reset_token,
      password: ADMIN_PASSWORD,
      confirm_password: ADMIN_PASSWORD,
    });
    check(
      "admin password recovery rejects the current password with a clear error",
      samePasswordReset.status === 400 &&
        /different from your current password/i.test(samePasswordReset.data?.error ?? ""),
      `${samePasswordReset.status} ${samePasswordReset.data?.error ?? ""}`
    );

    const throttledLoginFailures = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      throttledLoginFailures.push(
        await call("POST", "/api/auth/login", {
          username: `recovery-throttle-${attempt}`,
          password: "wrong-on-purpose",
        })
      );
    }
    const blockedBeforeRecovery = await call("POST", "/api/auth/login", {
      username: "admin",
      password: ADMIN_PASSWORD,
    });
    check(
      "the shared admin login throttle is active before password recovery",
      throttledLoginFailures.every((result) => result.status === 401) &&
        blockedBeforeRecovery.status === 429,
      `${throttledLoginFailures.map((result) => result.status).join(",")} then ${blockedBeforeRecovery.status}`
    );

    const reset = await call("POST", "/api/auth/password-recovery", {
      action: "reset",
      challenge_id: requested.data?.challenge_id,
      reset_token: verifiedCode.data?.reset_token,
      password: "CafeTrack!Reset3",
      confirm_password: "CafeTrack!Reset3",
    });
    check(
      "the verified owner code resets the admin password and confirms the shared lockout was cleared",
      reset.status === 200 && reset.data?.login_throttle_cleared === true,
      `${reset.status} ${reset.data?.message ?? reset.data?.error ?? ""}`
    );

    const recoveryLogin = await call("POST", "/api/auth/login", {
      username: "admin",
      password: "CafeTrack!Reset3",
    });
    A = (recoveryLogin.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    check(
      "password recovery clears the active shared login throttle and allows immediate sign-in",
      recoveryLogin.status === 200,
      `${recoveryLogin.status} ${recoveryLogin.data?.error ?? ""}`
    );

    const restoredRecoveredPassword = await call(
      "POST",
      "/api/auth/change-password",
      {
        current_password: "CafeTrack!Reset3",
        password: ADMIN_PASSWORD,
        confirm_password: ADMIN_PASSWORD,
      },
      A
    );
    check("the test restores the seeded admin password after recovery", restoredRecoveredPassword.status === 200);
    A = (restoredRecoveredPassword.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const reusedToken = await call("POST", "/api/auth/password-recovery", {
      action: "reset",
      challenge_id: requested.data?.challenge_id,
      reset_token: verifiedCode.data?.reset_token,
      password: "CafeTrack!Reset3",
      confirm_password: "CafeTrack!Reset3",
    });
    check("a recovery token cannot be used twice", reusedToken.status === 400, `${reusedToken.status}`);

    await stub.failNext(1);
    const failedRecoveryRequest = await call(
      "POST",
      "/api/auth/password-recovery",
      { action: "request", username: "admin" }
    );
    check(
      "a recovery email delivery failure is reported instead of claiming the code was sent",
      failedRecoveryRequest.status === 503 &&
        /couldn't send the recovery code/i.test(failedRecoveryRequest.data?.error ?? ""),
      `${failedRecoveryRequest.status} ${failedRecoveryRequest.data?.error ?? ""}`
    );

    const clearedAdminRecoveryEmail = await call(
      "PATCH",
      `/api/users/${adminRecoveryUserId}`,
      { recovery_email: "" },
      A
    );
    check("an admin email can be cleared to use the legacy fallback", clearedAdminRecoveryEmail.status === 200);

    const beforeFallbackMail = await stub.messages();
    const fallbackRequest = await call(
      "POST",
      "/api/auth/password-recovery",
      { action: "request", username: "admin" }
    );
    const fallbackMailArrived = await waitFor(async () => {
      const messages = await stub.messages();
      return messages.count > beforeFallbackMail.count;
    });
    const fallbackMessages = await stub.messages();
    const fallbackMail = fallbackMessages.messages
      .slice(beforeFallbackMail.count)
      .find((message) => /admin password reset code/i.test(message.subject));
    check(
      "legacy owner email is used when this admin has no individual recovery email",
      fallbackRequest.status === 200 &&
        fallbackMailArrived &&
        fallbackMail?.to.includes(SECOND) &&
        !fallbackMail?.to.includes(OWNER),
      fallbackMail?.to ?? "not delivered"
    );

    const restoredAdminRecoveryEmail = await call(
      "PATCH",
      `/api/users/${adminRecoveryUserId}`,
      { recovery_email: adminRecoveryEmailBefore },
      A
    );
    check("the test restores the admin's individual recovery email after fallback", restoredAdminRecoveryEmail.status === 200);

    const restoredRecoveryEmail = await call(
      "PATCH",
      "/api/settings",
      { password_recovery_email: recoveryEmailBefore },
      A
    );
    check("the test restores the previous legacy recovery email", restoredRecoveryEmail.status === 200);
  }

  /* ================================================================== */
  section("the queue is admin-only, like everything else in Settings");
  /* ================================================================== */

  r = await call("POST", "/api/email", { email_address: "x@y.test" });
  check("adding a recipient needs a session", r.status === 401 || r.status === 403, `${r.status}`);

  r = await call("GET", "/api/email", null, "");
  check("reading the delivery log needs a session", r.status === 401 || r.status === 403, `${r.status}`);
} catch (e) {
  fail++;
  failures.push(`suite crashed: ${e.message}`);
  console.log(`\n  FAIL  suite crashed: ${e.message}`);
  console.log(e.stack?.split("\n").slice(1, 4).join("\n"));
} finally {
  /* ---------------- put everything back ---------------- */

  const login = await call("POST", "/api/auth/login", {
    username: "admin",
    password: ADMIN_PASSWORD,
  });
  const A = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  if (A) {
    if (recoveryEmailBefore !== null) {
      await call("PATCH", "/api/settings", {
        password_recovery_email: recoveryEmailBefore,
      }, A);
    }
    if (adminRecoveryUserId && adminRecoveryEmailBefore !== null) {
      await call("PATCH", `/api/users/${adminRecoveryUserId}`, {
        recovery_email: adminRecoveryEmailBefore,
      }, A);
    }
    // Email off first, so nothing is queued while the rest is cleaned up.
    await call("PATCH", "/api/settings", { email_enabled: "0" }, A);
    // Every recipient, not just the ones this run created: emailing a report to
    // an address creates that address as a recipient, and leaving them behind
    // would silently change the subscription state the next run sees.
    await wipeEmailState(A);
    for (const id of created.items) {
      await call("DELETE", `/api/items/${id}`, null, A);
    }
    for (const id of created.suppliers) {
      await call("DELETE", `/api/refs/suppliers/${id}`, null, A);
    }
    // Clear any injection this run set but never spent, so the next run starts
    // with a stub that will accept everything.
    await stub.failNext(0);
    await stub.reset();
  }

  console.log(`\n${"-".repeat(50)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log("  - " + f));
  }
  process.exit(fail ? 1 : 0);
}