/** An idle credential starts a fresh failure streak after one day. */
export const FAILURE_STREAK_RESET_MS = 24 * 60 * 60 * 1000;

export function activeFailureStamps(
  rows: { success: boolean; at: number }[],
  now: number
): number[] {
  const stamps: number[] = [];
  for (const row of rows) {
    if (row.success || now - row.at >= FAILURE_STREAK_RESET_MS) break;
    stamps.push(row.at);
  }
  return stamps;
}
