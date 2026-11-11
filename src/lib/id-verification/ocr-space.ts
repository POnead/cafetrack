import {
  IdProviderError,
  ID_DOC_TYPE_LABELS,
  type IdExtractedFields,
  type IdSignal,
  type IdVerificationInput,
  type IdVerificationProvider,
  type IdVerificationResult,
} from "./types";
import { buildLayout, type OcrWord } from "./ocr/rows";
import { extract, isTrustworthy, type Extraction } from "./ocr/extract";
import { detectCardType } from "./ocr/card-type";
import { readImageSize } from "./image-size";
import { idTypeHasExpiry } from "./specification";

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
const REQUEST_TIMEOUT_MS = 25_000;

function apiKey(): string {
  return (process.env.OCR_SPACE_API_KEY ?? "").trim();
}

export function ocrSpaceConfigured(): boolean {
  return apiKey().length > 0;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ocrWords(value: unknown): OcrWord[] {
  if (!Array.isArray(value)) return [];

  const words: OcrWord[] = [];
  for (const line of value) {
    if (!isRecord(line) || !Array.isArray(line.Words)) continue;

    for (const rawWord of line.Words) {
      if (!isRecord(rawWord)) continue;
      const text = asText(rawWord.WordText);
      const left = asFiniteNumber(rawWord.Left);
      const top = asFiniteNumber(rawWord.Top);
      const width = asFiniteNumber(rawWord.Width);
      const height = asFiniteNumber(rawWord.Height);
      if (!text || left === null || top === null || width === null || height === null) continue;
      if (width <= 0 || height <= 0) continue;

      const confidence =
        asFiniteNumber(rawWord.WordConfidence) ??
        asFiniteNumber(rawWord.Confidence) ??
        0;

      words.push({
        text,
        confidence,
        x0: left,
        y0: top,
        x1: left + width,
        y1: top + height,
      });
    }
  }

  return words;
}

type ParsedOcrResponse = {
  text: string;
  words: OcrWord[];
};

/** Extract only the OCR text and word boxes; never retain the vendor response. */
export function parseOcrSpaceResponse(payload: unknown): ParsedOcrResponse {
  if (!isRecord(payload)) {
    throw new IdProviderError("ocr_space", "OCR.space returned an invalid response.");
  }

  if (payload.IsErroredOnProcessing === true) {
    throw new IdProviderError("ocr_space", "OCR.space could not read this image.");
  }

  const results = payload.ParsedResults;
  const parsed = Array.isArray(results) && isRecord(results[0]) ? results[0] : null;
  if (!parsed) {
    throw new IdProviderError("ocr_space", "OCR.space returned no result for this image.");
  }

  const overlay = isRecord(parsed.TextOverlay) ? parsed.TextOverlay : null;
  const lines = overlay && Array.isArray(overlay.Lines) ? overlay.Lines : [];
  const words = ocrWords(lines);
  const text = asText(parsed.ParsedText) ||
    lines
      .filter(isRecord)
      .map((line) => asText(line.LineText))
      .filter(Boolean)
      .join("\n");

  return { text, words };
}

const FIELD_LABELS: Record<keyof Extraction, string> = {
  full_name: "Name on the card",
  id_number: "ID number",
  date_of_birth: "Date of birth",
  date_of_expiry: "Date of expiry",
};

function fieldSignal(
  field: keyof Extraction,
  value: Extraction[keyof Extraction]
): IdSignal {
  if (value.value === null || value.strategy === "none") {
    return {
      id: `ocr_space_${field}`,
      label: FIELD_LABELS[field],
      tone: "unknown",
      detail: "OCR.space did not read this field.",
    };
  }

  if (!isTrustworthy(value)) {
    return {
      id: `ocr_space_${field}`,
      label: FIELD_LABELS[field],
      tone: "warn",
      detail:
        `OCR.space found "${value.value}", but could not tie it to a printed field label. ` +
        "It is kept as an unconfirmed suggestion; check it against the card.",
    };
  }

  return {
    id: `ocr_space_${field}`,
    label: FIELD_LABELS[field],
    tone: "pass",
    detail: `${value.value} — read beside its printed field label by OCR.space.`,
  };
}

export const ocrSpaceProvider: IdVerificationProvider = {
  id: "ocr_space",
  label: "OCR.space text reading",
  available: ocrSpaceConfigured,

  async verify(input: IdVerificationInput): Promise<IdVerificationResult> {
    const key = apiKey();
    if (!key) {
      throw new IdProviderError("ocr_space", "OCR.space is not configured on this server.");
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([input.front.bytes as unknown as BlobPart], { type: input.front.type }),
      `id-front.${input.front.type === "image/png" ? "png" : "jpg"}`
    );
    form.append("isOverlayRequired", "true");
    form.append("detectOrientation", "true");
    form.append("scale", "true");
    form.append("OCREngine", "2");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(OCR_SPACE_ENDPOINT, {
        method: "POST",
        headers: { apikey: key },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new IdProviderError(
          "ocr_space",
          `OCR.space did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`
        );
      }
      throw new IdProviderError("ocr_space", "Could not reach OCR.space.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new IdProviderError(
        "ocr_space",
        `OCR.space returned HTTP ${response.status}. Check the API key and service quota.`
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new IdProviderError("ocr_space", "OCR.space returned an invalid response.");
    }

    const parsed = parseOcrSpaceResponse(payload);
    const size = readImageSize(input.front.type, input.front.bytes);
    const layout = buildLayout(parsed.words, size ?? undefined);
    const { fields: extraction } = extract(layout, input.docType, parsed.text || layout.text);
    const fields: IdExtractedFields = {};

    for (const [key, value] of Object.entries(extraction) as [
      keyof Extraction,
      Extraction[keyof Extraction],
    ][]) {
      const numberSuggestion =
        key === "id_number" &&
        value.strategy === "heuristic" &&
        value.value !== null;
      if (
        (isTrustworthy(value) || numberSuggestion) &&
        value.value &&
        (key !== "date_of_expiry" || idTypeHasExpiry(input.docType))
      ) {
        fields[key] = value.value;
      }
    }

    const detected = detectCardType(parsed.text || layout.text);
    const signals: IdSignal[] = Object.entries(extraction)
      .filter(([key]) => key !== "date_of_expiry" || idTypeHasExpiry(input.docType))
      .map(([key, value]) => fieldSignal(key as keyof Extraction, value));

    if (detected.confidence === "high" && detected.type) {
      const matches = detected.type === input.docType;
      signals.push({
        id: "ocr_space_doc_type",
        label: "Selected ID type",
        tone: matches ? "pass" : "fail",
        detail: matches
          ? `OCR.space detected this as ${ID_DOC_TYPE_LABELS[detected.type]}, matching the selected type. This checks printed text only, not whether the ID is genuine.`
          : `OCR.space detected ${ID_DOC_TYPE_LABELS[detected.type]}, but ${ID_DOC_TYPE_LABELS[input.docType]} was selected.`,
      });
    } else {
      signals.push({
        id: "ocr_space_doc_type",
        label: "Selected ID type",
        tone: "unknown",
        detail:
          "OCR.space could not confidently identify the printed ID type. Compare the card with the selected type yourself.",
      });
    }

    signals.push({
      id: "ocr_space_summary",
      label: "OCR.space text reading",
      tone: parsed.text ? "pass" : "warn",
      detail: parsed.text
        ? "The ID front was sent to OCR.space to read printed text. OCR does not confirm that an ID is genuine."
        : "OCR.space returned no readable text from the ID front.",
    });

    return {
      provider: "ocr_space",
      signals,
      fields,
      detectedDocType: detected.confidence === "high" ? detected.type : null,
    };
  },
};
