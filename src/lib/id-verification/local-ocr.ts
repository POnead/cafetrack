/**
 * Reading the text off an ID on this machine, for free.
 *
 * This is the replacement for a paid vendor, and the reason it exists is stated
 * plainly in ./ocr/templates.ts: nobody has published template models for PhilSys,
 * LTO, UMID or PhilHealth, which is the entire reason CafeTrack talked about
 * HyperVerge. What it *can* replace is the $0.42 OCR call, because Tesseract reads
 * printed English and these cards are printed in English.
 *
 * ## What it does not replace
 *
 * Forgery detection. There is no honest free equivalent — see the note in
 * ./ocr/templates.ts — so this provider makes no attempt at one and says so on
 * the review screen. A signal that cries wolf on ordinary phone photographs is
 * worse than no signal, and the whole design of this module is built around not
 * being that.
 *
 * The Face++ portrait comparison is handled separately by the upload route.
 *
 * ## Provenance is the contract
 *
 * Names and dates require an anchored read. A shape-checked ID-number guess may
 * also be passed as an editable suggestion; it is never used for identity or
 * duplicate decisions without passing the selected type's number-format check.
 */

import {
  IdProviderError,
  ID_DOC_TYPE_LABELS,
  type IdExtractedFields,
  type IdSignal,
  type IdVerificationInput,
  type IdVerificationProvider,
  type IdVerificationResult,
} from "./types";
import { buildLayout } from "./ocr/rows";
import { extract, isTrustworthy, type Extraction } from "./ocr/extract";
import { MIN_OCR_WIDTH, languageModelPresent, runOcr } from "./ocr/engine";
import { readImageSize } from "./image-size";
import { detectCardType } from "./ocr/card-type";
import { idTypeHasExpiry } from "./specification";

/** Where the reading came from, in the words an admin needs. */
const STRATEGY_WORDS: Record<string, string> = {
  mrz: "read from the machine-readable zone, whose check digits verified",
  label: "read from beside its printed label",
  heuristic: "matched on shape, with no label to confirm it",
};

const FIELD_LABELS: Record<keyof Extraction, string> = {
  full_name: "Name on the card",
  id_number: "ID number",
  date_of_birth: "Date of birth",
  date_of_expiry: "Date of expiry",
};

/**
 * Turn one extraction into a signal.
 *
 * Three tones, and the middle one is the point. An anchored read is a `pass` and
 * says what it matched. A shape match is a `warn` — it is shown, quoted, and
 * explicitly not acted on. Nothing at all is `unknown`, and it names the card type
 * so an admin can tell "this card has no name on it" from "I have no template for
 * this card", which are very different problems with very different fixes.
 */
function signalFor(field: keyof Extraction, value: Extraction[keyof Extraction]): IdSignal {
  const label = FIELD_LABELS[field];

  if (value.strategy === "none" || value.value === null) {
    return { id: `ocr_${field}`, label, tone: "unknown", detail: "Nothing was read." };
  }

  if (!isTrustworthy(value)) {
    return {
      id: `ocr_${field}`,
      label,
      tone: "warn",
      detail:
        `Something that looks like ${/^[aeiou]/i.test(label) ? "an" : "a"} ` +
        `${label.toLowerCase()} was found — "${value.value}" — ` +
        `but it ${STRATEGY_WORDS.heuristic}, so it has not been checked against anything. ` +
        `Look at the card yourself.`,
    };
  }

  return {
    id: `ocr_${field}`,
    label,
    tone: "pass",
    detail: `${value.value} — ${STRATEGY_WORDS[value.strategy]}.`,
  };
}

export const localOcrProvider: IdVerificationProvider = {
  id: "local_ocr",
  label: "On-device text reading (no external service)",

  /*
   * Whether the model is on disk, not whether the setting is on.
   *
   * These are different questions and answering the wrong one produces a lie on
   * the review screen. A café whose first run happened without internet has the
   * reader switched on and no language file; reporting it as configured would tell
   * the name check that a reader ran, and it would then say "no name was read off
   * the card" — blaming the card for a missing download.
   */
  available: () => languageModelPresent(),

  async verify(input: IdVerificationInput): Promise<IdVerificationResult> {
    if (typeof window !== "undefined") {
      throw new IdProviderError(
        "local_ocr",
        "The text reader runs on the server and was reached from the browser."
      );
    }

    /*
     * Refuse a thumbnail before reaching the engine, rather than after.
     *
     * This is not an optimisation. Tesseract given a 1x1 pixel does not return an
     * error — it does not return at all, and because the engine has no cancel of
     * its own the request hangs until the client times out. Which is precisely what
     * happened: the HTTP suite uploads a single pixel, and the whole run stalled
     * for five minutes on a file with no text in it to read.
     *
     * The local shape check reports the same image as implausible anyway; this
     * only makes sure the text reader does not sit on it while that happens.
     */
    const size = readImageSize(input.front.type, input.front.bytes);
    if (!size || size.width < MIN_OCR_WIDTH) {
      throw new IdProviderError(
        "local_ocr",
        size
          ? `The image is ${size.width}px wide, which is too small to read text from. ` +
            `Photograph the card closer, or fill more of the frame.`
          : "The image's dimensions could not be read, so no text was read from it.",
        {}
      );
    }

    let run;
    try {
      run = await runOcr(input.front.bytes);
    } catch (cause) {
      // The orchestrator turns this into an `unknown` signal and carries on with
      // the local checks, which is the correct outcome: a text reader that will not
      // start must not stop the portrait comparison.
      throw new IdProviderError(
        "local_ocr",
        `The on-device text reader could not run${
          languageModelPresent() ? "." : " — its language file is not downloaded."
        } The face and card checks still apply.`,
        { cause }
      );
    }

    const layout = buildLayout(run.words);
    const { fields, mrz } = extract(layout, input.docType);
    const detected = detectCardType(layout.text || run.text);

    const applicableFields = Object.entries(fields).filter(
      ([key]) => key !== "date_of_expiry" || idTypeHasExpiry(input.docType)
    );
    const signals: IdSignal[] = applicableFields.map(([key, value]) =>
      signalFor(key as keyof Extraction, value)
    );

    /*
     * One summary signal, because four per-field signals reading "nothing was
     * read" is noise that buries the useful row. It is the one that tells an admin
     * which template failed, which is the thing they could actually act on.
     */
    const read = applicableFields.filter(([key, value]) => {
      if (isTrustworthy(value)) return true;
      return (
        key === "id_number" &&
        value.strategy === "heuristic" &&
        value.value !== null
      );
    });

    const total = applicableFields.length;
    const missing = total - read.length;

    /*
     * Tone follows the count, not merely whether anything was found.
     *
     * Any count above zero used to be green, so a card where one field of four was
     * read — and that one field turned out to be a single stray glyph — was headed
     * "1 of 4 fields read" in a pass-coloured row. Green next to a mostly-failed
     * read is the whole problem this module exists to avoid.
     */
    signals.push(
      read.length === 0
        ? {
            id: "ocr_summary",
            label: "Text on the ID",
            tone: "unknown",
            detail:
              `No text could be read off this ${ID_DOC_TYPE_LABELS[input.docType]} ` +
              `(${Math.round(run.confidence)}% overall confidence). Either the photo is too ` +
              `blurry, or this ${ID_DOC_TYPE_LABELS[input.docType]} layout is not supported by ` +
              `the current template. Capture the front square-on with both edges visible, avoid ` +
              `glare, and compare the card with the roster by eye.`,
          }
        : missing === 0
          ? {
              id: "ocr_summary",
              label: "Text on the ID",
              tone: "pass",
              detail:
                `All ${total} fields read from this ${ID_DOC_TYPE_LABELS[input.docType]}` +
                `${mrz ? ", including the machine-readable zone" : ""}. ` +
                `This text read stayed on this machine. Other configured checks may send images to their providers.`,
            }
          : {
              id: "ocr_summary",
              label: "Text on the ID",
              tone: "warn",
              detail:
                `${read.length} of ${total} fields read from this ` +
                `${ID_DOC_TYPE_LABELS[input.docType]}` +
                `${mrz ? ", including the machine-readable zone" : ""}. ` +
                `The rest were not found on the card, or could not be read from it. ` +
                `Look at the card yourself for anything shown as unchecked. ` +
                `This text read stayed on this machine. Other configured checks may send images to their providers.`,
            }
    );

    /*
     * Only anchored reads leave this function.
     *
     * The heuristic ones are reported above and deliberately withheld from
     * `fields`, which is what stops a guessed name becoming a failed name check.
     */
    const out: IdExtractedFields = {};
    for (const [key, value] of Object.entries(fields) as [keyof Extraction, Extraction[keyof Extraction]][]) {
      const numberSuggestion =
        key === "id_number" &&
        value.strategy === "heuristic" &&
        value.value !== null;
      if (
        (isTrustworthy(value) || numberSuggestion) &&
        value.value !== null &&
        (key !== "date_of_expiry" || idTypeHasExpiry(input.docType))
      ) {
        out[key] = value.value;
      }
    }

    return {
      provider: "local_ocr",
      signals,
      fields: out,
      detectedDocType: detected.confidence === "high" ? detected.type : null,
    };
  },
};
