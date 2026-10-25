/**
 * Parsing the machine-readable zone of a passport.
 *
 * ## Why this is the most reliable code in the whole feature
 *
 * Every other extraction in this folder reads text off a photograph, and text on
 * a photograph can be misread in ways that are hard to distinguish from truth. The
 * MRZ is the opposite: a fixed-width, all-caps format defined by ICAO Doc 9303,
 * printed in a font designed for machine reading, carrying check digits over its
 * own contents.
 *
 * That last part is the point. If the OCR misreads one character of a passport
 * number, the check digit fails and the parse can say so, rather than handing the
 * name-signal a number that is confidently wrong. It is the only field in the
 * entire ID feature that can detect its own errors.
 *
 * PhilSys, LTO, SSS, UMID, PhilHealth and the voter's ID have no MRZ — which is
 * precisely why a vendor charges $0.42 to read them — so this path helps one card
 * in eight, and that one very well.
 *
 * ## Two formats
 *
 * TD3 (two 44-character lines) is the passport book data page. TD1 (three
 * 30-character lines) is for ID-1 cards. Neither of the Philippine IDs CafeTrack
 * accepts emits TD1 in practice, but it costs little to parse and a misfiled
 * document is better recognised than silently ignored.
 */

const MRZ_CHARS = /^[A-Z0-9<]+$/;
const TD3_LENGTH = 44;
const TD1_LENGTH = 30;

export type MrzField = {
  /** The raw characters, fillers removed. */
  value: string;
  /** Whether the digit over this field matched. Null when the format has none. */
  check: boolean | null;
};

export type MrzParse = {
  format: "TD3" | "TD1";
  documentCode: string | null;
  issuingCountry: string | null;
  surname: string | null;
  givenNames: string | null;
  /** `DELA CRUZ, JUAN SANTOS` — the card's own printed order. */
  fullName: string | null;
  passportNumber: MrzField | null;
  nationality: string | null;
  dateOfBirth: MrzField | null;
  dateOfExpiry: MrzField | null;
  /** The composite digit over the whole of line 2. The single best error check. */
  compositeCheck: boolean | null;
  /** False when a check digit that could be verified did not match. */
  valid: boolean;
};

/**
 * The ICAO 7-3-1 weighted check digit.
 *
 * Letters count as their alphabet position (A=10 … Z=35) so that every value fits
 * in a digit-width field, which is what lets a 9-digit passport number and a date
 * share one rule.
 */
function charValue(ch: string): number {
  if (ch === "<") return 0;
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55;
  return 0;
}

export function checkDigit(text: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < text.length; i++) {
    sum += charValue(text[i]) * weights[i % 3];
  }
  return sum % 10;
}

/** Verify a field against the digit printed immediately after it. */
function field(text: string, position: number, length: number): MrzField {
  const value = text.slice(position, position + length);
  const printed = text[position + length];
  const digits = /^\d$/.test(printed) ? Number(printed) : null;

  return {
    value: clean(value),
    check: digits === null ? null : checkDigit(value) === digits,
  };
}

/** `<` is the filler character; it means "nothing here", not a literal. */
function clean(text: string): string {
  return text.replace(/<+/g, " ").trim();
}

/** `SANTOS<<JUAN` → surname, given names. Two consecutive fillers split a name. */
function splitNames(mrzName: string): { surname: string | null; givenNames: string | null } {
  const parts = mrzName.split("<<").map((p) => clean(p)).filter(Boolean);

  if (parts.length === 0) return { surname: null, givenNames: null };
  if (parts.length === 1) return { surname: parts[0], givenNames: null };

  return { surname: parts[0], givenNames: parts.slice(1).join(" ") };
}

/**
 * Assemble the name in the order the card prints it.
 *
 * Passports print `SURNAME<<GIVEN`, which reads as "Dela Cruz, Juan" to a human —
 * so the comma form is used, matching what name-signal.ts expects and what an
 * admin sees on the physical card.
 */
function assemble(surname: string | null, givenNames: string | null): string | null {
  if (!surname && !givenNames) return null;
  if (!surname) return givenNames;
  if (!givenNames) return surname;
  return `${surname}, ${givenNames}`;
}

function parseTd3(line1: string, line2: string): MrzParse {
  const documentCode = line1[0];
  const issuingCountry = clean(line1.slice(2, 5));
  const { surname, givenNames } = splitNames(line1.slice(5, TD3_LENGTH));

  const passportNumber = field(line2, 0, 9);
  const nationality = clean(line2.slice(10, 13));
  const dateOfBirth = field(line2, 13, 6);
  const dateOfExpiry = field(line2, 21, 6);

  const printedComposite = line2[43];
  const compositeCheck = /^\d$/.test(printedComposite)
    ? checkDigit(line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 43)) ===
      Number(printedComposite)
    : null;

  const checks = [
    passportNumber.check,
    dateOfBirth.check,
    dateOfExpiry.check,
    compositeCheck,
  ].filter((c): c is boolean => c !== null);

  return {
    format: "TD3",
    documentCode: documentCode ?? null,
    issuingCountry: issuingCountry || null,
    surname,
    givenNames,
    fullName: assemble(surname, givenNames),
    passportNumber,
    nationality: nationality || null,
    dateOfBirth,
    dateOfExpiry,
    compositeCheck,
    valid: checks.length > 0 && checks.every(Boolean),
  };
}

function parseTd1(line1: string, line2: string, line3: string): MrzParse {
  const documentCode = line1[0];
  const issuingCountry = clean(line1.slice(2, 5));
  const { surname, givenNames } = splitNames(line1.slice(5, TD1_LENGTH));

  const passportNumber = field(line2, 0, 9);
  const dateOfBirth = field(line2, 13, 6);
  const dateOfExpiry = field(line2, 21, 6);

  const printedComposite = line3[1];
  const compositeCheck = /^\d$/.test(printedComposite)
    ? checkDigit(line2.slice(0, 10) + line2.slice(13, 20) + line2.slice(21, 30)) ===
      Number(printedComposite)
    : null;

  const checks = [
    passportNumber.check,
    dateOfBirth.check,
    dateOfExpiry.check,
    compositeCheck,
  ].filter((c): c is boolean => c !== null);

  return {
    format: "TD1",
    documentCode: documentCode ?? null,
    issuingCountry: issuingCountry || null,
    surname,
    givenNames,
    fullName: assemble(surname, givenNames),
    passportNumber,
    nationality: clean(line2.slice(10, 13)) || null,
    dateOfBirth,
    dateOfExpiry,
    compositeCheck,
    valid: checks.length > 0 && checks.every(Boolean),
  };
}

/**
 * Pull an MRZ out of a page of OCR text.
 *
 * Looks for runs of MRZ characters rather than trusting line boundaries: the
 * zone is at a slight angle on a phone photograph, so a single line often comes
 * back as two rows with the second one indented, and joining on the character
 * class recovers it where trusting rows would not.
 *
 * Returns null when nothing MRZ-shaped is present, which is the correct answer
 * for the other seven card types and for a passport whose zone was cropped out.
 */
export function parseMrz(text: string): MrzParse | null {
  const candidates = text
    .split(/[\s\n]+/)
    .map((token) => token.toUpperCase())
    .filter((token) => token.length >= TD1_LENGTH && MRZ_CHARS.test(token));

  // TD3 first: two 44-character lines beat three 30-character ones, and a TD1
  // zone's first line is also a prefix of nothing in particular.
  for (const size of [TD3_LENGTH, TD1_LENGTH]) {
    const lines = candidates.filter((token) => token.length === size);
    if (size === TD3_LENGTH && lines.length >= 2) return parseTd3(lines[0], lines[1]);
    if (size === TD1_LENGTH && lines.length >= 3) return parseTd1(lines[0], lines[1], lines[2]);
  }

  return null;
}

/**
 * Turn an MRZ date into `YYYY-MM-DD`.
 *
 * Two-digit years are the genuinely ambiguous part: `900115` is 1990 to everyone
 * alive and 1890 to nobody holding an ID. A century is chosen rather than guessed
 * at — but **which way to shift is not the same question for both dates**, and
 * getting it wrong is not a rounding error.
 *
 * A first version applied one rule to everything: a year later than today belongs
 * to the previous century. That is right for a birth date, because nobody is born
 * in the future, and completely wrong for an expiry date, which is supposed to be
 * in the future. It turned a passport expiring on 2032-06-26 into one that expired
 * in 1932 — ninety-four years before it was issued.
 *
 * So `prefer` says which direction is plausible, and the caller knows which field it
 * is reading. The remaining bounds are kept as a backstop for a card that is older
 * or stranger than the format expects.
 */
export function mrzDateToIso(
  value: string,
  prefer: "past" | "future" = "past",
  now = new Date()
): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;

  const yy = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const thisYear = now.getFullYear();
  const century = Math.floor(thisYear / 100) * 100;

  let year = century + yy;

  if (prefer === "past") {
    // Nobody is born in the future.
    if (year > thisYear) year -= 100;
    // Anyone on a payroll is between 16 and 100.
    if (thisYear - year > 100) year += 100;
  } else {
    // A passport does not expire in the past.
    if (year < thisYear) year += 100;
    // Ten years is a typical validity; anything past that is a different century.
    if (year - thisYear > 25) year -= 100;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}
