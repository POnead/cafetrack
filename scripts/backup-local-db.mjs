/**
 * Backs up the local PGlite database.
 *
 * In local mode the database *is* the .pglite directory, so a backup is a
 * copy of that directory. (Under Supabase there is nothing to copy here —
 * that platform handles its own backups.)
 *
 * Every table's row count is recorded in manifest.json so a restore can be
 * sanity-checked afterwards: a restored copy with far fewer rows than the
 * manifest recorded means the wrong backup was taken.
 *
 * PGlite is single-process. If `npm run dev` is running it holds the database
 * open, and copying it mid-write could capture a torn state — so we refuse
 * rather than quietly produce a bad backup. Stop the dev server first.
 *
 * Run with:  npm run db:backup            (stop `npm run dev` first)
 */
import { PGlite } from "@electric-sql/pglite";
import {
  existsSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");
const backupRoot = process.env.CAFETRACK_BACKUP_DIR || join(here, "..", "backups");

if (!existsSync(dir)) {
  console.error(`Nothing to back up — ${dir} does not exist yet.`);
  process.exit(1);
}

const TABLES = [
  "users",
  "items",
  "categories",
  "locations",
  "transactions",
  "transaction_items",
  "alerts",
  "audit_log",
  "login_attempts",
  "settings",
];

/**
 * Best-effort check for a dev server holding the database open. PGlite has no
 * lock file we can rely on across platforms, so this is advisory: we look for
 * a node process with our own dev command line rather than guessing from a
 * port, which could belong to something unrelated.
 */
/**
 * Best-effort check for a dev server holding the database open. PGlite has no
 * portable lock file, so this looks for a node process running our own dev
 * command line. PowerShell is used rather than the old `wmic`, which is
 * removed from recent Windows builds.
 */
function devServerRunning() {
  // No -Filter and no inner quotes: cmd.exe -> powershell.exe mangles nested
  // quotes, and selecting every process then matching in JS is simpler and
  // portable than getting the quoting right twice.
  const cmd =
    'powershell.exe -NoProfile -NonInteractive -Command ' +
    '"Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"';
  try {
    return /next[\s\\/-]*dev/i.test(execSync(cmd, { encoding: "utf8" }));
  } catch {
    return false; // Could not determine — do not block a legitimate run.
  }
}

function warnIfServerRunning() {
  if (devServerRunning()) {
    console.error(
      "A Next.js dev server appears to be running.\n" +
        "PGlite is single-process, so copying the database while it is open\n" +
        "can capture an inconsistent state. Stop `npm run dev` and try again."
    );
    process.exit(1);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dest = join(backupRoot, `cafetrack-${stamp}`);

warnIfServerRunning();

mkdirSync(backupRoot, { recursive: true });

// Row counts first, while the database is open, so the manifest describes the
// state that is about to be copied.
const pg = new PGlite(dir);
await pg.waitReady;

const counts = {};
for (const table of TABLES) {
  const r = await pg.query(`select count(*)::int as n from ${table}`);
  counts[table] = Number(r.rows[0]?.n ?? 0);
}
await pg.close();

// cpSync is recursive and copies the whole directory tree.
cpSync(dir, dest, { recursive: true });

writeFileSync(
  join(dest, "manifest.json"),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      source: dir,
      tables: counts,
    },
    null,
    2
  ) + "\n"
);

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`Backed up ${dir}`);
console.log(`      ->  ${dest}`);
console.log(`      ${total} rows across ${TABLES.length} tables (see manifest.json)`);
console.log(`\nRestore with:  npm run db:restore -- "${dest}"`);

// Keep the ten most recent so this cannot fill the disk unattended.
const existing = readdirSync(backupRoot)
  .filter((n) => n.startsWith("cafetrack-"))
  .sort();
while (existing.length > 10) {
  const oldest = existing.shift();
  rmSync(join(backupRoot, oldest), { recursive: true, force: true });
  console.log(`Pruned old backup: ${oldest}`);
}
