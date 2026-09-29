/**
 * Stops a suite writing to a real database.
 *
 * The suites delete the stock and reference rows they create, but they cannot
 * delete the transactions: the movement ledger is append-only, transaction_items
 * keeps an item_name snapshot, and item_id is `on delete set null`. So a suite
 * run against ./.pglite leaves history there permanently, and the dashboard's
 * "In-Demand Items" and the report's "Most checked out" fill up with
 * ingredients that no longer exist.
 *
 * The app tags every API response with `x-cafetrack-db: test|live` (see
 * lib/api.ts), so a suite can tell before it writes a single row. This is
 * called as the first statement of every suite that writes.
 *
 * Set CAFETRACK_ALLOW_LIVE_DB=1 to override, which prints a banner and carries
 * on. That is the escape hatch for anyone deliberately testing against real
 * data, and the record of having used it.
 */
export async function assertTestTarget(BASE) {
  let mode = null;

  try {
    // Any endpoint will do; /api/auth/me answers 401 without a cookie but
    // still carries the header, so this needs no credentials.
    const res = await fetch(`${BASE}/api/auth/me`, { redirect: "manual" });
    mode = res.headers.get("x-cafetrack-db");
  } catch {
    console.error(
      `\n  Could not reach ${BASE}.\n` +
        `  Start a server first, e.g. \`npm run dev:test\` in another terminal.\n`
    );
    process.exit(1);
  }

  if (mode === "test") return;

  if (process.env.CAFETRACK_ALLOW_LIVE_DB === "1") {
    console.warn(
      `\n${"!".repeat(60)}\n` +
        `  !! CAFETRACK_ALLOW_LIVE_DB=1 - running against a LIVE database.\n` +
        `  !! Movements recorded by this suite cannot be deleted afterwards.\n` +
        `${"!".repeat(60)}\n`
    );
    return;
  }

  console.error(
    `\nRefusing to run against ${BASE}.\n\n` +
      `That server reports a live database (x-cafetrack-db: ${mode ?? "unknown"}).\n` +
      `This suite writes to the movement ledger, which is append-only, so what it\n` +
      `records cannot be removed afterwards.\n\n` +
      `Use the throwaway database instead:\n` +
      `    npm run dev:test          (terminal 1)\n` +
      `    npm run test:isolated     (terminal 2)\n\n` +
      `Or, if you really mean to test against real data:\n` +
      `    CAFETRACK_ALLOW_LIVE_DB=1 npm run <this suite>\n`
  );
  process.exit(1);
}
