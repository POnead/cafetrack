import { db } from "@/lib/supabase";
import { handler, ok, fail, clientIp } from "@/lib/api";
import { signSession, setSessionCookie, deactivatedMessage } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { getSessionMinutes, getFaceMatchThreshold } from "@/lib/settings";
import { parseEmbedding, parseStoredEmbedding, isMatch } from "@/lib/face";
import { recordFaceVerification } from "@/lib/face-gate";
import { getIdGate } from "@/lib/id-gate";
import { isValidFingerprint } from "@/lib/id-verification/card-hash";
import {
  findAccountByScannedId,
  nameAgrees,
  type IdLookupRow,
} from "@/lib/id-verification/id-lookup";
import { localOcrProvider } from "@/lib/id-verification/local-ocr";
import { extract } from "@/lib/id-verification/ocr/extract";
import { buildLayout } from "@/lib/id-verification/ocr/rows";
import { disposeWorker, runOcr, languageModelPresent } from "@/lib/id-verification/ocr/engine";
import { checkIdNumber } from "@/lib/id-verification/id-number";
import { IdDocType } from "@/lib/id-verification/types";
import { readBoundedFormData, readIdImage } from "@/lib/id-document";
import {
  checkLoginThrottle,
  tooManyAttempts,
  recordLoginAttempt,
  tokenKey,
  ID_LOGIN_METHOD,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Whether to offer the ID-card option on the sign-in screen.
 *
 *   GET -> { enabled: boolean }
 *
 * Public, and for the same reason as the equivalent on api/auth/face-login: the
 * login page runs before anyone is signed in and cannot ask /api/settings, which
 * answers 403 to exactly the person who needs to know whether the button should
 * exist. "Not shown" would otherwise be indistinguishable from "broken".
 *
 * Returns a boolean and nothing else. It must not grow into a settings dump — an
 * unauthenticated caller learning anything more is a new hole opened for a
 * cosmetic reason. The one fact needed to decide what to draw is this one.
 */
export const GET = handler(async () => {
  return ok({ enabled: await idLoginEnabled() });
});

/**
 * Sign in by showing an ID card and your face.
 *
 *   POST multipart — id_front (image), card_hash, face_embedding
 *   ->  { user, session_conflict }
 *
 * ## The shape of it, and why it is the badge flow again
 *
 * The card **identifies**; the face **authenticates**. Nothing else.
 *
 * That is the same division the existing badge-and-face flow uses — present your
 * badge, the camera confirms the face enrolled against *that one account* — with
 * a richer badge. It matters that this is one-to-one and not a search across the
 * roster: see the header of api/auth/face-login/route.ts, where the reason is
 * spelled out at length. A roster search compares a submitted face against every
 * enrolled person at once and answers with who it belongs to, which at a café's
 * scale is an identity oracle pointed at the staff room.
 *
 * So the card narrows to exactly one account or the attempt is refused, and the
 * face is then compared against that one account and nothing else.
 *
 * ## The card must already be on file
 *
 * This does not accept a valid Philippine ID and hand over a staff session. It
 * only recognises a card already attached to an account at onboarding. That is the
 * difference between proving you are *who the cafe thinks you are* and proving you
 * are *a citizen*, and only the first is any use at a till.
 *
 * ## Four rules shape what comes back
 *
 *   1. No distance, no score, no percentage, ever.
 *   2. Unknown card, unreadable card, ambiguous card and unrecognised face all
 *      return the *same* answer. Any difference is a way to learn which cards are
 *      on file, or to walk the roster one number at a time.
 *   3. The thresholds come from settings, never from the request.
 *   4. The ID image is read and discarded. It is not stored, not returned and not
 *      written to the audit log.
 */
export const POST = handler(async (req: Request) => {
  /*
   * Two gates before anything expensive happens.
   *
   * The model check is the same distinction `localOcrProvider.available()` makes,
   * repeated here because the failure is much more visible on this route: without
   * the language file the OCR silently produces nothing, the lookup then has only
   * a fingerprint to go on, and the attempt is refused as "not recognised" —
   * which reads as "your ID is not on file" rather than "this server is not set up".
   */
  if (!(await idLoginEnabled())) {
    return fail("Signing in with an ID is not switched on", 404);
  }

  if (!languageModelPresent()) {
    return fail(NO_MODEL, 503, { setup_needed: true });
  }

  const form = await readBoundedFormData(req);

  const frontPart = form.get("id_front");
  const front = frontPart ? await readIdImage(frontPart, "id_front") : null;
  if (!front || !front.ok) {
    return fail(front?.message ?? "No photo of the front of your ID was attached");
  }

  const rawHash = String(form.get("card_hash") ?? "").trim().toLowerCase();
  const cardHash = isValidFingerprint(rawHash) ? rawHash : null;
  const submitted = parseEmbedding(form.get("face_embedding"));

  /*
   * A card with neither signal cannot identify anyone, and a face with no
   * identifier to compare it against is exactly the roster search this endpoint
   * refuses to be. Both are refused before the database is touched.
   */
  if (!cardHash) {
    return fail(UNRECOGNISED, 401);
  }
  if (!submitted) {
    return fail(UNRECOGNISED, 401);
  }

  /*
   * Keyed on the fingerprint, because that is the credential.
   *
   * The same reasoning as the badge flow: the thing being tried is the card, and
   * hashing it means the counter works identically whether or not the card turns
   * out to be on file — which is most of them during a walk of the roster.
   */
  const key = tokenKey(cardHash);
  const throttle = await checkLoginThrottle(key, ID_LOGIN_METHOD);
  if (throttle.blocked) {
    return tooManyAttempts(throttle.retryAfterSeconds, "ID sign-in attempts");
  }

  /* ---- 1. read the card ------------------------------------------------ */

  let cardNumber: string | null = null;
  let cardName: string | null = null;
  let docType: IdDocType = "other";

  try {
    const run = await runOcr(front.bytes);
    const layout = buildLayout(run.words);
    const { fields } = extract(layout, docType);

    /*
     * Only an anchored read is used to identify. A name matched on shape alone has
     * no structure — "DELA CRUZ JUAN SANTOS" gives no surname — so guessing which
     * token is which is how a lookup starts rejecting the right person.
     *
     * The number is not gated the same way: `checkIdNumber` below decides whether
     * it is even a plausible number of any type, and the fingerprint carries the
     * identification on its own when OCR has done badly. See the header on
     * ./ocr/extract.ts for why an unanchored read is reported and not acted on.
     */
    if (fields.id_number.strategy !== "heuristic" && fields.id_number.value) {
      cardNumber = fields.id_number.value;
    }
    if (fields.full_name.strategy !== "heuristic" && fields.full_name.value) {
      cardName = fields.full_name.value;
    }
  } catch (e) {
    // The reader failing must not be "your ID was refused". Carried on as a card
    // with no number: the fingerprint still identifies, and the reason is logged.
    console.error("id sign-in OCR failed:", e instanceof Error ? e.message : String(e));
  } finally {
    // The worker is shared and reaped on its own timer; this only releases it when
    // the OCR threw, where the reference would otherwise be left dangling.
    if (!languageModelPresent()) await disposeWorker();
  }

  /* ---- 2. narrow to one account ---------------------------------------- */

  const { data: rows, error: rowsError } = await db()
    .from("users")
    .select(
      "id, username, full_name, is_active, role, face_enabled, face_embedding, " +
      "id_card_hash, id_doc_number, verification_status, id_doc_front, " +
      "deactivation_reason, deactivated_at, session_token"
    );

  if (rowsError) {
    console.error("id sign-in lookup failed:", rowsError.message);
    return fail(`Cannot query the database (${rowsError.message}). Check .env.local.`, 503);
  }

  const lookup = findAccountByScannedId({
    rows: (rows ?? []) as IdLookupRow[],
    hash: cardHash,
    number: cardNumber,
  });

  if (lookup.outcome !== "found") {
    /*
     * Logged, never returned.
     *
     * `ambiguous` is the one worth having in the log: it means one card is on two
     * accounts, which is the duplicate-ID fraud the review screen warns about, and
     * an admin needs to know it reached sign-in.
     */
    console.warn(
      `id sign-in refused: ${lookup.outcome} (${lookup.matched} match(es)) for a card ending ${cardHash.slice(-4)}`
    );
    await recordLoginAttempt(key, ID_LOGIN_METHOD, false);
    return fail(UNRECOGNISED, 401);
  }

  const user = lookup.candidates[0].row;

  /* ---- 3. the face, against that one account --------------------------- */

  const stored = parseStoredEmbedding(user.face_embedding);
  const threshold = await getFaceMatchThreshold();

  if (!isMatch(submitted, stored, threshold)) {
    await recordLoginAttempt(key, ID_LOGIN_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name ?? "", role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: ID_LOGIN_METHOD, reason: "no_match" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(UNRECOGNISED, 401);
  }

  /*
   * Everything below is after the face matched, and that placement is the point.
   *
   * Each of these answers differently for an account that exists and one that does
   * not — deactivated says so, the ID gate says so, "no face enrolled" says so.
   * Run before the match, any of them becomes a way to learn which cards are on
   * file and what state their accounts are in. After it, each is only reachable by
   * someone who has already proved they are that person.
   */
  if (!user.is_active) {
    await recordLoginAttempt(key, ID_LOGIN_METHOD, false);
    await audit(
      { id: user.id, username: user.username, fullName: user.full_name ?? "", role: "staff" },
      "LOGIN_FAILED",
      "user",
      user.id,
      { method: ID_LOGIN_METHOD, reason: "deactivated" },
      { critical: false, ip: clientIp(req), outcome: "failed" }
    );
    return fail(deactivatedMessage(user.deactivation_reason), 403, {
      deactivated: true,
      deactivation_reason: user.deactivation_reason ?? null,
      deactivated_at: user.deactivated_at ?? null,
    });
  }

  const idGate = await getIdGate(user as never);
  if (idGate.required && !idGate.cleared) {
    await recordLoginAttempt(key, ID_LOGIN_METHOD, false);
    return fail(idGate.message ?? "This account is not cleared to sign in yet.", 403, {
      id_unverified: true,
      verification_status: idGate.status,
    });
  }

  if (!user.face_enabled || !stored) {
    await recordLoginAttempt(key, ID_LOGIN_METHOD, false);
    return fail(
      "Face sign-in is not available on this account. Ask an administrator, or sign in with your password.",
      403
    );
  }

  /* ---- 4. signed in ----------------------------------------------------- */

  await recordLoginAttempt(key, ID_LOGIN_METHOD, true);

  const session = {
    id: user.id,
    username: user.username,
    fullName: user.full_name ?? "",
    role: "staff" as const,
  };

  const minutes = await getSessionMinutes();
  const token = await signSession(session, minutes);
  await setSessionCookie(token, minutes, user.id, db());

  // Same reason as the badge flow: without this the duty check would ask for the
  // same face again seconds later.
  await recordFaceVerification(user.id);

  /*
   * The name printed on the card, and what it said about it.
   *
   * Recorded, never acted on. The OCR templates are hand-written and unvalidated
   * against real cards (see ./ocr/templates.ts), so a mismatch must not stand
   * between a staff member and their shift — and because this is written *after*
   * the session exists, refusing here would mean refusing someone who has already
   * proved who they are.
   */
  const nameChecked = nameAgrees(cardName, user.full_name);
  const numberChecked = cardNumber ? checkIdNumber(cardNumber, docType) : null;

  await audit(
    session,
    "LOGIN",
    "user",
    user.id,
    {
      method: ID_LOGIN_METHOD,
      card_matched_by: lookup.candidates[0].matchedBy,
      // Distances and scores stay out of the audit log for the same reason they stay
      // out of the response: it is append-only and hash-chained, so anything written
      // there is permanent.
      card_name_agreed: nameChecked,
      card_number_shape: numberChecked ? (numberChecked.ok ? "ok" : "unexpected") : null,
      card_name_read: cardName ? "yes" : "no",
    },
    { ip: clientIp(req), outcome: "success" }
  );

  return ok({
    user: session,
    session_conflict: Boolean(user.session_token),
    /*
     * Advisory, and labelled as such on the client. A mismatch here is a sentence
     * for the person who just signed in to glance at, not a rejection.
     */
    warnings: buildWarnings(cardName, nameChecked, cardNumber),
  });
});

/**
 * Sent back with a successful sign-in, and shown, never enforced.
 *
 * Phrased as a thing to check rather than a thing that is wrong, because the
 * likeliest cause is a misread rather than a swapped card.
 */
function buildWarnings(
  cardName: string | null,
  agreed: boolean | null,
  cardNumber: string | null
): string[] {
  const out: string[] = [];

  if (agreed === false && cardName) {
    out.push(
      `The name on the card reads "${cardName}", which is not the name on this account. ` +
        "That can be a misread — the card is photographed rather than keyed — but it is " +
        "worth a glance."
    );
  }

  if (cardNumber) {
    const verdict = checkIdNumber(cardNumber, "other");
    if (!verdict.ok) {
      out.push(`The number read off the card was "${cardNumber}", which is an unusual shape.`);
    }
  }

  return out;
}

/** Admin-only, same pattern as `face_login_enabled`. */
async function idLoginEnabled(): Promise<boolean> {
  try {
    const { getSetting } = await import("@/lib/settings");
    const raw = ((await getSetting("id_login_enabled")) ?? "").trim().toLowerCase();
    return raw !== "0" && raw !== "false" && raw !== "no";
  } catch {
    return false;
  }
}

/**
 * One refusal for everything.
 *
 * Unknown card, unreadable card, ambiguous card, no face enrolled and an
 * unrecognised face are all the same sentence to the caller. Any difference
 * between them is a way to enumerate which cards are on file.
 */
const UNRECOGNISED = "Unrecognised ID, or that ID is not on file for any account";

/**
 * Distinct from UNRECOGNISED, and safe to be, because it is a property of the
 * server rather than of anything the caller supplied.
 *
 * Every answer that varies with the *request* is one refusal. This one does not:
 * it says the same thing whether or not a card was sent, and it is the only way an
 * admin finds out that a café has the feature switched on with no model installed
 * and every attempt silently failing.
 */
const NO_MODEL =
  "This server cannot read ID cards yet — its text model has not been downloaded. " +
  "Sign in with your badge and password instead, or ask an administrator to finish setup.";
