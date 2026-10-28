"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live updates for the dashboard and the lists beside it (FR-07).
 *
 * Two mechanisms, on purpose:
 *
 *   - a Server-Sent Events subscription, so a movement made on one device moves
 *     the numbers on another without anyone refreshing;
 *   - a poll, because SSE is a connection, and a connection ends. A cafe machine
 *     that sleeps, a phone that changes Wi-Fi, a proxy that idles an idle stream
 *     — all leave the tab showing figures from whenever the stream last carried
 *     something. The poll is the floor under the connection, not a second
 *     mechanism to reason about: while the stream is healthy it is stretched out
 *     to a slow interval, and when the stream drops the interval comes back down
 *     so the page is still honest while it reconnects.
 *
 * Both call the same `reload`, so there is exactly one definition of "what this
 * page shows" and one place that fetches it.
 */

export type LiveStatus = "connecting" | "live" | "polling";

/**
 * Poll interval while the event stream is healthy, and while it is not.
 *
 * The healthy interval is deliberately slow: the stream is already carrying
 * every movement, so the poll only exists to notice a stream that has gone
 * quiet without saying so. When the stream is down it becomes the only source
 * of updates, and 30s of stale figures is exactly what this hook exists to
 * avoid - so it comes down to a few seconds.
 */
const POLL_OPEN_MS = 30_000;
const POLL_CLOSED_MS = 5_000;

export function useLiveRefresh(reload: () => Promise<void> | void) {
  const [status, setStatus] = useState<LiveStatus>("connecting");

  // Held in a ref rather than closed over, so the EventSource is built once.
  // Re-creating it on every render would drop the subscription and reconnect in
  // a loop — the classic SSE bug, and invisible until you watch the network tab.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // Counts events off the stream. A connection that receives nothing cannot be
  // distinguished from one that is silently dead, so silence counts as failure
  // and the poll takes over.
  const connected = useRef(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const open = () => {
      if (closed) return;

      // EventSource reconnects on its own, so a failed constructor or a browser
      // that refuses the content type is handled by the retry below rather than
      // an `onerror` storm.
      try {
        source = new EventSource("/api/events");
      } catch {
        schedule();
        return;
      }

      source.addEventListener("open", () => {
        connected.current = true;
        attempt = 0;
        setStatus("live");
      });

      const onData = () => {
        connected.current = true;
        void reloadRef.current();
      };

      source.addEventListener("stock_changed", onData);
      source.addEventListener("items_changed", onData);
      source.addEventListener("alerts_changed", onData);

      source.addEventListener("error", () => {
        connected.current = false;
        // "polling" rather than "connecting" so the UI can say the figures may
        // be a moment behind, which is the honest description.
        setStatus((current) => (current === "connecting" ? current : "polling"));

        // Close before retrying: the browser retries on its own otherwise, and
        // the explicit schedule below would double the attempts.
        source?.close();
        source = null;
        schedule();
      });
    };

    /**
     * Back off, so a server that is down does not get hammered by every open tab
     * in the cafe at once. Capped at 30s; the poll below keeps the page honest
     * in the meantime, which is why the reconnect can afford to wait.
     */
    const schedule = () => {
      if (closed || retryTimer) return;
      const wait = Math.min(1000 * 2 ** attempt, 30_000);
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        open();
      }, wait);
    };

    open();

    return () => {
      closed = true;
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  /**
   * The floor. Interval length depends on the stream, so it is set up as two
   * effects that swap the timer when `status` changes rather than reading a ref
   * inside a single long-lived interval.
   */
  const poll = useCallback(() => {
    const timer = setInterval(() => {
      void reloadRef.current();
    }, connected.current ? POLL_OPEN_MS : POLL_CLOSED_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (status === "connecting") return;
    return poll();
  }, [status, poll]);

  return { status };
}