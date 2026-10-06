import { handler, ok } from "@/lib/api";
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
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`event: open\ndata: {}\n\n`)
      );

      // Subscribe to all event types
      const unsubs = [
        eventBus.on(Events.STOCK_CHANGED, (data) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `event: ${Events.STOCK_CHANGED}\ndata: ${JSON.stringify(data)}\n\n`
            )
          );
        }),
        eventBus.on(Events.ALERTS_CHANGED, (data) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `event: ${Events.ALERTS_CHANGED}\ndata: ${JSON.stringify(data)}\n\n`
            )
          );
        }),
        eventBus.on(Events.ITEMS_CHANGED, (data) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `event: ${Events.ITEMS_CHANGED}\ndata: ${JSON.stringify(data)}\n\n`
            )
          );
        }),
      ];

      // Heartbeat to keep the connection alive through proxies
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
      }, 15_000);

      // Cleanup on close
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        for (const u of unsubs) u();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});