import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { eventBus, Events } from "@/lib/events";

export const runtime = "nodejs";

/**
 * Server-Sent Events endpoint for real-time updates.
 *
 * Clients connect with: `const es = new EventSource("/api/events");`
 *
 * Events:
 *   - stock_changed  : { type, transaction_id, items, actor_name }
 *   - alerts_changed : { type: "recomputed" | "new", count }
 *   - items_changed  : { action: "create" | "update" | "delete", sku }
 *
 * The connection is kept alive with a heartbeat comment every 15s.
 * Clients should reconnect on disconnect (EventSource does this automatically).
 *
 * ## Scope: this instance only
 *
 * `eventBus` is an in-process emitter, so a movement written by instance A is
 * broadcast only to browsers connected to A. Instance B's subscribers hear
 * nothing. That is not a correctness hole, because the client
 * (`use-live-refresh.ts`) also polls — every 30s while the stream is open,
 * every 5s while it is down — so the worst case across instances is a stale
 * number for half a minute, not a number that never updates.
 *
 * If sub-30-second cross-instance updates are ever required, the fix belongs in
 * `lib/events.ts` (publish to Redis or a Postgres LISTEN/NOTIFY channel, and
 * bridge that into `eventBus`), not here: polling the database from every
 * instance would multiply load to shorten a delay the client already bounds.
 */
export const GET = handler(async (req: Request) => {
  await requireUser();

  // Verify this is an SSE request
  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("text/event-stream")) {
    return new Response("Expected text/event-stream", { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      /**
       * Write one frame, tolerating a dead connection.
       *
       * `controller.enqueue` throws once the stream is closed or errored, and
       * the heartbeat calls it from a timer — where a throw is an uncaught
       * exception and, in Node, takes the process with it. A browser that walks
       * out of Wi-Fi without a clean FIN is exactly the case that produces it.
       * So a failed write closes the stream instead of escaping.
       */
      const send = (text: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          shutdown();
        }
      };

      const frame = (event: string, data: unknown) =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const unsubs = [
        eventBus.on(Events.STOCK_CHANGED, (data) => frame(Events.STOCK_CHANGED, data)),
        eventBus.on(Events.ALERTS_CHANGED, (data) => frame(Events.ALERTS_CHANGED, data)),
        eventBus.on(Events.ITEMS_CHANGED, (data) => frame(Events.ITEMS_CHANGED, data)),
      ];

      const heartbeat = setInterval(
        () => send(`: heartbeat\n\n`),
        15_000
      );

      /**
       * One teardown path, so a dead socket and a deliberate navigate away do
       * the same thing: stop the timer, drop the bus subscriptions (otherwise
       * every reconnection leaks one subscriber for the life of the process),
       * and close the stream once.
       */
      function shutdown(): void {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        for (const u of unsubs) u();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime; nothing to do.
        }
      }

      req.signal.addEventListener("abort", shutdown, { once: true });

      // Acknowledge the connection so the client can tell "open" from "silently
      // refused" without waiting for the first movement.
      frame("open", {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops nginx and friends from buffering the stream into uselessness.
      "X-Accel-Buffering": "no",
    },
  });
});
