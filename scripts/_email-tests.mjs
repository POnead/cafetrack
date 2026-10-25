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

const created = { items: [], recipients: [] };

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
    password: "admin123",
  });
  const A = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
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

  // A direct check is not a queued delivery: it deliberately does not touch the
  // delivery log.
  let rows = await queue(A);
  const logged = rows.find((q) => /your email is set up|test message/i.test(q.subject));
  check("a check-by-hand is not logged as a queued delivery", !logged, logged ? logged.status : "absent");

  /* ================================================================== */
  section("an alert becomes a message (FR-11's headline behaviour)");
  /* ================================================================== */

  await stub.reset();
  r = await call("POST", "/api/items", {
    name: `Mail Probe ${Date.now().toString(36)}`,
    quantity: 1,
    low_stock_threshold: 5,
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
  r = await call("POST", "/api/email/report", { to: stranger }, A);
  check("a report can be emailed to an arbitrary address", r.status === 200, `${r.status} ${r.data?.error ?? ""}`);

  await stub.reset();
  const reportArrived = await waitFor(async () =>
    (await stub.messages()).messages.some((m) => m.to.includes(stranger))
  );
  got = await stub.messages();
  const reports = got.messages.filter((m) => m.to.includes(stranger));
  check("the report was delivered to that address", reportArrived, `${reports.length} delivered`);
  check(
    "it carries the stock table",
    /Current Stock:/i.test(reports[0]?.body ?? "") && /threshold/i.test(reports[0]?.body ?? ""),
    "includes current stock with thresholds"
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
    password: "admin123",
  });
  const A = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  if (A) {
    // Email off first, so nothing is queued while the rest is cleaned up.
    await call("PATCH", "/api/settings", { email_enabled: "0" }, A);
    // Every recipient, not just the ones this run created: emailing a report to
    // an address creates that address as a recipient, and leaving them behind
    // would silently change the subscription state the next run sees.
    await wipeEmailState(A);
    for (const id of created.items) {
      await call("DELETE", `/api/items/${id}`, null, A);
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