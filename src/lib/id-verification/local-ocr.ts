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
 * The portrait comparison in local.ts already runs alongside this and is
 * unaffected.
 *
 * ## Provenance is the contract
 *
 * Every field this provider returns carries how it was found, and only an anchored
 * read — a verified MRZ, or a value sitting beside its printed label — is passed
 * on to the orchestrator. A shape-based guess is reported on screen and kept out of
 * `fields`, so it can never become a red "different person" against a correct
 * upload. See `isTrustworthy` in ./ocr/extract.ts for why that matters.
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

    const signals: IdSignal[] = Object.entries(fields).map(([key, value]) =>
      signalFor(key as keyof Extraction, value)
    );

    /*
     * One summary signal, because four per-field signals reading "nothing was
     * read" is noise that buries the useful row. It is the one that tells an admin
     * which template failed, which is the thing they could actually act on.
     */
    const read = Object.values(fields).filter((f) => isTrustworthy(f));

    const total = Object.keys(fields).length;
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
              `blurry, or this app has no template for this card type — in which case ` +
              `compare the card with the roster by eye.`,
          }
        : missing === 0
          ? {
              id: "ocr_summary",
              label: "Text on the ID",
              tone: "pass",
              detail:
                `All ${total} fields read from this ${ID_DOC_TYPE_LABELS[input.docType]}` +
                `${mrz ? ", including the machine-readable zone" : ""}. ` +
                `Everything stayed on this machine — nothing was sent anywhere.`,
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
                `Everything stayed on this machine — nothing was sent anywhere.`,
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
      if (isTrustworthy(value) && value.value !== null) {
        out[key] = value.value;
      }
    }

    return { provider: "local_ocr", signals, fields: out };
  },
};
