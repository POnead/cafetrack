import { NextResponse } from "next/server";
import { HttpError } from "./auth";

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
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
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
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

/** Wraps a route handler so thrown HttpErrors become clean JSON responses. */
export function handler(fn: (...args: any[]) => Promise<Response>) {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
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
