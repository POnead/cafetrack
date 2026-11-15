/*
 * Shared wording for export completeness.
 *
 * The export preview (src/app/(app)/reports/page.tsx) renders this for both
 * the catalogue-items status and the transactions status, and the test
 * suites pin the exact strings. A report must never claim "Complete" when
 * the shared report builder could only mark a section "unknown" — a probe
 * that could not run proves nothing, so "Unknown — could not verify" is the
 * honest label and is what the UI renders.
 *
 * Anything that is not one of the three known states falls back to the
 * unknown wording rather than to a guess.
 */

export type ExportCompleteness = "complete" | "truncated" | "unknown";

const LABELS: Record<ExportCompleteness, string> = {
  complete: "Complete",
  truncated: "Truncated",
  unknown: "Unknown — could not verify",
};

export function exportCompletenessLabel(state: unknown): string {
  if (state === "complete" || state === "truncated" || state === "unknown") {
    return LABELS[state];
  }
  // A value the builder never produces: say so instead of rendering a guess.
  return LABELS.unknown;
}
