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

/** Reformat the common card layout "SURNAME, GIVEN MIDDLE" for review. */
export function formatIdNameForDisplay(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? "";
  const comma = trimmed.indexOf(",");
  if (comma <= 0) return trimmed;

  const surname = trimmed.slice(0, comma).trim();
  const given = trimmed.slice(comma + 1).trim();
  return surname && given ? `${given} ${surname}` : trimmed;
}

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
 * Compare both surname and the primary given name. A surname match is not enough:
 * a common surname can belong to many people. Card and account formats vary, so
 * punctuation, case, Filipino surname particles, and an OCR-style one-character
 * difference are handled, while middle names omitted on either side are tolerated.
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

  const tokens = (s: string) =>
    normalise(s).split(" ").filter((part) => part.length > 0);

  const namesMatch = (left: string, right: string) => {
    if (left === right) return true;
    if (Math.min(left.length, right.length) < 4) return false;
    const tolerance = 1;
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i++) {
      const current = [i];
      for (let j = 1; j <= right.length; j++) {
        current[j] = Math.min(
          current[j - 1] + 1,
          previous[j] + 1,
          previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    return previous[right.length] <= tolerance;
  };

  const splitAccountName = (name: string) => {
    const comma = name.indexOf(",");
    if (comma > 0) {
      const surname = tokens(name.slice(0, comma));
      const given = tokens(name.slice(comma + 1));
      return { surname: surname.join(" "), given };
    }

    const all = tokens(name);
    if (all.length < 2) return { surname: "", given: [] };

    // Multi-word surnames with particles (Dela Cruz, De los Santos) belong to the
    // surname, while ordinary single surnames use the final token.
    let surnameStart = all.length - 1;
    if (surnameStart > 0 && PARTICLES.has(all[surnameStart - 1])) {
      surnameStart -= 1;
      while (surnameStart > 0 && PARTICLES.has(all[surnameStart - 1])) surnameStart -= 1;
    }

    return {
      surname: all.slice(surnameStart).join(" "),
      given: all.slice(0, surnameStart),
    };
  };

  const trimmedCard = cardName.trim();
  const comma = trimmedCard.indexOf(",");
  const cardNameParts =
    comma > 0
      ? {
          surname: tokens(trimmedCard.slice(0, comma)).join(" "),
          given: tokens(trimmedCard.slice(comma + 1)),
        }
      : splitAccountName(trimmedCard);
  const cardSurname = cardNameParts.surname;
  const cardGiven = cardNameParts.given;
  const account = splitAccountName(expectedName);

  if (!cardSurname || !cardGiven.length || !account.surname || !account.given.length) {
    return {
      id: "name_match",
      label,
      tone: "unknown",
      detail: "The card or account did not contain enough surname and given-name parts to compare.",
    };
  }

  const surnameMatches = namesMatch(cardSurname, account.surname);
  const givenMatches = account.given.map((expected) =>
    cardGiven.some((actual) => namesMatch(actual, expected))
  );
  const primaryGivenMatches = givenMatches[0] ?? false;

  if (!surnameMatches) {
    return {
      id: "name_match",
      label,
      tone: "fail",
      detail:
        `The card reads "${trimmedCard}" but this account is ${expectedName.trim()}. ` +
        "The surname and full-name details do not identify the account holder consistently.",
    };
  }

  if (!primaryGivenMatches) {
    const missing = account.given[0] ?? "";
    return {
      id: "name_match",
      label,
      tone: "fail",
      detail:
        `The card reads "${trimmedCard}" but this account is ${expectedName.trim()}. ` +
        `The card does not contain the account holder's given name${missing ? ` "${missing}"` : ""}; ` +
        "the same surname alone is not enough to match.",
    };
  }

  return {
    id: "name_match",
    label,
    tone: "pass",
    detail:
      `The card reads "${trimmedCard}" and this account is ${expectedName.trim()}. ` +
      "The surname and given-name details match.",
  };
}