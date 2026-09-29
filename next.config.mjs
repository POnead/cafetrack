import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Extra hostnames allowed to reach the dev server.
 *
 * Next blocks dev-only endpoints — including the HMR websocket — for any
 * Origin other than localhost. From another device on the LAN the page still
 * loads (an ordinary request carries no Origin, so it is matched on Referer)
 * but the websocket is refused, React never hydrates, and nothing on the page
 * responds to clicks. It fails silently, which is what makes it confusing.
 *
 * Entries are bare hostnames — no scheme, no port. Override with
 * DEV_ALLOWED_ORIGINS when the router hands out a different address.
 */
const allowedDevOrigins = (process.env.DEV_ALLOWED_ORIGINS ?? "192.168.1.9")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PGlite ships PostgreSQL compiled to WebAssembly. Keep it out of the
  // webpack bundle so it loads from node_modules at runtime instead.
  //
  // Next 15 renamed this from `experimental.serverComponentsExternalPackages`
  // to the top-level `serverExternalPackages`; the old key is ignored.
  serverExternalPackages: ["@electric-sql/pglite"],
  // A package-lock.json exists above this folder, so Next would otherwise infer
  // the parent as the workspace root and warn on every start. Pin it here.
  outputFileTracingRoot: here,
  // Development only — `next build` ignores it. See the note above.
  allowedDevOrigins,
  // A second dev server cannot share `.next`: Next takes a lock at
  // .next/dev/lock and refuses to start if another one holds it. So the
  // test-isolated server (scripts/dev-test.mjs) points this at its own
  // directory. Unset, nothing changes.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
