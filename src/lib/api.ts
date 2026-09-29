import { NextResponse } from "next/server";
import { join } from "node:path";
import { HttpError } from "./auth";

/**
 * Whether this server is pointed at a throwaway database.
 *
 * `dev:test` sets CAFETRACK_DB_DIR so the suites get a database of their own;
 * unset, the app uses ./.pglite, which is real working data. The suites read
 * this header and refuse to write to a live one, because the movement ledger is
 * append-only: a suite that checks stock out against ./.pglite leaves history
 * there that nothing in the app can remove, and it then shows up on the
 * dashboard as in-demand items that no longer exist.
 */
const DB_IS_TEST =
  Boolean(process.env.CAFETRACK_DB_DIR) &&
  process.env.CAFETRACK_DB_DIR !== join(process.cwd(), ".pglite");

/**
 * "test" when this server is pointed at a throwaway database, "live" otherwise.
 *
 * Exported because proxy.ts stamps the header on its own 401s too — a denied
 * request never reaches a route handler, and the suites probe unauthenticated.
 * One definition, so the two cannot disagree about which database is in use.
 */
export const dbMode = () => (DB_IS_TEST ? "test" : "live");

/**
 * Tags a response with which database it came from.
 *
 * `ok` and `fail` are the only two functions every route returns through, so
 * stamping here covers the whole API.
 */
function withDbMode(res: Response) {
  res.headers.set("x-cafetrack-db", dbMode());
  return res;
}

export function ok(data: unknown, status = 200) {
  return withDbMode(NextResponse.json(data, { status }));
}

/**
 * Error response. `extra` adds structured fields next to the message, for the
 * cases where the client needs more than prose — e.g. the deactivation reason
 * that goes with a 403 on sign-in.
 */
export function fail(
  message: string,
  status = 400,
  extra?: Record<string, unknown>
) {
  return withDbMode(NextResponse.json({ error: message, ...(extra ?? {}) }, { status }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard for routes whose `:id` is a uuid column. Postgres reports a type error
 * for anything else ("invalid input syntax for type uuid"), which the routes
 * would otherwise surface as a 500 when the real problem is a malformed
 * request. The write paths that ignored the database error answered 404, which
 * is a different mistake and a misleading one.
 *
 * Returns the response to send, or null when the id is usable. Call it after
 * authenticating, so an anonymous caller still gets a 401.
 */
export function badId(id: string, what = "id") {
  return UUID.test(id) ? null : fail(`Not a valid ${what} id`, 400);
}

/**
 * Reads and parses a JSON request body, answering 400 rather than throwing when
 * the body is absent or malformed.
 *
 * `req.json()` throws on an empty or truncated body, and the generic handler
 * turned that into a 500 that also leaked the raw parser message ("Unexpected
 * end of JSON input") to the caller. An absent body is a malformed *request*,
 * not a server fault, and every route that reads a body has to answer the same
 * way — so it is handled here rather than repeated at nine call sites.
 *
 * Returns `{}` for an empty body so a route's own required-field checks produce
 * the useful message ("Item name is required") instead of a generic one.
 */
export async function readBody(req: Request): Promise<any> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, "Could not read the request body");
  }

  // An empty body is treated as `{}` so the route's own required-field check
  // produces the useful message ("Item name is required") rather than a generic
  // "invalid JSON" one.
  if (!text || !text.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }

  // A bare `null`, number or string parses fine but has no fields; treat those
  // as an empty object so property access below cannot blow up.
  if (parsed === null || typeof parsed !== "object") return {};

  return parsed;
}

/** Wraps a route handler so thrown HttpErrors become clean JSON responses. */
export function handler(fn: (...args: any[]) => Promise<Response>) {
  return async (...args: any[]) => {
    try {
      // Stamped here as well as in ok/fail, so a route that returns a
      // NextResponse of its own still declares which database answered.
      return withDbMode(await fn(...args));
    } catch (e: any) {
      // Framework control-flow signal (route read cookies during prerender) —
      // re-throw so Next.js can mark the route dynamic instead of us
      // swallowing it and reporting a bogus 500.
      if (e?.digest === "DYNAMIC_SERVER_USAGE" || e?.name === "DynamicServerError") {
        throw e;
      }
      if (e instanceof HttpError) return fail(e.message, e.status);
      console.error("Unhandled API error:", e);
      return fail(e?.message || "Internal server error", 500);
    }
  };
}
