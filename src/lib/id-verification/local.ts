/**
 * The non-face ID checks that run on the café's own machine.
 *
 * This supplemental provider always checks document shape. It needs no API key,
 * no network, no Docker and no ML server, which matters
 * because CafeTrack runs on the register in the back room and every alternative
 * provider assumes a server with room to spare.
 *
 * ## What it can honestly do
 *
 * Look at the shape of the uploads and say whether they are plausibly cards.
 *
 * ## What it cannot do, and will not pretend to
 *
 * It cannot tell whether a Philippine driver's licence is genuine. There is no
 * MRZ on a PhilSys card or an LTO licence, no PDF417 barcode, and no open
 * template library for either to be checked against. This module reads no text at
 * all; on-device OCR is used by ID-card sign-in, not staff ID verification.
 * "This is a real licence" and "the card
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

import { readImageSize } from "./image-size";
import {
  IdProviderError,
  type IdSignal,
  type IdVerificationInput,
  type IdVerificationProvider,
  type IdVerificationResult,
} from "./types";

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
 * Build the on-device document-shape provider.
 */
export function makeLocalProvider(): IdVerificationProvider {
  return {
    id: "local",
    label: "Local checks (no external service)",

    // Always. There is nothing to configure and nothing that can be down.
    available: () => true,

    async verify(input: IdVerificationInput): Promise<IdVerificationResult> {
      try {
        const signals: IdSignal[] = [
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
