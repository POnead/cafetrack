import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { resolveAuthSecret } from "@/lib/secret";

const COOKIE_NAME = "cafetrack_session";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/staff",
  "/api/auth/logout",
];

export async function middleware(req: NextRequest) {
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
