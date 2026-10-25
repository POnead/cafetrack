import { db } from "@/lib/supabase";
import { dbMode } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Is the application actually able to work?
 *
 * NFR-04 asks for 99.5% uptime, and an availability target nobody can measure is
 * a wish. This is the thing to point a monitor at: it answers 200 when the app
 * can reach its database, 503 when it cannot. A monitor polling this every
 * 30 seconds turns the target into a number, and the number is what tells the
 * owner whether it was met.
 *
 * Deliberately unauthenticated. A check that needs a session cookie expires at
 * the same moment the thing it is checking breaks — a restart clears every
 * cookie — so it would report a healthy system as down. That is why nothing
 * sensitive is returned: a bare yes/no and the version.
 *
 * The database probe is the whole point. The app process staying alive while
 * Postgres is unreachable looks healthy from the outside and fails every request
 * from the inside, which is the case worth catching.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    // `settings` is the smallest table in the schema and is read with `head`,
    // so no rows are transferred and nothing is locked. It is also created by
    // the very first statement in schema.sql, so if this table is missing the
    // database is not merely unreachable but never initialised — which is
    // exactly the failure worth reporting as down rather than up.
    const { error } = await db()
      .from("settings")
      .select("key", { head: true })
      .limit(1);

    if (error) throw new Error(error.message);

    return Response.json(
      {
        ok: true,
        database: "reachable",
        mode: dbMode(),
        latency_ms: Date.now() - startedAt,
        version: process.env.npm_package_version ?? "0.1.0",
      },
      {
        status: 200,
        // A monitor must never be served a cached "up" from an edge or the
        // browser, so this is explicitly uncacheable.
        headers: { "Cache-Control": "no-store" },
      }
    );
  } catch (e: any) {
    // The message is the database's, not a route's, and it names the connection
    // rather than the data — safe to return to whatever is monitoring.
    return Response.json(
      {
        ok: false,
        database: "unreachable",
        mode: dbMode(),
        error: e?.message || "Database probe failed",
        version: process.env.npm_package_version ?? "0.1.0",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}