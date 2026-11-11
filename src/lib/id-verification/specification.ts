import type { IdDocType, IdSignal } from "./types";
import { checkIdNumber } from "./id-number";

const EXPIRY_SUPPORT: Record<IdDocType, boolean> = {
  philsys: false,
  lto_license: true,
  passport: true,
  sss: true,
  umid: false,
  philhealth: false,
  voters: false,
  other: true,
};

export function idTypeHasExpiry(docType: IdDocType): boolean {
  return EXPIRY_SUPPORT[docType];
}

export function idNumberSignal(value: string, docType: IdDocType): IdSignal | null {
  const number = value.trim();
  if (!number) return null;

  const verdict = checkIdNumber(number, docType);
  return verdict.ok
    ? {
        id: "id_number_shape",
        label: "ID number format",
        tone: "pass",
        detail: `The number read as "${number}" matches the expected format for this ID type.`,
      }
    : {
        id: "id_number_shape",
        label: "ID number format",
        tone: "warn",
        detail:
          `The number read as "${number}" does not match the expected format for this ID type. ` +
          `${verdict.problem ?? "Check and correct it against the card."}`,
      };
}
