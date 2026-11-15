/**
 * Test stub for the two Next.js server-module specifiers the app imports
 * statically (`next/headers` in lib/auth.ts, which is only ever called at
 * request time).
 *
 * Next resolves these through its own bundler, so plain Node cannot — its
 * `next/headers.js` re-exports from `next/dist/...`, which pulls in the
 * Next server runtime that unit tests deliberately do not boot. This stub
 * exists so the module graph of the pure unit suites can load; it throws
 * loudly if anything actually calls into it, because there is no request in
 * a unit test to read cookies from.
 */
export class NextServerStubError extends Error {
  constructor(name) {
    super(
      `${name}() was called from a unit test. These suites run without a Next ` +
        `request scope; exercise the route over HTTP (see scripts/_report-preview-e2e.mjs) ` +
        `or keep the tested code inside the pure builder.`
    );
    this.name = "NextServerStubError";
  }
}

export async function cookies() {
  throw new NextServerStubError("cookies");
}

export async function headers() {
  throw new NextServerStubError("headers");
}

export async function draftMode() {
  throw new NextServerStubError("draftMode");
}
