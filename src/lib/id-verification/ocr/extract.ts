/**
 * Reading fields off a card, and being honest about how each one was found.
 *
 * ## Every answer carries its own provenance
 *
 * This is the design decision the rest of the feature rests on. Each field comes
 * back with the *strategy* that produced it:
 *
 *   `mrz`       a fixed-width machine-readable zone, check digits verified
 *   `label`     found beside a printed label — "DATE OF BIRTH   1990-01-15"
 *   `heuristic` matched on shape alone, with no label to corroborate it
 *   `none`      not found
 *
 * The distinction matters because a heuristic that guesses is not wrong by
 * construction — it is a bet that the register in front of it is the right field,
 * and on a card it does not recognise the bet loses. Passing that on as a fact
 * would put a name in front of an admin with the same confidence as one read from
 * a verified MRZ, which is how an automated check teaches someone to trust it when
 * it is wrong.
 *
 * So the strategy travels all the way to the screen. A heuristic read is reported
 * as one.
 */

import type { IdDocType } from "../types";
import { parseMrz, mrzDateToIso, type MrzParse } from "./mrz";
import {
  contentWords,
  isFillerWord,
  wordsAbove,
  wordsBeside,
  wordsBelow,
  wordsInMatch,
  type OcrLayout,
  type OcrRow,
  type OcrWord,
} from "./rows";
import {
  nameOrderFor,
  templateFor,
  type CardTemplate,
  type NameRole,
  type TemplateField,
} from "./templates";

export type ExtractionStrategy = "mrz" | "label" | "heuristic" | "none";

export type Extracted<T = string> = {
  value: T | null;
  strategy: ExtractionStrategy;
  /** The text this was read from, quoted in the signal so it can be eyeballed. */
  evidence: string;
  /** 0-100. */
  confidence: number;
};

export type Extraction = {
  full_name: Extracted;
  id_number: Extracted;
  date_of_birth: Extracted;
  date_of_expiry: Extracted;
};

const nothing = (): Extracted => ({
  value: null,
  strategy: "none",
  evidence: "",
  confidence: 0,
});

/* ------------------------------------------------------------------ dates -- */

const ISO_DATE = /\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/;
const US_DATE = /\b(\d{2})[-/.](\d{2})[-/.](\d{4})\b/;

const MONTHS: Record<string, string> = {
  JAN: "01", JANUARY: "01",
  FEB: "02", FEBRUARY: "02",
  MAR: "03", MARCH: "03",
  APR: "04", APRIL: "04",
  MAY: "05",
  JUN: "06", JUNE: "06",
  JUL: "07", JULY: "07",
  AUG: "08", AUGUST: "08",
  SEP: "09", SEPT: "09", SEPTEMBER: "09",
  OCT: "10", OCTOBER: "10",
  NOV: "11", NOVEMBER: "11",
  DEC: "12", DECEMBER: "12",
};

/** "OCTOBER", "Oct", "SEPT" — the name as printed, in whatever case or damage. */
const MONTH_NAME = Object.keys(MONTHS).join("|");

/*
 * The comma is optional and the space after it is not required. PhilSys prints
 * "OCTOBER 29,2005" with no space at all — which is also how Tesseract returns it,
 * because the gap there is a fraction of a character — so `,?\s+` rejected the
 * real card while happily accepting a tidier "OCTOBER 29, 2005" that no card
 * prints. Requiring whitespace after an optional comma is asking for a format
 * that exists in the spec and not on the card.
 */
const MONTH_FIRST = new RegExp(
  `\\b(${MONTH_NAME})[A-Z]*\\.?\\s+(\\d{1,2})(?:ST|ND|RD|TH)?\\s*,?\\s*(\\d{4})\\b`,
  "i"
);
const DAY_FIRST = new RegExp(
  `\\b(\\d{1,2})(?:ST|ND|RD|TH)?\\s+(${MONTH_NAME})[A-Z]*\\.?\\s*,?\\s*(\\d{4})\\b`,
  "i"
);

/**
 * A real calendar date, or null.
 *
 * Built rather than arithmetic because JavaScript will happily roll "February 31"
 * forward into March, and a birth date quietly shifted by three days is worse than
 * one that was not read at all — it looks correct.
 */
function calendarDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  if (!Number.isInteger(y) || y < 1900 || y > 2100) return null;
  if (!Number.isInteger(m) || m < 1 || m > 12) return null;
  if (!Number.isInteger(d) || d < 1 || d > 31) return null;

  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;

  return `${year}-${month}-${String(d).padStart(2, "0")}`;
}

/**
 * A date written out in words.
 *
 * PhilSys prints "OCTOBER 29, 2005", and the parser below only understood digits,
 * so a card whose name, ID number and photograph all read cleanly still reported
 * no birth date at all — the one field on it that is never in doubt. This was not
 * a tuning problem; the format was simply not supported.
 *
 * The month name also makes the date *unambiguous*, which the numeric branches
 * below are careful never to be: "29,10,2005" could be two different days and has
 * to be reported as read, whereas "OCTOBER 29, 2005" is one date and is checked
 * against the calendar for real.
 */
function normaliseWrittenDate(text: string): string | null {
  const first = MONTH_FIRST.exec(text);
  if (first) {
    const month = MONTHS[first[1].toUpperCase()];
    if (month) return calendarDate(first[3], month, first[2]);
  }

  const second = DAY_FIRST.exec(text);
  if (second) {
    const month = MONTHS[second[2].toUpperCase()];
    if (month) return calendarDate(second[3], month, second[1]);
  }

  return null;
}

function normaliseDate(text: string): string | null {
  const written = normaliseWrittenDate(text);
  if (written) return written;

  const iso = ISO_DATE.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  /*
   * Printed as MM/DD/YYYY on the American-derived cards (LTO, SSS, PhilHealth)
   * and DD/MM/YYYY on others. Ambiguous by nature — 05/06/1990 is two different
   * people — so the month is required to be ≤ 12 and, when both readings are
   * legal, it is reported as read rather than guessed at. A date is not used for
   * a decision here; it is displayed for a human to check.
   */
  const us = US_DATE.exec(text);
  if (us) {
    const a = Number(us[1]);
    const b = Number(us[2]);
    if (a > 12 && b <= 12) return `${us[3]}-${us[2]}-${us[1]}`;
    if (b > 12 && a <= 12) return `${us[3]}-${us[1]}-${us[2]}`;
    if (a <= 12 && b <= 12) return `${us[3]}-${us[1]}-${us[2]}`;
    return null;
  }

  return null;
}

/* ------------------------------------------------------------------- name -- */

const NAME_TOKEN = /^[A-Z][A-Z'’-]{1,24}$/;

/**
 * The name tokens in a row, or null if the row is not plausibly a name.
 *
 * Numeric-only tokens are dropped first. LTO prints a small card number — a bare
 * "1" — in a box at the left of the name row, and counting it pushed a perfectly
 * good four-part name over the length limit and lost the whole row. No name
 * contains a number, so removing them is safe and is not a special case for one
 * card.
 */
function nameTokens(row: OcrRow, noise: RegExp[]): OcrWord[] | null {
  const words = contentWords(row).filter((w) => !/^[0-9]+$/.test(w.text.trim()));
  if (words.length < 2 || words.length > 4) return null;

  const text = words.map((w) => w.text.trim()).join(" ");
  if (noise.some((re) => re.test(text))) return null;
  if (!words.every((w) => NAME_TOKEN.test(w.text.trim().toUpperCase()))) return null;
  if (words.some((w) => w.text.trim().length > 20)) return null;

  return words;
}

/**
 * Join name parts in the order the card prints them.
 *
 * `surname_first` yields the comma form, which is both what the card shows and what
 * name-signal.ts reads as "the surname is before this". Normalising to "Given
 * Surname" here would throw away the one reliable structural cue the string has.
 */
function assembleName(parts: string[], order: "surname_first" | "given_first"): string | null {
  const clean = parts.map((p) => p.trim()).filter(Boolean);
  if (clean.length === 0) return null;

  const joined = clean.join(" ").replace(/\s+/g, " ").trim();
  if (order === "given_first") return joined;

  const first = clean[0];
  const rest = clean.slice(1).join(" ").trim();
  return rest ? `${first}, ${rest}` : first;
}

/**
 * Reassemble parts labelled individually.
 *
 * Read **by role, not by position**. UMID prints the surname on the row above the
 * given name, so a collector that appends as it reads builds "SANTOS MARIA" for
 * Maria Santos — which the name check then reports as a different person on a
 * correct upload. Only when no role was recognised does reading order stand in,
 * and then the card's own convention decides how to read it.
 */
function assembleFromRoles(
  parts: { role: NameRole | undefined; value: string }[],
  order: "surname_first" | "given_first"
): string | null {
  const withRoles = parts.filter((p) => p.role);

  if (withRoles.length === 0) {
    return assembleName(
      parts.map((p) => p.value),
      order
    );
  }

  const surname = withRoles.filter((p) => p.role === "surname").map((p) => p.value).join(" ");
  const given = withRoles.filter((p) => p.role === "given").map((p) => p.value).join(" ");
  const middle = withRoles.filter((p) => p.role === "middle").map((p) => p.value).join(" ");

  const tail = [given, middle].filter(Boolean).join(" ");

  if (!surname) return tail || null;
  if (!tail) return surname;

  // The comma form, matching how the card prints it and what name-signal.ts reads.
  return `${surname}, ${tail}`;
}

/**
 * The name, found three ways in descending order of trust.
 *
 * LTO's stacked layout is handled specially: it prints the name in one row and the
 * column headings in the row *below*, so there is nothing beside the label to take
 * and the row above is what holds the value.
 */
function extractName(
  layout: OcrLayout,
  docType: IdDocType,
  mrz: MrzParse | null,
  layoutStacked: boolean
): Extracted {
  const template = templateFor(docType);
  const order = nameOrderFor(docType);

  if (mrz?.fullName) {
    return {
      value: mrz.fullName,
      strategy: "mrz",
      evidence: `${mrz.surname ?? ""}${mrz.surname && mrz.givenNames ? ", " : ""}${mrz.givenNames ?? ""}`,
      confidence: mrz.valid ? 95 : 72,
    };
  }

  const nameLabels = template.fields.filter((f) => f.field === "full_name");

  /* --- labelled ------------------------------------------------------- */

  if (layoutStacked) {
    // Find the heading row, then read the row immediately above it.
    const headingIndex = layout.rows.findIndex((row) =>
      nameLabels.some((rule) => rule.label.test(row.text))
    );

    if (headingIndex > 0) {
      const valueRow = layout.rows[headingIndex - 1];

      const tokens = nameTokens(valueRow, template.noise);
      if (tokens) {
        const assembled = assembleName([tokens.map((w) => w.text.trim()).join(" ")], order);

        // Same guard as the sideways read: a whole row of capitals can be card
        // furniture. See looksLikeName.
        if (assembled && looksLikeName(assembled)) {
          return {
            value: assembled,
            strategy: "label",
            evidence: `${assembled} (above "${layout.rows[headingIndex].text}")`,
            confidence: valueRow.confidence,
          };
        }
      }
      // The heading's own row had nothing above it worth taking, so fall through
      // rather than returning an empty name.
    }
  }

  const parts: { role: NameRole | undefined; value: string }[] = [];
  const evidence: string[] = [];
  let confidence = 0;

  for (const [rowIndex, row] of layout.rows.entries()) {
    const words = contentWords(row);
    if (words.length === 0) continue;

    for (const rule of nameLabels) {
      if (!rule.label.test(row.text)) continue;

      const labelWords = wordsInMatch(row, rule.label);
      if (labelWords.length === 0) continue;

      const partsBeforeThisRule = parts.length;

      // A row where the label and the value are one and the same ("NAME DELA CRUZ"
      // with the value split across several words) still resolves, because
      // `wordsBeside` keeps everything past the label's right edge.
      const candidates = valueCandidates(
        layout,
        rowIndex,
        row,
        labelWords,
        rule.side,
        template.valuePosition ?? "beside"
      );

      for (const found of candidates) {
        const value = nameValueWords(found.words)
          .map((w) => w.text.trim())
          .join(" ")
          .replace(/^[^A-Za-z]+/, "")
          .trim();

        if (!value) continue;

        // "LAST NAME JUAN" has read the given name under the surname label; a value
        // containing another of the known labels means the row is a heading, or
        // that the row underneath this one is the *next* field's label.
        if (candidateIsAnotherLabel(value, template, rule.label)) continue;

        /*
         * Found next to a printed label, and still not necessarily a name.
         *
         * A single glyph to the right of a PhilSys "Apelyido/Last Name" satisfied
         * every anchoring condition and came back as "A". Demoted rather than
         * accepted, so it is shown and not acted on — the same treatment every
         * other unanchored guess gets. See looksLikeName.
         */
        if (!looksLikeName(value)) continue;

        parts.push({ role: rule.role, value });
        evidence.push(
          `${value} (${found.where} "${labelWords.map((w) => w.text.trim()).join(" ")}")`
        );
        confidence = Math.max(confidence, row.confidence);
        break;
      }

      if (parts.length > partsBeforeThisRule) break;
    }
  }

  if (parts.length > 0) {
    const name = assembleFromRoles(parts, order);
    if (name && looksLikeName(name)) {
      return { value: name, strategy: "label", evidence: evidence.join("; "), confidence };
    }
  }

  /* --- heuristic ------------------------------------------------------ */

  /*
   * Last resort, and the only path that will ever return a name with no printed
   * label behind it. Restricted to a single row: a name split across two rows
   * because of a crease is not something to reconstruct by guessing.
   */
  for (const row of layout.rows) {
    const tokens = nameTokens(row, template.noise);
    if (!tokens) continue;
    // Ignore a row that is almost entirely filler ("LAST NAME . . . . .").
    const fillerRatio =
      row.words.filter((w) => isFillerWord(w.text)).length / Math.max(row.words.length, 1);
    if (fillerRatio > 0.4) continue;

    const text = tokens.map((w) => w.text.trim()).join(" ");

    return {
      value: assembleName([text], order),
      strategy: "heuristic",
      evidence: `${text} (no label found — matches the shape of a name)`,
      confidence: Math.min(row.confidence, 70),
    };
  }

  return nothing();
}

/* ------------------------------------------------------- where values live -- */

/**
 * Find the value belonging to a label, wherever this card prints it.
 *
 * One place, so the three extractors cannot disagree about where a value is. A
 * card declares its arrangement once (`valuePosition` on CardTemplate) and every
 * field is read the same way:
 *
 *   "beside"  the same row, to the side the rule asks for
 *   "below"   the next row down, in the same column   <- PhilSys
 *   "above"   the previous row, in the same column    <- LTO
 *
 * Returned as an ordered list rather than a single answer, because "where" cannot
 * be decided without looking at what was found. On a card that declares "below",
 * the row underneath is the best candidate — but if that row turns out to be the
 * *next* label ("DATE OF EXPIRY" under "DATE OF BIRTH"), the sideways read is
 * the right one after all. So the caller takes the first candidate that survives
 * its own validation, and the order only decides ties.
 *
 * Taking the first non-empty candidate instead is what made this module reject
 * every card whose layout disagreed with its template, and it silently preferred
 * a neighbouring label over the value sitting right beside the one it was reading.
 */
function valueCandidates(
  layout: OcrLayout,
  rowIndex: number,
  row: OcrRow,
  labelWords: OcrWord[],
  side: "left" | "right",
  position: "beside" | "above" | "below"
): { words: OcrWord[]; where: string }[] {
  const beside = { words: wordsBeside(row, labelWords, side), where: "beside" };
  const stacked =
    position === "below"
      ? { words: wordsBelow(layout.rows, rowIndex, labelWords), where: "below" }
      : position === "above"
        ? { words: wordsAbove(layout.rows, rowIndex, labelWords), where: "above" }
        : null;

  const ordered = stacked ? [stacked, beside] : [beside];
  return ordered.filter((c) => c.words.length > 0);
}

/**
 * Is this candidate actually another field's label rather than a value?
 *
 * ## Why this check exists
 *
 * Reading the row under a label is only correct when that row is the label's
 * value. Often it is not: it is the *next* field's label. "DATE OF BIRTH" is
 * followed by "DATE OF EXPIRY 2032-06-26", and taking the row underneath without
 * asking whether it is a label reported an expiry as a birth date — a plausible,
 * well-formed, entirely wrong answer, which is the most dangerous kind this
 * feature can produce.
 *
 * Tested against every label in the template rather than only this field's own, so
 * one field cannot swallow another's. Identity comparison is safe here because the
 * rules are the same objects held by the template, and a RegExp without /g keeps
 * no state between calls.
 */
function candidateIsAnotherLabel(
  value: string,
  template: CardTemplate,
  currentRule: RegExp
): boolean {
  return template.fields.some((f) => f.label !== currentRule && f.label.test(value));
}

/**
 * Keep only the words in a candidate value that could be part of a name.
 *
 * The value under a label on a real card is rarely just the value. On the PhilSys
 * above, the row beneath "Apelyido/Last Name" is clean, but the row beneath
 * "Mga Pangalan/Given Names" is `s.- » PRINCE DEANO h,` — two broken glyphs, the
 * value, and a stray mark, all on one printed line. Quoting that whole row gives
 * "s.- PRINCE DEANO", which is not a name and reads as though it might be one.
 *
 * This keeps words that are letters and carry at least two of them, and drops
 * everything else. It is applied to the *value* only — the label is matched by
 * regex and is unaffected — and it is deliberately blunt, because a name is
 * letters and anything that is not letters is not part of one.
 */
function nameValueWords(words: OcrWord[]): OcrWord[] {
  return words.filter((w) => {
    const t = w.text.trim();
    if (!/^[A-Za-z]/.test(t)) return false;
    return (t.match(/[A-Za-z]/g) ?? []).length >= 2;
  });
}

/**
 * Is this plausibly a person's name?
 *
 * ## Why an anchored read still needs checking
 *
 * `isTrustworthy` treats a value as sound because of *how* it was found — beside
 * a printed label, or out of a check-digit-verified MRZ. That is a statement about
 * the method, and it is not a statement about the result. A single stray glyph on
 * the right-hand margin of a PhilSys card sat to the right of the label
 * "Apelyido/Last Name", satisfied every condition for an anchored read, and was
 * returned as the name: **"A"**. It was stored, displayed in green as
 * "read from beside its printed label", and compared against the account.
 *
 * Nothing about that read was unreliable except its content. So an anchored read
 * has to survive one more question — could this be a name at all?
 *
 * Two rules, both very weak, and deliberately so: this only ever *demotes* a read
 * to the heuristic tier, where it is shown and not acted on. It never promotes one,
 * and it never invents a rule a human would not recognise.
 */
export function looksLikeName(value: string | null | undefined): boolean {
  if (!value) return false;

  const cleaned = String(value).trim();
  if (cleaned.length < 2) return false;

  /*
   * At least one token of two or more letters. A name is not "A B" — that is two
   * stray glyphs that happened to land beside a label, which is exactly the shape
   * of the failure above. Initials and mononyms of two letters ("Li", "Wu") are
   * real and must survive, so the rule is two letters, not two words.
   */
  return cleaned.split(/\s+/).some((token) => /[A-Za-z]{2}/.test(token));
}

/* ---------------------------------------------------------------- numbers -- */

/**
 * A token that could be an ID number: mostly digits and hyphens, anchored at both
 * ends.
 *
 * Anchored, deliberately. An earlier version of this matched with `\b...\b` and
 * silently truncated `1234-5678-9012-3456` to `1234-5678-9012` — which is a valid
 * looking number of a plausible length, so it would have been displayed and stored
 * as though it were the real one. A partial read of an ID number is worse than no
 * read, because nobody checks an ID number against anything.
 */
const ID_CANDIDATE = /^[A-Z0-9][A-Z0-9-]{5,}[A-Z0-9]$/;

/** Dates that reach the number heuristic, which must not return them as numbers. */
const looksLikeDate = (value: string): boolean => /\d{2}[-/.]\d{2}[-/.]\d{2,4}/.test(value);

function extractNumber(
  layout: OcrLayout,
  docType: IdDocType,
  mrz: MrzParse | null,
  claimed: Set<string>
): Extracted {
  const template = templateFor(docType);
  const rules = template.fields.filter((f) => f.field === "id_number");

  if (mrz?.passportNumber?.value) {
    return {
      value: mrz.passportNumber.value,
      strategy: "mrz",
      evidence: mrz.passportNumber.value,
      confidence: mrz.passportNumber.check ? 95 : 65,
    };
  }

  for (const [rowIndex, row] of layout.rows.entries()) {
    const words = contentWords(row);
    if (words.length === 0) continue;

    for (const rule of rules) {
      if (!rule.label.test(row.text)) continue;

      const labelWords = wordsInMatch(row, rule.label);
      if (labelWords.length === 0) continue;

      const candidates = valueCandidates(
        layout,
        rowIndex,
        row,
        labelWords,
        rule.side,
        template.valuePosition ?? "beside"
      );

      for (const found of candidates) {
        const value = found.words.map((w) => w.text.trim()).join(" ").trim();

        const cleaned = value.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, "");
        if (!cleaned) continue;
        // A label with nothing recognisable beside it is a heading, not a value.
        if (!/[0-9]/.test(cleaned)) continue;
        // The row underneath may be the next field's label. See
        // candidateIsAnotherLabel — without this a number can be read off the
        // wrong label entirely.
        if (candidateIsAnotherLabel(cleaned, template, rule.label)) continue;

        return {
          value: cleaned,
          strategy: "label",
          evidence: `${cleaned} (${found.where} the label)`,
          confidence: row.confidence,
        };
      }
    }
  }

  /* --- heuristic ------------------------------------------------------ */

  for (const row of layout.rows) {
    if (template.noise.some((re) => re.test(row.text))) continue;

    for (const word of contentWords(row)) {
      const text = word.text.trim().toUpperCase();
      if (!ID_CANDIDATE.test(text)) continue;

      const value = text;
      if (looksLikeDate(value)) continue;
      if (!/\d/.test(value)) continue;
      if (value.replace(/\D/g, "").length < 6) continue;
      // Already handed to another field — a number cannot be two things.
      if (claimed.has(value)) continue;

      return {
        value,
        strategy: "heuristic",
        evidence: `${value} (no label found — matches the shape of an ID number)`,
        confidence: Math.min(row.confidence, 70),
      };
    }
  }

  return nothing();
}

/* ------------------------------------------------------------------ dates -- */

function extractDate(
  layout: OcrLayout,
  docType: IdDocType,
  mrz: MrzParse | null,
  field: Extract<TemplateField, "date_of_birth" | "date_of_expiry">,
  claimed: Set<string>
): Extracted {
  const template = templateFor(docType);
  const mrzField = field === "date_of_birth" ? mrz?.dateOfBirth : mrz?.dateOfExpiry;

  if (mrzField?.value) {
    return {
      // An expiry lives in the future and a birth date in the past; telling the
      // parser which is which is what stops a 2032 expiry reading as 1932.
      value: mrzDateToIso(mrzField.value, field === "date_of_expiry" ? "future" : "past"),
      strategy: "mrz",
      evidence: mrzField.value,
      confidence: mrzField.check ? 95 : 70,
    };
  }

  const rules = template.fields.filter((f) => f.field === field);

  for (const [rowIndex, row] of layout.rows.entries()) {
    const words = contentWords(row);
    if (words.length === 0) continue;

    for (const rule of rules) {
      if (!rule.label.test(row.text)) continue;

      const labelWords = wordsInMatch(row, rule.label);
      if (labelWords.length === 0) continue;

      const candidates = valueCandidates(
        layout,
        rowIndex,
        row,
        labelWords,
        rule.side,
        template.valuePosition ?? "beside"
      );

      for (const found of candidates) {
        const value = found.words.map((w) => w.text.trim()).join(" ");

        const iso = normaliseDate(value);
        if (!iso) continue;

        /*
         * The row underneath a date label is very often the *next* date label —
         * "DATE OF BIRTH" sits directly above "DATE OF EXPIRY 2032-06-26" on the
         * cards that print both. Without this guard the expiry was reported as the
         * birth date: well-formed, plausible and wrong, which is worse than blank
         * because it looks like a successful read.
         */
        if (candidateIsAnotherLabel(value, template, rule.label)) continue;

        return {
          value: iso,
          strategy: "label",
          evidence: `${iso} (${found.where} "${labelWords.map((w) => w.text.trim()).join(" ")}")`,
          confidence: row.confidence,
        };
      }
    }
  }

  /* --- heuristic ------------------------------------------------------ */

  /*
   * Skipping anything another field already claimed is what stops a card with one
   * printed date from reporting that date as its birth date *and* its expiry.
   *
   * That is not hypothetical: it is what the first version of this did, and the
   * output was a PhilSys card with no expiry field at all reporting
   * `date_of_expiry: 1990-01-15` — the holder's birthday, displayed as when their
   * ID runs out. A wrong value in the wrong field is worse than a blank one,
   * because a blank one gets checked and a wrong one does not.
   */
  for (const row of layout.rows) {
    const iso = normaliseDate(row.text);
    if (!iso) continue;
    if (claimed.has(iso)) continue;

    return {
      value: iso,
      strategy: "heuristic",
      evidence: `${iso} (no label found — matches the shape of a date)`,
      confidence: Math.min(row.confidence, 65),
    };
  }

  return nothing();
}

/* ------------------------------------------------------------------- run -- */

/**
 * Read whatever this card has to give, recording how each field was found.
 *
 * The MRZ is attempted for every document type, not just passports: it costs a
 * scan of the text, and a card that turns out to have one is better read from it
 * than inferred. It is simply absent from the other seven.
 *
 * **Order is load-bearing.** Date of birth is read before date of expiry so that a
 * card printing only one date has that date claimed by the right field; and
 * `date_of_birth` is read before either date is offered to the number heuristic so
 * a birth date can never be reported as an ID number. Both were wrong in the first
 * version and both produced output that looked entirely plausible.
 */
export function extract(
  layout: OcrLayout,
  docType: IdDocType,
  text = layout.text
): { fields: Extraction; mrz: MrzParse | null } {
  const mrz = parseMrz(text);
  const template = templateFor(docType);
  const claimed = new Set<string>();

  const claim = (value: string | null): void => {
    if (value) claimed.add(value);
  };

  const id_number = extractNumber(layout, docType, mrz, claimed);
  claim(id_number.value);

  const date_of_birth = extractDate(layout, docType, mrz, "date_of_birth", claimed);
  claim(date_of_birth.value);

  const date_of_expiry = extractDate(layout, docType, mrz, "date_of_expiry", claimed);
  claim(date_of_expiry.value);

  const full_name = extractName(layout, docType, mrz, template.valuePosition === "above");

  return {
    mrz,
    fields: { full_name, id_number, date_of_birth, date_of_expiry },
  };
}

/**
 * Whether a reading is solid enough to hand to the name check.
 *
 * Only an anchored read — a verified MRZ or a value sitting beside its printed
 * label — survives. A heuristic read is reported on screen and kept out of
 * `fields`, and that is not timidity about OCR quality: it is that a heuristic
 * *name* has no structure. "DELA CRUZ JUAN SANTOS" read off a card with no
 * recognisable label is a name in unknown order, so splitting it into surname and
 * given names is a guess, and a guessed surname compared against the account's
 * produces a confident red `fail` on a correct upload.
 *
 * So the guess is shown, and the comparison is left unrun.
 */
export function isTrustworthy(field: Extracted): boolean {
  return field.strategy === "mrz" || field.strategy === "label";
}
