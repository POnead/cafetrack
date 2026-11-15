/**
 * Catalogue pagination — regression tests.
 *
 *   node scripts/_ts-node.mjs scripts/_catalogue-pagination-tests.mjs
 *
 * These pin the contract the Reports page depends on: the catalogue is
 * loaded in 500-row pages, every page's metadata must be genuine and
 * self-consistent JSON, and no failure path may leave a partial catalogue
 * looking like the whole one.
 *
 * The loader is independent of React (src/lib/catalogue-pagination.ts), so
 * sequence, abort and loading-state behavior are tested here directly with a
 * fake fetch. Nothing touches the database or the network.
 */
import assert from "node:assert/strict";
import {
  createCatalogueLoader,
  parseCataloguePage,
  CATALOGUE_PAGE_SIZE,
  MAX_CATALOGUE_PAGES,
} from "../src/lib/catalogue-pagination.ts";

let pass = 0;
let fail = 0;
const failures = [];
const tests = [];

function check(label, fn) {
  tests.push({ type: "test", label, fn });
}

function section(title) {
  tests.push({ type: "section", title });
}

/* ------------------------------------------------------------------ */
/* fakes                                                              */
/* ------------------------------------------------------------------ */

function makeItems(from, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${from + i}`,
    sku: `SKU-${String(from + i).padStart(5, "0")}`,
    name: `Item ${from + i}`,
  }));
}

/** A /api/items page body with every field genuine unless overridden. */
function page({ items, offset, total, hasMore, returned, limit }) {
  const body = {
    items,
    offset,
    limit: 500,
    total,
    has_more: hasMore,
  };
  if (returned !== undefined) body.returned = returned;
  if (limit !== undefined) body.limit = limit;
  if (returned === undefined) body.returned = items.length;
  return body;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Spin up a loader wired to a handler `(offset, callIndex, signal) =>
 * Promise<response>`. Records every fetch call and every callback the loader
 * fires, so tests can assert what consumers would observe.
 */
function setup(handler) {
  const calls = [];
  const events = [];
  const fetchImpl = (url, init) => {
    const offset = Number(new URL(url, "http://test.local").searchParams.get("offset"));
    const signal = init?.signal ?? null;
    calls.push({ offset, signal });
    return handler(offset, calls.length - 1, signal);
  };
  const loader = createCatalogueLoader(
    {
      onStart: () => events.push({ type: "start" }),
      onSuccess: (items) => events.push({ type: "success", items }),
      onError: (message) => events.push({ type: "error", message }),
      onDone: () => events.push({ type: "done" }),
    },
    { fetchImpl }
  );
  return { loader, calls, events };
}

const flush = async () => {
  for (let i = 0; i < 100; i++) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const eventsOfType = (events, type) => events.filter((e) => e.type === type);

/* ================================================================== */

section("contract constants");
check("the page size is 500 and the page cap is 40", () => {
  assert.equal(CATALOGUE_PAGE_SIZE, 500);
  assert.equal(MAX_CATALOGUE_PAGES, 40);
});

section("parseCataloguePage — the strict contract");
check("a well-formed page is accepted and normalised", () => {
  const items = makeItems(0, 3);
  const parsed = parseCataloguePage(
    { items, returned: 3, limit: 500, offset: 10, total: 100, has_more: true },
    10,
    500
  );
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.returned, 3);
  assert.equal(parsed.offset, 10);
  assert.equal(parsed.limit, 500);
  assert.equal(parsed.total, 100);
  assert.equal(parsed.hasMore, true);
});

check("missing returned is not inferred from the array length", () => {
  const items = makeItems(0, 500);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, limit: 500, offset: 0, total: 500, has_more: false },
        0,
        500
      ),
    /returned/
  );
});

check("numeric strings are rejected for returned, offset, limit, total", () => {
  const items = makeItems(0, 3);
  for (const body of [
    { items, returned: "3", limit: 500, offset: 0, total: 3, has_more: false },
    { items, returned: 3, limit: "500", offset: 0, total: 3, has_more: false },
    { items, returned: 3, limit: 500, offset: "0", total: 3, has_more: false },
    { items, returned: 3, limit: 500, offset: 0, total: "3", has_more: false },
  ]) {
    assert.throws(() => parseCataloguePage(body, 0, 500), /returned|offset|limit|total/);
  }
});

check("missing items array is rejected", () => {
  assert.throws(
    () =>
      parseCataloguePage(
        { returned: 0, limit: 500, offset: 0, total: 0, has_more: false },
        0,
        500
      ),
    /items/
  );
});

check("non-array items is rejected", () => {
  assert.throws(
    () =>
      parseCataloguePage(
        { items: {}, returned: 0, limit: 500, offset: 0, total: 0, has_more: false },
        0,
        500
      ),
    /items/
  );
});

check("returned that does not match the items array is rejected", () => {
  const items = makeItems(0, 3);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, returned: 5, limit: 500, offset: 0, total: 3, has_more: false },
        0,
        500
      ),
    /returned/
  );
});

check("returned beyond the page size is rejected", () => {
  const items = makeItems(0, 3);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, returned: 3, limit: 500, offset: 0, total: 3, has_more: false },
        0,
        2
      ),
    /returned|page size/
  );
});

check("missing total is rejected", () => {
  const items = makeItems(0, 1);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, returned: 1, limit: 500, offset: 0, has_more: false },
        0,
        500
      ),
    /total/
  );
});

check("non-integer or negative totals are rejected", () => {
  const items = makeItems(0, 1);
  for (const total of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        parseCataloguePage(
          { items, returned: 1, limit: 500, offset: 0, total, has_more: false },
          0,
          500
        ),
      /total/
    );
  }
});

section("parseCataloguePage — has_more must be a genuine boolean");
check("missing has_more is rejected", () => {
  const items = makeItems(0, 1);
  assert.throws(
    () => parseCataloguePage({ items, returned: 1, limit: 500, offset: 0, total: 1 }, 0, 500),
    /has_more/
  );
});
check("string has_more values are rejected", () => {
  const items = makeItems(0, 1);
  for (const has_more of ["true", "false", "1", 1, 0, null]) {
    assert.throws(
      () =>
        parseCataloguePage(
          { items, returned: 1, limit: 500, offset: 0, total: 1, has_more },
          0,
          500
        ),
      /has_more/
    );
  }
});

section("parseCataloguePage — self-consistency");
check("offset + returned beyond total is rejected", () => {
  const items = makeItems(0, 500);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, returned: 500, limit: 500, offset: 0, total: 400, has_more: false },
        0,
        500
      ),
    /inconsistent/
  );
});
check("has_more=false before the total is reached is rejected", () => {
  const items = makeItems(0, 100);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, returned: 100, limit: 500, offset: 0, total: 600, has_more: false },
        0,
        500
      ),
    /inconsistent/
  );
});
check("has_more=true at or beyond the total is rejected", () => {
  const items = makeItems(0, 500);
  assert.throws(
    () =>
      parseCataloguePage(
        { items, returned: 500, limit: 500, offset: 0, total: 500, has_more: true },
        0,
        500
      ),
    /inconsistent/
  );
});
check("an empty page with has_more=true is rejected", () => {
  assert.throws(
    () =>
      parseCataloguePage(
        { items: [], returned: 0, limit: 500, offset: 0, total: 100, has_more: true },
        0,
        500
      ),
    /stalled/
  );
});

section("the full loop — ordinary loads");
check("a 600-item catalogue is loaded across two pages", async () => {
  const { loader, calls, events } = setup((offset) => {
    if (offset === 0) {
      return jsonResponse(page({ items: makeItems(0, 500), offset: 0, total: 600, hasMore: true }));
    }
    return jsonResponse(page({ items: makeItems(500, 100), offset: 500, total: 600, hasMore: false }));
  });
  loader.load();
  await flush();
  const success = eventsOfType(events, "success");
  assert.equal(success.length, 1, "exactly one success callback");
  assert.equal(success[0].items.length, 600);
  assert.equal(success[0].items[599].sku, "SKU-00599");
  assert.deepEqual(calls.map((c) => c.offset), [0, 500]);
  assert.equal(eventsOfType(events, "error").length, 0);
  assert.equal(eventsOfType(events, "done").length, 1);
});

check("a 1500-item catalogue is loaded across three pages", async () => {
  const { loader, calls, events } = setup((offset) => {
    const remaining = 1500 - offset;
    const take = Math.min(500, remaining);
    return jsonResponse(
      page({ items: makeItems(offset, take), offset, total: 1500, hasMore: offset + take < 1500 })
    );
  });
  loader.load();
  await flush();
  const success = eventsOfType(events, "success");
  assert.equal(success[0].items.length, 1500);
  assert.deepEqual(calls.map((c) => c.offset), [0, 500, 1000]);
});

check("an empty catalogue (total 0) succeeds with an empty list", async () => {
  const { loader, events } = setup(() =>
    jsonResponse(page({ items: [], offset: 0, total: 0, hasMore: false }))
  );
  loader.load();
  await flush();
  const success = eventsOfType(events, "success");
  assert.equal(success.length, 1);
  assert.equal(success[0].items.length, 0);
  assert.equal(eventsOfType(events, "error").length, 0);
});

section("the full loop — exact 40-page boundary, both ways");
check("a catalogue that finishes on page 40 loads successfully", async () => {
  const TOTAL = 500 * MAX_CATALOGUE_PAGES; // exactly 40 full pages
  const { loader, calls, events } = setup((offset) => {
    const take = 500;
    const hasMore = offset + take < TOTAL;
    return jsonResponse(
      page({ items: makeItems(offset, take), offset, total: TOTAL, hasMore })
    );
  });
  loader.load();
  await flush();
  const success = eventsOfType(events, "success");
  assert.equal(success.length, 1, "the 40-page catalogue is a complete load");
  assert.equal(success[0].items.length, TOTAL);
  assert.equal(calls.length, MAX_CATALOGUE_PAGES);
  assert.equal(eventsOfType(events, "error").length, 0);
});

check("a catalogue still reporting another page after page 40 fails", async () => {
  const TOTAL = 500 * (MAX_CATALOGUE_PAGES + 1); // 41 pages' worth
  const { loader, events } = setup((offset) =>
    jsonResponse(page({ items: makeItems(offset, 500), offset, total: TOTAL, hasMore: true }))
  );
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1, "the load fails instead of returning short data");
  assert.match(errors[0].message, /40-page maximum/);
  assert.equal(eventsOfType(events, "success").length, 0, "no partial catalogue is emitted");
});

section("the full loop — contradictory metadata over the wire");
check("contradictory totals across pages abort the load", async () => {
  const { loader, events } = setup((offset) => {
    if (offset === 0) {
      return jsonResponse(page({ items: makeItems(0, 500), offset: 0, total: 1200, hasMore: true }));
    }
    return jsonResponse(page({ items: makeItems(500, 100), offset: 500, total: 1300, hasMore: false }));
  });
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /inconsistent/);
  assert.equal(eventsOfType(events, "success").length, 0);
});

check("offset metadata that does not advance between pages aborts the load", async () => {
  const { loader, events } = setup((offset) => {
    if (offset === 0) {
      return jsonResponse(page({ items: makeItems(0, 500), offset: 0, total: 600, hasMore: true }));
    }
    // The API echoes the first page's offset instead of the requested 500.
    return jsonResponse({ ...page({ items: makeItems(500, 100), offset: 500, total: 600, hasMore: false }), offset: 0 });
  });
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /offset/);
  assert.equal(eventsOfType(events, "success").length, 0);
});

check("incorrect response limit aborts the load", async () => {
  const { loader, events } = setup((offset) =>
    jsonResponse({ ...page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false }), limit: 200 })
  );
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /limit/);
});

check("incorrect response offset on the first page aborts the load", async () => {
  const { loader, events } = setup(() =>
    jsonResponse({ ...page({ items: makeItems(0, 10), offset: 500, total: 10, hasMore: false }), offset: 500 })
  );
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /offset/);
});

check("missing returned on any page aborts the load", async () => {
  const { loader, events } = setup(() => {
    const body = page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false });
    delete body.returned;
    return jsonResponse(body);
  });
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /returned/);
});

check("string has_more over the wire aborts the load", async () => {
  const { loader, events } = setup(() =>
    jsonResponse({ ...page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false }), has_more: "false" })
  );
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /has_more/);
});

section("the full loop — failure paths");
check("a failed later page discards the partial catalogue (never emitted as complete)", async () => {
  const { loader, events } = setup((offset) => {
    if (offset === 0) {
      return jsonResponse(page({ items: makeItems(0, 500), offset: 0, total: 600, hasMore: true }));
    }
    return jsonResponse({ error: "Server exploded" }, 500);
  });
  loader.load();
  await flush();
  assert.equal(
    eventsOfType(events, "success").length,
    0,
    "the partial catalogue is not reported to consumers (KPIs, charts, table stay empty)"
  );
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Server exploded");
  assert.equal(eventsOfType(events, "done").length, 1, "loading still settles");
});

check("a failed first page reports the server's error message", async () => {
  const { loader, events } = setup(() => jsonResponse({ error: "Could not load the inventory" }, 503));
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Could not load the inventory");
  assert.equal(eventsOfType(events, "success").length, 0);
});

check("a 200 response carrying an error field is rejected", async () => {
  const { loader, events } = setup(() =>
    jsonResponse({ ...page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false }), error: "partial write" })
  );
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "partial write");
});

check("a non-JSON body aborts the load", async () => {
  const { loader, events } = setup(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("invalid json");
    },
  }));
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /items/);
});

check("an empty page with has_more=true over the wire aborts the load", async () => {
  const { loader, events } = setup(() =>
    jsonResponse(page({ items: [], offset: 0, total: 600, hasMore: true, returned: 0 }))
  );
  loader.load();
  await flush();
  const errors = eventsOfType(events, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /stalled/);
  assert.equal(eventsOfType(events, "success").length, 0);
});

section("the full loop — request sequencing and aborts");
check("an older request completing after a newer one is ignored", async () => {
  let resolveFirst;
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let call = 0;
  const { loader, events } = setup(() => {
    call += 1;
    if (call === 1) {
      // Deliberately unresponsive to the abort signal: a slow response that
      // lands after the newer load finished.
      return firstResponse;
    }
    return jsonResponse(page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false }));
  });

  loader.load(); // request A
  loader.load(); // request B — supersedes A
  await flush();
  assert.equal(eventsOfType(events, "success").length, 1, "B succeeds");
  assert.equal(eventsOfType(events, "success")[0].items.length, 10);

  resolveFirst(jsonResponse(page({ items: makeItems(0, 999), offset: 0, total: 999, hasMore: false })));
  await flush();
  assert.equal(eventsOfType(events, "success").length, 1, "A's late response does not overwrite B");
  assert.equal(eventsOfType(events, "error").length, 0, "A's late response does not raise an error either");
  assert.equal(eventsOfType(events, "done").length, 1, "only B settles the loading flag");
});

check("an aborted request does not clear the newer request's loading state", async () => {
  let call = 0;
  const { loader, events } = setup((offset, callIndex, signal) => {
    call += 1;
    if (call === 1) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    }
    return jsonResponse(page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false }));
  });

  loader.load(); // request A
  loader.load(); // request B — aborts A, whose fetch then rejects
  await flush();
  assert.equal(eventsOfType(events, "success").length, 1, "B succeeds");
  assert.equal(eventsOfType(events, "error").length, 0, "A's abort is silent");
  assert.equal(eventsOfType(events, "done").length, 1, "A's settle does not clear B's loading flag");
});

check("a superseded load that fails does not raise an error", async () => {
  let call = 0;
  let rejectFirst;
  const { loader, events } = setup(() => {
    call += 1;
    if (call === 1) {
      // A's only request, left pending until the test rejects it after B
      // has superseded A.
      return new Promise((_, reject) => {
        rejectFirst = reject;
      });
    }
    return jsonResponse(page({ items: makeItems(0, 10), offset: 0, total: 10, hasMore: false }));
  });

  loader.load(); // A — fetch pending
  loader.load(); // B — supersedes A and fetches its own page
  await flush();
  assert.equal(eventsOfType(events, "success").length, 1, "B succeeds");

  rejectFirst(new Error("Server exploded"));
  await flush();
  assert.equal(eventsOfType(events, "error").length, 0, "A's failure is swallowed as stale");
  assert.equal(eventsOfType(events, "success").length, 1, "B's result stands");
});

check("starting a load while one is in flight aborts the older request", async () => {
  const { loader, calls, events } = setup(() =>
    new Promise(() => { /* never resolves */ })
  );
  loader.load();
  loader.load();
  await flush();
  assert.equal(calls[0].signal.aborted, true, "the first request is aborted");
  assert.equal(calls[1].signal.aborted, false, "the second request stays live");
  assert.equal(eventsOfType(events, "done").length, 0, "nothing has settled yet");
});

/* ================================================================== */

for (const entry of tests) {
  if (entry.type === "section") {
    console.log(`\n== ${entry.title} ==`);
    continue;
  }
  try {
    // eslint-disable-next-line no-await-in-loop
    await entry.fn();
    pass++;
    console.log(`  PASS  ${entry.label}`);
  } catch (error) {
    fail++;
    failures.push(entry.label);
    console.error(`  FAIL  ${entry.label}: ${error.message}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length > 0) {
  console.error(`failures:\n  - ${failures.join("\n  - ")}`);
}
process.exit(fail > 0 ? 1 : 0);
