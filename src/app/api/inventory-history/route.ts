import { dbFail, fail, handler, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import {
  buildInventoryHistory,
  daysBetween,
  HistoryRequestError,
  isCalendarDay,
  MAX_RANGE_DAYS,
} from "@/lib/inventory-history";
import { isValidTimeZone, todayInZone } from "@/lib/zoned-time";

export const runtime = "nodejs";

/**
 * The same uuid shape the item routes accept. A category id that is not one
 * is a bad request; a well-formed id that names nothing is answered with an
 * empty result rather than an error, because "show me that category" has an
 * honest answer when the category has been deleted, and that answer is
 * "there is nothing in it".
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The reconstructed inventory value of the stock on hand, over a date range.
 *
 * CafeTrack stores the *current* unit price on the item and the on-hand
 * quantity on the item too. It does not keep a price history and it does not
 * keep a stock snapshot per day. What it does keep is the movement ledger:
 * `transaction_items` records `qty_before` and `qty_after` for every line, so
 * the on-hand quantity of every item at any point in time can be rebuilt from
 * the movements that produced it.
 *
 * `from`/`to` bound calendar days in the IANA timezone named by `tz`
 * (e.g. "Asia/Manila"). A calendar day is not a fixed span of hours — it is
 * 25 long on one side of a DST shift — so each day's boundary is resolved
 * per date in that zone. Omit `tz` and days are UTC days, as they always
 * were. Local midnight is inclusive and the following local midnight is
 * exclusive: a movement lands on exactly one calendar day, in every zone.
 *
 * A read-only view over the movement ledger: it rebuilds each item's
 * on-hand quantity from the `qty_before`/`qty_after` recorded on every
 * movement line, values it at the item's current unit price, and returns the
 * series. Nothing here writes, and nothing here changes how movements are
 * recorded or how quantities are calculated.
 *
 * The prices are current prices. There is no price history in CafeTrack, so
 * a past value is an estimate at today's prices rather than a historical
 * valuation — the response carries the counts the interface needs to say so,
 * and the caller is expected to show them.
 */
export const GET = handler(async (req: Request) => {
  await requireUser();

  const { searchParams } = new URL(req.url);

  const fromRaw = searchParams.get("from");
  const toRaw = searchParams.get("to");
  const categoryRaw = searchParams.get("category");
  const tzRaw = searchParams.get("tz");

  /*
   * The timezone the day keys mean. A calendar day is not a fixed span of
   * milliseconds — it is 25 hours long on one side of a DST transition — so
   * the boundary of each requested day is resolved per date in this zone.
   * Omit it and everything is reconstructed in UTC, as it always was.
   */
  if (tzRaw !== null && !isValidTimeZone(tzRaw)) {
    return fail("That timezone is not recognised", 400);
  }
  const tz = tzRaw ?? "UTC";

  /*
   * Dates.
   *
   * The shape check alone is not enough — `2026-02-30` has the right shape
   * and names no day — so the value is round-tripped through a Date and
   * compared with the input, the same test the transaction API applies to
   * its own `from`/`to`.
   */
  if (fromRaw !== null && !isCalendarDay(fromRaw)) {
    return fail("Dates must be given as YYYY-MM-DD", 400);
  }
  if (toRaw !== null && !isCalendarDay(toRaw)) {
    return fail("Dates must be given as YYYY-MM-DD", 400);
  }

  // A missing end date means "up to today"; a missing start date means "as
  // far back as the recorded movements reach", which the service resolves.
  const to = toRaw ?? todayInZone(tz);
  const from = fromRaw;

  if (from) {
    const span = daysBetween(from, to);
    if (span < 1) {
      return fail("The start date must not be after the end date", 400);
    }
    if (span > MAX_RANGE_DAYS) {
      return fail("Choose a date range of ten years or less", 400);
    }
  }

  if (categoryRaw !== null && !UUID.test(categoryRaw)) {
    return fail("That category id is not valid", 400);
  }
  const category = categoryRaw || null;

  try {
    const history = await buildInventoryHistory({ from, to, category, tz });
    return ok(history);
  } catch (error) {
    if (error instanceof HistoryRequestError) {
      return fail(error.message, 400);
    }
    return dbFail(error as { message?: string } | null, {
      context: "inventory history",
    });
  }
});
