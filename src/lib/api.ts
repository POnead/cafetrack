import { NextResponse } from "next/server";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
 * Refuse a body larger than this before buffering it.
 *
 * App Router route handlers have no body size limit the way the old Pages
 * `bodyParser` did, and `readBody` reads the whole stream into a string. On the
 * unauthenticated sign-in routes that is a free way to make the server allocate
 * an arbitrary amount of memory, one request at a time. One megabyte is far
 * larger than any JSON body this API actually accepts (the ID uploads take
 * multipart and go through readBoundedFormData instead).
 */
const MAX_BODY_BYTES = 1_000_000;

function tooLarge(maxBytes: number) {
  return new HttpError(
    413,
    `Request body must be ${Math.floor(maxBytes / 1024)} KB or smaller`
  );
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
type JsonObject = Record<string, unknown>;

export async function readBody(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES
): Promise<JsonObject> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);

  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, "Could not read the request body");
  }

  // A missing or lying Content-Length is common, so the actual size is checked
  // too — the header is an optimisation, not the control.
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw tooLarge(maxBytes);

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

  // A bare `null`, number, string, or array parses fine but has no fields; treat
  // those as an empty object so property access below cannot blow up.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed as JsonObject;
}

/**
 * The client's address, for the audit trail's `ip_address` column.
 *
 * CafeTrack runs on the cafe's own machine, so the immediate peer is almost
 * always 127.0.0.1 and the useful address is the one the browser sent in
 * `x-forwarded-for` — a phone on the same Wi-Fi reaching the dev server through
 * a proxy, for instance. That header is client-controlled, which is exactly why
 * the column sits outside the hash chain: a forged value cannot make a forged
 * entry look authentic, because the entry_hash covers the action and its details
 * rather than the address it came from.
 *
 * Returns null when there is nothing plausible to record, so the column stays
 * honestly empty instead of carrying "unknown".
 */
export function clientIp(req: Request): string | null {
  // IPv4 addresses from a Node socket arrive as "::ffff:127.0.0.1". The prefix is
  // an IPv4-in-IPv6 compatibility marker, not part of the address, and leaving it
  // in makes the audit column harder to read than it needs to be.
  const tidy = (v: string) => v.trim().replace(/^::ffff:/, "").slice(0, 45);

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    // A chain of proxies appends; the client is first.
    const first = forwarded.split(",")[0]?.trim();
    if (first) return tidy(first);
  }

  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return tidy(real);

  // Node exposes the socket address on a non-standard property.
  const socket = (req as Request & { socket?: { remoteAddress?: string } }).socket
    ?.remoteAddress;
  if (typeof socket === "string" && socket) return tidy(socket);

  return null;
}

/**
 * Wraps a route handler so thrown HttpErrors become clean JSON responses.
 *
 * Unexpected failures are logged in full, keyed by a request id, but the caller
 * gets only that id. The previous version returned `e.message` on a 500, which
 * handed database hostnames, file paths and SQL detail to whoever made the
 * request — the health endpoint already refuses to do that for the same reason.
 * The id is what lets an owner match a user's screenshot to the server log.
 */
export function handler<T extends unknown[]>(
  fn: (...args: T) => Promise<Response>
) {
  return async (...args: T): Promise<Response> => {
    const requestId = randomUUID();

    const tag = (res: Response) => {
      res.headers.set("x-request-id", requestId);
      return withDbMode(res);
    };

    try {
      // Stamped here as well as in ok/fail, so a route that returns a
      // NextResponse of its own still declares which database answered.
      return tag(await fn(...args));
    } catch (error: unknown) {
      // Framework control-flow signal (route read cookies during prerender) —
      // re-throw so Next.js can mark the route dynamic instead of us
      // swallowing it and reporting a bogus 500.
      const asDynamic = error as { digest?: string; name?: string };
      if (
        asDynamic?.digest === "DYNAMIC_SERVER_USAGE" ||
        asDynamic?.name === "DynamicServerError"
      ) {
        throw error;
      }
      if (error instanceof HttpError) return tag(fail(error.message, error.status));
      console.error(`[api ${requestId}] unhandled error:`, error);
      return tag(
        fail("Internal server error", 500, { request_id: requestId })
      );
    }
  };
}
