/**
 * Tests for identifying a staff account from a scanned ID card.
 *
 *   npm run test:id-lookup
 *
 * ## What is being defended here
 *
 * The lookup has one really important job and it is the one that is not a lookup:
 * it has to **refuse** when two accounts match, because signing in the wrong person
 * is worse than signing in nobody. Every ambiguous case below is a real way that
 * arises — one card uploaded twice and both approved, which is precisely the fraud
 * the duplicate-card check is there to surface.
 *
 * The other job is to never widen the question. A match on the number and a match
 * on the fingerprint for *different* accounts is ambiguous, not "one of them", and
 * the tests below pin that down.
 */

/*
 * No `type IdLookupRow` import.
 *
 * Node's type stripping only applies to `.ts` files. A `.mjs` file is plain
 * JavaScript and an inline `import { type X }` is a syntax error there — the
 * eraser never runs. The type is not used at runtime here anyway.
 */
import {
  findAccountByScannedId,
  nameAgrees,
} from "../src/lib/id-verification/id-lookup.ts";

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

const row = (over = {}) => ({
  id: "u1",
  username: "cook1",
  full_name: "Ana Dela Cruz",
  is_active: true,
  role: "staff",
  face_enabled: true,
  face_embedding: "x",
  id_card_hash: "0123456789abcdef",
  id_doc_number: "1234-5678-9012-3456",
  verification_status: "approved",
  id_doc_front: "data:image/png;base64,AAA",
  deactivation_reason: null,
  deactivated_at: null,
  session_token: null,
  ...over,
});

/* ------------------------------------------------------------- matching -- */

section("matching a scanned card");

{
  const r = findAccountByScannedId({
    rows: [row()],
    hash: "0123456789abcdef",
    number: null,
  });
  check("an identical fingerprint matches", r.outcome === "found", r.outcome);
  check("and reports how it matched", r.candidates[0]?.matchedBy.join() === "fingerprint");
  check("with a distance of zero", r.candidates[0]?.distance === 0);
}

{
  const r = findAccountByScannedId({
    rows: [row()],
    hash: null,
    number: "1234-5678-9012-3456",
  });
  check("a matching number alone matches", r.outcome === "found", r.outcome);
  check("reported as a number match", r.candidates[0]?.matchedBy.join() === "number");
}

{
  const r = findAccountByScannedId({
    rows: [row()],
    hash: null,
    number: "1234567890123456",
  });
  check("separators in the typed number do not matter", r.outcome === "found", r.outcome);
}

{
  /* The classic OCR confusion. Refusing here would lock out a real person on the
   * strength of one misread letter. */
  const r = findAccountByScannedId({
    rows: [row({ id_doc_number: "1234-5678-9012-3456" })],
    hash: null,
    number: "1234-5678-9O12-3456",
  });
  check("an O read where a 0 belongs still matches", r.outcome === "found", r.outcome);
}

{
  /*
   * A valid fingerprint that is nowhere near the stored one, plus a matching
   * number. The number alone must carry the match — which is the point of "either
   * is enough": a card photographed in poor light, or through a screen, can
   * fingerprint badly while its printed number reads perfectly.
   *
   * The first version of this fixture ended in `g`, which is not a hex digit. The
   * hash was correctly rejected as malformed, so only the number matched and the
   * "both are reported" assertion failed — the app was right and the fixture was
   * testing nothing.
   */
  const r = findAccountByScannedId({
    rows: [row()],
    hash: "fedcba9876543210",
    number: "1234-5678-9012-3456",
  });
  check("either signal alone is enough", r.outcome === "found", `${r.outcome} (${r.matched})`);
  check("the number carried it", r.candidates[0]?.matchedBy.join() === "number");

  const both = findAccountByScannedId({
    rows: [row()],
    hash: "0123456789abcdef",
    number: "1234-5678-9012-3456",
  });
  check("when both match, both are reported", both.candidates[0]?.matchedBy.length === 2, both.candidates[0]?.matchedBy.join());
}

{
  const r = findAccountByScannedId({
    rows: [row()],
    hash: "ffffffffffffffff",
    number: null,
  });
  check("a completely different card does not match", r.outcome === "no_match", r.outcome);
  check("and returns no candidate", r.candidates.length === 0);
}

section("nothing to match on");

{
  const r = findAccountByScannedId({ rows: [row()], hash: null, number: null });
  check("no hash and no number is refused", r.outcome === "nothing_to_match_on", r.outcome);

  const junk = findAccountByScannedId({
    rows: [row()],
    hash: "not-a-fingerprint",
    number: "",
  });
  check("a malformed hash counts as nothing", junk.outcome === "nothing_to_match_on", junk.outcome);
  check("rather than matching everything", junk.candidates.length === 0);
}

section("accounts that cannot be signed into");

{
  const r = findAccountByScannedId({
    rows: [row({ role: "admin" })],
    hash: "0123456789abcdef",
    number: "1234-5678-9012-3456",
  });
  check("an admin's card is never a staff candidate", r.outcome === "no_match", r.outcome);

  const none = findAccountByScannedId({
    rows: [row({ id_card_hash: null, id_doc_number: null })],
    hash: "0123456789abcdef",
    number: "1234-5678-9012-3456",
  });
  check("an account with no card on file is not found by it", none.outcome === "no_match", none.outcome);
}

/* ------------------------------------------------------------ ambiguity -- */

section("refusing when the card matches more than one account");

{
  /*
   * One card, uploaded twice, both approved. This is the exact fraud the
   * duplicate-card check exists to catch, and the moment it reaches sign-in the app
   * must not pick one of the two people and let them in.
   */
  const r = findAccountByScannedId({
    rows: [
      row({ id: "u1", username: "ana" }),
      row({ id: "u2", username: "ben", full_name: "Ben Dela Cruz" }),
    ],
    hash: "0123456789abcdef",
    number: null,
  });
  check("the same card on two accounts is refused", r.outcome === "ambiguous", r.outcome);
  check("returns no candidate at all", r.candidates.length === 0);
  check("but counts the matches for the log", r.matched === 2, String(r.matched));
}

{
  /*
   * The subtle one: fingerprint points at one person, the number at another. That
   * is not "either is enough" — it is two different accounts, and signing in
   * either one is a coin flip on an accusation.
   */
  const r = findAccountByScannedId({
    rows: [
      row({ id: "u1", id_card_hash: "0123456789abcdef", id_doc_number: "9999-9999-9999-9999" }),
      row({ id: "u2", id_card_hash: "ffffffffffffffff", id_doc_number: "1234-5678-9012-3456" }),
    ],
    hash: "0123456789abcdef",
    number: "1234-5678-9012-3456",
  });
  check("a fingerprint and a number pointing at different people is refused", r.outcome === "ambiguous", r.outcome);
  check("even though each signal found exactly one", r.matched === 2, String(r.matched));
}

{
  /*
   * Two accounts sharing a number but not a card — two siblings, or an admin
   * typo — is still ambiguous on the number alone, and must not be resolved by the
   * fingerprint preferring one. Because the fingerprint here matches *nobody*.
   */
  const r = findAccountByScannedId({
    rows: [
      row({ id: "u1", id_card_hash: "aaaaaaaaaaaaaaaa", id_doc_number: "1234-5678-9012-3456" }),
      row({ id: "u2", id_card_hash: "bbbbbbbbbbbbbbbb", id_doc_number: "1234-5678-9012-3456" }),
    ],
    hash: null,
    number: "1234-5678-9012-3456",
  });
  check("two accounts sharing a number is refused", r.outcome === "ambiguous", r.outcome);
}

/* ---------------------------------------------------------------- names -- */

section("the name printed on the card, advisory only");

{
  check("the same surname agrees", nameAgrees("DELA CRUZ, ANA", "Ana Dela Cruz") === true);
  check("a different surname does not", nameAgrees("REYES, ANA", "Ana Dela Cruz") === false);
  check("no readable name is neither", nameAgrees(null, "Ana Dela Cruz") === null);
  check("no account name is neither", nameAgrees("DELA CRUZ, ANA", null) === null);
  check("a comma form and a plain form agree", nameAgrees("Santos, Maria", "MARIA SANTOS") === true);
  check("particles are not surnames", nameAgrees("DELA CRUZ, ANA", "CRUZ") === true);
  check("two genuinely different surnames do not", nameAgrees("SANTOS, MARIA", "CRUZ, JUAN") === false);
}

console.log(`\n----------------------------------------------`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
