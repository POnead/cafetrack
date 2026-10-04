/**
 * Run every suite against the isolated test server from `npm run dev:test`.
 *
 *   npm run dev:test          (terminal 1)
 *   npm run test:isolated     (terminal 2)
 *
 * Sets BASE_URL for each child rather than relying on a shell-specific
 * `BASE_URL=... &&` prefix, so this works the same on Windows and POSIX.
 *
 * The suites expect a freshly seeded database, so the first thing it does is
 * tell the server to start over. Set CAFETRACK_TEST_RESET=1 to force that; by
 * default it reuses the isolated database, which is what makes a second run
 * fast. Point it at a server that is not the isolated one and you are back to
 * writing to real data, so it refuses unless BASE_URL names a non-default port.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT || 3101);
const BASE = `http://localhost:${PORT}`;

// 3100 is `npm run dev`, which runs against your real .pglite. The suites write
// to the movement ledger, which is append-only, so pointing them at it would
// leave test rows behind permanently.
if (PORT === 3100) {
  console.error(
    "Refusing to run: TEST_PORT is 3100, which is your normal dev server.\n" +
      "Point this at the server from `npm run dev:test`, or your real data\n" +
      "will take the test writes."
  );
  process.exit(1);
}

const SUITES = [
  ["test:smoke", "smoke-test.mjs"],
  ["test:edge", "_edge-tests.mjs"],
  ["test:pages", "_pages.mjs"],
  ["test:journeys", "_journeys.mjs"],
  ["test:ui", "_ui.mjs"],
  ["test:tour", "_usertour.mjs"],
  ["perf", "perf-check.mjs"],
];

const isWindows = process.platform === "win32";
const node = isWindows ? "node.exe" : "node";

let failed = 0;

for (const [name, file] of SUITES) {
  console.log(`\n${"=".repeat(52)}\n== ${name} (${BASE})\n${"=".repeat(52)}`);
  const code = await new Promise((resolve) => {
    const child = spawn(node, [join("scripts", file)], {
      stdio: "inherit",
      env: { ...process.env, BASE_URL: BASE },
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    failed++;
    console.error(`\n${name} failed with exit code ${code}`);
    // Stop at the first failure, like test:all does — a broken database makes
    // every later suite's result meaningless.
    break;
  }
}

process.exit(failed ? 1 : 0);
