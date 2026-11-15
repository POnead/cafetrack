/*
 * Catalogue pagination for the Reports page.
 *
 * The reports are only meaningful against the complete active catalogue, so
 * the page loads it page by page instead of rendering the first page as if
 * it were everything. The response contract of GET /api/items makes a page
 * self-describing (items, returned, limit, offset, total, has_more), and this
 * module holds the two halves that used to live inline in the component:
 *
 *   parseCataloguePage   — strict validation of one response page. Nothing is
 *                          inferred, nothing is coerced: `returned` must be a
 *                          genuine JSON number and equal to the items array it
 *                          describes, `has_more` must be a genuine JSON
 *                          boolean, and the metadata must agree with itself
 *                          and with the page that was requested.
 *   createCatalogueLoader — the page loop and its guards: 500 rows per page,
 *                          40 pages maximum, one in-flight request sequence,
 *                          one AbortController, and a loading flag that only
 *                          the latest request may settle.
 *
 * The loader is independent of React so its sequence, abort and loading-state
 * behavior can be tested without rendering the page. It never reports a
 * partial catalogue as complete: `onSuccess` only ever fires with the full
 * collection, on any inconsistency `onError` instead.
 */

export const CATALOGUE_PAGE_SIZE = 500;
export const MAX_CATALOGUE_PAGES = 40;

export type CataloguePage<T> = {
  items: T[];
  returned: number;
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
};

function fail(message: string): never {
  throw new Error(message);
}

/** A genuine JSON number: finite, an integer, >= 0. Strings are rejected. */
function jsonNonNegativeInteger(value: unknown, message: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    fail(message);
  }
  return value;
}

/**
 * Validate one /api/items page.
 *
 * @param payload           the decoded JSON body (or whatever came back)
 * @param requestedOffset   the `offset` the page was asked for
 * @param requestedLimit    the `limit` the page was asked for
 * @throws Error            on any inconsistency — the caller must clear the
 *                          catalogue rather than render what it has.
 */
export function parseCataloguePage<T = unknown>(
  payload: unknown,
  requestedOffset: number,
  requestedLimit: number
): CataloguePage<T> {
  const raw = (payload ?? {}) as Record<string, unknown>;

  const rawItems = raw.items;
  if (!Array.isArray(rawItems)) {
    fail("The item catalogue response is missing the items array");
  }
  const items = rawItems as T[];

  // `returned` is authoritative. It is never inferred from the array length.
  const returned = jsonNonNegativeInteger(
    raw.returned,
    "The item catalogue response is missing a valid 'returned' value"
  );
  if (returned !== items.length) {
    fail("The item catalogue response 'returned' does not match the items array");
  }
  if (returned > requestedLimit) {
    fail("The item catalogue response 'returned' exceeds the page size");
  }

  const offset = jsonNonNegativeInteger(
    raw.offset,
    "The item catalogue response offset is incorrect"
  );
  if (offset !== requestedOffset) {
    fail("The item catalogue response offset is incorrect");
  }

  const limit = jsonNonNegativeInteger(
    raw.limit,
    "The item catalogue response limit is incorrect"
  );
  if (limit !== requestedLimit) {
    fail("The item catalogue response limit is incorrect");
  }

  const total = jsonNonNegativeInteger(
    raw.total,
    "The item catalogue response total is invalid"
  );

  // has_more is a boolean or the response is refused.
  const rawHasMore = raw.has_more;
  if (typeof rawHasMore !== "boolean") {
    fail("The item catalogue response 'has_more' is not a boolean");
  }
  const hasMore = rawHasMore;

  if (offset + returned > total) {
    fail("The item catalogue pagination metadata is inconsistent");
  }
  if (hasMore && offset + returned >= total) {
    fail("The item catalogue pagination metadata is inconsistent");
  }
  if (!hasMore && offset + returned < total) {
    fail("The item catalogue pagination metadata is inconsistent");
  }
  if (hasMore && returned === 0) {
    fail("The item catalogue pagination stalled");
  }

  return { items, returned, limit, offset, total, hasMore };
}

export type CatalogueLoaderCallbacks<T> = {
  /** Called at the start of every load, before any request is issued. */
  onStart?: () => void;
  /**
   * Called exactly once per successful load, with the complete catalogue.
   * Never called with a partial collection: a catalogue that cannot be read
   * to the end produces onError instead.
   */
  onSuccess?: (items: T[]) => void;
  /**
   * Called when the load fails (a page could not be read or failed validation,
   * the maximum page count was exceeded, or the API reported an error). The
   * in-flight load's partial items are discarded. Not called for loads that
   * were superseded by a newer one, nor for aborted ones.
   */
  onError?: (message: string) => void;
  /**
   * Called when the load settles — but only for the request that is still the
   * newest when it settles, so a stale or aborted request can never clear the
   * loading state of its successor.
   */
  onDone?: () => void;
};

export type CatalogueLoaderOptions = {
  /** Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  pageSize?: number;
  maxPages?: number;
};

export type CatalogueLoader = {
  /**
   * Begin a load. Aborts whatever was in flight and issues the requests from
   * the first page. Fire-and-forget by design; progress is reported through
   * the callbacks.
   */
  load(): void;
};

export function createCatalogueLoader<T = unknown>(
  callbacks: CatalogueLoaderCallbacks<T>,
  options: CatalogueLoaderOptions = {}
): CatalogueLoader {
  const pageSize = options.pageSize ?? CATALOGUE_PAGE_SIZE;
  const maxPages = options.maxPages ?? MAX_CATALOGUE_PAGES;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  let sequence = 0;
  let controller: AbortController | null = null;

  function load() {
    controller?.abort();
    const next = new AbortController();
    controller = next;
    const requestId = ++sequence;

    callbacks.onStart?.();

    (async () => {
      try {
        const collected: T[] = [];
        let offset = 0;
        let seenTotal: number | null = null;

        for (let page = 0; page < maxPages; page += 1) {
          // A newer load started while this one was awaiting: abandon.
          if (requestId !== sequence) return;

          const response = await fetchImpl(
            `/api/items?limit=${pageSize}&offset=${offset}`,
            { signal: next.signal }
          );
          const data: unknown = await response.json().catch(() => ({}));
          if (requestId !== sequence) return;

          const serverError =
            data && typeof data === "object"
              ? (data as Record<string, unknown>).error
              : undefined;
          if (!response.ok || (typeof serverError === "string" && serverError)) {
            throw new Error(
              typeof serverError === "string" && serverError
                ? serverError
                : "Could not load the inventory"
            );
          }

          const parsed = parseCataloguePage<T>(data, offset, pageSize);
          if (seenTotal !== null && parsed.total !== seenTotal) {
            fail("The item catalogue pagination metadata is inconsistent");
          }
          if (seenTotal === null) seenTotal = parsed.total;

          collected.push(...parsed.items);

          if (!parsed.hasMore) {
            if (requestId !== sequence) return;
            callbacks.onSuccess?.(collected);
            return;
          }
          offset = parsed.offset + parsed.returned;
        }

        // The loop ran to the page cap without the API saying there is no
        // more. The catalogue is never returned short of its end.
        fail(`The item catalogue pagination exceeded the ${maxPages}-page maximum`);
      } catch (error) {
        // Stale or aborted: settle silently, and never touch shared state.
        if (next.signal.aborted) return;
        if (requestId !== sequence) return;
        callbacks.onError?.(
          error instanceof Error ? error.message : "Could not load the inventory"
        );
      } finally {
        if (requestId === sequence) {
          if (controller === next) controller = null;
          callbacks.onDone?.();
        }
      }
    })();
  }

  return { load };
}
