export function fmtQty(n: number | string, unit?: string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  const s = Number.isInteger(num) ? String(num) : num.toFixed(2);
  return unit ? `${s} ${unit}` : s;
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-PH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function daysUntil(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;

  // Two shapes reach this function, and only one of them used to work:
  //
  //   - "2026-09-28"                            from an <input type="date">
  //   - "2026-09-28T00:00:00.000Z"              from an API response, because a
  //                                              Postgres `date` column
  //                                              serialises to a full ISO instant
  //
  // Appending "T00:00:00" to the second shape produced an Invalid Date, so
  // every caller reading an item's expiry from the API got NaN. NaN then failed
  // *both* guards — `d < 0` and `d <= warningDays` are both false — so every
  // dated item silently fell through to "In Date", and the UI contradicted
  // refresh_alerts(), which computes the same thing correctly in SQL.
  //
  // An expiry is a calendar day, not an instant, so the time part is dropped
  // and the day is read as local midnight: the same basis `today` is set to
  // below. Parsing the instant directly would happen to round correctly in most
  // zones, but at a large positive offset (UTC+14) an item expiring *today*
  // rounds to 1, claiming a day is left on the day it expires.
  const day = String(dateStr).slice(0, 10);
  const target = new Date(`${day}T00:00:00`);

  // An unparseable date reports "unknown" (null) rather than NaN. Callers treat
  // null as a defined, visible state; NaN would fail open and read as "fine".
  if (Number.isNaN(target.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: Record<string, unknown>[], headers?: string[]): string {
  if (rows.length === 0) return headers ? headers.join(",") : "";
  const cols = headers ?? Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(row[c])).join(","));
  }
  return lines.join("\n");
}
