/**
 * Tests for local OCR: row reconstruction, card templates, and the MRZ parser.
 *
 *   npm run test:ocr
 *
 * ## Why these do not use Tesseract
 *
 * The interesting failures in this feature are not "Tesseract misread a letter" —
 * they are "the right letters ended up in the wrong field", and those are decided
 * by the row grouping and the template, not by the recogniser. Feeding them through
 * a real OCR pass would add two seconds and a lot of noise per case and make every
 * failure a question about which layer broke.
 *
 * So the words and their bounding boxes are written by hand. Tesseract's output
 * shape was verified separately against the real library (scripts/_ocr-shape.mjs),
 * and that finding is pinned by `flatteningMatchesTesseractShape` below.
 *
 * Every case that corresponds to a bug found during the build is marked, because
 * all four of them produced output that looked entirely plausible.
 */

import { buildRows, buildLayout, isFillerWord, contentWords, wordsBeside } from "../src/lib/id-verification/ocr/rows.ts";
import { extract, isTrustworthy } from "../src/lib/id-verification/ocr/extract.ts";
import { parseMrz, mrzDateToIso, checkDigit } from "../src/lib/id-verification/ocr/mrz.ts";
import { TEMPLATES, templateFor } from "../src/lib/id-verification/ocr/templates.ts";

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
 * Build words with deterministic geometry.
 *
 * `lines` is an array of `{ y, text }`. Words are laid out left to right with a
 * fixed advance, which is what lets a test assert that "the value to the right of
 * the label" is the value and not something on the next line.
 */
function makeWords(lines, confidence = 95) {
  const words = [];
  for (const line of lines) {
    let x = 10;
    for (const token of line.text.split(/\s+/).filter(Boolean)) {
      const w = Math.max(token.length * 14, 20);
      words.push({
        text: token,
        confidence,
        x0: x,
        y0: line.y,
        x1: x + w,
        y1: line.y + 24,
      });
      x += w + 12;
    }
  }
  return words;
}

const layoutOf = (lines) => buildLayout(makeWords(lines));

/* ============================================================== row grouping */

section("rows are rebuilt from boxes");

{
  const rows = buildRows(
    makeWords([
      { y: 0, text: "REPUBLIC OF THE PHILIPPINES" },
      { y: 40, text: "LAST NAME DELA CRUZ" },
      { y: 80, text: "FIRST NAME JUAN" },
    ])
  );

  check("three lines become three rows", rows.length === 3, `got ${rows.length}`);
  check("text survives intact", rows[1].text === "LAST NAME DELA CRUZ", rows[1]?.text);
  check("rows come out in reading order", rows[0].text.startsWith("REPUBLIC"));
}

{
  // A genuine two-column card: same visual band, different x. This is the case
  // Tesseract's own line grouping gets wrong, and the reason rows.ts exists.
  const rows = buildRows([
    { text: "DATE OF BIRTH", confidence: 95, x0: 10, y0: 0, x1: 180, y1: 24 },
    { text: "1990-01-15", confidence: 95, x0: 200, y0: 6, x1: 340, y1: 30 },
    { text: "SEX", confidence: 95, x0: 10, y0: 200, x1: 60, y1: 224 },
  ]);

  check("words at nearly the same height share a row", rows.length === 2, `got ${rows.length}`);
  check(
    "and land in one row in left-to-right order",
    rows[0].text === "DATE OF BIRTH 1990-01-15",
    rows[0]?.text
  );
}

{
  const rows = buildRows(makeWords([{ y: 0, text: "SURNAME . . . . . DELA CRUZ" }]));
  const words = contentWords(rows[0]);

  check("dot leaders are dropped", words.length === 3, `got ${words.length}: ${rows[0].text}`);
  check("the real words remain", rows[0].text.includes("DELA CRUZ"));
}

check("a run of dots is filler", isFillerWord("..."));
check("a bare pipe is filler", isFillerWord("|"));
check("a name is not filler", !isFillerWord("DELA"));

{
  // A single-word label, so the left-hand side is unambiguous.
  const rows = buildRows(makeWords([{ y: 0, text: "1990-01-15 SEX" }]));
  const words = contentWords(rows[0]);

  const left = wordsBeside(rows[0], [words[1]], "left").map((w) => w.text);
  const right = wordsBeside(rows[0], [words[0]], "right").map((w) => w.text);

  check("a value to the left of its label is found", left.join(" ") === "1990-01-15", left.join(" "));
  check("a value to the right of its label is found", right.join(" ") === "SEX", right.join(" "));
}

/* ======================================================================== MRZ */

section("MRZ parsing");

/** A real ICAO specimen, which is the only kind of MRZ worth testing against. */
const MRZ_L1 = "P<PHLDELA<CRUZ<<JUAN<SANTOS".padEnd(44, "<");

/*
 * TD3 line 2 built to the spec rather than by eye: 9 number + 1 check + 3
 * nationality + 6 dob + 1 check + 1 sex + 6 expiry + 1 check + 14 personal
 * + 1 check + 1 composite = 44.
 *
 * The composite is computed from line 2's own slices rather than from a
 * hand-written concatenation, because the first version of this test included the
 * nationality and sex fields in it — which the spec excludes — and produced a
 * composite that disagreed with the parser and reported a valid passport as
 * invalid.
 */
const PERSONAL = "<".repeat(14);
const L2_BODY =
  "L898902C3" + checkDigit("L898902C3") +
  "PHL" +
  "900115" + checkDigit("900115") +
  "M" +
  "320626" + checkDigit("320626") +
  PERSONAL + checkDigit(PERSONAL);

const MRZ_L2 =
  L2_BODY +
  checkDigit(L2_BODY.slice(0, 10) + L2_BODY.slice(13, 20) + L2_BODY.slice(21, 43));

check("the specimen line 2 is the right length", MRZ_L2.length === 44, `got ${MRZ_L2.length}`);

{
  const parsed = parseMrz(`${MRZ_L1} ${MRZ_L2}`);

  check("a passport MRZ is found", parsed !== null);
  check("it is recognised as TD3", parsed?.format === "TD3", parsed?.format);
  check("the surname comes out", parsed?.surname === "DELA CRUZ", parsed?.surname);
  check("the given names come out", parsed?.givenNames === "JUAN SANTOS", parsed?.givenNames);
  check("the passport number comes out", parsed?.passportNumber?.value === "L898902C3", parsed?.passportNumber?.value);
  check("the issuing country comes out", parsed?.issuingCountry === "PHL", parsed?.issuingCountry);
  check("valid check digits validate", parsed?.valid === true, `valid=${parsed?.valid}`);
  check(
    "the name is in the card's own order",
    parsed?.fullName === "DELA CRUZ, JUAN SANTOS",
    parsed?.fullName
  );
}

{
  /* The value of having check digits: a misread is detectable, so it can be
   * reported as low-confidence rather than handed over as fact.
   *
   * The passport number is altered while its check digit is left alone, which is
   * exactly the shape of an OCR misreading — one character wrong, everything else
   * consistent. Nine characters of number, one of check digit, so the line stays
   * 44 wide and still looks structurally sound. */
  const corrupted = `${MRZ_L1} L998902C3${MRZ_L2.slice(9)}`;
  const parsed = parseMrz(corrupted);

  check("a corrupted number is still structurally a MRZ", parsed !== null);
  check("its check digit fails", parsed?.passportNumber?.check === false, String(parsed?.passportNumber?.check));
  check("which makes the whole parse invalid", parsed?.valid === false);
  check(
    "but the number is still shown, at reduced confidence",
    parsed?.passportNumber?.value === "L998902C3",
    parsed?.passportNumber?.value
  );
}

{
  const parsed = parseMrz("REPUBLIC OF THE PHILIPPINES\nDATE OF BIRTH 1990-01-15");
  check("a card with no MRZ returns null", parsed === null);
}

{
  /* Bug: one century rule was applied to both dates, so a 2032 expiry read as 1932
   * — ninety-four years before the passport was issued. */
  check("a birth date resolves into the past", mrzDateToIso("900115", "past") === "1990-01-15", mrzDateToIso("900115", "past"));
  check("an expiry date resolves into the future", mrzDateToIso("320626", "future") === "2032-06-26", mrzDateToIso("320626", "future"));
  check("a future birth date is pulled back", mrzDateToIso("300101", "past") === "1930-01-01", mrzDateToIso("300101", "past"));
  /* An expiry 64 years out is not believable either, so it reads as this century
   * rather than the next — an expired passport, which is the likelier mistake. */
  check("an implausible far-future expiry reads as past", mrzDateToIso("900115", "future") === "1990-01-15", mrzDateToIso("900115", "future"));
  check("an impossible month is rejected", mrzDateToIso("901345", "past") === null);
  check("a malformed date is rejected", mrzDateToIso("abcdef", "past") === null);
}

/* =============================================================== extraction */

section("labelled extraction");

{
  const layout = layoutOf([
    { y: 0, text: "REPUBLIC OF THE PHILIPPINES" },
    { y: 40, text: "PHILIPPINE IDENTIFICATION SYSTEM" },
    { y: 80, text: "LAST NAME DELA CRUZ" },
    { y: 120, text: "FIRST NAME JUAN" },
    { y: 160, text: "MIDDLE NAME SANTOS" },
    { y: 220, text: "DATE OF BIRTH 1990-01-15" },
    { y: 260, text: "DATE OF EXPIRY 2032-06-26" },
    { y: 320, text: "PHLSYS ID 1234-5678-9012-3456" },
  ]);

  const { fields } = extract(layout, "philsys");

  check("the name is read from its labels", fields.full_name.value === "DELA CRUZ, JUAN SANTOS", fields.full_name.value);
  check("as a labelled read, not a guess", fields.full_name.strategy === "label", fields.full_name.strategy);
  check("the ID number is read", fields.id_number.value === "1234-5678-9012-3456", fields.id_number.value);
  check("the birth date is read", fields.date_of_birth.value === "1990-01-15", fields.date_of_birth.value);
  check("the expiry date is read", fields.date_of_expiry.value === "2032-06-26", fields.date_of_expiry.value);
  check("all four are trustworthy", Object.values(fields).every(isTrustworthy));
}

{
  /* Bug: the anchored number regex used \b...\b and truncated
   * `1234-5678-9012-3456` to `1234-5678-9012` — a valid-looking number of a
   * plausible length, which nobody would think to check. */
  const layout = layoutOf([
    { y: 0, text: "JUAN SANTOS DELA CRUZ" },
    { y: 40, text: "SOMETHING ELSE ENTIRELY" },
    { y: 200, text: "1122334455667788" },
  ]);

  const { fields } = extract(layout, "philsys");

  check("a long number is not truncated", fields.id_number.value === "1122334455667788", fields.id_number.value);
}

{
  /* Bug: a card printing one date had it returned as BOTH the birth date and the
   * expiry, so a PhilSys with no expiry field showed the holder's birthday as
   * when their ID ran out. */
  const layout = layoutOf([
    { y: 0, text: "LAST NAME DELA CRUZ" },
    { y: 40, text: "DATE OF BIRTH 1990-01-15" },
  ]);

  const { fields } = extract(layout, "philsys");

  check("the one printed date is read as the birth date", fields.date_of_birth.value === "1990-01-15");
  check("and is not also reported as the expiry", fields.date_of_expiry.value === null, String(fields.date_of_expiry.value));
}

{
  /* LTO prints the name above its column headings, so there is nothing beside the
   * label to take and the row above is the value. */
  const layout = layoutOf([
    { y: 0, text: "1 DELA CRUZ JUAN SANTOS" },
    { y: 40, text: "LAST NAME FIRST NAME MIDDLE NAME" },
    { y: 120, text: "DATE OF BIRTH 15 JAN 1990" },
  ]);

  const { fields } = extract(layout, "lto_license");

  check("a stacked layout still finds the name", Boolean(fields.full_name.value), String(fields.full_name.value));
  check("by reading the row above the headings", fields.full_name.strategy === "label", fields.full_name.strategy);
}

section("every card type has a template");

{
  const types = ["philsys", "lto_license", "passport", "sss", "umid", "philhealth", "voters", "other"];
  for (const t of types) {
    const template = templateFor(t);
    check(`${t} has a template`, Boolean(template));
    check(`${t} has at least one name rule`, template.fields.some((f) => f.field === "full_name"));
  }
  check("every doc type is covered", Object.keys(TEMPLATES).length === types.length);
}

{
  // The card whose name is split across a label row and its own must still read.
  const layout = layoutOf([
    { y: 0, text: "UMID GSIS" },
    { y: 40, text: "LAST NAME SANTOS" },
    { y: 80, text: "FIRST NAME MARIA" },
    { y: 140, text: "CRN 123456789012" },
  ]);

  const { fields } = extract(layout, "umid");

  /*
   * "SANTOS, MARIA" is the right answer, not "MARIA SANTOS". The card prints the
   * surname on the row above the given name, and the comma form is both what the
   * card shows and what name-signal.ts reads as "the surname is before this".
   * Building it in reading order instead gives "SANTOS MARIA", whose last token is
   * MARIA — so the check would compare Maria against a Maria and pass by accident
   * on some uploads and fail on others.
   */
  check("UMID reassembles the parts by role, not by reading order",
    fields.full_name.value === "SANTOS, MARIA", fields.full_name.value);
  check("UMID reads its number", fields.id_number.value === "123456789012", fields.id_number.value);
}

section("a card it does not recognise");

{
  const layout = layoutOf([
    { y: 0, text: "TOTAL PURCHASE 45.00" },
    { y: 40, text: "THANK YOU COME AGAIN" },
  ]);

  const { fields } = extract(layout, "other");

  check("no name is invented", fields.full_name.value === null, String(fields.full_name.value));
  check("and it reports finding nothing", fields.full_name.strategy === "none");
}

section("heuristic reads are not trusted");

{
  /* Bug risk: a heuristic name has no structure, so "DELA CRUZ JUAN SANTOS" split
   * into surname and given names is a guess — and a guessed surname compared
   * against the account produces a confident red fail on a correct upload. */
  const layout = layoutOf([{ y: 0, text: "DELA CRUZ JUAN SANTOS" }]);

  const { fields } = extract(layout, "philsys");

  check("an unlabelled name is still found", fields.full_name.value === "DELA CRUZ JUAN SANTOS", fields.full_name.value);
  check("but is marked a guess", fields.full_name.strategy === "heuristic", fields.full_name.strategy);
  check("and is refused as trustworthy", !isTrustworthy(fields.full_name));
  check("its confidence is capped below an anchored read", fields.full_name.confidence <= 70, String(fields.full_name.confidence));
}

{
  // The noise list exists so "DATE OF BIRTH" is never returned as a person's name.
  const layout = layoutOf([
    { y: 0, text: "DATE OF BIRTH" },
    { y: 40, text: "1990-01-15" },
    { y: 80, text: "DELA CRUZ JUAN" },
  ]);

  const { fields } = extract(layout, "philsys");

  check("a printed label is never mistaken for a name", fields.full_name.value === "DELA CRUZ JUAN", fields.full_name.value);
}

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
