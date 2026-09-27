/**
 * Restores the local PGlite database from a backup made by db:backup.
 *
 * The current .pglite is moved aside rather than deleted, so a mistaken
 * restore can be undone by hand. Pass --force to overwrite an existing
 * database without keeping the old one.
 *
 * After restoring, the row counts recorded in the backup's manifest.json are
 * compared against the live database, so a wrong or truncated backup is
 * reported rather than silently accepted.
 *
 * Run with:  npm run db:restore -- backups/cafetrack-<stamp>   (stop `npm run dev` first)
 */
import { PGlite } from "@electric-sql/pglite";
import { existsSync, renameSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const live = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");
const backupRoot = process.env.CAFETRACK_BACKUP_DIR || join(here, "..", "backups");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const target = argv.find((a) => !a.startsWith("--"));

if (!target) {
  console.error(
    "Usage:  npm run db:restore -- <backup-dir> [--force]\n\n" +
      "List available backups with:  npm run db:backup -- --list"
  );
  process.exit(1);
}

// Convenience: no argument, or --list, means show what is available.
if (target === "--list" || !existsSync(resolve(target))) {
  if (existsSync(backupRoot)) {
    const { readdirSync } = await import("node:fs");
    const all = readdirSync(backupRoot).filter((n) => n.startsWith("cafetrack-"));
    if (all.length === 0) console.log("No backups found.");
    for (const name of all.sort().reverse()) console.log("  " + join(backupRoot, name));
  } else {
    console.log(`No backups directory at ${backupRoot}.`);
  }
  process.exit(0);
}

const src = resolve(target);
const manifestPath = join(src, "manifest.json");

if (!existsSync(src)) {
  console.error(`No such backup: ${src}`);
  process.exit(1);
}

/* ---- refuse while a dev server holds the database open ---- */
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

if (devServerRunning()) {
  console.error(
    "A Next.js dev server appears to be running.\n" +
      "PGlite is single-process, so restoring under it would be undone or fail.\n" +
      "Stop `npm run dev` and try again."
  );
  process.exit(1);
}

/* ---- swap the directories ---- */
if (existsSync(live)) {
  if (force) {
    rmSync(live, { recursive: true, force: true });
    console.log(`Replaced ${live}`);
  } else {
    const stash = `${live}.replaced`;
    if (existsSync(stash)) rmSync(stash, { recursive: true, force: true });
    renameSync(live, stash);
    console.log(`Kept the previous database at ${stash}`);
  }
} else {
  console.log("No current database — restoring into a fresh one.");
}

const { cpSync } = await import("node:fs");
cpSync(src, live, { recursive: true, time: Date.now() });

// manifest.json is metadata about the backup, not part of the database.
const strayManifest = join(live, "manifest.json");
if (existsSync(strayManifest)) {
  copyFileSync(strayManifest, `${live}.manifest.json`);
  rmSync(strayManifest, { force: true });
}

console.log(`Restored ${src} -> ${live}`);

/* ---- verify against the manifest ---- */
if (!existsSync(manifestPath)) {
  console.log("No manifest.json in that backup — skipping the row-count check.");
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pg = new PGlite(live);
await pg.waitReady;

let mismatches = 0;
for (const [table, expected] of Object.entries(manifest.tables ?? {})) {
  const r = await pg.query(`select count(*)::int as n from ${table}`);
  const actual = Number(r.rows[0]?.n ?? 0);
  const ok = actual === expected;
  if (!ok) mismatches++;
  console.log(
    `  ${ok ? "ok  " : "DIFF"} ${table.padEnd(20)} expected ${String(expected).padStart(5)}  got ${String(actual).padStart(5)}`
  );
}
await pg.close();

if (mismatches > 0) {
  console.error(
    `\n${mismatches} table(s) do not match the manifest. This may be a different ` +
      "backup than you intended."
  );
  process.exit(1);
}
console.log("\nAll row counts match the backup manifest.");
