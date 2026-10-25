/**
 * Choosing and running the ID check.
 *
 * This is the only module the routes talk to. It picks which providers to run,
 * survives any of them failing, merges what they read off the document, and adds
 * the one check that is not provider-specific: comparing the name on the card
 * against the name on the account.
 *
 * ## The provider order
 *
 * The external provider runs first when it is configured, and the local checks
 * run alongside it — not instead of it. Three reasons:
 *
 *   - The local face comparison and the vendor's face comparison disagree often
 *     enough that one of them being available is worth having, and an admin
 *     seeing two independent readings can tell a genuine borderline from a
 *     threshold that happened to land badly.
 *   - They fail independently. The vendor can time out, rate-limit, or have no
 *     Philippine template and still leave a usable comparison behind.
 *   - It costs nothing to run both, and the local one has no dependency to be
 *     missing.
 *
 * `local` always runs. That is what makes the feature work on a café machine
 * with no HyperVerge account, no Docker and no network.
 */

import { hypervergeConfigured, hypervergeProvider } from "./hyperverge";
import { localOcrProvider } from "./local-ocr";
import { DEFAULT_ID_MATCH_THRESHOLD, makeLocalProvider } from "./local";
import { getSetting } from "../settings";
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

export * from "./types";
export { readImageSize } from "./image-size";
export {
  DEFAULT_ID_MATCH_THRESHOLD,
  ID_MATCH_REJECT,
  MAX_ID_MATCH_THRESHOLD,
  MIN_ID_MATCH_THRESHOLD,
} from "./local";
export { localOcrProvider } from "./local-ocr";
export type { NameReadStatus } from "./name-signal";

/**
 * Whether the admin has switched the on-device reader off.
 *
 * Default on. The reader is free, runs on this machine, and sends nothing
 * anywhere — but its templates are hand-written rather than trained (see
 * ./ocr/templates.ts), so a café whose cards it reads badly needs a way to turn it
 * off without removing the whole feature.
 *
 * Read once per verification rather than per provider, so the two providers in a
 * run can never disagree about whether it is enabled.
 */
async function localOcrEnabled(): Promise<boolean> {
  try {
    const raw = ((await getSetting("local_ocr_enabled")) ?? "").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "no";
  } catch {
    // A settings table that cannot be read is not a reason to skip a free check
    // that runs locally. Default on.
    return true;
  }
}

/** Which providers will run, given what is configured. */
export function activeProviders(): { providers: IdVerificationProvider[]; ocrEnabled: boolean } {
  const providers: IdVerificationProvider[] = [];

  // External first, so that if it fails outright the local checks are what is
  // left rather than the other way round.
  if (hypervergeConfigured()) providers.push(hypervergeProvider);

  // Included only when its language model is actually on disk. See
  // `localOcrProvider.available` for why that is not the same question as whether
  // the admin has switched it on.
  const ocrEnabled = localOcrProvider.available();
  if (ocrEnabled) providers.push(localOcrProvider);

  return { providers, ocrEnabled };
}

/**
 * A one-line description of what will actually run, for the admin to see before
 * uploading.
 *
 * Async because it consults the setting, which is in the database. Reporting a
 * provider the admin has switched off would be worse than reporting nothing: the
 * upload form says this list is what is about to happen, and then something else
 * happens.
 */
export async function providerSummary(): Promise<{ id: string; label: string }[]> {
  const ocrEnabled = await localOcrEnabled();
  const { providers, ocrEnabled: ocrPresent } = activeProviders();

  return providers
    .filter((p) => p.id !== "local_ocr" || (ocrEnabled && ocrPresent))
    .map((p) => ({ id: p.id, label: p.label }))
    .concat([{ id: "local", label: "Local checks (no external service)" }]);
}

/**
 * Why the name on the card is or is not available.
 *
 * The distinction the review screen turns on. "Nothing in this app can read text"
 * and "the reader ran and found nothing on this card" are both `unknown` by tone,
 * but they call for opposite responses from the person reading them, and a single
 * boolean cannot carry the difference.
 */
function nameStatus(cardName: string | null | undefined, ocrEnabled: boolean): NameReadStatus {
  if (cardName) return "ok";
  if (hypervergeConfigured()) return "ran_but_read_nothing";

  // The reader is wanted but its model is not downloaded — a first run with no
  // internet, which on a café machine is an ordinary Tuesday rather than a fault.
  if (ocrEnabled) return localOcrProvider.available() ? "ran_but_read_nothing" : "model_missing";

  return "no_reader_configured";
}

export type RunOptions = {
  /** From settings.id_face_match_threshold. */
  faceMatchThreshold?: number;
  /** From settings.id_provider. Empty means "whatever is configured". */
  preferredProvider?: string | null;
};

/**
 * Run every available provider and merge the answers.
 *
 * Never throws for a provider problem. A provider that fails contributes an
 * `unknown` signal saying so and the rest of the run carries on — a café owner
 * whose vendor is down should still get the portrait comparison and a review
 * screen, not an error.
 */
export async function runIdVerification(
  input: IdVerificationInput,
  options: RunOptions = {}
): Promise<IdVerificationResult> {
  const threshold = Number.isFinite(options.faceMatchThreshold)
    ? (options.faceMatchThreshold as number)
    : DEFAULT_ID_MATCH_THRESHOLD;

  // Read once, so the selection below and the name signal below cannot disagree.
  const ocrEnabled = await localOcrEnabled();

  // The local provider is always present, whether or not a vendor is configured.
  // It is built here rather than inside chooseProviders so the threshold resolved
  // above is the one it actually uses.
  const chosen = chooseProviders(options.preferredProvider, threshold, ocrEnabled);

  const signals: IdSignal[] = [];
  const fields: IdExtractedFields = {};
  const providersRun: string[] = [];
  let primary = "local";

  for (const provider of chosen) {
    try {
      const result = await provider.verify(input);

      signals.push(...result.signals);
      mergeFields(fields, result.fields);

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
    nameStatus(cardName, ocrEnabled)
  );

  /*
   * One name, one outcome.
   *
   * The OCR provider also emits a per-field signal for the name, reading
   * "Name on the card: <value> — read from beside its printed label". That is a
   * statement about *how the text was read*; `nameSignal` is the statement about
   * whether it matches this account. Keeping both produced two rows about one
   * value with opposite verdicts and near-identical labels — a pass-coloured
   * "Name on the card: A" directly above a failing "Name on the ID" — and an
   * admin scanning for problems has no way to know the green one is about
   * confidence rather than correctness.
   *
   * So when there is a name to compare against, `nameSignal` is the verdict and
   * the per-field one is dropped. It still stands alone when there is no account
   * name to compare, which is the only situation where "how it was read" is the
   * whole of what there is to say.
   *
   * The read strategy is not lost: it travels in the verdict's evidence, and the
   * signals are ordered by tone below, so the failing row cannot be scrolled past
   * behind a passing one.
   */
  const comparable = Boolean(cardName && cardName.trim() && expectedName && expectedName.trim());
  if (comparable) {
    // Strip the provider's per-field name signal; the verdict replaces it.
    for (let i = signals.length - 1; i >= 0; i--) {
      if (signals[i].id === "ocr_full_name") signals.splice(i, 1);
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

function chooseProviders(
  preferred: string | null | undefined,
  threshold: number,
  ocrEnabled: boolean
): IdVerificationProvider[] {
  const local = makeLocalProvider(threshold);
  const { providers, ocrEnabled: ocrPresent } = activeProviders();

  // Two gates, and both have to pass: the admin wants the reader on, and its
  // language model has to be on disk for it to do anything.
  const external = providers.filter(
    (p) => p.id !== "local_ocr" || (ocrEnabled && ocrPresent)
  );

  const wanted = (preferred ?? "").trim().toLowerCase();

  if (!wanted || wanted === "auto") {
    // `local` always runs; external providers run too, and in front of it.
    return [...external, local];
  }

  if (wanted === "local") return [local];

  const named = external.filter((p) => p.id === wanted);
  if (named.length > 0) return [...named, local];

  // A setting naming a provider that is not configured must not take the feature
  // down. Falling back to the automatic choice keeps the review screen working,
  // which matters more than honouring the preference exactly.
  return [...external, local];
}

/** First non-empty value wins; a later provider never overwrites an earlier one. */
function mergeFields(target: IdExtractedFields, incoming: IdExtractedFields): void {
  const sink = target as Record<string, unknown>;

  for (const [key, value] of Object.entries(incoming)) {
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
