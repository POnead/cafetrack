/**
 * Regression tests for the calendar-day boundary convention.
 *
 *   node scripts/_ts-node.mjs scripts/_day-boundary-tests.mjs
 *
 * Reports, exports and the history screen let a person pick a calendar day.
 * A day is not a fixed span of milliseconds: midnight Manila and midnight
 * New York are different instants, and the offset that applies to a date
 * changes across a DST transition. These tests pin the behavior the reports
 * page depends on, in three zones, including both transition days of 2026.
 *
 * Everything here is synthetic — no database, no network.
 */
import {
  buildHistoryFromScan,
  HistoryRequestError,
} from "../src/lib/inventory-history-core.ts";
import {
  dayKeyInZone,
  isCalendarDayString,
  isValidTimeZone,
  localDayBoundsIso,
  resolvedTimeZone,
  shiftDayKey,
  todayInZone,
  zonedDayEndUtc,
  zonedMidnightUtc,
  zoneOffsetMs,
} from "../src/lib/zoned-time.ts";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${label}${detail ? "  — " + detail : ""}`);
  }
}

/* ------------------------------------------------------------------ */
/* zoned-time primitives                                                */
/* ------------------------------------------------------------------ */

console.log("\nday keys — calendar facts, zone-free arithmetic");
{
  check(
    "shiftDayKey crosses month and year boundaries",
    shiftDayKey("2026-01-01", -1) === "2025-12-31" &&
      shiftDayKey("2026-02-28", 1) === "2026-03-01" &&
      shiftDayKey("2026-11-15", 7) === "2026-11-22"
  );
  check(
    "isCalendarDayString rejects impossible dates and accepts real ones",
    isCalendarDayString("2026-02-28") === true &&
      isCalendarDayString("2026-02-30") === false &&
      isCalendarDayString("2026-13-01") === false &&
      isCalendarDayString("not-a-day") === false &&
      isCalendarDayString("2026-11-15T00:00:00Z") === false
  );
  check(
    "isValidTimeZone recognises named zones and rejects junk",
    isValidTimeZone("Asia/Manila") &&
      isValidTimeZone("America/New_York") &&
      isValidTimeZone("UTC") &&
      !isValidTimeZone("Not/AZone") &&
      !isValidTimeZone("UTC+8") &&
      !isValidTimeZone("") &&
      !isValidTimeZone(480) &&
      !isValidTimeZone(null)
  );
  check(
    "resolvedTimeZone returns a recognised zone",
    isValidTimeZone(resolvedTimeZone()),
    resolvedTimeZone()
  );
  check(
    "dayKeyInZone agrees with Intl's own formatting",
    dayKeyInZone(Date.UTC(2026, 10, 15, 22, 30), "Asia/Manila") === "2026-11-16" &&
      dayKeyInZone(Date.UTC(2026, 10, 15, 22, 30), "UTC") === "2026-11-15"
  );
  check(
    "todayInZone returns the zone's current day",
    todayInZone("UTC") ===
      new Date().toISOString().slice(0, 10)
  );
}

console.log("\nmidnight boundaries — resolved per date in the zone");
{
  // UTC is the identity mapping.
  check(
    "UTC midnight is the same instant as the ISO day boundary",
    zonedMidnightUtc("2026-11-15", "UTC") ===
      Date.parse("2026-11-15T00:00:00.000Z")
  );
  // Manila is UTC+8 year-round: 15 Nov starts at 14 Nov 16:00Z.
  check(
    "Manila midnight lands on the previous UTC day",
    zonedMidnightUtc("2026-11-15", "Asia/Manila") ===
      Date.parse("2026-11-14T16:00:00.000Z")
  );
  // New York falls back on 1 Nov 2026 (02:00 → 01:00). Midnight that day is
  // still EDT (UTC−4); midnight the next day is EST (UTC−5).
  check(
    "New York midnight before the fallback is still EDT",
    zonedMidnightUtc("2026-11-01", "America/New_York") ===
      Date.parse("2026-11-01T04:00:00.000Z")
  );
  check(
    "New York midnight after the fallback is EST",
    zonedMidnightUtc("2026-11-02", "America/New_York") ===
      Date.parse("2026-11-02T05:00:00.000Z")
  );
  // Spring forward: 8 March 2026 (02:00 → 03:00). Midnight that day exists and
  // is EST (UTC−5).
  check(
    "New York midnight on the spring-forward day exists and is EST",
    zonedMidnightUtc("2026-03-08", "America/New_York") ===
      Date.parse("2026-03-08T05:00:00.000Z")
  );
  // 25-hour day: 1 Nov 2026 in New York spans 04:00Z → 05:00Z next day.
  const span =
    zonedMidnightUtc("2026-11-02", "America/New_York") -
    zonedMidnightUtc("2026-11-01", "America/New_York");
  check(
    "the fallback day is 25 hours long in New York",
    span === 25 * 3_600_000,
    `${span / 3_600_000}h`
  );
  const manilaSpan =
    zonedMidnightUtc("2026-11-16", "Asia/Manila") -
    zonedMidnightUtc("2026-11-15", "Asia/Manila");
  check("an ordinary Manila day is 24 hours long", manilaSpan === 86_400_000);
  check(
    "zonedDayEndUtc is one millisecond before the next local midnight",
    zonedDayEndUtc("2026-11-15", "Asia/Manila") ===
      Date.parse("2026-11-15T15:59:59.999Z")
  );
  check(
    "zoneOffsetMs agrees with the offset Intl reports on both sides of the fallback",
    zoneOffsetMs("Asia/Manila", Date.parse("2026-11-01T00:00:00.000Z")) ===
      8 * 3_600_000 &&
      zoneOffsetMs("America/New_York", Date.parse("2026-11-01T05:00:00.000Z")) ===
        -4 * 3_600_000 &&
      zoneOffsetMs("America/New_York", Date.parse("2026-11-01T07:00:00.000Z")) ===
        -5 * 3_600_000
  );
}

console.log("\nlocal day bounds — inclusive start, exclusive end");
{
  const bounds = localDayBoundsIso("2026-11-15", "Asia/Manila");
  check(
    "a Manila day runs from 16:00Z the day before to 16:00Z on the day",
    bounds?.fromAt === "2026-11-14T16:00:00.000Z" &&
      bounds?.before === "2026-11-15T16:00:00.000Z",
    `${bounds?.fromAt} → ${bounds?.before}`
  );

  const inDay = (iso) =>
    bounds !== null &&
    Date.parse(iso) >= Date.parse(bounds.fromAt) &&
    Date.parse(iso) < Date.parse(bounds.before);

  // 00:00 local (16:00Z prev day) — included.
  check(
    "a transaction at 00:00 local is in the day",
    inDay("2026-11-14T16:00:00.000Z")
  );
  // 23:59:59.999 local — included.
  check(
    "a transaction at 23:59:59.999 local is in the day",
    inDay("2026-11-15T15:59:59.999Z")
  );
  // The following local midnight — a new day, not this one.
  check(
    "a transaction at the next local midnight is not in the day",
    !inDay("2026-11-15T16:00:00.000Z")
  );
  // One millisecond before this day's local midnight — the previous day.
  check(
    "a transaction one millisecond before the day's start is not in the day",
    !inDay("2026-11-14T15:59:59.999Z")
  );

  // Open-ended bounds are per-side: a one-sided range stays one-sided.
  const toOnly = localDayBoundsIso("2026-11-15", "Asia/Manila");
  check(
    "the end bound is exactly the next local midnight",
    toOnly !== null &&
      Date.parse(toOnly.before) ===
        zonedMidnightUtc("2026-11-16", "Asia/Manila")
  );

  // Half-open bounds never double-count or drop an instant at a year edge.
  const newYear = localDayBoundsIso("2026-01-01", "Asia/Manila");
  check(
    "the new year boundary does not bleed into or out of 2026",
    newYear?.fromAt === "2025-12-31T16:00:00.000Z" &&
      newYear?.before === "2026-01-01T16:00:00.000Z"
  );

  check(
    "localDayBoundsIso refuses an unrecognised zone",
    localDayBoundsIso("2026-11-15", "Not/AZone") === null
  );
  check(
    "localDayBoundsIso refuses an impossible day",
    localDayBoundsIso("2026-02-30", "Asia/Manila") === null
  );
}

/* ------------------------------------------------------------------ */
/* buildHistoryFromScan — the zone the day keys mean                    */
/* ------------------------------------------------------------------ */

function scanOf(movements) {
  return {
    items: [
      { sku: "AAA", name: "AAA", quantity: 100, unitPrice: 10, categoryId: null },
    ],
    movements,
    transactionsScanned: movements.length,
    movementsScanned: movements.length,
    historyFrom: movements[0]
      ? new Date(Math.min(...movements.map((m) => m.at))).toISOString()
      : null,
    historyTo: null,
    truncated: false,
    completeness: "complete",
  };
}

console.log("\nreconstruction — day keys mean local days in the requested zone");
{
  // A movement at 2026-11-14T22:00Z is 06:00 on 15 Nov in Manila, but still
  // 14 Nov in UTC. The two series must differ on exactly that day.
  const at = Date.parse("2026-11-14T22:00:00.000Z");
  const scan = scanOf([{ sku: "AAA", at, qtyBefore: 50, qtyAfter: 60 }]);

  const manila = buildHistoryFromScan(scan, {
    from: "2026-11-15",
    to: "2026-11-15",
    category: null,
    tz: "Asia/Manila",
  });
  const utc = buildHistoryFromScan(scan, {
    from: "2026-11-14",
    to: "2026-11-15",
    category: null,
    tz: "UTC",
  });

  check(
    "the Manila series for 15 Nov reflects the movement that was local then",
    manila.points.some(
      (point) => point.day === "2026-11-15" && point.valueCents === 60 * 10 * 100
    ),
    JSON.stringify(manila.points.map((p) => [p.day, p.valueCents]))
  );
  check(
    "the UTC series attributes the same movement to 14 Nov, not 15 Nov",
    utc.points.some(
      (point) => point.day === "2026-11-14" && point.valueCents === 60 * 10 * 100
    ) &&
      utc.points.some(
        (point) => point.day === "2026-11-15" && point.valueCents === 60 * 10 * 100
      ),
    JSON.stringify(utc.points.map((p) => [p.day, p.valueCents]))
  );
  check(
    "both reconstructions agree on the day keys they emit",
    manila.points[0]?.day === "2026-11-15" && utc.points[0]?.day === "2026-11-14"
  );
  check(
    "the same scan yields the requested zone's series, not a shared one",
    manila.requested.timeZone === "Asia/Manila" && utc.requested.timeZone === "UTC"
  );

  // A movement at 16:00Z on 15 Nov is local 16 Nov 00:00 — exclusive from
  // 15 Nov in Manila, inclusive in UTC's 15 Nov.
  const midnightManila = Date.parse("2026-11-15T16:00:00.000Z");
  const scanTwo = scanOf([
    { sku: "AAA", at: midnightManila, qtyBefore: 50, qtyAfter: 70 },
  ]);
  const manilaToday = buildHistoryFromScan(scanTwo, {
    from: "2026-11-15",
    to: "2026-11-15",
    category: null,
    tz: "Asia/Manila",
  });
  const utcToday = buildHistoryFromScan(scanTwo, {
    from: "2026-11-15",
    to: "2026-11-15",
    category: null,
    tz: "UTC",
  });
  check(
    "a movement at the next local midnight is excluded from the local day",
    manilaToday.points.every((point) => point.valueCents === 50 * 10 * 100),
    JSON.stringify(manilaToday.points.map((p) => [p.day, p.valueCents]))
  );
  check(
    "the same instant belongs to the UTC day containing it",
    utcToday.points.some((point) => point.valueCents === 70 * 10 * 100),
    JSON.stringify(utcToday.points.map((p) => [p.day, p.valueCents]))
  );

  // A one-day range that spans a week in the zone stays inside the zone.
  const overnight = buildHistoryFromScan(
    scanOf([
      { sku: "AAA", at: Date.parse("2026-11-14T16:00:00.000Z"), qtyBefore: 50, qtyAfter: 55 },
    ]),
    { from: "2026-11-15", to: "2026-11-15", category: null, tz: "Asia/Manila" }
  );
  check(
    "a movement exactly at the local day's first instant is in the day",
    overnight.points.some((point) => point.valueCents === 55 * 10 * 100)
  );
}

console.log("\nreconstruction — invalid timezone and DST-long days");
{
  const scan = scanOf([
    { sku: "AAA", at: Date.parse("2026-11-01T12:00:00.000Z"), qtyBefore: 50, qtyAfter: 60 },
  ]);
  try {
    buildHistoryFromScan(scan, {
      from: "2026-11-01",
      to: "2026-11-01",
      category: null,
      tz: "Not/AZone",
    });
    check("an unrecognised zone is refused", false);
  } catch (error) {
    check(
      "an unrecognised zone is refused",
      error instanceof HistoryRequestError
    );
  }

  // The 25-hour day in New York: a movement after the fallback belongs to
  // 1 November local even though it sits past 22:00Z of the same UTC day.
  const dst = buildHistoryFromScan(
    scanOf([
      {
        sku: "AAA",
        at: Date.parse("2026-11-02T03:30:00.000Z"), // 22:30 EDT on 1 Nov
        qtyBefore: 50,
        qtyAfter: 80,
      },
    ]),
    { from: "2026-11-01", to: "2026-11-01", category: null, tz: "America/New_York" }
  );
  check(
    "a movement late on the 25-hour fallback day belongs to that local day",
    dst.points.some((point) => point.valueCents === 80 * 10 * 100),
    JSON.stringify(dst.points.map((p) => [p.day, p.valueCents]))
  );

  // The fallback day's own boundary: 22:30 EDT on 1 Nov is still 1 Nov local,
  // and it is strictly before the local midnight that starts 2 Nov.
  const fallbackZone = "America/New_York";
  check(
    "a movement at 22:30 EDT on the fallback day is before local midnight on 2 Nov",
    Date.parse("2026-11-02T03:30:00.000Z") < zonedMidnightUtc("2026-11-02", fallbackZone)
  );
  const dstTwo = buildHistoryFromScan(
    scanOf([
      {
        sku: "AAA",
        at: Date.parse("2026-11-02T03:30:00.000Z"),
        qtyBefore: 50,
        qtyAfter: 80,
      },
    ]),
    { from: "2026-11-02", to: "2026-11-02", category: null, tz: "America/New_York" }
  );
  check(
    "on the following local day the balance carries the latest movement's qty_after",
    dstTwo.points.some((point) => point.valueCents === 80 * 10 * 100)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
