/**
 * Finding the one account a scanned ID card belongs to.
 *
 * ## Why this returns exactly one or nothing
 *
 * The whole point of this feature is that the ID card **identifies** an account
 * and the face **authenticates** the person holding it. That is the same shape as
 * the existing badge flow in api/auth/face-login/route.ts, where a barcode narrows
 * to one account and the camera then confirms the face against that account alone.
 *
 * So this module's most important output is a refusal. Two accounts matching the
 * same card is not a harder version of the question — it means the app cannot tell
 * which account is being claimed, and guessing would be signing the wrong person
 * in. That can happen for real: the duplicate-card check exists precisely because
 * one card covering two accounts is the fraud a café actually sees, and if an
 * admin ever approved both, this is where it surfaces.
 *
 * ## Why the caller supplies the rows
 *
 * A database cannot compute a Hamming distance without the function being
 * registered, which means a migration. The staff table is measured in single
 * figures and the whole comparison is a loop, so the route fetches and this
 * decides — which also makes every rule in here testable without a database.
 */

import { DUPLICATE_DISTANCE, hammingDistance, isValidFingerprint } from "./card-hash";
import { normaliseIdNumber } from "./id-number";

/**
 * The account columns this needs. Deliberately short — it runs before anyone is
 * signed in, so it must not become a way to pull any column off any user.
 */
export type IdLookupRow = {
  id: string;
  /** `username text unique not null` in the schema, so this is never null. */
  username: string;
  full_name: string | null;
  is_active: boolean;
  role: string | null;
  face_enabled: boolean | null;
  /**
   * The stored descriptor, as the text the column holds.
   *
   * Typed as `string | null` rather than `unknown` because that is what the column
   * is, and because `parseStoredEmbedding` takes exactly that. Typing it `unknown`
   * — which is what an untyped database result widens to — pushes a cast into
   * every caller for no gain.
   */
  face_embedding: string | null;
  id_card_hash: string | null;
  id_doc_number: string | null;
  verification_status: string | null;
  id_doc_front: string | null;
  deactivation_reason: string | null;
  deactivated_at: string | null;
  session_token: string | null;
};

/** How a card was recognised. Both may be true for the same account. */
export type IdMatchMethod = "fingerprint" | "number";

export type IdCandidate = {
  row: IdLookupRow;
  matchedBy: IdMatchMethod[];
  /** Bits of difference, when the fingerprint is what matched. */
  distance: number | null;
};

/**
 * Why the lookup did or did not produce one account.
 *
 * For the server log and the audit trail. **Never for the response** — every one
 * of these answers the same thing to the caller. See the note in the route.
 */
export type IdLookupOutcome = "found" | "nothing_to_match_on" | "no_match" | "ambiguous";

export type IdLookupResult = {
  /** Exactly one entry when `outcome` is "found", otherwise empty. */
  candidates: IdCandidate[];
  outcome: IdLookupOutcome;
  /** Accounts that matched, for the log. Not for the caller. */
  matched: number;
};

export type IdLookupInput = {
  rows: IdLookupRow[];
  /** 16 hex characters from the browser, or null. */
  hash: string | null | undefined;
  /** The number OCR'd off the card, or null. Separators are tolerated. */
  number: string | null | undefined;
  fingerprintThreshold?: number;
};

/**
 * Match a scanned card against the staff table.
 *
 * Fingerprint and number are matched independently and the results unioned, so a
 * card that reads correctly but whose fingerprint is off still identifies, and one
 * that OCRs badly but is unmistakably the right card also does. Either alone is
 * enough — but never together meaning "two accounts", which is the ambiguous case
 * above and refuses.
 */
export function findAccountByScannedId({
  rows,
  hash,
  number,
  fingerprintThreshold = DUPLICATE_DISTANCE,
}: IdLookupInput): IdLookupResult {
  const wantHash = isValidFingerprint(hash) ? (hash as string).toLowerCase() : null;
  const wantNumber = normaliseIdNumber(number);

  if (!wantHash && wantNumber === "") {
    return { candidates: [], outcome: "nothing_to_match_on", matched: 0 };
  }

  const matched: IdCandidate[] = [];

  for (const row of rows) {
    /*
     * Staff only. An admin's ID is not a way into a staff session, and an admin
     * who also happens to have a card on file should not become a candidate for
     * signing in as staff.
     */
    if (row.role !== "staff") continue;

    const byMethod: IdMatchMethod[] = [];
    let distance: number | null = null;

    if (wantHash) {
      const d = hammingDistance(wantHash, row.id_card_hash);
      // `hammingDistance` returns null for a row with no fingerprint stored, which
      // is most accounts before their first upload. That is not a match and must
      // not become a large distance that looks like one.
      if (d !== null && d <= fingerprintThreshold) {
        byMethod.push("fingerprint");
        distance = d;
      }
    }

    if (wantNumber !== "") {
      const stored = normaliseIdNumber(row.id_doc_number);
      // Compared both ways round because OCR will occasionally read a character
      // differently from the admin who typed it — O against 0 is the classic one,
      // and it must not decide a sign-in.
      if (
        stored !== "" &&
        (stored === wantNumber || stripAmbiguous(stored) === stripAmbiguous(wantNumber))
      ) {
        byMethod.push("number");
      }
    }

    if (byMethod.length > 0) matched.push({ row, matchedBy: byMethod, distance });
  }

  if (matched.length === 1) {
    return { candidates: matched, outcome: "found", matched: 1 };
  }

  return {
    candidates: [],
    outcome: matched.length === 0 ? "no_match" : "ambiguous",
    matched: matched.length,
  };
}

/**
 * Drop the characters OCR and a human most often disagree about.
 *
 * `O` and `0`, `I` and `1`, `S` and `5`, `B` and `8` — the confusions are a fixed,
 * small set, so collapsing both sides onto one representative is enough. Applied
 * only as a *fallback*: an exact match wins outright and is never loosened, because
 * this does turn two genuinely different numbers into one in rare cases and that
 * has to stay bounded.
 */
function stripAmbiguous(value: string): string {
  return value
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8");
}

/**
 * Does the name printed on the card look like the account holder?
 *
 * Advisory only — see the answer to the third question in the plan. The OCR
 * templates are hand-written (./ocr/templates.ts) and unvalidated against real
 * cards, so a mismatch here must never stand between a staff member and their
 * shift. It is shown, recorded, and otherwise ignored.
 */
export function nameAgrees(cardName: string | null | undefined, accountName: string | null | undefined): boolean | null {
  const card = (cardName ?? "").trim();
  const account = (accountName ?? "").trim();
  if (card === "" || account === "") return null;

  return surnameOf(card) === surnameOf(account);
}

/** The part before the comma, or the last token — see name-signal.ts for why. */
function surnameOf(name: string): string {
  const comma = name.indexOf(",");
  const head = comma > 0 ? name.slice(0, comma) : "";
  const source = head.trim() || name;

  const particles = new Set(["DELA", "DE", "DA", "LA", "SAN", "SANTA", "NG", "BIN", "BINTANAM"]);
  const parts = source
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .split(/\s+/)
    .filter((p) => p.length > 0 && !particles.has(p));

  return parts.length ? parts[parts.length - 1] : "";
}
