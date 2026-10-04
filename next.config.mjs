import { hostname, networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every non-internal IPv4 address this machine answers on, e.g. 192.168.199.147.
 *
 * This used to be a hardcoded "192.168.1.9", which worked until the router
 * handed out a different subnet and the allowlist was left naming an address
 * this machine no longer had. The browser on the LAN then got a 403 on every
 * stylesheet and JS chunk: an unstyled page that never hydrated, so nothing was
 * clickable and it read as "a different website". Reading the real interfaces
 * keeps up with DHCP instead of going stale silently.
 *
 * Link-local 169.254.x.x addresses are skipped. Windows keeps several "Network"
 * and VPN adapters around holding APIPA addresses, and none of them is
 * reachable from a phone on the Wi-Fi, so allowing them only adds noise.
 */
function localIPv4Addresses() {
  const found = new Set();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node reports family as the number 4 on older releases and "IPv4" on
      // newer ones; accept either so this does not depend on the Node version.
      const family =
        typeof entry.family === "number" ? `IPv${entry.family}` : entry.family;
      if (!entry.internal && family === "IPv4" && !entry.address.startsWith("169.254.")) {
        found.add(entry.address);
      }
    }
  }
  return found;
}

/**
 * This machine's own names, so http://<pcname>:3100 and http://<pcname>.local:3100
 * work from a phone as well as the raw IP. A tablet is often easier to browse by
 * name than by an address the router may change, and Next matches the hostname
 * from the Origin header, so both forms have to be listed.
 */
function localHostnames() {
  const short = hostname().toLowerCase();
  return [short, `${short}.local`];
}

/**
 * Extra hostnames allowed to reach the dev server.
 *
 * Next blocks dev-only endpoints — including the HMR websocket — for any
 * Origin other than localhost. From another device on the LAN the page still
 * loads (an ordinary request carries no Origin, so it is matched on Referer)
 * but the websocket is refused, React never hydrates, and nothing on the page
 * responds to clicks. It fails silently, which is what makes it confusing.
 *
 * This machine's own addresses and names are allowed automatically, so the LAN
 * case works without configuration. Entries are bare hostnames — no scheme, no
 * port. DEV_ALLOWED_ORIGINS adds to that list rather than replacing it, for
 * reaching the dev server by a name or an address not in networkInterfaces().
 */
const allowedDevOrigins = [
  ...localIPv4Addresses(),
  ...localHostnames(),
  ...(process.env.DEV_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
];

// Printed on every dev start. The failure this prevents is invisible otherwise:
// the page loads, but an unlisted address leaves it unstyled and unclickable,
// and there is nothing on screen that says which address to try instead.
if (process.env.NODE_ENV !== "production") {
  console.log(
    `[cafetrack] LAN origins allowed: ${allowedDevOrigins.join(", ") || "none"}\n` +
      `[cafetrack] open on a phone/tablet at http://${
        [...localIPv4Addresses()][0] ?? "<this machine's IPv4>"
      }:3100`
  );
}

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
