/**
 * Is this ID number the right *shape* for this kind of card?
 *
 * ## What a format check can and cannot tell you
 *
 * It tells you a number is impossible, not that it is real. A correctly-shaped
 * number belonging to someone else passes, and a real number mistyped fails. That
 * is still worth having, because inventing a plausible-looking ID number is the
 * *easy* half of a casual forgery — nobody bothers to produce a 6-digit "PhilSys
 * ID" — and because it costs nothing and cannot misfire on a genuine upload.
 *
 * What it is not is authentication. Only a government database can answer "is this
 * number Juan's", and there is no free access to one for Philippine IDs. HyperVerge
 * charges $0.42 per lookup partly for this reason. See ./card-hash.ts for what
 * actually catches reuse, and local.ts for what catches a swapped-in portrait.
 *
 * ## Why the patterns are loose
 *
 * Every rule here is "would a real card of this type be rejected?". A validator
 * that turns away a legitimate card because the government reformatted it is worse
 * than no validator: the admin learns to override it, and then it is not being
 * checked at all. So where a format has genuinely varied over the years, the
 * pattern accepts every variant and says so, rather than encoding the current one.
 */

import type { IdDocType } from "./types";

export type NumberVerdict = {
  /** True when the number cannot be a real number of this type. */
  ok: boolean;
  /** Digits, separators removed. What the comparison actually works on. */
  normalised: string;
  /** Shown when `ok` is false. */
  problem: string | null;
};

type Rule = {
  /** What a real number looks like, separators already stripped. */
  pattern: RegExp;
  /** How the card is actually printed, for the failure message. */
  shape: string;
  /** Why it is that shape, and what varies. Shown only on failure. */
  note?: string;
};

const ok = (normalised: string): NumberVerdict => ({ ok: true, normalised, problem: null });

const bad = (normalised: string, shape: string, note?: string): NumberVerdict => ({
  ok: false,
  normalised,
  problem: `A ${shape} is ${note ?? "not this shape"}, so this number cannot be right. Check it against the card.`,
});

const RULES: Record<IdDocType, Rule> = {
  philsys: {
    /*
     * Printed in five groups of four, `1234-5678-9012-3456`. Some cards and some
     * printings omit the separators, and the last group is sometimes the only one
     * shown. Four groups of four is the floor; nothing shorter is a PhilSys ID.
     */
    pattern: /^\d{16}$/,
    shape: "PhilSys ID",
    note: "sixteen digits, printed as 1234-5678-9012-3456",
  },

  lto_license: {
    /*
     * Has never been one format. Older licences are a 10-digit number, the
     * 2014-onward ones are `L##-##-######`, and provincial series use letters.
     * Anything alphanumeric, 8-14 characters, with at least one digit, is accepted —
     * a stricter rule here would reject a large share of licences in service.
     */
    pattern: /^(?=.*\d)[A-Z0-9]{8,14}$/,
    shape: "driver's licence number",
    note: "eight to fourteen letters and digits, and always contains a digit",
  },

  passport: {
    /*
     * A letter, a digit, then six or seven more, optionally followed by a letter
     * for the holder's sex — `P1234567A`. Some countries issue a plain nine
     * characters. Both are accepted.
     */
    pattern: /^[A-Z]\d{6,8}[A-Z]?$/,
    shape: "passport number",
    note: "one letter then six to eight digits, optionally ending in a letter",
  },

  sss: {
    /*
     * Ten digits, printed `12-3456789-0` in 2-7-1 groups — the last digit is a
     * check digit and is part of the ten, not a separator. There is no public
     * algorithm for it and no list of the first two, which are region codes, so
     * the shape is all that can be checked.
     */
    pattern: /^\d{10}$/,
    shape: "SSS ID",
    note: "ten digits, printed as 12-3456789-0",
  },

  umid: {
    /*
     * The CRN is twelve digits, commonly printed `12-345678-9012`. One numbering
     * series carried 13 digits before the current one, so both are allowed — the
     * cost of accepting it is low, because a 13-digit number is still not something
     * anyone invents casually.
     */
    pattern: /^\d{12,13}$/,
    shape: "UMID",
    note: "twelve or thirteen digits (the CRN)",
  },

  philhealth: {
    /* Ten digits, printed `12-34-5678-9012`. No published check digit. */
    pattern: /^\d{10}$/,
    shape: "PhilHealth number",
    note: "ten digits",
  },

  voters: {
    /*
     * There is no national format — the number is assigned by the local
     * election office, and the shapes differ between cities and provinces. Only
     * "has digits and is not absurdly long" can be said.
     */
    pattern: /^(?=.*\d)[A-Z0-9-]{6,20}$/,
    shape: "voter's ID number",
    note: "assigned by the local election office, so its shape varies",
  },

  other: {
    /* Nothing is claimed about a card this app has no template for. */
    pattern: /^[A-Z0-9-]{4,32}$/,
    shape: "ID number",
  },
};

/**
 * Strip presentation from a number and upper-case it.
 *
 * Separators are how humans read these — `1234-5678-9012-3456`, `12-3456789-0` —
 * and they are meaningless to a comparison. Exported apart from `checkIdNumber`
 * because the sign-in flow compares an OCR'd number against one an admin typed
 * months ago, and cannot assume either was formatted the same way. That
 * comparison must not depend on knowing which card either came from.
 */
export function normaliseIdNumber(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase().replace(/[\s\-–—_]/g, "");
}

/**
 * Check a number against the format for its card type.
 *
 * An empty number is `ok` with nothing normalised: the field is optional, and the
 * admin types it only when they can read it off the card. Reporting "this is the
 * wrong shape" for a blank field would be reporting a missing field as a wrong one.
 */
export function checkIdNumber(value: string | null | undefined, docType: IdDocType): NumberVerdict {
  const raw = (value ?? "").trim().toUpperCase();
  if (raw === "") return ok("");

  const normalised = normaliseIdNumber(raw);

  const rule = RULES[docType] ?? RULES.other;
  if (rule.pattern.test(normalised)) return ok(normalised);

  return bad(normalised, rule.shape, rule.note);
}
