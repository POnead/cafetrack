/**
 * Runs once when a Next.js server instance starts.
 *
 * Only the Node.js runtime has timers, sockets and the PGlite filesystem, so
 * everything is imported lazily behind the runtime check — importing it during
 * an edge build (or during `next build`'s static pass) would pull `node:fs` and
 * `nodemailer` into a bundle that cannot use them.
 *
 * See lib/background.ts for what is started and why it no longer lives in the
 * local database adapter.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  await import("./lib/background").then(({ startBackgroundJobs }) => {
    startBackgroundJobs();
  });
}
