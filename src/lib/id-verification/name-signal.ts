/**
 * Comparing the name on an ID against the name on the account.
 *
 * Split out of ./index.ts because it is the one check in this feature that is not
 * a provider's job: it needs a name read off the card *and* a name on the
 * account, and only the first of those belongs to any single provider.
 *
 * It also has a property no other part of the feature has — it can only ever run
 * if something was configured that reads text — which makes it worth being its
 * own module with no runtime imports, so the rule can be tested in Node without
 * a vendor, a database or a card.
 */
import type { IdSignal } from "./types";

/**
 * Why a name is or is not available.
 *
 * Four states rather than a yes/no, because two of them are configuration
 * problems and two are not, and telling them apart is the entire point of this
 * module.
 *
 *   ok                     a name was read, and by an anchored method
 *   no_reader_configured   nothing in this app can read text off a card
 *   model_missing          the reader is set up but its language file is not
 *                          downloaded yet — a first run with no internet
 *   ran_but_read_nothing   a reader ran, on this card, and found no name
 *
 * The middle two used to be indistinguishable, and both were reported as the
 * last one. An admin reading "no name was read off the card" on a café whose
 * first OCR run happened offline has been told the wrong thing, and will conclude
 * the feature is broken rather than that it needs one internet connection.
 */
export type NameReadStatus =
  | "ok"
  | "no_reader_configured"
  | "model_missing"
  | "ran_but_read_nothing";

const NO_NAME_MESSAGES: Record<Exclude<NameReadStatus, "ok">, string> = {
  no_reader_configured:
    "No ID-reading service is set up, so names cannot be read off a card automatically. " +
    "This check stays unavailable until one is configured — the face and card " +
    "checks still run. Check the name against the roster yourself.",

  model_missing:
    "The on-device text reader is set up but its language file has not been " +
    "downloaded yet, so it could not read this card. It needs one internet " +
    "connection to fetch it; after that it works offline. The face and card " +
    "checks still ran. Check the name against the roster yourself.",

  ran_but_read_nothing:
    "No name was read off the card, so it could not be compared with this account. " +
    "The photo may be blurry or the card may be a type this app has no template " +
    "for. Check the name on the card against the roster yourself.",
};

/**
 * Compare the surname on the card against the surname on the account.
 *
 * Surnames only, and the reason is that full-name comparison does not survive
 * contact with Philippine naming. A card reading "DELA CRUZ, JUAN SANTOS"
 * against an account reading "Juan Dela Cruz" is the *same person*, and a rule
 * that flagged it would fire on nearly every correct upload — which is worse than
 * no rule at all, because it trains an admin to ignore the signal.
 *
 * So: case, punctuation and the particles that are part of a Filipino surname
 * rather than separate words are normalised away, and a middle name appearing on
 * one side and not the other is not counted either way.
 *
 * It also has a property no other part of the feature has — it can only ever run
 * if something was configured that reads text — which is why it is its own module
 * with no runtime imports, so the rule can be tested in Node without a vendor, a
 * database or a card.
 */
export function nameSignal(
  cardName: string | null | undefined,
  expectedName: string | null | undefined,
  status: NameReadStatus = "no_reader_configured"
): IdSignal {
  const label = "Name on the ID";

  if (!cardName || !cardName.trim()) {
    return {
      id: "name_match",
      label,
      tone: "unknown",
      detail: NO_NAME_MESSAGES[status === "ok" ? "ran_but_read_nothing" : status],
    };
  }

  if (!expectedName || !expectedName.trim()) {
    return {
      id: "name_match",
      label,
      tone: "unknown",
      detail: `The card reads "${cardName.trim()}", but this account has no name to compare it against.`,
    };
  }

  const normalise = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  /*
   * "Dela", "de la", "san" and friends are parts of a surname, not separate
   * words — comparing on the last *word* would compare "CRUZ" against "CRUZ" by
   * luck and "SANTOS" against "CRUZ" by accident.
   */
  const PARTICLES = new Set([
    "DELA",
    "DE",
    "DA",
    "LA",
    "SAN",
    "SANTA",
    "NG",
    "BIN",
    "BINTANAM",
  ]);

  const lastToken = (s: string) => {
    const parts = normalise(s)
      .split(" ")
      .filter((p) => p.length > 0 && !PARTICLES.has(p));
    return parts.length ? parts[parts.length - 1] : null;
  };

  /**
   * The surname, wherever the document happens to put it.
   *
   * **Philippine cards print `SURNAME, GIVEN NAMES`.** So on a card reading
   * "DELA CRUZ, JUAN SANTOS" the surname is the part *before* the comma, and the
   * last token — "SANTOS" — is a given name. Taking the last token therefore
   * compared one person's given name against another person's surname, which
   * flags the correct upload as a different person.
   *
   * That is precisely the failure this function's own header warns about: a rule
   * that fires on nearly every correct card is worse than no rule, because an
   * admin learns to ignore it. It was unreachable while no OCR was configured,
   * which is why it sat unnoticed behind a message saying names cannot be read.
   *
   * So a comma means the surname is what precedes it. With no comma — a passport,
   * or a name typed into a free-text field — fall back to the last token, which is
   * right for the "Juan Dela Cruz" form an account name holds.
   */
  const surname = (s: string) => {
    const trimmed = String(s ?? "").trim();
    if (!trimmed) return null;

    const comma = trimmed.indexOf(",");
    const head = comma > 0 ? trimmed.slice(0, comma) : "";

    if (head.trim()) return lastToken(head);

    return lastToken(trimmed);
  };

  const fromCard = surname(cardName);
  const fromAccount = surname(expectedName);

  if (!fromCard || !fromAccount) {
    return {
      id: "name_match",
      label,
      tone: "unknown",
      detail: "One of the two names had no usable surname to compare.",
    };
  }

  if (fromCard === fromAccount) {
    return {
      id: "name_match",
      label,
      tone: "pass",
      detail:
        `The card reads "${cardName.trim()}" and this account is ${expectedName.trim()}. ` +
        "Same surname.",
    };
  }

  return {
    id: "name_match",
    label,
    tone: "fail",
    detail:
      `The card reads "${cardName.trim()}" but this account is ${expectedName.trim()}. ` +
      "Different surnames — check whether the wrong person's ID was attached.",
  };
}