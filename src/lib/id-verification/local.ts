/**
 * The ID check that runs on the café's own machine, with nothing external.
 *
 * This is the default provider and the floor the feature never drops below. It
 * needs no API key, no network, no Docker and no ML server, which matters
 * because CafeTrack runs on the register in the back room and every alternative
 * provider assumes a server with room to spare.
 *
 * ## What it can honestly do
 *
 *   - Compare the portrait printed on the card against a photo of the person.
 *     This is the one strong check, and it works because lib/face-sface computes
 *     both descriptors in the browser with SFace — the engine the thresholds in
 *     this file are calibrated to.
 *   - Look at the shape of the uploads and say whether they are plausibly cards.
 *
 * ## What it cannot do, and will not pretend to
 *
 * It cannot tell whether a Philippine driver's licence is genuine. There is no
 * MRZ on a PhilSys card or an LTO licence, no PDF417 barcode, and no open
 * template library for either to be checked against. This module reads no text at
 * all; the on-device OCR provider (./local-ocr.ts) is separate and runs alongside
 * it, filling the name field where it can. "This is a real licence" and "the card
 * belongs to this person" both stay human judgements made by an admin looking at
 * the two images.
 *
 * That is why this module returns signals and never a verdict — see ./types.ts.
 *
 * The name comparison lives in ./index.ts rather than here, because it is a
 * cross-provider concern: only a provider that does OCR has anything to compare,
 * and duplicating the rule in every provider is how two providers end up
 * disagreeing about whether the card matches the account.
 */

import { cosineDistance } from "../face";
import { readImageSize } from "./image-size";
import {
  IdProviderError,
  type IdSignal,
  type IdVerificationInput,
  type IdVerificationProvider,
  type IdVerificationResult,
} from "./types";

/**
 * At or below this cosine distance the two portraits read as the same person.
 *
 * **This number is not measured on printed portraits, and that is a real caveat.**
 *
 * `face.ts` can justify SFace's sign-in threshold with measurements taken on this
 * app: same-person re-captures landed between 0.019 and 0.119, front-versus-side
 * between 0.253 and 0.473, and different people between 0.559 and 0.653. Those are
 * live photographs of one person taken in one room, which is a much easier
 * comparison than the one here.
 *
 * This is a different problem. One image is a *printed portrait* — flat-lit, low
 * resolution, sometimes years old, sometimes creased — and the other is a live
 * photo. Jumio's own engineering write-up names this as the hard case, and it is
 * why every vendor sells a separate and much looser threshold for "selfie versus
 * ID photo" than for "selfie versus selfie".
 *
 * So 0.55 is a reasoned starting point rather than a measured one. It sits just
 * below the closest measured stranger pair (0.559), which is what makes it
 * defensible at all: it leaves room for a printed/live pair while staying under
 * every different-person reading taken with this engine. It is editable
 * (settings.id_face_match_threshold) precisely so it can be corrected against
 * real cards once the café has some. Re-measure before changing it; do not tune it
 * downward to make the output look tidier, because the band in the middle is
 * doing real work.
 */
export const DEFAULT_ID_MATCH_THRESHOLD = 0.55;
export const MIN_ID_MATCH_THRESHOLD = 0.1;
export const MAX_ID_MATCH_THRESHOLD = 0.95;

/**
 * At or above this, the two portraits are almost certainly different people.
 *
 * The measured different-person range for SFace is 0.559-0.653, so this sits
 * above every one of those readings and fires only on an obvious mismatch (the
 * wrong person's card, or a photo that is not the same face at all). Everything
 * between the match threshold and this line is reported as inconclusive, because
 * a printed portrait and a live photo of the same person can genuinely land there
 * and the honest outcome is "ask a human".
 */
export const ID_MATCH_REJECT = 0.85;

/**
 * A photograph of a person, rather than of a card.
 *
 * A face photo is not ID-shaped and was never going to be. It was being measured
 * against the card band and described in the card's words, which produced the
 * signal "Photo of the person: 1280x720px, a shape of 1.78:1 — consistent with an
 * ID card" — a 16:9 frame certified as a 1.59:1 document.
 *
 * The check still earns its place, but for a narrower purpose: catching a wrong
 * file entirely, such as a photograph of a receipt submitted into the photo slot.
 * It says the file is shaped like a portrait. It does not say anything about who
 * the person is, and the wording says so, because a green tick beside somebody's
 * photograph reads as far more than it means.
 */
const PORTRAIT_ASPECT_MIN = 0.6;
const PORTRAIT_ASPECT_MAX = 1.9;

function portraitSignal(id: string, label: string, type: string, bytes: Uint8Array): IdSignal {
  const size = readImageSize(type, bytes);

  if (!size) {
    return {
      id,
      label,
      tone: "unknown",
      detail: "The file's dimensions could not be read, so its shape was not checked.",
    };
  }

  const ratio = size.width / size.height;
  const ratioText = ratio.toFixed(2);

  if (ratio < PORTRAIT_ASPECT_MIN || ratio > PORTRAIT_ASPECT_MAX) {
    return {
      id,
      label,
      tone: "warn",
      detail:
        `${size.width}x${size.height}px, a shape of ${ratioText}:1, which is unusually wide or ` +
        "tall for a photograph of a person. Check this is their photo and not something else.",
    };
  }

  return {
    id,
    label,
    tone: "pass",
    detail:
      `${size.width}x${size.height}px, a shape of ${ratioText}:1 — a plausible shape for a ` +
      "photograph of a person. That says the file is a portrait, not that the person is who " +
      "they say they are.",
  };
}

/**
 * An ID-1 card is 85.6 x 54mm, a ratio of 1.585. Philippine government IDs
 * (PhilSys, LTO) are ID-1, and so is a passport's data page.
 *
 * The accepted band is wide on purpose: the file will have been re-photographed
 * at an angle or cropped, either of which moves the ratio a long way, and a tight
 * band would fire on almost every usable phone photo of a card.
 */
const CARD_ASPECT_MIN = 1.05;
const CARD_ASPECT_MAX = 2.6;

function aspectSignal(id: string, label: string, type: string, bytes: Uint8Array): IdSignal {
  const size = readImageSize(type, bytes);

  if (!size) {
    return {
      id,
      label,
      tone: "unknown",
      detail: "The file's dimensions could not be read, so its shape was not checked.",
    };
  }

  const ratio = size.width / size.height;
  const ratioText = ratio.toFixed(2);

  if (ratio < CARD_ASPECT_MIN || ratio > CARD_ASPECT_MAX) {
    return {
      id,
      label,
      tone: "warn",
      detail:
        `${size.width}x${size.height}px, a shape of ${ratioText}:1. An ID card is about ` +
        "1.59:1 — check this is the card itself and not a photo of something else.",
    };
  }

  return {
    id,
    label,
    tone: "pass",
    detail: `${size.width}x${size.height}px, a shape of ${ratioText}:1 — consistent with an ID card.`,
  };
}

/**
 * Compare the portrait printed on the card with the photo of the person.
 *
 * Three outcomes rather than two, and the middle one is the point. A distance in
 * the band above the threshold is reported as `warn`, not folded into pass or
 * fail: given the caveat on DEFAULT_ID_MATCH_THRESHOLD, a reading just over the
 * line is genuinely not evidence either way, and presenting it as a failure
 * would be the model asserting a certainty it does not have.
 *
 * `adminOnly` is set on every branch, including the passing ones. There is no
 * reason for an applicant to learn how close a comparison came — the same rule
 * governs the duty face check (see the note on cosineDistance in lib/face.ts).
 */
function faceSignal(
  cardEmbedding: Float32Array | null | undefined,
  photoEmbedding: Float32Array | null | undefined,
  hasPhoto: boolean,
  threshold: number
): IdSignal {
  const label = "Portrait matches photo";

  if (!hasPhoto) {
    return {
      id: "face_match",
      label,
      adminOnly: true,
      tone: "unknown",
      detail:
        "No photo of the person was attached, so the portrait on the card was not compared with anything.",
    };
  }

  if (!cardEmbedding) {
    return {
      id: "face_match",
      label,
      adminOnly: true,
      tone: "unknown",
      detail:
        "No face could be read from the card image, so the portrait was not compared. " +
        "The printed photo may be too small or too blurred for the model to register.",
    };
  }

  if (!photoEmbedding) {
    return {
      id: "face_match",
      label,
      adminOnly: true,
      tone: "unknown",
      detail: "No face could be read from the photo of the person, so nothing was compared.",
    };
  }

  let distance: number;
  try {
    distance = cosineDistance(cardEmbedding, photoEmbedding);
  } catch {
    return {
      id: "face_match",
      label,
      adminOnly: true,
      tone: "unknown",
      detail: "The two portraits could not be compared — the comparison produced no usable value.",
    };
  }

  if (Number.isNaN(distance)) {
    return {
      id: "face_match",
      label,
      adminOnly: true,
      tone: "unknown",
      detail: "The two portraits could not be compared — the comparison produced no usable value.",
    };
  }

  const rounded = distance.toFixed(3);
  const base = { id: "face_match", label, adminOnly: true };

  if (distance <= threshold) {
    return {
      ...base,
      tone: "pass",
      detail:
        `The portrait on the card and the photo of the person read as the same face ` +
        `(distance ${rounded}, at or under the ${threshold} threshold).`,
    };
  }

  if (distance >= ID_MATCH_REJECT) {
    return {
      ...base,
      tone: "fail",
      detail:
        `These read as two different people (distance ${rounded}, at or over the ` +
        `${ID_MATCH_REJECT} reject threshold). Look at both images before deciding.`,
    };
  }

  return {
    ...base,
    tone: "warn",
    detail:
      `Inconclusive (distance ${rounded}, between the ${threshold} match threshold and the ` +
      `${ID_MATCH_REJECT} reject threshold). A printed portrait and a live photo of the same ` +
      "person can land here — judge it by eye.",
  };
}

/**
 * Build the provider for one verification, with the threshold already resolved.
 *
 * A factory rather than a singleton taking a setter, because the threshold comes
 * from the settings table and two verifications running at once must not share
 * mutable module state to get it. The object is a few closures and nothing is
 * expensive to make per request.
 */
export function makeLocalProvider(threshold: number): IdVerificationProvider {
  const effective =
    Number.isFinite(threshold) &&
    threshold >= MIN_ID_MATCH_THRESHOLD &&
    threshold <= MAX_ID_MATCH_THRESHOLD
      ? threshold
      : DEFAULT_ID_MATCH_THRESHOLD;

  return {
    id: "local",
    label: "Local checks (no external service)",

    // Always. There is nothing to configure and nothing that can be down.
    available: () => true,

    async verify(input: IdVerificationInput): Promise<IdVerificationResult> {
      try {
        const signals: IdSignal[] = [
          faceSignal(input.cardEmbedding, input.photoEmbedding, Boolean(input.photo), effective),
          aspectSignal("front_shape", "Front of the ID", input.front.type, input.front.bytes),
        ];

        if (input.back) {
          signals.push(
            aspectSignal("back_shape", "Back of the ID", input.back.type, input.back.bytes)
          );
        }

        if (input.photo) {
          signals.push(
            portraitSignal("photo_shape", "Photo of the person", input.photo.type, input.photo.bytes)
          );
        }

        // No `fields`: this provider reads no text off the card. The orchestrator
        // fills that gap from any other provider that ran.
        return { provider: "local", signals, fields: {} };
      } catch (e) {
        throw new IdProviderError(
          "local",
          "The local checks could not be completed.",
          { cause: e }
        );
      }
    },
  };
}
