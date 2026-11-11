/**
 * Choosing and running the ID check.
 *
 * This is the only module the routes talk to. It always runs OCR.space, adds
 * HyperVerge when configured and local document-shape checks, merges what they
 * read off the document, and compares the card name with the account name.
 *
 * ## The provider order
 *
 * OCR.space is required. HyperVerge runs when configured, alongside local
 * document-shape checks. Face++ portrait comparison is handled separately by the
 * upload route; it does not fall back to a local face model.
 *
 * `local` always runs for supplemental document checks; it does not read ID text.
 */

import { hypervergeConfigured, hypervergeProvider } from "./hyperverge";
import { ocrSpaceConfigured, ocrSpaceProvider } from "./ocr-space";
import { makeLocalProvider } from "./local";
import { facePlusPlusMode } from "../facepp";
import {
  IdProviderError,
  type IdExtractedFields,
  type IdSignal,
  type IdSignalTone,
  type IdVerificationInput,
  type IdVerificationProvider,
  type IdVerificationResult,
} from "./types";
import { nameSignal, type NameReadStatus } from "./name-signal";
import { idTypeHasExpiry } from "./specification";

export * from "./types";
export { readImageSize } from "./image-size";
export type { NameReadStatus } from "./name-signal";

/** Which providers will run, given what is configured. */
export function activeProviders(): IdVerificationProvider[] {
  return [
    ocrSpaceProvider,
    ...(hypervergeConfigured() ? [hypervergeProvider] : []),
  ];
}

/**
 * A one-line description of what will run, for the admin to see before uploading.
 */
export async function providerSummary(): Promise<{ id: string; label: string }[]> {
  const providers = activeProviders();
  const faceMode = facePlusPlusMode();

  return providers
    .map((provider) => ({
      id: provider.id,
      label:
        provider.id === "ocr_space" && !provider.available()
          ? "OCR.space (API key not configured)"
          : provider.label,
    }))
    .concat([
      {
        id: "facepp",
        label:
          faceMode === "enabled"
            ? "Face++ portrait comparison"
            : faceMode === "invalid"
              ? "Face++ credentials need attention"
              : "Face++ not configured",
      },
      { id: "local", label: "Local document checks" },
    ]);
}

/**
 * Why the name on the card is or is not available.
 *
 * The distinction the review screen turns on. "The reader ran and found nothing
 * on this card" differs from "nothing can read text", and a single boolean cannot
 * carry the difference.
 */
function nameStatus(cardName: string | null | undefined): NameReadStatus {
  if (cardName) return "ok";
  if (hypervergeConfigured() || ocrSpaceConfigured()) return "ran_but_read_nothing";
  return "no_reader_configured";
}

/**
 * Run the required OCR.space provider and all configured supplemental checks.
 *
 * A failed OCR.space call contributes an `unknown` signal so the route can refuse
 * the upload explicitly. Supplemental document-shape checks still run.
 */
export async function runIdVerification(
  input: IdVerificationInput
): Promise<IdVerificationResult> {
  if (!ocrSpaceConfigured()) {
    throw new IdProviderError(
      "ocr_space",
      "OCR.space is required for ID verification, but its API key is not configured."
    );
  }

  const chosen = [...activeProviders(), makeLocalProvider()];

  const signals: IdSignal[] = [];
  const fields: IdExtractedFields = {};
  const providersRun: string[] = [];
  let detectedDocType: IdVerificationResult["detectedDocType"] = null;
  let primary = "local";

  for (const provider of chosen) {
    try {
      const result = await provider.verify(input);

      signals.push(
        ...result.signals.filter(
          (signal) => idTypeHasExpiry(input.docType) || !signal.id.endsWith("date_of_expiry")
        )
      );
      mergeFields(fields, result.fields, idTypeHasExpiry(input.docType));
      if (result.detectedDocType) detectedDocType = result.detectedDocType;

      providersRun.push(provider.id);
      // The first provider that actually read something is the one whose answer
      // is worth recording as the source of the fields.
      if (primary === "local" && Object.values(result.fields).some(Boolean)) {
        primary = provider.id;
      }
    } catch (e) {
      signals.push({
        id: `provider_${provider.id}`,
        label: `${provider.label} could not run`,
        tone: "unknown",
        detail:
          e instanceof IdProviderError || e instanceof Error
            ? `${e.message} The remaining checks still apply.`
            : "The provider failed for an unknown reason. The remaining checks still apply.",
      });
      // Still recorded as having been attempted, so an admin reading the log can
      // tell "never ran" from "ran and failed".
      providersRun.push(`${provider.id} (failed)`);
    }
  }

  /*
   * Last, because it needs the name from whichever provider read one.
   *
   * `nameStatus` is what keeps three different situations from being reported in
   * the same words: nothing configured that can read text, a reader that is
   * configured but has not downloaded its language model, and a reader that ran
   * and found nothing on this card. The middle one used to be invisible, and it is
   * the one a café hits on its first offline run.
   */
  const cardName = fields.full_name;
  const expectedName = input.expectedName;

  const verdict = nameSignal(
    cardName,
    expectedName,
    nameStatus(cardName)
  );

  // The review form shows extracted values, so per-provider field-status rows
  // would repeat the same information for each OCR engine. Keep one name verdict.
  for (let i = signals.length - 1; i >= 0; i--) {
    if (
      /^ocr(?:_space)?_(?:full_name|id_number|date_of_birth|date_of_expiry)$/.test(
        signals[i].id
      )
    ) {
      signals.splice(i, 1);
    }
  }

  signals.push(verdict);

  return {
    provider: providersRun.filter((p) => !p.includes("(")).join("+") || primary,
    // Worst first, so the thing that needs a decision is at the top of the list.
    // Ties keep their original order, which is the reading order the providers
    // emitted them in.
    signals: [...signals].sort(
      (a, b) => toneRank(b.tone) - toneRank(a.tone) || 0
    ),
    fields,
    detectedDocType,
  };
}

/** fail before warn before unknown before pass, so the worst news is seen first. */
function toneRank(tone: IdSignalTone): number {
  switch (tone) {
    case "fail":
      return 3;
    case "warn":
      return 2;
    case "unknown":
      return 1;
    default:
      return 0;
  }
}

/** First non-empty value wins; a later provider never overwrites an earlier one. */
function mergeFields(
  target: IdExtractedFields,
  incoming: IdExtractedFields,
  expiryApplicable: boolean
): void {
  const sink = target as Record<string, unknown>;

  for (const [key, value] of Object.entries(incoming)) {
    if (key === "date_of_expiry" && !expiryApplicable) continue;
    if (value === null || value === undefined || value === "") continue;

    const existing = sink[key];
    if (existing === null || existing === undefined || existing === "") {
      sink[key] = value;
    }
  }
}

/**
 * A short summary for the audit trail and the roster list.
 *
 * Deliberately contains no ID number, no name read off the document, and no
 * similarity figure. `audit_log` is append-only and hash-chained, so anything
 * written to it can never be removed — a national ID number written there would
 * be there permanently and would outlive the account.
 */
export function summariseForAudit(result: IdVerificationResult): Record<string, unknown> {
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const s of result.signals) counts[s.tone]++;

  return {
    providers: result.provider,
    signal_count: result.signals.length,
    signals_passed: counts.pass,
    signals_warning: counts.warn,
    signals_failed: counts.fail,
    signals_unknown: counts.unknown,
  };
}
