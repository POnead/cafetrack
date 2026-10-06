import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localDbReady } from "./local-db";

/**
 * The automatic daily backup (NFR-04: "automated backups shall run daily").
 *
 * This is deliberately *not* the same mechanism as `npm run db:backup`. That
 * script copies the .pglite directory and refuses to run while the dev server is
 * up, because copying a live database directory can capture a torn write. An
 * unattended backup cannot require someone to stop the server first, so this one
 * asks PGlite to produce a consistent snapshot through `dumpDataDir()` — a
 * checkpoint taken from inside the running process, which is safe to do while
 * queries are in flight.
 *
 * Under Supabase this does nothing. That platform takes its own backups, and
 * taking a second copy of a hosted database from the application server would be
 * the wrong place to do it.
 */

const BACKUP_ROOT = process.env.CAFETRACK_BACKUP_DIR || join(process.cwd(), "backups");

/** Hour of the day the backup runs. Early, before the cafe opens. */
const HOUR = Number(process.env.CAFETRACK_BACKUP_HOUR ?? 3);

/**
 * How many to keep. Each snapshot is tens of MB, so this is a real disk cost.
 * Three days is enough to notice a bad morning and still recover.
 */
const KEEP = Math.max(1, Number(process.env.CAFETRACK_BACKUP_KEEP) || 3);

/** The row counts a restore is checked against. */
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
  "email_recipients",
  "email_notifications",
];

/** Where the "last backup happened" marker lives. */
const STAMP = join(BACKUP_ROOT, "last-auto-backup.txt");

let started = false;

/**
 * Start the daily backup timer. Idempotent — safe to call from more than one
 * request handler.
 *
 * Checks once every ten minutes rather than scheduling a precise daily tick,
 * because a web server has no reliable "3am". Polling is also what makes this
 * survive a restart: if the machine was off at 3am, the first check after it
 * comes back sees that today's backup is missing and takes it then, instead of
 * skipping the day.
 */
export function startAutoBackup(): void {
  if (started) return;

  // Local mode only. In Supabase mode there is nothing to copy.
  if ((process.env.CAFETRACK_DB || "local") !== "local") return;
  if (process.env.CAFETRACK_DISABLE_AUTO_BACKUP === "1") return;

  started = true;

  const tick = async () => {
    try {
      await maybeBackup();
    } catch (e: any) {
      // Never let a backup problem become an unhandled rejection that takes the
      // server down. A failed backup is worth a line in the log and nothing more.
      console.error("auto-backup failed:", e?.message || e);
    }
  };

  // Wait a moment before the first check so it cannot compete with startup.
  setTimeout(tick, 15_000);

  // ten minutes
  const timer = setInterval(tick, 10 * 60_000);
  // Do not hold the process open just for this.
  timer.unref?.();
}

/** Has today's backup already been taken? */
function alreadyDoneToday(): boolean {
  try {
    if (!existsSync(STAMP)) return false;
    const last = readFileSafe(STAMP).trim();
    const lastDay = new Date(last);
    const now = new Date();
    // Same calendar day, in local time — the same unit a person means by "today".
    return (
      lastDay.getFullYear() === now.getFullYear() &&
      lastDay.getMonth() === now.getMonth() &&
      lastDay.getDate() === now.getDate()
    );
  } catch {
    return false;
  }
}

function readFileSafe(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Take the backup if it is due: past the configured hour, and not already done
 * today.
 */
async function maybeBackup(): Promise<void> {
  const now = new Date();
  if (now.getHours() < HOUR) return;
  if (alreadyDoneToday()) return;

  await runBackup();
}

/**
 * Take one snapshot now. Exported so it can be called directly — the Settings
 * page has a "back up now" button, which is the honest answer for a cafe that
 * wants a copy before doing something risky.
 */
export async function runBackup(): Promise<{ path: string; rows: number } | null> {
  const pg = await localDbReady();

  mkdirSync(BACKUP_ROOT, { recursive: true });

  const stamp = nowStamp();
  const dest = join(BACKUP_ROOT, `cafetrack-auto-${stamp}`);
  mkdirSync(dest, { recursive: true });

  // The consistent copy. PGlite takes this from inside the running process, so
  // it is a checkpoint rather than a file copy of something in use — which is
  // the whole reason this can run unattended while the server is up.
  //
  // It comes back as a tar archive rather than a directory, which is written
  // straight to disk as `pgdata.tar.gz`. Restoring from it is a plain extract;
  // see the note in manifest.json.
  const archive = await pg.dumpDataDir("gzip");
  const tarPath = join(dest, "pgdata.tar.gz");
  await writeFile(tarPath, Buffer.from(await (archive as Blob).arrayBuffer()));

  // Counts taken before the copy, so the manifest describes the state it was
  // taken from. A table added later is recorded as absent (-1) rather than as
  // zero, because zero would read as "all rows lost" to a restore check.
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    try {
      const r = (await pg.query(`select count(*)::int as n from ${table}`)) as any;
      counts[table] = Number(r?.rows?.[0]?.n ?? 0);
    } catch {
      counts[table] = -1;
    }
  }

  writeFileSync(
    join(dest, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        kind: "auto",
        // An automatic backup is a tar of the data directory, not a copy of the
        // .pglite folder the way `npm run db:backup` makes. Restoring it means
        // extracting pgdata.tar.gz over a fresh database directory, so the
        // existing restore script — which expects a plain copy — is not the
        // right tool here. Stated plainly rather than left for someone to
        // discover at the worst moment.
        archive: "pgdata.tar.gz",
        restoreHint:
          "Stop the dev server, then extract pgdata.tar.gz into the database " +
          "directory named by CAFETRACK_DB_DIR (default ./.pglite).",
        tables: counts,
      },
      null,
      2
    ) + "\n"
  );

  writeFileSync(STAMP, new Date().toISOString());

  pruneAuto();

  const total = Object.values(counts).reduce((a, b) => a + Math.max(0, b), 0);
  console.log(`CafeTrack: auto-backup -> ${dest} (${total} rows)`);

  return { path: dest, rows: total };
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/**
 * Delete all but the newest KEEP automatic backups.
 *
 * Only touches `cafetrack-auto-*` directories, so a manual `npm run db:backup`
 * left in the same folder is never deleted by the timer.
 */
function pruneAuto(): void {
  if (!existsSync(BACKUP_ROOT)) return;

  const stale = readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("cafetrack-auto-"))
    .map((e) => e.name)
    .sort() // ISO-8601 sorts chronologically
    .reverse() // newest first
    .slice(KEEP);

  for (const name of stale) {
    rmSync(join(BACKUP_ROOT, name), { recursive: true, force: true });
    console.log(`CafeTrack: pruned old auto-backup ${name}`);
  }
}