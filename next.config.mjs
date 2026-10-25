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
  // PGlite ships PostgreSQL compiled to WebAssembly, and pdfkit loads its font
  // metrics from `data/*.afm` on disk at runtime. Neither survives being
  // bundled: PGlite's WASM breaks, and pdfkit resolves its data directory
  // relative to its own file location, so a bundled copy looks for it under the
  // build directory and fails with ENOENT on the first document.
  //
  // Next 15 renamed this from `experimental.serverComponentsExternalPackages`
  // to the top-level `serverExternalPackages`; the old key is ignored.
  //
  // `tesseract.js` is here for a sharper version of the same reason as pdfkit.
  // It does not merely read files relative to its own location — it spawns a Node
  // worker thread and resolves that worker's entry point through the bundler's own
  // module root. Bundled, that root becomes a placeholder, and the ID upload route
  // died with:
  //
  //   Cannot find module 'C:\ROOT\node_modules\tesseract.js\src\worker-script\node\index.js'
  //
  // No build error and no useful stack, and because the failure happens in the
  // worker's thread rather than this one it surfaced as an uncaughtException that
  // took the request down with it. Marking the package external makes Next
  // `require()` it from node_modules with ordinary Node resolution, which is the
  // only thing that worker path survives.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pdfkit",
    "fontkit",
    "tesseract.js",
  ],
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
  // PGlite's WASM files break under Turbopack's module resolution on Windows
  // (junction point creation fails with os error 145 — "directory not empty").
  // Webpack handles this correctly, so we use it instead of Turbopack.
  //
  // Superseded: retested against Next 16.3.6 and PGlite now boots and serves
  // queries under Turbopack on this machine. The junction error is gone. The
  // webpack function below remains because the face-api alias it carries has no
  // automatic Turbopack equivalent — hence the matching `turbopack.resolveAlias`
  // further down. Switch between the two with the `--webpack` / `--turbopack`
  // flags; the alias is declared for both so neither one silently falls back to
  // the broken face-api build.
  webpack: (config, { isServer }) => {
    if (isServer) {
      // `serverExternalPackages` covers Next's own resolution, but the webpack
      // config is built separately and has to be told directly.
      config.externals = [
        ...(config.externals || []),
        "@electric-sql/pglite",
        "tesseract.js",
      ];
    }

    /*
     * face-api resolves to its `nobundle` build, and the wasm backend to a stub.
     *
     * The default browser bundle inlines tfjs-core but ships no compute backend
     * with it, and exposes `tf` as a read-only ESM binding. So the two ways of
     * feeding it a backend both fail: the bundle has none to find, and
     * `faceapi.tf = tf` throws "Cannot set property tf ... which has only a
     * getter", because module namespace properties are not writable.
     *
     * `esm-nobundle` imports `@tensorflow/tfjs` and its backends as ordinary
     * modules instead. Webpack then hands face-api the very same tfjs instance
     * this app already uses — the one with webgl and cpu registered — so there is
     * a single copy of the library and no injection step at all.
     *
     * It imports `@tensorflow/tfjs-backend-wasm` unconditionally, and that package
     * is installed even though this app never selects the wasm backend (the choice
     * is webgl then cpu, both of which ship with `@tensorflow/tfjs`). Aliasing the
     * import to a stub was tried first and abandoned: webpack rewrites the matched
     * prefix and appends the remainder, so the deep specifier resolved to
     * `<stub>/dist/index.js` and the resolver tried to scandir a file as a
     * directory. The real package is simpler and cannot drift out of step with
     * face-api's import path.
     */
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@vladmandic/face-api": "@vladmandic/face-api/dist/face-api.esm-nobundle.js",
    };

    /*
     * face-api's ESM build reaches for `require` in a couple of optional paths
     * (node-only helpers it never takes in a browser). Webpack cannot statically
     * resolve those and warns on every compile. The warning says nothing about
     * whether the feature works, and repeated per recompile it was burying real
     * build problems — so it is silenced for this one package rather than for the
     * whole build, which would hide genuine ones.
     *
     * This lives here rather than as a top-level `ignoreWarnings` because that
     * key is not part of NextConfig — Next validates the config object and
     * refuses to start on an unrecognised key. `ignoreWarnings` is a webpack
     * option, so it has to be set on the webpack config.
     */
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      {
        module: /@vladmandic[\\/]face-api/,
        message: /Critical dependency: require function/,
      },
    ];

    return config;
  },

  /*
   * The Turbopack half of the face-api alias above.
   *
   * `webpack()` is ignored under Turbopack, so without this key a Turbopack
   * build resolves `@vladmandic/face-api` through the package's own
   * `browser` field to `dist/face-api.esm.js` — the build the comment above
   * describes as broken: tfjs-core inlined, no compute backend, and `tf` as a
   * read-only ESM binding. Face capture and face sign-in would then fail at
   * runtime with no build-time error at all, which is the worst kind of
   * difference between two bundlers.
   *
   * The alias is only needed for browser targets. The server never imports
   * face-api — the matching maths lives in lib/face.ts, which is pure — so
   * `browser` keeps it scoped to where the broken build actually lives.
   *
   * Declaring this key at all is also what lets Next 16 start under Turbopack
   * at all: with a `webpack` key present and no `turbopack` key, it refuses.
   */
  turbopack: {
    resolveAlias: {
      "@vladmandic/face-api": {
        browser: "@vladmandic/face-api/dist/face-api.esm-nobundle.js",
      },
    },
  },
};

export default nextConfig;
