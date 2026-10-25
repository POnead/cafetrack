import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { resolveAuthSecret } from "@/lib/secret";
import { dbMode } from "@/lib/api";

const COOKIE_NAME = "cafetrack_session";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
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
  // The health check (FR-20). Public on purpose: a check that needs a session
  // cookie expires at the same moment the thing it is checking breaks — a
  // restart clears every cookie — so it would report a healthy system as down.
  // It returns nothing but a boolean and the version, which is the whole reason
  // it is safe to leave open.
  "/api/health",
];

// Next 16 renamed the `middleware` file convention to `proxy`; the export is
// `proxy` rather than `middleware`. Same behaviour, same matcher.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
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
    return NextResponse.next();
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
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/|models/).*)",
  ],
};
