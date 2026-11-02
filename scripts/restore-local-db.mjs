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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const live = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");
const backupRoot = process.env.CAFETRACK_BACKUP_DIR || join(here, "..", "backups");

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const target = argv.find((a) => !a.startsWith("--"));

if (argv.includes("--list")) {
  const { readdirSync } = await import("node:fs");
  if (existsSync(backupRoot)) {
    const all = readdirSync(backupRoot)
      .filter((name) => name.startsWith("cafetrack-"))
      .sort()
      .reverse();
    if (all.length === 0) console.log("No backups found.");
    for (const name of all) console.log("  " + join(backupRoot, name));
  } else {
    console.log(`No backups directory at ${backupRoot}.`);
  }
  process.exit(0);
}

if (!target) {
  console.error(
    "Usage:  npm run db:restore -- <backup-dir> [--force]\n\n" +
      "List available backups with:  npm run db:restore -- --list"
  );
  process.exit(1);
}

const src = resolve(target);
if (!existsSync(src)) {
  console.error(`No such backup: ${src}`);
  process.exit(1);
}
const manifestPath = join(src, "manifest.json");

const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;
const archivePath = join(src, "pgdata.tar.gz");
const isAutomatic = manifest?.archive === "pgdata.tar.gz" && existsSync(archivePath);

/* ---- refuse while a dev server holds the database open ---- */
function appServerRunning() {
  // No -Filter and no inner quotes: cmd.exe -> powershell.exe mangles nested
  // quotes, and selecting every process then matching in JS is simpler and
  // portable than getting the quoting right twice.
  const cmd =
    'powershell.exe -NoProfile -NonInteractive -Command ' +
    '"Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"';
  try {
    return /next[\s\\/-]*(dev|start)/i.test(execSync(cmd, { encoding: "utf8" }));
  } catch {
    return false; // Could not determine — do not block a legitimate run.
  }
}

if (appServerRunning()) {
  console.error(
    "A Next.js server appears to be running.\n" +
      "PGlite is single-process, so restoring under it would be undone or fail.\n" +
      "Stop `npm run dev` and try again."
  );
  process.exit(1);
}

const tables = manifest?.tables ?? {};
for (const [table, expected] of Object.entries(tables)) {
  if (
    !/^[a-z_][a-z0-9_]*$/.test(table) ||
    !Number.isInteger(expected) ||
    expected < -1
  ) {
    console.error(`Invalid row-count entry in ${manifestPath}: ${table}`);
    process.exit(1);
  }
}

/*
 * Restore to a sibling staging directory and validate it before touching the
 * current database. Automatic backups are tar archives made while PGlite is
 * live; manual backups are directory copies. Both now use the same validated
 * swap path, and a failed extraction or row check leaves the current database
 * in place.
 */
mkdirSync(dirname(live), { recursive: true });
const stage = `${live}.restore-staging-${process.pid}`;
rmSync(stage, { recursive: true, force: true });

try {
  if (isAutomatic) {
    const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
    if (listing.error) throw listing.error;
    if (listing.status !== 0) {
      throw new Error(listing.stderr.trim() || "Could not inspect the automatic backup archive");
    }

    const unsafeEntry = listing.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .find((entry) => {
        const normalized = entry.replace(/\\/g, "/").replace(/^\/+/, "");
        return (
          normalized.split("/").some((part) => part === "..") ||
          /^[a-zA-Z]:/.test(normalized)
        );
      });
    if (unsafeEntry) throw new Error(`Unsafe path in backup archive: ${unsafeEntry}`);

    mkdirSync(stage, { recursive: true });
    const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", stage], {
      encoding: "utf8",
    });
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) {
      throw new Error(extraction.stderr.trim() || "Could not extract the automatic backup");
    }
  } else {
    cpSync(src, stage, { recursive: true });
    rmSync(join(stage, "manifest.json"), { force: true });
  }

  if (Object.keys(tables).length > 0) {
    const pg = new PGlite(stage);
    await pg.waitReady;
    try {
      let mismatches = 0;
      for (const [table, expected] of Object.entries(tables)) {
        if (expected === -1) {
          console.log(`  skip ${table.padEnd(20)} absent when the backup was made`);
          continue;
        }
        const result = await pg.query(`select count(*)::int as n from "${table}"`);
        const actual = Number(result.rows[0]?.n ?? 0);
        const matches = actual === expected;
        if (!matches) mismatches++;
        console.log(
          `  ${matches ? "ok  " : "DIFF"} ${table.padEnd(20)} expected ${String(expected).padStart(5)}  got ${String(actual).padStart(5)}`
        );
      }

      /*
       * The automatic snapshot and the manifest counts are captured in separate
       * operations while the server is live, so a concurrent write can make
       * their counts differ. Report that condition without rejecting a database
       * that PGlite successfully opened. Manual backups are closed before the
       * copy and can be checked strictly.
       */
      if (mismatches > 0 && !isAutomatic) {
        throw new Error(
          `${mismatches} table(s) do not match the manifest; the live database was not changed.`
        );
      }
      if (mismatches > 0) {
        console.warn(
          `Automatic backup opened, but ${mismatches} row count(s) differ from its non-atomic manifest.`
        );
      } else {
        console.log("\nAll row counts match the backup manifest.");
      }
    } finally {
      await pg.close();
    }
  } else {
    console.warn("No row-count manifest found; the staged database opened without count checks.");
    const pg = new PGlite(stage);
    await pg.waitReady;
    await pg.close();
  }

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const stash = force
    ? `${live}.restore-old-${suffix}`
    : `${live}.replaced-${suffix}`;
  let movedLive = false;

  if (existsSync(live)) {
    renameSync(live, stash);
    movedLive = true;
    console.log(
      force
        ? `Temporarily kept the previous database at ${stash} until the swap succeeds.`
        : `Kept the previous database at ${stash}`
    );
  } else {
    console.log("No current database — restoring into a fresh one.");
  }

  try {
    renameSync(stage, live);
    if (force && movedLive) rmSync(stash, { recursive: true, force: true });
  } catch (error) {
    if (movedLive && !existsSync(live)) renameSync(stash, live);
    throw error;
  }

  console.log(`Restored ${src} -> ${live}`);
} catch (error) {
  rmSync(stage, { recursive: true, force: true });
  console.error(`Restore aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
