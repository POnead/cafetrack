/**
 * A dev server for running the test suites, isolated from your real data.
 *
 *   npm run dev:test          (in one terminal)
 *   npm run test:staff-confirm (in another; uses the secure default)
 *
 * The broader legacy suite can opt into the test-only staff-login bypass by
 * starting this server with CAFETRACK_TEST_BYPASS_STEP2=1.
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
 *
 * It also starts a throwaway SMTP server (scripts/_smtp-stub.mjs) and points the
 * application at it. Email is off in the settings by default, so this changes
 * nothing for the other suites — it only gives the notification path somewhere
 * to send, so `test:email` can prove a message was actually delivered rather
 * than merely queued. Without it, FR-11 is the one requirement with no possible
 * way to verify.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startSmtpStub, recordStubPorts, STUB_USER, STUB_PASS } from "./_smtp-stub.mjs";

function loadEnvFile(file) {
  if (!existsSync(file)) return {};

  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim();
    const unwrapped = value.replace(/^['"]|['"]$/g, "");
    values[key] = unwrapped;
  }
  return values;
}

const PORT = Number(process.env.TEST_PORT || 3101);
const DB_DIR = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite-test");
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next-test";
const LOCAL_ENV = loadEnvFile(join(process.cwd(), ".env.local"));
const bypassStepTwo = process.env.CAFETRACK_TEST_BYPASS_STEP2 === "1";
const requireStepTwo = process.env.CAFETRACK_TEST_STEP2 === "1";

if (bypassStepTwo && requireStepTwo) {
  throw new Error(
    "Set either CAFETRACK_TEST_BYPASS_STEP2=1 or CAFETRACK_TEST_STEP2=1, not both."
  );
}

if (process.env.CAFETRACK_TEST_RESET === "1" && existsSync(DB_DIR)) {
  rmSync(DB_DIR, { recursive: true, force: true });
  console.log(`[dev:test] reset ${DB_DIR}`);
}

if (existsSync(DIST_DIR)) {
  rmSync(DIST_DIR, { recursive: true, force: true });
  console.log(`[dev:test] cleared ${DIST_DIR}`);
}

console.log(`[dev:test] port ${PORT}`);
console.log(`[dev:test] database ${DB_DIR}  (your .pglite is not touched)`);
console.log(`[dev:test] distDir  ${DIST_DIR}`);
console.log(
  `[dev:test] staff face confirmation ${bypassStepTwo ? "explicitly bypassed for legacy tests" : "required"}`
);
console.log(
  `[dev:test] then run the suites against it, e.g.\n` +
    `            BASE_URL=http://localhost:${PORT} npm run test:all\n`
);

// Next's CLI is invoked through this same node binary rather than via `npx`.
// Node 20.12+ refuses to spawn a .cmd without a shell (EINVAL, the fix for
// CVE-2024-27980), and going through the JS entry avoids the shell entirely,
// so this behaves identically on Windows and POSIX.
const NEXT_BIN = join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

// Started before Next so the environment it inherits is complete on its first
// request. Email is off by default in the settings, so nothing is sent unless a
// suite asks for it.
const stub = await startSmtpStub({ smtpPort: 0, controlPort: 0 });
// Both ports are ephemeral, so the suite in the other process cannot guess the
// control one. Recording it is what lets `npm run test:isolated` run test:email
// instead of dying on ECONNREFUSED 2526.
recordStubPorts(stub);
console.log(
  `[dev:test] smtp stub 127.0.0.1:${stub.smtpPort}  control http://127.0.0.1:${stub.controlPort}  (test:email)`
);

const child = spawn(
  process.execPath,
  // Turbopack, like `npm run dev`. next.config.mjs used to pin `--webpack`
  // because PGlite's WASM broke under Turbopack on Windows with a junction
  // error; retested against Next 16.3.6, that no longer happens. The webpack
  // function is still in the config because the face-api alias it carries has
  // no automatic Turbopack equivalent, so `turbopack.resolveAlias` declares the
  // same alias. See next.config.mjs.
  //
  // Pass DEV_BUNDLER=webpack to run the isolated server on webpack instead —
  // useful for checking that a change behaves the same under both.
  [
    NEXT_BIN,
    "dev",
    process.env.DEV_BUNDLER === "webpack" ? "--webpack" : "--turbopack",
    "-p",
    String(PORT),
  ],
  {
    stdio: "inherit",
    env: {
      ...LOCAL_ENV,
      ...process.env,
      CAFETRACK_DB: "local",
      CAFETRACK_DB_DIR: DB_DIR,
      NEXT_DIST_DIR: DIST_DIR,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(stub.smtpPort),
      SMTP_STUB_PORT: String(stub.smtpPort),
      SMTP_STUB_CONTROL_PORT: String(stub.controlPort),
      SMTP_USER: STUB_USER,
      SMTP_PASS: STUB_PASS,
      EMAIL_FROM: "CafeTrack <no-reply@cafetrack.test>",
      // The stub speaks plain TCP on loopback, which is the one case
      // `SMTP_ALLOW_INSECURE` exists for. Everything else about the
      // configuration — the queue, the retries, the dedupe — is unchanged by it.
      SMTP_ALLOW_INSECURE: "1",
      // The scheduler would fire during a suite and queue mail at moments no
      // assertion expects. The daily-summary logic is tested by calling its
      // function directly, which is where the dedupe actually lives.
      CAFETRACK_DISABLE_EMAIL: "1",
      /*
       * Step two is enforced by default, including in the isolated test server.
       * Legacy suites that need direct staff sessions must explicitly opt in to
       * bypassing the face check with CAFETRACK_TEST_BYPASS_STEP2=1.
       *
       * CAFETRACK_TEST_STEP2=1 remains an explicit secure-mode override. The
       * route refuses to honour the bypass under NODE_ENV=production.
       */
      CAFETRACK_DISABLE_STEP2: bypassStepTwo && !requireStepTwo ? "1" : "",
    },
  }
);

// Ctrl-C should take the child down with it, or it is orphaned holding the
// isolated database open and the next run fails to seed.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig);
    stub.close().finally(() => process.exit(0));
  });
}
child.on("exit", (code) => {
  stub.close().finally(() => process.exit(code ?? 0));
});
