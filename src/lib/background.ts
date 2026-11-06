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
import { SESSION_IDLE_TIMEOUT_MINUTES } from "./session-policy";
import {
  deleteFacePlusPlusEnrollment,
  facePlusPlusFaceSetTokens,
} from "./facepp";

let started = false;

/** Login attempts are a rolling security counter, not history worth keeping. */
const LOGIN_ATTEMPT_RETENTION_DAYS = 30;
const PRUNE_EVERY_MS = 6 * 60 * 60_000;
const IDLE_SESSION_SWEEP_EVERY_MS = 30_000;

async function expireIdleSessions(): Promise<void> {
  const now = Date.now();

  for (const role of ["admin", "staff"] as const) {
    const cutoff = new Date(
      now - SESSION_IDLE_TIMEOUT_MINUTES[role] * 60_000
    ).toISOString();

    try {
      const { error } = await db()
        .from("users")
        .update({ session_token: null, session_last_active_at: null })
        .eq("role", role)
        .lt("session_last_active_at", cutoff);

      if (error) {
        console.error(`idle ${role} session cleanup failed:`, error.message);
      }
    } catch (e) {
      console.error(
        `idle ${role} session cleanup threw:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }
}

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

async function pruneIdentityData(): Promise<void> {
  try {
    const { data: expiredUsers, error: selectError } = await db()
      .from("users")
      .select(
        "id, identity_retention_until, facepp_faceset_token, facepp_retired_facesets"
      );
    if (selectError) throw new Error(selectError.message);

    for (const user of expiredUsers ?? []) {
      if (!user.identity_retention_until) continue;
      const retention = new Date(user.identity_retention_until).valueOf();
      if (!Number.isFinite(retention) || retention >= Date.now()) continue;
      const faceSets = facePlusPlusFaceSetTokens(
        user.facepp_faceset_token,
        user.facepp_retired_facesets
      );
      const deletedFaceSets = await Promise.all(faceSets.map(deleteFacePlusPlusEnrollment));
      const undeletedFaceSet = deletedFaceSets.find((result) => result.status === "unavailable");
      if (undeletedFaceSet?.status === "unavailable") {
        console.error(
          `identity Face++ retention cleanup failed for user ${user.id} (${undeletedFaceSet.code}).`
        );
      }
      const { error } = await db()
        .from("users")
        .update({
          id_doc_front: null,
          id_doc_back: null,
          id_photo: null,
          id_doc_number: null,
          id_fields: null,
          face_image: null,
          face_embedding: null,
          face_enabled: false,
          ...(undeletedFaceSet === undefined
            ? {
                facepp_faceset_token: null,
                facepp_face_token: null,
                facepp_retired_facesets: [],
              }
            : {}),
          identity_data_erased_at: new Date().toISOString(),
        })
        .eq("id", user.id);
      if (error) console.error("identity data prune failed:", error.message);
      await db().from("user_face_samples").delete().eq("user_id", user.id);
    }
  } catch (e) {
    console.error(
      "identity data prune threw:",
      e instanceof Error ? e.message : String(e)
    );
  }
}

export function startBackgroundJobs(): void {
  if (started) return;
  started = true;

  startAutoBackup();
  startEmailScheduler();

  // Revoke idle sessions without depending on the browser reconnecting. This
  // keeps closed-tab sessions from remaining recorded as active at the next
  // sign-in; request-time checks still enforce the exact timeout boundary.
  const idleSessionTimer = setInterval(() => {
    void expireIdleSessions();
  }, IDLE_SESSION_SWEEP_EVERY_MS);
  idleSessionTimer.unref?.();
  setTimeout(() => {
    void expireIdleSessions();
  }, IDLE_SESSION_SWEEP_EVERY_MS).unref?.();

  // Do it once shortly after boot, then twice a day. The table is only read as
  // the newest 40 rows during sign-in, so an unbounded one is a slow scan and a
  // growing disk cost rather than an immediate failure.
  setTimeout(() => {
    void pruneLoginAttempts();
    void pruneIdentityData();
  }, 60_000).unref?.();

  const timer = setInterval(() => {
    void pruneLoginAttempts();
    void pruneIdentityData();
  }, PRUNE_EVERY_MS);
  timer.unref?.();
}
