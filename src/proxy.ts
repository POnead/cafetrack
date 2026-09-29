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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
