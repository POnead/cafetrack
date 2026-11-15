/**
 * Calendar days in a named IANA timezone.
 *
 * Reports, exports and the history screen all let a person pick a calendar
 * day — "today", "this week", "15 Nov". A calendar day is not a fixed span of
 * milliseconds: 1 November 2026 is 25 hours long in New York and 24 hours
 * in Manila, because a named zone applies a different offset on either side
 * of a daylight-saving transition. A fixed `tz_offset_minutes` cannot express
 * that, so every day boundary in CafeTrack is resolved per date, in the named
 * zone, with the offset that actually applies to that date.
 *
 * Nothing here reads the database, the auth stack or any request context — it
 * is pure `Intl` arithmetic, safe to import from server routes, the report
 * builder, and client components alike.
 */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD pattern plus a round-trip through the calendar. */
export function isCalendarDayString(
  value: string | null | undefined
): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Calendar-day arithmetic on day keys — shifting a day key by N days never
 * touches a timezone, because a date is a date everywhere.
 */
export function shiftDayKey(day: string, deltaDays: number): string {
  const at = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(at + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday of a day key, 0 = Sunday. A calendar fact, not a zone fact. */
export function dayKeyWeekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

/** Whether the string names a timezone Intl recognises. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The timezone the host (browser or server) is configured to use. */
export function resolvedTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(zone, formatter);
  }
  return formatter;
}

function partsInZone(zone: string, atMs: number) {
  const parts = partsFormatter(zone).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** The wall clock of `atMs` in `zone`, as an ISO-ish day key. */
export function dayKeyInZone(atMs: number, zone: string): string {
  const parts = partsInZone(zone, atMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Today as a day key in `zone`. */
export function todayInZone(zone: string): string {
  return dayKeyInZone(Date.now(), zone);
}

/** How many milliseconds the zone's wall clock is ahead of UTC at `atMs`. */
export function zoneOffsetMs(zone: string, atMs: number): number {
  const wall = partsInZone(zone, atMs);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );
  // The wall clock has second resolution; drop sub-second noise.
  return wallAsUtc - Math.floor(atMs / 1000) * 1000;
}

/**
 * The UTC instant of local midnight on `day` in `zone`.
 *
 * Null when the zone is invalid or when the day's midnight does not exist
 * (a skipped day boundary in zones that shift at midnight — no supported
 * deployment reports one, but a null boundary is answered honestly rather
 * than as a wrong-but-plausible timestamp).
 */
export function zonedMidnightUtc(day: string, zone: string): number | null {
  if (!isCalendarDayString(day) || !isValidTimeZone(zone)) return null;
  const [year, month, dayNum] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, dayNum);
  // Refine twice: the offset at the initial guess is applied a second time at
  // the refined instant, which catches zones whose offset changes inside the
  // hour surrounding the target midnight.
  let at = guess - zoneOffsetMs(zone, guess);
  at = guess - zoneOffsetMs(zone, at);
  const parts = partsInZone(zone, at);
  const stillTheDay =
    parts.year === year && parts.month === month && parts.day === dayNum;
  return stillTheDay ? at : null;
}

/**
 * The UTC instant of local midnight on the day after `day` in `zone`,
 * minus one millisecond — the inclusive end of `day`. Local midnight is
 * inclusive and the following local midnight is exclusive: a timestamp lands
 * in exactly one calendar day, in every zone, on every date.
 */
export function zonedDayEndUtc(day: string, zone: string): number {
  const nextStart = zonedMidnightUtc(shiftDayKey(day, 1), zone);
  if (nextStart === null) {
    throw new Error(`Could not resolve the end of ${day} in ${zone}`);
  }
  return nextStart - 1;
}

/**
 * A half-open bound pair for one local calendar day: `fromAt` inclusive,
 * `before` exclusive. Null when either boundary cannot be resolved.
 */
export function localDayBoundsIso(
  day: string,
  zone: string
): { fromAt: string; before: string } | null {
  if (!isValidTimeZone(zone)) return null;
  const start = zonedMidnightUtc(day, zone);
  const next = zonedMidnightUtc(shiftDayKey(day, 1), zone);
  if (start === null || next === null) return null;
  return {
    fromAt: new Date(start).toISOString(),
    before: new Date(next).toISOString(),
  };
}
