/**
 * Measures the three performance targets from the project spec against a
 * running server and reports pass/fail:
 *
 *   - item lookup completes in under 100 milliseconds
 *   - responsive dashboard updates with real-time data refresh (under 2 seconds)
 *   - near-instant stock deduction (under 1 second)
 *
 * This is a measurement tool, not a test of correctness: it writes a real
 * transaction and then undoes it, so run it against a development database
 * rather than one holding real stock.
 *
 * Each check is sampled several times and reports the median, because a single
 * cold request (first compile in dev, a GC pause) is not representative.
 *
 * Run with:  node scripts/perf-check.mjs          (server must be running)
 *            BASE_URL=http://localhost:3001 node scripts/perf-check.mjs
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const SAMPLES = Number(process.env.SAMPLES || 5);
const ADMIN = { username: "admin", password: "admin123" };

let cookie = "";

async function call(method, path, body) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length) {
    cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  }
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, ms: 0 };
}

/** Times one request, returning milliseconds. */
async function timed(method, path, body) {
  const start = performance.now();
  const r = await call(method, path, body);
  return { ...r, ms: performance.now() - start };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const results = [];

function report(label, ms, budget) {
  const pass = ms < budget;
  results.push({ label, ms, budget, pass });
  const flag = pass ? "PASS" : "FAIL";
  console.log(
    `  ${flag}  ${label.padEnd(34)} ${ms.toFixed(1).padStart(7)} ms  (budget ${budget} ms)`
  );
}

/* Warm the routes so the first compile is not counted as a slow request. */
await call("GET", "/login");
await call("POST", "/api/auth/login", ADMIN);
const me = await call("GET", "/api/auth/me");
if (me.status !== 200) {
  console.error(
    `Could not sign in at ${BASE} (${me.status}).\n` +
      "Start the server first, and make sure the seeded admin credentials are unchanged."
  );
  process.exit(1);
}

console.log(`\nCafeTrack performance check against ${BASE}`);
console.log(`  ${SAMPLES} samples each, median reported\n`);

/* ---- 1. item lookup (< 100 ms) ---- */
const items = await call("GET", "/api/items");
if (!items.data?.items?.length) {
  console.error("No items to look up. Seed the database first.");
  process.exit(1);
}
const sku = items.data.items[0].sku;

{
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = await timed("GET", `/api/items/lookup?code=${encodeURIComponent(sku)}`);
    if (r.status !== 200) {
      console.error(`  item lookup returned ${r.status}`);
      process.exit(1);
    }
    times.push(r.ms);
  }
  report("Item lookup", median(times), 100);
}

/* ---- 2. dashboard refresh (< 2000 ms) ----
 * The dashboard polls /api/items and /api/transactions every 2s, so the
 * refresh target is met when the pair of requests it depends on completes
 * comfortably inside that interval.
 */
{
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    await Promise.all([
      call("GET", "/api/items"),
      call("GET", "/api/transactions?limit=200"),
    ]);
    times.push(performance.now() - start);
  }
  report("Dashboard refresh (2 fetches)", median(times), 2000);
}

/* ---- 3. stock deduction (< 1000 ms) ----
 * Uses the process_transaction path a checkout takes, then restocks the same
 * amount so the net stock change is zero. If a step fails partway the item is
 * reported so the database can be corrected by hand.
 */
{
  const target = items.data.items.find((i) => Number(i.quantity) >= 2);
  if (!target) {
    console.log("  SKIP  stock deduction — no item with 2+ on hand");
  } else {
    const times = [];
    let failed = false;
    for (let i = 0; i < SAMPLES; i++) {
      const out = await timed("POST", "/api/transactions", {
        type: "checkout",
        password: ADMIN.password,
        items: [{ sku: target.sku, qty: 1 }],
      });
      if (out.status !== 201) {
        console.error(`\n  Checkout failed (${out.status}): ${JSON.stringify(out.data)}`);
        failed = true;
        break;
      }
      times.push(out.ms);

      // Put it back immediately so repeated samples do not drain the item.
      const back = await call("POST", "/api/transactions", {
        type: "restock",
        password: ADMIN.password,
        items: [{ sku: target.sku, qty: 1 }],
      });
      if (back.status !== 201) {
        console.error(
          `\n  Restock failed (${back.status}) for ${target.sku} (${target.name}).\n` +
            "  Add the unit back by hand before trusting the numbers."
        );
        failed = true;
        break;
      }
    }
    if (!failed) report("Stock deduction (checkout)", median(times), 1000);
  }
}

/* ---- summary ---- */
const failedCount = results.filter((r) => !r.pass).length;
console.log(
  `\n${results.length - failedCount} of ${results.length} targets met.\n`
);
process.exit(failedCount > 0 ? 1 : 0);
