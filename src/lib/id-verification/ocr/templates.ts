/**
 * What to look for on each of the eight Philippine IDs CafeTrack accepts.
 *
 * ## The honest position
 *
 * HyperVerge sells what it sells because trained per-document models do better
 * than hand-written rules. There is no open template library for PhilSys, LTO,
 * UMID or PhilHealth, so this file is what stands in for one, and it is written
 * from the printed layout of each card rather than from samples of them.
 *
 * That means these templates are **unvalidated against real cards**. They are
 * written to fail loudly rather than quietly — every extraction reports how it got
 * its answer (see ./extract.ts), and a template that finds nothing produces an
 * `unknown` signal saying which card type it did not recognise, not a blank field
 * that looks like "this card has no name on it".
 *
 * ## Anchored before heuristic
 *
 * Every field is looked for twice: once against a printed label, and once against
 * the shape of the value itself. The label match is trusted and reported. The
 * shape match is a fallback for the printings where the label is missing or
 * mangled, and it is reported as such, because a date-shaped token found floating
 * unlabelled is a guess and an admin deserves to know it was one.
 */

import type { IdDocType } from "../types";

/** Which extracted field a template is trying to fill. */
export type TemplateField = "full_name" | "id_number" | "date_of_birth" | "date_of_expiry";

export type FieldRule = {
  field: TemplateField;
  /**
   * Matches the label as printed.
   *
   * Tested against a row's text with spacing collapsed and case folded, so
   * `/\bLAST\s+NAME\b/i` matches "LAST NAME", "Last  Name" and "lastname" alike —
   * OCR varies in exactly that way and a strict match would miss all three.
   */
  label: RegExp;
  /** Where the value sits relative to the label on the same row. */
  side: "left" | "right";
  /**
   * On `full_name` rules only: which part of the name this label introduces.
   *
   * Not cosmetic. Every card that splits the name across separate labels prints
   * them **surname first, top to bottom** — UMID reads "LAST NAME SANTOS" on the
   * row above "FIRST NAME MARIA" — so a collector that appends values in reading
   * order produces "SANTOS MARIA" for someone called Maria Santos and then
   * compares that against the account and calls it a different person. The role is
   * what reassembles the parts correctly regardless of how they are printed.
   */
  role?: NameRole;
};

/** Which part of a name a label introduces. */
export type NameRole = "surname" | "given" | "middle";

export type CardTemplate = {
  docType: IdDocType;
  /** Human label, matching types.ts so the UI never re-derives it. */
  label: string;
  fields: FieldRule[];
  /**
   * Words that appear on the card in a position where a name would otherwise be
   * plausible, and which are never a name.
   *
   * Needed because the name fallback is a shape heuristic and "DATE OF BIRTH" is
   * a perfectly good-looking run of capital letters sitting right above the
   * applicant's actual name on several of these cards.
   */
  noise: RegExp[];
  /**
   * Where a field's value sits relative to its label.
   *
   *   "beside"  the default, and what UMID and SSS do: `LABEL  value`
   *   "above"   LTO prints the value in one row and the column headings
   *             ("LAST NAME  FIRST NAME  MIDDLE NAME") in the row below
   *   "below"   PhilSys prints the label in one row and the value in the next:
   *             `Apelyido/Last Name` / `RODRIGUEZ`
   *
   * The third case was not expressible before, and it is the common one on the
   * card most likely to be photographed. Without it, `wordsBeside` looks sideways
   * into an empty row and returns nothing — the value is not missing, it is one
   * line down. That is why a PhilSys with the surname in 96%-confidence capitals
   * yielded no name at all.
   *
   * Declared per card rather than guessed, because the three arrangements are not
   * visually distinguishable to a label that has already lost its row structure.
   */
  valuePosition?: "beside" | "above" | "below";
};

/**
 * The name labels, shared across cards.
 *
 * Both the "LAST NAME" and "SURNAME" spellings are listed because PhilSys has used
 * both across printings, and a template that only knows one of them silently reads
 * nothing off half the cards in circulation.
 */
const NAME_LABELS: FieldRule[] = [
  { field: "full_name", label: /\bLAST\s+NAME\b/i, side: "right", role: "surname" },
  { field: "full_name", label: /\bSUR\s*NAME\b/i, side: "right", role: "surname" },
  { field: "full_name", label: /\bFAMILY\s+NAME\b/i, side: "right", role: "surname" },
  { field: "full_name", label: /\bFIRST\s+NAME\b/i, side: "right", role: "given" },
  { field: "full_name", label: /\bGIVEN\s+NAMES?\b/i, side: "right", role: "given" },
  { field: "full_name", label: /\bMIDDLE\s+NAME\b/i, side: "right", role: "middle" },
  /*
   * One whole name in one field, as SSS prints it. Deliberately no role: the card
   * puts the surname first and that is what nameOrderFor is for.
   */
  { field: "full_name", label: /\bPRINTED\s+NAME\b/i, side: "right" },
];

/**
 * Card furniture that is shaped exactly like a name.
 *
 * The unlabelled name heuristic accepts any short run of capitalised words that is
 * not a known label, and on its first run it returned "THANK YOU COME AGAIN" as a
 * person's name from the bottom of an unfamiliar card. Structurally it is
 * indistinguishable — four capitalised words, no digits, no label — so the only
 * defence is to know the words.
 *
 * This is the trade every template engine makes, and it is why a heuristic read is
 * reported as a heuristic rather than as the holder's name.
 */
const CHROME_NOISE: RegExp[] = [
  /\bTHANK\s+YOU\b/i,
  /\bCOME\s+AGAIN\b/i,
  /\bPLEASE\b/i,
  /\bVISIT\b/i,
  /\bOFFICIAL\b/i,
  /\bGOVERNMENT\b/i,
  /\bPROPERTY\s+OF\b/i,
  /\bTRANSFERABLE\b/i,
  /\bVALID\s+(FOR|UNTIL|ON)\b/i,
  /\bNOT\s+VALID\b/i,
  /\bDO\s+NOT\b/i,
  /\bTOTAL\b/i,
  /\bPURCHASE\b/i,
  /\bCASH\b/i,
  /\bCHANGE\b/i,
  /\bRECEIPT\b/i,
  /\bTICKET\b/i,
  /\bWELCOME\b/i,
  /\bSAMPLE\b/i,
  /\bSPECIMEN\b/i,
];

/** Every card's header and footer boilerplate, in one list. */
const COMMON_NOISE: RegExp[] = [
  /\bREPUBLIC\b/i,
  /\bPHILIPPINES?\b/i,
  /\bPHILIPPINE\b/i,
  /\bIDENTIFICATION\b/i,
  /\bSYSTEM\b/i,
  /\bPERSONAL\s+ID/i,
  /\bDATE\s+OF\s+BIRTH\b/i,
  /\bDATE\s+OF\s+EXPIRY\b/i,
  /\bDATE\s+OF\s+ISSUE\b/i,
  /\bBIRTH\s*DATE\b/i,
  /\bEXPIRY\b/i,
  /\bSEX\b/i,
  /\bGENDER\b/i,
  /\bNATIONALITY\b/i,
  /\bCIVIL\s+STATUS\b/i,
  /\bBLOOD\s+TYPE\b/i,
  /\bCARD\s+NO\b/i,
  /\bSIGNATURE\b/i,
  /\bVALID\b/i,
  /\bUNTIL\b/i,
  /\bM\b/,
  /\bF\b/,
  ...CHROME_NOISE,
];

const withNoise = (...extra: RegExp[]): RegExp[] => [...COMMON_NOISE, ...extra];

export const TEMPLATES: Record<IdDocType, CardTemplate> = {
  philsys: {
    docType: "philsys",
    label: "PhilSys National ID",
    /*
     * Every field on a PhilSys card is printed label-then-value, one to a line.
     * See valuePosition on CardTemplate for why this was previously unreadable.
     */
    valuePosition: "below",
    fields: [
      ...NAME_LABELS,
      /*
       * The Tagalog labels, which are the ones actually printed.
       *
       * PhilSys is bilingual and the Tagalog comes first on every field
       * ("Apelyido/Last Name"), so a template that only knows the English half
       * depends on the English half being read correctly — which it frequently is
       * not, the small grey bilingual text being the hardest thing on the card.
       * Matching either half makes the read survive a misread of the other.
       *
       * Deliberately tolerant of the common OCR damage to this text ("Pangala"
       * for "Pangalan", "sven" for "Given") without matching so loosely that it
       * fires on the name it is meant to find.
       */
      /*
       * The lookahead is load-bearing. PhilSys prints the middle-name label as
       * "Gitnang Apelyido/Middle Name", so a plain /APEL[YI]IDO/ also matches the
       * "Apelyido" *inside* the middle-name label and, because it is a surname
       * rule, claimed the middle name's row as the surname's. Excluding that one
       * context leaves "Apelyido/Last Name" as the only thing it can match.
       */
      { field: "full_name", label: /\bAPEL[YI]IDO\b(?!\s*\/?\s*MIDDLE)/i, side: "right", role: "surname" },
      /*
       * Anchored on "Mga" so the match covers the whole of the label's Tagalog
       * half. Matching "Pangala" alone left "sven" — Tesseract's reading of
       * "Given" — sitting beside it and therefore looking like a value.
       */
      { field: "full_name", label: /\bMGA\s+PANGALA[N]?\b/i, side: "right", role: "given" },
      { field: "full_name", label: /\bGITNANG\b/i, side: "right", role: "middle" },
      { field: "full_name", label: /\bGIVEN\s+NAMES?\b/i, side: "right", role: "given" },
      { field: "id_number", label: /\bPHLSYS\s*(ID|CARD)\b/i, side: "right" },
      { field: "id_number", label: /\bCARD\s*(NO|NUMBER)\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
      { field: "date_of_birth", label: /\bPETSA\s+NG\b/i, side: "right" },
      { field: "date_of_expiry", label: /\bDATE\s+OF\s+EXPIRY\b/i, side: "right" },
    ],
    noise: withNoise(/\bPHLSYS\b/i, /\bNATIONAL\s+ID\b/i, /\bTIRAHAN\b/i),
  },

  lto_license: {
    docType: "lto_license",
    label: "LTO Driver's Licence",
    fields: [
      ...NAME_LABELS,
      { field: "id_number", label: /\b(LTO|LICEN[SC]E)\s*(NO|NUMBER)\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
      { field: "date_of_expiry", label: /\bDATE\s+OF\s+EXPIRY\b/i, side: "right" },
    ],
    noise: withNoise(/\bDRIVERS?\b/i, /\bLICEN[SC]E\b/i, /\bRESTRICTION\b/i, /\bENDORSEMENT\b/i),
    valuePosition: "above",
  },

  passport: {
    /*
     * A passport is the one card here with an MRZ — the two fixed-width lines at
     * the bottom that every machine-readable passport since 1980 carries. It is
     * parsed separately and preferred over anything below (see ./mrz.ts), because
     * a fixed-width format is far more reliable than reading text off a
     * photograph, and every other card in this file lacks one.
     *
     * These rules are the fallback for when the MRZ is cropped out, blurred or
     * covered, which on a phone photo of a folded passport is common.
     */
    docType: "passport",
    label: "Passport",
    fields: [
      { field: "full_name", label: /\bSURNAME\b/i, side: "right" },
      { field: "full_name", label: /\bGIVEN\s+NAMES?\b/i, side: "right" },
      { field: "id_number", label: /\bPASSPORT\s*(NO|NUMBER)\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
      { field: "date_of_expiry", label: /\bDATE\s+OF\s+EXPIRY\b/i, side: "right" },
    ],
    noise: withNoise(/\bPASSPORT\b/i, /\bTYPE\b/i, /\bCODE\b/i, /\bISSUING/i, /\bAUTHORITY\b/i),
  },

  sss: {
    docType: "sss",
    label: "SSS ID",
    fields: [
      /*
       * SSS prints one NAME field, and — unusually — with the surname *first*,
       * same as the cards that use a comma. Handled by nameOrder below rather
       * than by a separate rule.
       */
      { field: "full_name", label: /\bNAME\b/i, side: "right" },
      { field: "id_number", label: /\b(SSS|LCD)?\s*(NO|NUMBER)\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
      { field: "date_of_expiry", label: /\bVALID\s+THRU\b/i, side: "right" },
    ],
    noise: withNoise(/\bSSS\b/i, /\bSOCIAL\s+SECURITY\b/i, /\bLUDGER\s+NO\b/i, /\bGSIS\b/i),
  },

  umid: {
    docType: "umid",
    label: "UMID / GSIS",
    fields: [
      ...NAME_LABELS,
      { field: "id_number", label: /\b(CRN|UMID)\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
    ],
    noise: withNoise(/\bUMID\b/i, /\bGSIS\b/i, /\bCRN\b/i, /\bUNIFIED\s+ID\b/i),
  },

  philhealth: {
    docType: "philhealth",
    label: "PhilHealth ID",
    fields: [
      ...NAME_LABELS,
      { field: "id_number", label: /\bNO\.?\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
    ],
    noise: withNoise(/\bPHILHEALTH\b/i, /\bINSURANCE\b/i, /\bMEMBER\b/i, /\bNO\.?\b/i),
  },

  voters: {
    docType: "voters",
    label: "Voter's ID",
    fields: [
      ...NAME_LABELS,
      { field: "id_number", label: /\b(VOTER'?S?|VOTERS)\s*(NO|NUMBER)\b/i, side: "right" },
      { field: "date_of_birth", label: /\bDATE\s+OF\s+BIRTH\b/i, side: "right" },
    ],
    noise: withNoise(/\bVOTER\b/i, /\bVOTERS?\b/i, /\bCOMELEC\b/i, /\bPRECINCT\b/i, /\bNUMBER\b/i),
  },

  other: {
    /*
     * Nothing is claimed here. An unknown card gets the unlabelled heuristics and
     * nothing else, and the resulting signal says so — a template for "other"
     * that quietly returned a surname found by shape would be the app inventing
     * structure it does not have.
     */
    docType: "other",
    label: "Other",
    fields: NAME_LABELS,
    noise: COMMON_NOISE,
  },
};

/**
 * How the card prints the name, which decides how the parts reassemble.
 *
 * `"surname_first"` produces `DELA CRUZ, JUAN SANTOS` — kept in the card's own
 * printed order rather than normalised, because name-signal.ts reads the comma as
 * "the surname is before this" and an admin comparing the screen against the card
 * in their hand sees the same string in both.
 */
export function nameOrderFor(docType: IdDocType): "surname_first" | "given_first" {
  switch (docType) {
    case "sss":
    case "philsys":
    case "lto_license":
    case "passport":
      return "surname_first";
    default:
      return "given_first";
  }
}

export function templateFor(docType: IdDocType): CardTemplate {
  return TEMPLATES[docType] ?? TEMPLATES.other;
}
