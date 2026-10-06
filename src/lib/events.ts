/**
 * Simple in-process event bus for Server-Sent Events.
 *
 * This is a minimal EventEmitter that lets different parts of the app
 * (API routes, database functions) emit events that the SSE endpoint
 * broadcasts to connected clients.
 *
 * In a multi-instance deployment you would replace this with Redis pub/sub,
 * but for a single-cafe deployment this in-process bus is sufficient.
 */

type EventCallback = (data: unknown) => void;

interface EventHandlers {
  [event: string]: EventCallback[];
}

class EventBus {
  private handlers: EventHandlers = {};

  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: string, callback: EventCallback): () => void {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(callback);

    return () => {
      const arr = this.handlers[event];
      if (!arr) return;
      const idx = arr.indexOf(callback);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  /** Emit an event to all subscribers. */
  emit(event: string, data: unknown): void {
    const arr = this.handlers[event];
    if (!arr) return;
    for (const cb of arr) {
      try {
        cb(data);
      } catch {
        // Ignore callback errors — they must not crash the emitter
      }
    }
  }

  /** Get all registered events (for debugging). */
  events(): string[] {
    return Object.keys(this.handlers);
  }
}

export const eventBus = new EventBus();

/** Event names used by the app. */
export const Events = {
  /** Fired when any transaction commits (checkout/restock/waste). */
  STOCK_CHANGED: "stock_changed",
  /** Fired when alerts are recomputed or new ones fire. */
  ALERTS_CHANGED: "alerts_changed",
  /** Fired when items are added/updated/deleted. */
  ITEMS_CHANGED: "items_changed",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];