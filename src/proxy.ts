import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { resolveAuthSecret } from "@/lib/secret";
import { dbMode } from "@/lib/api";

const COOKIE_NAME = "cafetrack_session";

/**
 * Is Content Security Policy served the old, wide way?
 *
 * The default is nonce-based: script-src carries no 'unsafe-inline', and inline
 * scripts run only when the proxy stamped them with this request's nonce. If a
 * deployment has to run on a browser that breaks under that (an old tablet, a
 * locked-down kiosk shell), setting CAFETRACK_CSP_LEGACY=1 restores the previous
 * policy — with 'unsafe-inline' — rather than leaving the operator with no way
 * to diagnose it. It is deliberately opt-out-by-env, not a code path anyone
 * reaches by accident.
 */
const CSP_LEGACY = process.env.CAFETRACK_CSP_LEGACY === "1";

const isDev = process.env.NODE_ENV !== "production";

/**
 * The policy documents get.
 *
 * Production is strict: `'nonce-<txn>' 'strict-dynamic'` means an inline script
 * only runs when the proxy stamped it, and `'wasm-unsafe-eval'` covers the face
 * engines' compiled WASM. Development keeps `'unsafe-inline' 'unsafe-eval'`
 * (no 'strict-dynamic'), because the dev live-reload scripts are inline and
 * un-nonoised, and locking a development server down to a policy one HMR
 * reload disproves proves nothing about production.
 *
 * styles keep 'unsafe-inline' in both: Next's SSR emits inline style tags, and
 * a style injection buys an attacker nothing this API's cookies do not already
 * require a session for. Tightening styles would mean shipping Next's styling
 * out of line in the process — a bigger day's work than this file is for.
 */
function contentSecurityPolicy(nonce: string): string {
  if (CSP_LEGACY) {
    return [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  return [
    "default-src 'self'",
    // prod: nonce + strict-dynamic; dev: wide enough for Turbopack's dev tools
    isDev
      ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * One-pass forwarding of the Security-Policy and nonce into the request.
 *
 * This is what makes the nonce work at all in the public paths: Next builds its
 * inline bootstrap scripts at render time, and it learns the nonce from the
 * Content-Security-Policy header on the *request*. /login returns early below,
 * so the header has to be attached before any path decides how to respond —
 * otherwise the login screen is the one page in the app left with un-nonoised
 * inline scripts, and a nonce-only policy would keep it permanently blank.
 *
 * The request-header copy has quotes and spaces escaped (the % encoding below)
 * — the browser requirement for a header value traveling as a merge target
 * (older Safari rejected a CSP request header with bare quotes), and Next's
 * own documented middleware example does the same.
 */
function withCsp(req: NextRequest): { headers: Headers; nonce: string } {
  const nonce = btoa(crypto.randomUUID()).replace(/[^A-Za-z0-9+/=]/g, "");
  const policy = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set("x-cafetrack-nonce", nonce);
  headers.set(
    "content-security-policy",
    policy.replace(/'/g, "%27").replace(/\s/g, "%20")
  );
  return { headers, nonce };
}

/** Attach the response-side copy of the policy. */
function stampCsp(res: NextResponse, nonce: string): NextResponse {
  res.headers.set("content-security-policy", contentSecurityPolicy(nonce));
  return res;
}

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/password-recovery",
  "/api/auth/staff",
  "/api/auth/logout",
  // Face sign-in. Public for the same reason the two above are: there is no
  // session yet — that is the entire point of the route. Without this the proxy
  // would answer 401 before the handler ran, and the feature would be a button
  // that silently does nothing.
  //
  // Safe to leave open because the route does its own work: it takes a barcode or
  // username plus a matching face, and the proxy could not check either.
  "/api/auth/face-login",
  // ID-card sign-in, on the same reasoning and for the same reason it needs its
  // own line rather than falling under a prefix: there is no session yet, and
  // without this the proxy answers 401 before the handler runs — so the sign-in
  // button appears and every attempt is refused, with the cause visible only in
  // the network tab.
  //
  // Safe to leave open because the route carries its own weight: it requires a
  // card that matches exactly one account on file *and* a face matching that
  // account, neither of which the proxy could check. See the route header.
  "/api/auth/id-login",
  // Step two of two-step sign-in. Open precisely because there is no session yet:
  // the whole point of the route is to *earn* one. Left out, the proxy would
  // answer 401 before the handler ran and the password step would look like it
  // worked while nothing followed it.
  //
  // Safe because it cannot be reached without a ticket, and a ticket is signed
  // with a key this file does not hold — so it is not a session, cannot be
  // forged, and expires in five minutes even when it is real. The proxy has
  // nothing to check here that it is not already unable to check for the other
  // three.
  "/api/auth/staff/confirm",
  // The face-bypass request only carries a password-verified, short-lived
  // step-two ticket; it must work before the caller has a session cookie.
  "/api/auth/staff/duty-bypass",
  // The health check (FR-20). Public on purpose: a check that needs a session
  // cookie expires at the same moment the thing it is checking breaks — a
  // restart clears every cookie — so it would report a healthy system as down.
  // It returns nothing but a boolean and the version, which is the whole reason
  // it is safe to leave open.
  "/api/health",
  // Which face engine the capture screens should run.
  //
  // Public because the sign-in screen needs it before anyone has identified
  // themselves, and the answer is a property of the cafe's configuration, not of
  // any account: "legacy" or "sface". It returns nothing else — no threshold, no
  // counts, no names — so there is nothing here to probe with.
  "/api/face/config",
  /*
   * The face measurement page (`npm run probe:face`).
   *
   * It has to be reachable without a session because the whole point is to run
   * the models on a machine that may not be signed in, and because Playwright
   * drives it before any login. It is not a hole: the page itself calls
   * `notFound()` unless this is a dev build or `CAFETRACK_FACE_PROBE=1`, and the
   * same condition gates this entry, so a production install without the flag
   * gets the ordinary 404 and one with it has deliberately opted in.
   */
  ...(process.env.NODE_ENV !== "production" || process.env.CAFETRACK_FACE_PROBE === "1"
    ? ["/dev/face-probe"]
    : []),
];

// Next 16 renamed the `middleware` file convention to `proxy`; the export is
// `proxy` rather than `middleware`. Same behaviour, same matcher.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const { headers, nonce } = withCsp(req);

  if (
    pathname === "/api/auth/me" &&
    req.nextUrl.searchParams.get("session_check") === "1" &&
    req.nextUrl.searchParams.get("login_check") === "1"
  ) {
    return stampCsp(NextResponse.next({ request: { headers } }), nonce);
  }

  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return stampCsp(NextResponse.next({ request: { headers } }), nonce);
  }

  const token = req.cookies.get(COOKIE_NAME)?.value;

  if (!token) {
    return deny(req, pathname);
  }

  // Same rule as the session code (src/lib/secret.ts), but failing closed: a
  // misconfigured deployment must refuse access rather than verify tokens
  // against the published dev secret.
  let secret: Uint8Array;
  try {
    secret = new TextEncoder().encode(resolveAuthSecret());
  } catch {
    return new NextResponse("Server is misconfigured: AUTH_SECRET is not set.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  try {
    await jwtVerify(token, secret);
    return stampCsp(NextResponse.next({ request: { headers } }), nonce);
  } catch {
    return deny(req, pathname);
  }
}

function deny(req: NextRequest, pathname: string) {
  if (pathname.startsWith("/api/")) {
    // Tagged here as well as in lib/api.ts: a 401 from the proxy never reaches
    // a route handler, so without this the test suites' unauthenticated probe
    // would get no database-mode header and could not tell live from test.
    const res = NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    res.headers.set("x-cafetrack-db", dbMode());
    return res;
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // The favicon and the brand illustrations are excluded alongside the other
  // static paths. A browser fetches both on its own, without a session, so
  // letting the proxy answer them would send the sign-in page instead — and an
  // icon that renders HTML is a broken tab on every page, while an illustration
  // that renders HTML is a torn-up image square on the login page, which is the
  // one page a logged-out visitor is guaranteed to load.
  //
  // `models/` is the face-recognition weights, copied by `npm run setup:face`.
  // Same reasoning, and worse without it: they are fetched by the enrolment
  // capture and the duty check, and a 6MB model answered with the sign-in page
  // produces a JSON parse error inside face-api rather than anything a person
  // could read. The feature would appear to do nothing, with no error on screen
  // to say why.
  //
  // `onnx/` is the onnxruntime wasm build, and it fails in a way that is harder
  // to diagnose than either: onnxruntime fetches it from inside a worker-like
  // loader, so an HTML body arrives as "no available backend found" and the
  // browser console says nothing about a sign-in page. Same class of mistake,
  // so it is excluded here rather than discovered later.
  //
  // `mediapipe/` contains the local Face Landmarker wasm runtime used during
  // login. Redirecting these files to /login makes both GPU and CPU setup fail
  // with an unhelpful resource-load event, even though the model under
  // `models/` is already public.
  //
  // `_next/hmr` (and its webpack-mode name) is the dev live-reload socket. It
  // carries no application data, but it is fetched before anyone signs in — and
  // a redirect to /login makes the websocket handshake fail. The page still
  // renders, React then never hydrates, and every control on a public screen
  // (the sign-in form, the face probe) silently does nothing. The matcher is
  // deliberately narrow elsewhere so an RSC payload for a protected page is
  // still gated; only the socket is excluded.
  matcher: [
    "/((?!_next/static|_next/image|_next/hmr|_next/webpack-hmr|favicon.ico|icon.svg|brand/|models/|onnx/|mediapipe/).*)",
  ],
};
