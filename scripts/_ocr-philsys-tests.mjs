/**
 * Regression tests transcribed from a real PhilSys card photograph.
 *
 *   npm run test:ocr-philsys
 *
 * ## Why these numbers are hand-written and specific
 *
 * A real card was uploaded, the engine run on it, and the word boxes copied out
 * of scripts/_ocr-dump.mjs. Every x0/y0/x1/y1 below is a measured value, not a
 * guess, because the bugs these lock down were all bugs of *degree*:
 *
 *   - rows chained 19 words across 4 printed lines (the name came back "A")
 *   - a value printed *under* its label was invisible (PhilSys prints it that way)
 *   - the country code leaked into a birth date and made it unparseable
 *   - one glyph beside a label was accepted as a name
 *
 * Each of those produced a confident, plausible, wrong answer, and none of them
 * would be caught by a test using tidy synthetic rows. So these rows are untidy:
 * the gaps are 15-25px between a 17-25px line height, exactly as the card is
 * printed, because that tightness is the thing that broke.
 *
 * The transcription is the point. A synthetic card with generous spacing passes
 * all of this; the real one did not.
 */

import { buildLayout } from "../src/lib/id-verification/ocr/rows.ts";
import { extract, looksLikeName } from "../src/lib/id-verification/ocr/extract.ts";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

/**
 * The card.
 *
 * A PhilSys National ID, photographed at an angle on a desk: 1280x960, the
 * card filling most of the frame. Fields are label-then-value, one to a line,
 * in the card's own column at x~620-1010.
 *
 * Only the words the extractor can plausibly act on are here. Tesseract also
 * returned "AY", "aN", "Y", "\\j,", "Phitippine" and two dozen other fragments
 * from the background and the card's microprint, and leaving them in would make
 * this file a test of noise handling rather than of layout. They are covered
 * separately by the tolerance checks at the bottom.
 */
const CARD_WORDS = [
  // Header and the bare number, which PhilSys prints with no label at all.
  { text: "3872-4062-9356-0465", x0: 223, y0: 341, x1: 554, y1: 409, confidence: 91 },

  // Surname: label on one line, value on the next.
  { text: "Apelydo/Last", x0: 619, y0: 392, x1: 755, y1: 409, confidence: 44 },
  { text: "Name", x0: 763, y0: 391, x1: 822, y1: 406, confidence: 96 },
  { text: "RODRIGUEZ", x0: 628, y0: 424, x1: 829, y1: 450, confidence: 96 },

  // Given names. "sven" is Tesseract's reading of "Given"; it is kept because it
  // is what the engine really returned and because the fix has to survive it.
  { text: "Mga", x0: 619, y0: 462, x1: 660, y1: 480, confidence: 92 },
  { text: "Pangala", x0: 671, y0: 461, x1: 745, y1: 479, confidence: 90 },
  { text: "sven", x0: 781, y0: 465, x1: 826, y1: 474, confidence: 70 },
  { text: "Names", x0: 836, y0: 461, x1: 904, y1: 475, confidence: 94 },
  { text: "s.-", x0: 560, y0: 505, x1: 600, y1: 522, confidence: 56 },
  { text: "»", x0: 610, y0: 505, x1: 624, y1: 522, confidence: 64 },
  { text: "PRINCE", x0: 628, y0: 502, x1: 753, y1: 527, confidence: 93 },
  { text: "DEANO", x0: 767, y0: 503, x1: 886, y1: 529, confidence: 89 },
  { text: "h,", x0: 900, y0: 504, x1: 918, y1: 522, confidence: 29 },

  // Middle name. Present on the card; unreadable by the engine (see note below).
  { text: "ny", x0: 323, y0: 570, x1: 350, y1: 582, confidence: 25 },
  { text: "sitnang", x0: 360, y0: 570, x1: 440, y1: 582, confidence: 35 },
  { text: "Apelyido/Middle", x0: 712, y0: 564, x1: 876, y1: 582, confidence: 32 },
  { text: "Name", x0: 884, y0: 564, x1: 943, y1: 581, confidence: 85 },

  // Birth date. The country code "PHL" sits at the far edge of the same line.
  { text: "Sey", x0: 205, y0: 640, x1: 250, y1: 660, confidence: 57 },
  { text: "PeLsa", x0: 621, y0: 640, x1: 671, y1: 649, confidence: 9 },
  { text: "ng", x0: 680, y0: 638, x1: 706, y1: 655, confidence: 92 },
  { text: "Kapanganakan/Date", x0: 714, y0: 635, x1: 925, y1: 657, confidence: 86 },
  { text: "of", x0: 932, y0: 634, x1: 952, y1: 657, confidence: 97 },
  { text: "Birth", x0: 959, y0: 635, x1: 1006, y1: 652, confidence: 96 },
  { text: "OCTOBER", x0: 626, y0: 678, x1: 799, y1: 719, confidence: 93 },
  { text: "29,2005", x0: 813, y0: 679, x1: 945, y1: 710, confidence: 85 },
  { text: "PHL", x0: 1087, y0: 682, x1: 1160, y1: 714, confidence: 49 },
];

const layout = buildLayout(CARD_WORDS);
const { fields } = extract(layout, "philsys");

/* ================================================================== */

section("a tall word must not chain the lines beneath it");

{
  /*
   * "3872-4062-9356-0465" is 68px tall against a 17px line height, because it
   * spans. Under the previous overlap rule its bottom edge touched the "Apelydo/
   * Last Name" label 15px below, and that one word dragged every line after it
   * into the same row.
   */
  check("the card is not collapsed into a handful of rows", layout.rows.length >= 8, `${layout.rows.length} rows`);

  const numberRow = layout.rows.find((r) => r.text.includes("3872-4062"));
  check("the number is on a row of its own", numberRow?.words.length === 1, `${numberRow?.words.length} words`);

  const surnameRow = layout.rows.find((r) => r.text.includes("Apelydo/Last"));
  check("the surname label is not sharing a row with the number", surnameRow?.text.trim() === "Apelydo/Last Name", surnameRow?.text);

  const valueRow = layout.rows.find((r) => r.text.includes("RODRIGUEZ"));
  check("the surname value is on its own row", valueRow?.text.trim() === "RODRIGUEZ", valueRow?.text);

  check(
    "the label and its value are adjacent rows, not the same one",
    layout.rows.indexOf(valueRow) === layout.rows.indexOf(surnameRow) + 1
  );
}

/* ================================================================== */

section("a value printed UNDER its label is found");

{
  check("the name is read", fields.full_name.value === "RODRIGUEZ, PRINCE DEANO", fields.full_name.value);
  check("as a labelled read, not a guess", fields.full_name.strategy === "label", fields.full_name.strategy);
  check(
    "and the evidence says it was read from below the label",
    /\(below "Apelydo\/Last Name"\)/.test(fields.full_name.evidence),
    fields.full_name.evidence
  );
}

{
  /*
   * The regression that mattered most. Before the fix this card's name was "A":
   * a single stray glyph on the right-hand margin of a merged row sat to the
   * right of the label, satisfied every condition for an anchored read, and was
   * stored and shown in green as though it were a surname.
   */
  check("the name is not a single stray glyph", (fields.full_name.value ?? "").length > 1, fields.full_name.value);
  check("the surname is real", /RODRIGUEZ/.test(fields.full_name.value ?? ""), fields.full_name.value);
}

{
  /*
   * "FIRST NAME  DELA CRUZ" puts the value to the *right* of the label; this card
   * puts it underneath. Both have to work, so the beside path is asserted here on
   * the same words rather than only in the synthetic tests.
   *
   * Moving the value onto the label's row is not enough — it has to move to the
   * label's *right* as well, because a value directly beneath the text it
   * belongs to is the stacked case, not the beside one, and reading it as beside
   * would be testing nothing.
   */
  const besideWords = CARD_WORDS.map((w) =>
    w.text === "RODRIGUEZ"
      ? { ...w, x0: 900, y0: 392, x1: 1050, y1: 406 }
      : w
  );
  const beside = extract(buildLayout(besideWords), "philsys");

  check("a value beside the label is still found", /RODRIGUEZ/.test(beside.fields.full_name.value ?? ""), beside.fields.full_name.value);
  check(
    "and the evidence says it was read sideways",
    /\(beside/.test(beside.fields.full_name.evidence),
    beside.fields.full_name.evidence
  );
}

/* ================================================================== */

section("the birth date, and the country code beside it");

{
  check("the birth date is read", fields.date_of_birth.value === "2005-10-29", fields.date_of_birth.value);
  check("as a labelled read", fields.date_of_birth.strategy === "label", fields.date_of_birth.strategy);
  check(
    "and read from below its label",
    /\(below "Kapanganakan\/Date of Birth"\)/.test(fields.date_of_birth.evidence),
    fields.date_of_birth.evidence
  );
}

{
  /*
   * "PHL" is the card's country code, 80px to the right of where the label ends.
   * It was pulled into the value, making "OCTOBER 29,2005 PHL", which parses as
   * no date at all — so the one field on this card that is never in doubt came
   * back blank.
   */
  check("the country code did not enter the date", !/PHL/.test(fields.date_of_birth.evidence ?? ""), fields.date_of_birth.evidence);
}

{
  // PhilSys prints no expiry, so "nothing" is the correct answer rather than a
  // failure, and must not be dressed up as a read.
  check("no expiry is invented", fields.date_of_expiry.value === null, String(fields.date_of_expiry.value));
  check("and reported as nothing read", fields.date_of_expiry.strategy === "none", fields.date_of_expiry.strategy);
}

/* ================================================================== */

section("a number printed with no label stays a guess");

{
  /*
   * PhilSys prints the ID number bare, at the top left, with nothing naming it.
   * There is no label to anchor to, so this must remain a heuristic: shown to the
   * admin, never written to the account. Downgrading it would be the more
   * dangerous change, not the safer one.
   */
  check("the ID number is still read", fields.id_number.value === "3872-4062-9356-0465", fields.id_number.value);
  check("but only as a heuristic", fields.id_number.strategy === "heuristic", fields.id_number.strategy);
}

/* ================================================================== */

section("noise does not become a name");

{
  /*
   * The row under the given-names label is "s.- » PRINCE DEANO h," — two broken
   * glyphs, the value, and a stray mark. Quoting the whole row would give
   * "s.- PRINCE DEANO", which is not a name and reads as though it might be.
   */
  check("broken glyphs are not quoted as part of the name", !/s\.-|»|h,/.test(fields.full_name.value ?? ""), fields.full_name.value);
  check("the given names come through clean", /PRINCE DEANO/.test(fields.full_name.value ?? ""), fields.full_name.value);
}

{
  /*
   * The label "Apelyido/Middle Name" contains the word "Apelyido", which the
   * surname rule would otherwise match, claiming the middle name's row as the
   * surname's. It must not.
   */
  check("the middle-name label is not read as a surname", !/Apelyido/i.test(fields.full_name.value ?? ""), fields.full_name.value);
  check("and neither is the word 'Name' from it", !/\bNAME\b/.test(fields.full_name.value ?? ""), fields.full_name.value);
}

/* ================================================================== */

section("a single glyph can never be a name");

{
  check("'A' is not a name", looksLikeName("A") === false);
  check("'A.' is not a name", looksLikeName("A.") === false);
  check("'AB' is two letters and is accepted", looksLikeName("AB") === true);
  check("'Li' — a real two-letter mononym — survives", looksLikeName("Li") === true);
  check("'CRUZ' is a name", looksLikeName("CRUZ") === true);
  check("a digit is not a name", looksLikeName("29") === false);
  check("nothing is not a name", looksLikeName(null) === false);
  check("whitespace is not a name", looksLikeName("   ") === false);
}

{
  /*
   * The original failure, asserted at the level it actually occurred: a row
   * holding the label and a stray glyph, with no value anywhere near.
   */
  const stray = extract(
    buildLayout([
      { text: "Apelydo/Last", x0: 619, y0: 392, x1: 755, y1: 409, confidence: 44 },
      { text: "Name", x0: 763, y0: 391, x1: 822, y1: 406, confidence: 96 },
      { text: "A", x0: 1087, y0: 391, x1: 1100, y1: 406, confidence: 48 },
    ]),
    "philsys"
  );

  check("a lone glyph beside a label is not trusted as the name", stray.fields.full_name.strategy !== "label", stray.fields.full_name.strategy);
  check("and it is certainly not 'A'", stray.fields.full_name.value !== "A", String(stray.fields.full_name.value));
}

/* ================================================================== */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);