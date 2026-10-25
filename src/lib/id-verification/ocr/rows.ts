/**
 * Turning Tesseract's word boxes back into rows of text.
 *
 * ## Why not just read the text
 *
 * `worker.recognize()` returns a `text` string, and reading it is what a naive
 * implementation does. It fails immediately on a card, because a card is not a
 * paragraph:
 *
 *   LAST NAME, FIRST NAME, MIDDLE NAME
 *   DELA CRUZ          JUAN          SANTOS
 *   DATE OF BIRTH
 *   1990-01-15   M
 *
 * Every field is on its own line with the label sitting somewhere above or beside
 * it, the dot leaders ("SURNAME . . . . .") are in the OCR output, and a column
 * of names is indistinguishable from a column of dates once line breaks are lost.
 * The bounding boxes are the only part of the response that carries the layout,
 * so this module exists to put it back.
 *
 * ## Nothing here imports tesseract
 *
 * It takes plain objects with `text` and a box, and returns rows. That keeps the
 * awkward part — grouping — testable in Node with hand-written input, where a
 * failing case can be written down in six lines rather than photographed onto a
 * card. See scripts/_ocr-tests.mjs.
 */

/** One recognised word and where Tesseract put it. */
export type OcrWord = {
  text: string;
  /** 0-100, Tesseract's own estimate. */
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

/** Words sharing a line of text, left to right. */
export type OcrRow = {
  words: OcrWord[];
  /** The row's text, single-spaced. */
  text: string;
  /** Mean confidence of the row's words. */
  confidence: number;
  /** Vertical centre, used for ordering and for column detection. */
  y: number;
  /** Median word height in the row — a decent stand-in for the line's height. */
  height: number;
  x0: number;
  x1: number;
};

export type OcrLayout = {
  rows: OcrRow[];
  /** The whole page's text, rows joined by newlines. */
  text: string;
  /** Mean confidence across every word. */
  confidence: number;
  width: number;
  height: number;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * How close two words' centres must be to share a line, as a fraction of the
 * median word height.
 *
 * ## Why this is a centre gap and not a vertical overlap
 *
 * The previous rule grouped words by how much their boxes overlapped, comparing
 * each new word against the *running union* of the row so far. That union only
 * ever grows, so one tall word becomes an anchor that chains every line it can
 * touch into a single row, and the chain never breaks because each merge widens
 * the target for the next one.
 *
 * On a real PhilSys card that produced these rows:
 *
 *   "3872-4062-9356-0465 W hi li Apelydo/Last Name A"
 *   "Sey ny ; PeLsa sitnang = OCTOBER ng Apelyido/Middle Kapanganakan/Date
 *    29,2005 Name of Birth 4 - PHL \ \N"
 *
 * — nineteen words across four printed lines. The ID number's box is 68px tall
 * because it spans, its bottom edge touched the label 15px below it, and
 * everything after that was dragged along with it.
 *
 * A centre gap cannot chain, because it is measured against the *previous* word
 * rather than against a growing extent. On that same card the centres run
 * 375 (ID number), 400 (the "Last Name" label), 437 (RODRIGUEZ), 470 (the "Given
 * Names" label), 515 (PRINCE DEANO) — and 0.7 of a median 18px word height is
 * ~12px, which separates every one of them.
 *
 * The ratio is below 0.5 on purpose: words on the same printed line differ in
 * centre by a few pixels because of ascenders, descenders and perspective, so a
 * tighter band would shred a real line into fragments.
 */
const ROW_GAP_RATIO = 0.7;

/**
 * Group words into rows by how close their vertical centres are.
 *
 * Sorted by centre and swept once, so words are compared only against the row
 * they would join rather than every pair in the document — the naive pairwise
 * version is quadratic and a noisy photograph of a card has thousands of words.
 */
export function buildRows(words: OcrWord[]): OcrRow[] {
  const usable = words.filter((w) => w.text && w.text.trim().length > 0);
  if (usable.length === 0) return [];

  /*
   * The line height is taken across the whole page rather than per cluster. A
   * median is used because a card photograph is mostly large printed text with a
   * few tiny artefacts, and the artefacts are exactly the words that would
   * otherwise set a tiny line height and then reject every real line.
   */
  const lineHeight = median(usable.map((w) => w.y1 - w.y0)) || 1;
  const gap = lineHeight * ROW_GAP_RATIO;

  const centre = (w: OcrWord) => (w.y0 + w.y1) / 2;
  const sorted = [...usable].sort((a, b) => centre(a) - centre(b));

  const groups: OcrWord[][] = [];
  let current: OcrWord[] = [sorted[0]];
  let currentCentre = centre(sorted[0]);

  for (const word of sorted.slice(1)) {
    const c = centre(word);

    // Half a gap either way, so the running centre can sit between two words
    // rather than always sitting on the most recent one.
    if (Math.abs(c - currentCentre) <= gap / 2) {
      current.push(word);
      currentCentre = mean(current.map(centre));
    } else {
      groups.push(current);
      current = [word];
      currentCentre = c;
    }
  }
  groups.push(current);

  return groups.map((group) => {
    const wordsInRow = [...group].sort((a, b) => a.x0 - b.x0);
    const heights = wordsInRow.map((w) => w.y1 - w.y0);
    const height = median(heights);

    return {
      words: wordsInRow,
      text: wordsInRow.map((w) => w.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
      confidence: mean(wordsInRow.map((w) => w.confidence)),
      y: wordsInRow.reduce((sum, w) => sum + (w.y0 + w.y1) / 2, 0) / wordsInRow.length,
      height: height || 1,
      x0: Math.min(...wordsInRow.map((w) => w.x0)),
      x1: Math.max(...wordsInRow.map((w) => w.x1)),
    };
  });
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Flatten words into a layout.
 *
 * The `text` is rebuilt from the rows rather than taken from Tesseract's own, so
 * that what the templates read and what the admin might paste into the log are the
 * same string.
 */
export function buildLayout(
  words: OcrWord[],
  size: { width: number; height: number } = { width: 0, height: 0 }
): OcrLayout {
  const rows = buildRows(words);

  return {
    rows,
    text: rows.map((r) => r.text).join("\n"),
    confidence: mean(words.map((w) => w.confidence)),
    width: size.width,
    height: size.height,
  };
}

/**
 * Drop words that are decorative rather than textual.
 *
 * Dot leaders ("SURNAME . . . . . . VALUE") and stray punctuation survive OCR as
 * real tokens and would otherwise be picked up as the start of a value. Removed
 * here rather than at each use site so every caller gets the same definition of
 * "a word".
 */
export function isFillerWord(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  // Runs of dots, dashes, bullets, pipes.
  if (/^[.\-–—_|,·•…]+$/.test(t)) return true;
  // A lone character left over from a broken glyph.
  if (t.length === 1 && !/[A-Z0-9]/i.test(t)) return true;
  return false;
}

/** The row's words with fillers and empty tokens removed. */
export function contentWords(row: OcrRow): OcrWord[] {
  return row.words.filter((w) => !isFillerWord(w.text));
}

/**
 * The words covered by a label's match on this row.
 *
 * ## Why this is not just "test each word against the regex"
 *
 * Because it silently does nothing for every multi-word label on every card. A
 * rule for `/\bLAST\s+NAME\b/i` never matches the word "LAST", and never matches
 * the word "NAME", so a row-by-word test finds no label, skips the rule, and the
 * extraction quietly falls through to a heuristic. That is what happened on the
 * first run: PhilSys cards came back `strategy: heuristic` with the name right
 * there beside the label, because "LAST NAME DELA CRUZ" was being read as a
 * floating name rather than as a label and its value.
 *
 * The match is made against the joined text — which is the only place a multi-word
 * pattern can match at all — and this maps the resulting character span back onto
 * the words that produced it, so the label's extent is known and the value beside
 * it is unambiguous.
 */
export function wordsInMatch(row: OcrRow, label: RegExp): OcrWord[] {
  const match = label.exec(row.text);
  if (!match || match.index === undefined) return [];

  const start = match.index;
  const end = start + match[0].length;

  /*
   * Character offsets are recomputed from the same join that produced `row.text`,
   * so the two cannot drift apart. One space per boundary, matching the join in
   * buildRows.
   */
  const hits: OcrWord[] = [];
  let offset = 0;

  for (const word of row.words) {
    const token = word.text.trim();
    const from = offset;
    const to = offset + token.length;
    offset = to + 1;

    if (from < end && to > start) hits.push(word);
  }

  return hits;
}

/**
 * How far past a label a value may start, in multiples of the label's height,
 * floored at one label-width.
 *
 * Without a bound, "beside" means anywhere on the rest of the row — which on a
 * card is the whole card. On a real PhilSys, the label "Apelydo/Last Name" ends at
 * x=822 and a stray glyph sat at the card's right margin; it was returned as the
 * name, which is how a card whose surname is printed in 96%-confidence capitals
 * produced the name "A".
 *
 * The floor matters as much as the bound. Scaling only by height assumes a fixed
 * relationship between a glyph's height and a letter's width, which holds on a
 * photograph and not on a synthetic card: in the unit tests a token is 14px per
 * character against a 24px line, so "CRUZ" sat just beyond three line-heights of
 * "LAST NAME" and the name came back as "DELA". One label-width is the smallest
 * reach that can always hold a value at least as wide as the label naming it.
 */
const BESIDE_REACH = 3;

/**
 * The text to the left or right of a label, within the same row.
 *
 * `side` is named from the *label's* point of view, so `"right"` means "the value
 * is printed after the label", which is how UMID does it. LTO's licence does the
 * reverse on some printings, which is why both sides are supported rather than the
 * layout being hardcoded to whichever card happened to be photographed first.
 */
export function wordsBeside(
  row: OcrRow,
  labelWords: OcrWord[],
  side: "left" | "right"
): OcrWord[] {
  const content = contentWords(row);
  if (labelWords.length === 0) return [];
  const kept = new Set(labelWords);

  // Anchor on the label's extent, so "NAME" in a two-word label cannot be matched
  // halfway and cut the row in the wrong place.
  const labelLeft = Math.min(...labelWords.map((w) => w.x0));
  const labelRight = Math.max(...labelWords.map((w) => w.x1));

  const labelHeight =
    median(labelWords.map((w) => w.y1 - w.y0)) || row.height || 1;
  const reach = Math.max(labelHeight * BESIDE_REACH, labelRight - labelLeft);

  if (side === "right") {
    return content.filter(
      (w) => !kept.has(w) && w.x0 >= labelRight && w.x0 <= labelRight + reach
    );
  }
  return content
    .filter((w) => !kept.has(w) && w.x1 <= labelLeft && w.x1 >= labelLeft - reach)
    .reverse();
}

/**
 * The text directly *below* a label, on the next row.
 *
 * ## Why this exists
 *
 * Most ID cards print the label on one line and the value on the next:
 *
 *     Apelyido/Last Name
 *     RODRIGUEZ
 *
 * `wordsBeside` cannot see that — the value is not in the label's row — and the
 * stacked mode that does exist reads the row *above* the label, which is the
 * opposite arrangement (LTO prints labels below their values).
 *
 * So PhilSys was unreadable by construction. Not a tolerance problem: no amount
 * of tuning found a name on that card that is printed underneath its own label.
 *
 * ## Why x-overlap is the test
 *
 * Two rows on a card are related when they sit in the same column. On the card
 * above, the label spans x619-822 and "RODRIGUEZ" spans x628-829 — almost exactly
 * the same column. Requiring horizontal overlap rejects the neighbouring fields
 * (the given-names label starts at x671 but the row beneath it is the middle
 * name's value, not this label's) without needing to know which of them is which.
 */
export function wordsBelow(
  rows: OcrRow[],
  labelRowIndex: number,
  labelWords: OcrWord[]
): OcrWord[] {
  const next = rows[labelRowIndex + 1];
  if (!next || labelWords.length === 0) return [];

  const labelLeft = Math.min(...labelWords.map((w) => w.x0));
  const labelRight = Math.max(...labelWords.map((w) => w.x1));

  /*
   * A quarter of the label's width, either side.
   *
   * Half was too generous and cost a date. The label "Kapanganakan/Date of Birth"
   * spans x714-1006, and "PHL" — the country code at the card's far edge — sits at
   * x1087, inside a half-width margin. It was pulled into the birth date, and
   * "OCTOBER 29,2005 PHL" is not a date any parser can read.
   *
   * A quarter still covers the real cases: the value is often set slightly wider
   * than the label ("RODRIGUEZ" spans x628-829 under a label at x619-822), and a
   * value that starts *left* of its label is common on cards with an indented
   * value column.
   */
  const margin = (labelRight - labelLeft) * 0.25;

  return contentWords(next).filter((w) => w.x1 > labelLeft - margin && w.x0 < labelRight + margin);
}

/**
 * The text directly *above* a label, on the previous row. The mirror of
 * `wordsBelow`, for cards that print the value first.
 */
export function wordsAbove(
  rows: OcrRow[],
  labelRowIndex: number,
  labelWords: OcrWord[]
): OcrWord[] {
  const prev = rows[labelRowIndex - 1];
  if (!prev || labelWords.length === 0) return [];

  const labelLeft = Math.min(...labelWords.map((w) => w.x0));
  const labelRight = Math.max(...labelWords.map((w) => w.x1));
  const margin = (labelRight - labelLeft) * 0.25;

  return contentWords(prev).filter((w) => w.x1 > labelLeft - margin && w.x0 < labelRight + margin);
}
