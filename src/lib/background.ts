/**
 * Long-running work that must start once per server process.
 *
 * These used to be started from `bootstrap()` in lib/local-db.ts, which meant
 * they only ever ran when the app was pointed at PGlite. A Supabase deployment
 * therefore had no daily-summary job and no retry loop at all: queued mail only
 * moved when somebody happened to trigger a dispatch, and a failed send was
 * never picked up again. The jobs are independent of which database is in use,
 * so they belong to the server's lifecycle (see src/instrumentation.ts), not to
 * one database adapter's.
 *
 * Starting twice is harmless — each job guards itself with its own flag — but
 * the flag here keeps instrumentation and any lazy local-db bootstrap from
 * racing on the same tick.
 */
import { startAutoBackup } from "./backup";
import { startEmailScheduler } from "./email";
import { db } from "./supabase";

let started = false;

/** Login attempts are a rolling security counter, not history worth keeping. */
const LOGIN_ATTEMPT_RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;

async function pruneLoginAttempts(): Promise<void> {
  const cutoff = new Date(
    Date.now() - LOGIN_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60_000
  ).toISOString();

  try {
    const { error } = await db()
      .from("login_attempts")
      .delete()
      .lt("created_at", cutoff);

    if (error) console.error("login_attempts prune failed:", error.message);
  } catch (e) {
    console.error(
      "login_attempts prune threw:",
      e instanceof Error ? e.message : String(e)
    );
  }
}

export function startBackgroundJobs(): void {
  if (started) return;
  started = true;

  startAutoBackup();
  startEmailScheduler();

  // Do it once shortly after boot, then twice a day. The table is only read as
  // the newest 40 rows during sign-in, so an unbounded one is a slow scan and a
  // growing disk cost rather than an immediate failure.
  setTimeout(() => {
    void pruneLoginAttempts();
  }, 60_000).unref?.();

  const timer = setInterval(() => {
    void pruneLoginAttempts();
  }, PRUNE_EVERY_MS);
  timer.unref?.();
}
