/**
 * A dev server for running the test suites, isolated from your real data.
 *
 *   npm run dev:test          (in one terminal)
 *   npm run test:isolated     (in another)
 *
 * The suites write to the database: they check stock out, restock it, create
 * and delete accounts, and add to the movement ledger. A ledger is
 * append-only by design, so none of that can be undone by the suites
 * themselves — `test:journeys` deletes the items it creates, but the
 * transactions that touched them survive on purpose (transaction_items keeps a
 * name snapshot, and item_id is `on delete set null`). Run against your working
 * database repeatedly, the test history accumulates and starts topping the
 * dashboard's "In-Demand Items" and the report's "Most checked out".
 *
 * So: this server points CAFETRACK_DB_DIR at a throwaway directory. The suites
 * get a freshly seeded database of their own and your data is never opened.
 * The plumbing already existed — local-db.ts and all five db:* scripts already
 * read CAFETRACK_DB_DIR — and the suites already honour BASE_URL. This just
 * wires the two together.
 *
 * Two details make it work:
 *   - a different port, so it does not collide with `npm run dev`
 *   - its own distDir, because Next locks .next/dev and a second server in
 *     the same folder refuses to start
 *
 * The isolated database lives in .pglite-test/ and is seeded on first request.
 * `npm run db:test:wipe` throws it away.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT || 3101);
const DB_DIR = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite-test");
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next-test";

if (process.env.CAFETRACK_TEST_RESET === "1" && existsSync(DB_DIR)) {
  rmSync(DB_DIR, { recursive: true, force: true });
  console.log(`[dev:test] reset ${DB_DIR}`);
}

console.log(`[dev:test] port ${PORT}`);
console.log(`[dev:test] database ${DB_DIR}  (your .pglite is not touched)`);
console.log(`[dev:test] distDir  ${DIST_DIR}`);
console.log(
  `[dev:test] then run the suites against it, e.g.\n` +
    `            BASE_URL=http://localhost:${PORT} npm run test:all\n`
);

// Next's CLI is invoked through this same node binary rather than via `npx`.
// Node 20.12+ refuses to spawn a .cmd without a shell (EINVAL, the fix for
// CVE-2024-27980), and going through the JS entry avoids the shell entirely,
// so this behaves identically on Windows and POSIX.
const NEXT_BIN = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

const child = spawn(
  process.execPath,
  [NEXT_BIN, "dev", "-p", String(PORT)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CAFETRACK_DB_DIR: DB_DIR,
      NEXT_DIST_DIR: DIST_DIR,
    },
  }
);

// Ctrl-C should take the child down with it, or it is orphaned holding the
// isolated database open and the next run fails to seed.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
    process.exit(0);
  });
}
child.on("exit", (code) => process.exit(code ?? 0));
