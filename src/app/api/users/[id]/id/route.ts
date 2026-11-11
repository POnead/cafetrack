import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, clientIp, readBody, dbFail } from "@/lib/api";
import { requireAdmin, HttpError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { compareFacePlusPlus, facePlusPlusMode } from "@/lib/facepp";
import { ocrSpaceConfigured } from "@/lib/id-verification/ocr-space";
import {
  exceedsDeclaredLength,
  fieldLabel,
  IdRequestTooLargeError,
  readBoundedFormData,
  readIdImage,
} from "@/lib/id-document";
import {
  isIdDocType,
  providerSummary,
  runIdVerification,
  summariseForAudit,
  type IdDocType,
  type IdSignal,
} from "@/lib/id-verification";
import {
  DUPLICATE_DISTANCE,
  hammingDistance,
  isValidFingerprint,
} from "@/lib/id-verification/card-hash";
import { checkIdNumber, normaliseIdNumber } from "@/lib/id-verification/id-number";
import { idNumberSignal } from "@/lib/id-verification/specification";
import { ID_DOC_TYPE_LABELS } from "@/lib/id-verification/types";
import { auditIdReview } from "@/lib/audit-id-review";

export const runtime = "nodejs";

/**
 * A staff member's government ID: attach it, read it, decide on it, remove it.
 *
 *   POST    multipart — the ID images, then runs the checks and stores the result
 *   GET               — one image, for the admin reviewing the two side by side
 *   PATCH             — approve or reject. A reason is required to reject.
 *   DELETE            — remove the stored documents, keeping the audit trail
 *
 * Three verbs in one file because they are three verbs on one resource and share
 * the same lookup, exactly as /api/users/[id]/face does. They do not share
 * handlers: POST validates three uploads with different rules and then calls out
 * to a provider, and folding that into one branchy handler is how a validation
 * ends up skipped on the path nobody tested.
 *
 * A clear face mismatch stops the upload before text checks run. A successful
 * upload is still only evidence: `verification_status` moves only in PATCH,
 * after a human makes the final decision.
 */

/**
 * Never selects password_hash, and never selects the document images — those are
 * hundreds of kilobytes of base64 per person and are fetched one at a time
 * through GET below, the same way face_image is.
 */
const REVIEW_COLUMNS =
  "id, full_name, username, role, is_active, verification_status, id_doc_type, " +
  "id_doc_number, id_fields, id_signals, id_provider, verification_notes, " +
  "verified_at, verified_by, id_doc_front is not null as has_front, " +
  "id_doc_back is not null as has_back, id_photo is not null as has_photo";

/**
 * The cross-account checks, which run here rather than inside a provider.
 *
 * A provider sees one image and nothing else — that is the interface in
 * lib/id-verification/types.ts, and it is what lets one be added without touching
 * anything else. Neither of these can be expressed that way: "is this the same
 * card as someone else's", "has this number already been used", and "does this
 * number fit the selected type" are questions about the account's relationship to
 * the rest of the system, and the number checks need no image at all.
 *
 * They are appended to the same `signals` array as everything else, so the review
 * screen and the stored `id_signals` do not need to know which checks came from
 * where.
 */

/** Another account whose stored fingerprint is within the threshold of this one. */
type DuplicateHit = {
  id: string;
  full_name: string | null;
  username: string | null;
  distance: number;
};

/**
 * Find another account holding what looks like the same card.
 *
 * Every other account is fetched rather than a search query, because the
 * comparison is a Hamming distance and no database can do that without the
 * function being registered — which would mean a migration adding a PL/pgSQL
 * function, for a table of café staff measured in single figures.
 *
 * Null when this upload carried no usable fingerprint. That is not an error: the
 * browser computes it from a canvas, and an older build, a browser that will not
 * decode the image, or a client posting without one all produce the same thing,
 * which is that the check could not run.
 */
async function findDuplicateCard(hash: string, selfId: string): Promise<DuplicateHit | null> {
  /*
   * No `.not("id_card_hash", "is", null)`, even though it reads like the obvious
   * filter here.
   *
   * The local PGlite adapter in src/lib/supabase.ts implements a subset of the
   * query builder, and `.not` is not in it. Using it produced
   * `TypeError: .not is not a function` and a 500 on every upload that carried a
   * fingerprint — while the two uploads without one passed, which is a
   * spectacularly confusing way for this to fail.
   *
   * It costs nothing to filter here instead: `hammingDistance` already returns
   * null for a missing fingerprint and the loop skips those, so the filter was
   * doing work this function already does.
   */
  const { data, error } = await db()
    .from("users")
    .select("id, full_name, username, id_card_hash");

  if (error) throw new Error(`Could not check for a reused ID card: ${error.message}`);
  if (!Array.isArray(data)) throw new Error("Could not check for a reused ID card.");

  let closest: DuplicateHit | null = null;

  for (const row of data as Array<{
    id: string;
    full_name: string | null;
    username: string | null;
    id_card_hash: string | null;
  }>) {
    if (row.id === selfId) continue;

    const distance = hammingDistance(hash, row.id_card_hash);
    if (distance === null) continue;

    if (distance <= DUPLICATE_DISTANCE && (closest === null || distance < closest.distance)) {
      closest = { id: row.id, full_name: row.full_name, username: row.username, distance };
    }
  }

  return closest;
}

async function findDuplicateIdNumber(
  number: string,
  docType: IdDocType,
  selfId: string
): Promise<DuplicateHit | null> {
  const normalised = normaliseIdNumber(number);
  if (!normalised) return null;

  const { data, error } = await db()
    .from("users")
    .select("id, full_name, username, role, id_doc_type, id_doc_number");

  if (error) throw new Error(`Could not check whether this ID number was used: ${error.message}`);
  if (!Array.isArray(data)) throw new Error("Could not check whether this ID number was used.");

  for (const row of data as Array<{
    id: string;
    full_name: string | null;
    username: string | null;
    role: string;
    id_doc_type: string | null;
    id_doc_number: string | null;
  }>) {
    if (
      row.id !== selfId &&
      row.role === "staff" &&
      row.id_doc_type === docType &&
      normaliseIdNumber(row.id_doc_number) === normalised
    ) {
      return { id: row.id, full_name: row.full_name, username: row.username, distance: 0 };
    }
  }

  return null;
}

function duplicateSignal(hash: string | null): IdSignal {
  if (!hash) {
    return {
      id: "card_duplicate",
      label: "Card already on file",
      tone: "unknown",
      detail:
        "No card fingerprint was supplied, so this could not be checked against other " +
        "accounts. If this card has been uploaded before, it will not be flagged.",
    };
  }

  return {
    id: "card_duplicate",
    label: "Card already on file",
    tone: "pass",
    detail: "No matching card image was found on another staff account.",
  };
}

function parseSignals(raw: unknown): IdSignal[] {
  // jsonb comes back as a parsed object under supabase-js and as the same
  // object under PGlite, but a column that predates this feature is null and one
  // written by hand in the SQL editor could be anything. An unparseable value is
  // an empty list, not a 500: the review screen still has to render.
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is IdSignal =>
      !!s && typeof s === "object" && typeof (s as IdSignal).id === "string"
  );
}

/**
 * How many signals of each kind the admin was looking at when they decided.
 *
 * Enough to distinguish an "approved over two warnings" from a clean approval in
 * the log a year later, without recording the numbers behind them — see the note
 * at the top of lib/audit-id-review.ts.
 */
function tallySignals(signals: IdSignal[]) {
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0 };
  for (const s of signals) counts[s.tone]++;
  return counts;
}

/* ---------------------------------------------------------------- POST ---- */

/**
 * Attach an ID and run the checks.
 *
 * multipart, not readBody() — readBody() calls req.text() and JSON.parse, which
 * turns a multipart body into one unreadable string. Same note as the face route.
 */
export const POST = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    // The row first, so a 404 is answered before any upload work and so the
    // audit entry records what actually changed.
    const { data: before } = await db()
      .from("users")
      .select("id, username, full_name, role, is_active, verification_status, id_provider, face_image")
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    // An admin is never gated by the duty face check — they are the people who
    // grant permissions and approve submissions. The same reasoning applies
    // here: an ID for an admin would be stored and never looked at.
    if (before.role !== "staff") {
      return fail("Only staff accounts are verified by ID", 400);
    }

    /*
     * Size first, before a single byte is buffered.
     *
     * App Router has no bodyParser size limit, so `formData()` will read whatever
     * arrives. This machine is reachable from every phone on the café's Wi-Fi,
     * so an unbounded multipart read is a way to make the server allocate as much
     * as a caller cares to send. The declared length is checked here because
     * browsers set it and it is the cheap rejection; readBoundedFormData then
     * enforces the same ceiling against the bytes that actually arrive, for the
     * caller that lies or omits it.
     */
    const tooBig = exceedsDeclaredLength(req);
    if (tooBig) return fail(tooBig, 413);

    let form: FormData;
    try {
      form = await readBoundedFormData(req);
    } catch (e) {
      if (e instanceof IdRequestTooLargeError) return fail(e.message, 413);
      if (e instanceof HttpError) return fail(e.message, e.status);
      return fail("Expected a multipart upload with the ID images", 400);
    }

    const docTypeRaw = String(form.get("doc_type") ?? "").trim();
    if (!isIdDocType(docTypeRaw)) {
      return fail("Choose what kind of ID this is");
    }
    const docType: IdDocType = docTypeRaw;

    /*
     * The front is required, and it is checked before the optional two — a
     * request missing the one image that makes this meaningful should say so
     * rather than failing later on a back the document may not even have.
     */
    const front = await readIdImage(form.get("front"), "front");
    if (!front.ok) return fail(front.message);

    const backPart = form.get("back");
    const back = backPart ? await readIdImage(backPart, "back") : null;
    if (back && !back.ok) return fail(back.message);

    if (!before.face_image) {
      return fail("Enroll this account's face before uploading an ID for verification", 400);
    }

    let portraitCompared = false;
    if (!ocrSpaceConfigured()) {
      return fail(
        "OCR.space is required to read ID documents, but its API key is not configured on this server.",
        503
      );
    }

    let faceSignal: IdSignal;
    const facePlusPlusStatus = facePlusPlusMode();
    if (facePlusPlusStatus !== "enabled") {
      faceSignal = {
        id: "face_match",
        label: "Face match",
        tone: "unknown",
        adminOnly: true,
        detail: "The photos could not be compared. Check them manually.",
      };
    } else {
      const comparison = await compareFacePlusPlus(before.face_image, front.dataUrl);
      portraitCompared = comparison.status !== "unavailable";
      if (comparison.status === "rejected") {
        return fail(
          "The face on this ID does not match the staff photo. The ID was not saved. Check the images and try again.",
          400
        );
      }

      faceSignal = {
        id: "face_match",
        label: "Face match",
        tone: comparison.status === "matched" ? "pass" : "unknown",
        adminOnly: true,
        detail:
          comparison.status === "matched"
            ? "The ID photo matches the staff photo."
            : "The photos could not be compared. Check them manually.",
      };
    }

    const declaredNumber = String(form.get("id_number") ?? "").trim();

    /*
     * OCR.space is mandatory for ID text extraction. Other checks add evidence,
     * but a failed OCR request must not be presented as a completed ID scan.
     */
    const result = await runIdVerification(
      {
        front: { bytes: front.bytes, type: front.type },
        back: back && back.ok ? { bytes: back.bytes, type: back.type } : null,
        docType,
        declaredNumber: declaredNumber || null,
        expectedName: before.full_name,
      }
    );

    const ocrFailure = result.signals.find(
      (signal) => signal.id === "provider_ocr_space"
    );
    if (ocrFailure) {
      const detail = ocrFailure.detail.replace(/ The remaining checks still apply\.?$/, "");
      return fail(`OCR.space could not read this ID. ${detail}`, 502);
    }

    if (result.signals.some((signal) => signal.id === "ocr_space_doc_type" && signal.tone === "fail")) {
      return fail(
        "The ID type does not match your selection. Choose the correct type and upload again.",
        400
      );
    }

    if (result.detectedDocType && result.detectedDocType !== docType) {
      return fail(
        `The scanned ID was detected as ${ID_DOC_TYPE_LABELS[result.detectedDocType]}, ` +
        `but ${ID_DOC_TYPE_LABELS[docType]} was selected. Choose the matching ID type and upload again.`,
        400
      );
    }

    if (result.signals.some((signal) => signal.id === "name_match" && signal.tone === "fail")) {
      return fail(
        "The name read from this ID does not match the selected staff account. Check the account and card, then upload the correct ID.",
        400
      );
    }

    /*
     * The two cross-account checks, appended to the same signal list so the review
     * screen and the stored evidence need no idea which checks came from where.
     *
     * Both are read from the form the same way, and both treat a missing value as
     * "could not run" rather than as a failure — consistent with how a missing face
     * descriptor is handled above, and for the same reason: this app reports what
     * it could not do instead of guessing.
     */
    const rawHash = String(form.get("card_hash") ?? "").trim().toLowerCase();
    const cardHash = isValidFingerprint(rawHash) ? rawHash : null;

    const storedIdNumber = declaredNumber || String(result.fields?.id_number ?? "").trim();
    const numberIsValid = storedIdNumber ? checkIdNumber(storedIdNumber, docType).ok : false;
    const [duplicate, duplicateNumber] = await Promise.all([
      cardHash ? findDuplicateCard(cardHash, id) : Promise.resolve(null),
      numberIsValid
        ? findDuplicateIdNumber(storedIdNumber, docType, id)
        : Promise.resolve(null),
    ]);

    if (duplicate || duplicateNumber) {
      return fail(
        duplicateNumber
          ? "This ID number is already attached to another staff account. The ID was not saved."
          : `This card image closely matches an ID already attached to ${
              duplicate?.full_name || duplicate?.username || "another staff account"
            }. The ID was not saved.`,
        409
      );
    }

    result.signals = result.signals.filter((signal) => signal.id !== "face_match");
    result.signals.push(faceSignal);
    result.provider = `${result.provider}+facepp${
      facePlusPlusStatus === "enabled" ? "" : "(unavailable)"
    }`;
    result.signals.push(duplicateSignal(cardHash));
    result.signals = result.signals.filter((signal) => signal.id !== "id_number_shape");
    const numberCheck = idNumberSignal(storedIdNumber, docType);
    if (numberCheck) result.signals.push(numberCheck);

    const { data, error } = await db()
      .from("users")
      .update({
        id_doc_front: front.dataUrl,
        id_doc_back: back && back.ok ? back.dataUrl : null,
        id_photo: null,
        id_doc_type: docType,
        id_doc_number: storedIdNumber || null,
        id_doc_expiry: typeof result.fields?.date_of_expiry === "string"
          && /^\d{4}-\d{2}-\d{2}$/.test(result.fields.date_of_expiry)
            ? result.fields.date_of_expiry : null,
        id_doc_uploaded_by: admin.id,
        // Kept so the next upload can be compared against this one. Not part of the
        // review payload and not audited: 64 bits that cannot become a photograph
        // have nothing an auditor needs to read.
        id_card_hash: cardHash,
        id_fields: result.fields,
        id_signals: result.signals,
        id_provider: result.provider,
        // A fresh set of documents reopens the decision. Clearing the notes and
        // the stamps matters as much as the status: leaving "approved by Dana on
        // Tuesday" beside a card uploaded on Thursday would be a claim about
        // evidence that no longer exists.
        verification_status: "unverified",
        verification_notes: null,
        verified_at: null,
        verified_by: null,
      })
      .eq("id", id)
      .select(REVIEW_COLUMNS)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "USER_ID_UPLOAD",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        doc_type: docType,
        has_back: Boolean(back?.ok),
        has_photo: false,
        portrait_compared: portraitCompared,
        front_bytes: front.length,
        front_type: front.type,
        replaced_previous_verification: before.verification_status !== "unverified",
        // Deliberately no ID number, no name read off the card, and no
        // similarity figure. The audit log is append-only and hash-chained, so
        // anything written there can never be taken back out.
        ...summariseForAudit(result),
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      signals: result.signals,
      fields: result.fields,
      providers: await providerSummary(),
    });
  }
);

/* ----------------------------------------------------------------- GET ---- */

/**
 * One of the stored images, for the review screen.
 *
 * Served rather than inlined into anything the roster fetches. A front, a back
 * and a photo is a few hundred kilobytes of base64 per person, and the staff
 * list is loaded on every page load.
 *
 * Admin-only, and deliberately not "anyone signed in" — the proxy has
 * established that *a* session exists and says nothing about which account, so a
 * route that trusted that would let any barista read any other barista's ID.
 */
export const GET = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const part = new URL(req.url).searchParams.get("part") ?? "front";

    const column =
      part === "back" ? "id_doc_back" : part === "photo" ? "id_photo" : "id_doc_front";

    const { data, error } = await db()
      .from("users")
      .select(column)
      .eq("id", id)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    const stored = String((data as Record<string, unknown>)[column] ?? "");
    if (!stored.startsWith("data:")) {
      return fail(`No ${fieldLabel(part)} stored for this account`, 404);
    }

    const match = /^data:([^;,]+);base64,(.*)$/.exec(stored);
    if (!match) return fail(`No ${fieldLabel(part)} stored for this account`, 404);

    await audit(admin, "IDENTITY_DOCUMENT_READ", "user", id, {
      part,
    }, { ip: clientIp(req) });

    const [, type, base64] = match;

    /*
     * Private, and not cached at all.
     *
     * The face photo is allowed five minutes because a stale thumbnail after a
     * re-enrolment is a mildly wrong face beside the right name. A stale ID
     * document is a stale *government ID* beside the right name, and the whole
     * point of replacing it was that the old one was wrong. `no-store` also
     * keeps it out of a shared cache, which biometric PII must never sit in.
     */
    return new Response(Buffer.from(base64, "base64"), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);

/* --------------------------------------------------------------- PATCH ---- */

/**
 * Approve or reject. The only thing in this whole feature that can set
 * `verification_status` to 'verified'.
 *
 * A reason is required to reject and not to approve. The asymmetry is the same
 * one the duty-check override makes: a rejection is a claim an admin may have to
 * justify to someone asking why they cannot work, and an approval with a note is
 * noise.
 */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const body = await readBody(req);
    const decision = String(body.decision ?? "").trim();
    const reason = String(body.reason ?? "").trim();

    if (decision !== "approve" && decision !== "reject") {
      return fail('Decision must be "approve" or "reject"');
    }

    if (decision === "reject") {
      if (reason.length < 3) {
        return fail("Give a reason for the rejection — it will be shown at sign-in");
      }
      if (reason.length > 300) {
        return fail("Reason must be 300 characters or fewer");
      }
    }

    const { data: before } = await db()
      .from("users")
      .select(
        "id, username, full_name, role, is_active, verification_status, " +
          "id_doc_front, id_doc_type, id_doc_number, id_provider, id_signals"
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    if (before.role !== "staff") {
      return fail("Only staff accounts are verified by ID", 400);
    }

    /*
     * Cannot approve what was never attached.
     *
     * Without this a PATCH with no prior POST sets 'verified' on an account with
     * nothing behind it, and the row then reads as a completed check that never
     * happened — the exact kind of claim the hash-chained log is there to make
     * impossible elsewhere in this app.
     */
    if (!before.id_doc_front) {
      return fail("No ID has been attached to this account yet");
    }

    const storedSignals = parseSignals(before.id_signals);
    if (!storedSignals.some((signal) => signal.id === "id_fields_reviewed")) {
      return fail("Review and save the ID details before recording a decision");
    }

    if (
      decision === "approve" &&
      storedSignals.some((signal) => signal.id === "name_match" && signal.tone === "fail")
    ) {
      return fail("The name on this ID does not match the staff account, so it cannot be approved");
    }

    if (
      decision === "approve" &&
      storedSignals.some((signal) => signal.id === "face_match" && signal.tone === "fail")
    ) {
      return fail(
        "The face on this ID does not match the staff photo, so it cannot be approved."
      );
    }

    if (
      decision === "approve" &&
      storedSignals.some((signal) => signal.id === "id_number_shape" && signal.tone === "warn")
    ) {
      return fail(
        "The ID number does not match the format for this ID type. Correct or clear it before approval."
      );
    }

    const nextStatus = decision === "approve" ? "verified" : "rejected";

    const { data, error } = await db()
      .from("users")
      .update({
        verification_status: nextStatus,
        verification_notes: decision === "reject" ? reason : null,
        verified_at: new Date().toISOString(),
        verified_by: admin.id,
      })
      .eq("id", id)
      .select(REVIEW_COLUMNS)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await auditIdReview({
      admin,
      req,
      user: data,
      decision,
      reason,
      previousStatus: (before.verification_status as string | null) ?? null,
      provider: (before.id_provider as string | null) ?? null,
      signalCounts: tallySignals(parseSignals(before.id_signals)),
    });

    return ok({ user: data, signals: parseSignals(data.id_signals) });
  }
);

/* -------------------------------------------------------------- DELETE ---- */

/**
 * Remove the stored documents, so the highest-sensitivity data this app holds
 * can be taken back out of it.
 *
 * Verification is reset to 'unverified' rather than left alone: with the evidence
 * gone, a 'verified' row would be claiming a check that can no longer be
 * substantiated or repeated.
 *
 * "Removed" covers everything derived from the document, not just the pictures:
 * the OCR fields, the signals, the provider name, the ID type and number, and the
 * card fingerprint. The number and the fingerprint are the columns `id-login`
 * narrows an account by, so leaving them behind would let a card whose documents
 * were deleted still name its owner. They are also the most sensitive things here
 * — a national ID number is sensitive personal information under the Data Privacy
 * Act — and the point of this route is that the cafe can take them back out.
 *
 * The audit entry is deliberately kept. Removing documents is not something an
 * app should be able to do without a trace.
 */
export const DELETE = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data: before } = await db()
      .from("users")
      .select(
        "id, username, full_name, role, id_doc_front, id_doc_back, id_photo, " +
          "id_doc_number, id_doc_type, id_card_hash, verification_status"
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    if (before.role !== "staff") {
      return fail("Only staff accounts carry a verified ID", 400);
    }

    // Refusing a no-op keeps the trail honest: an entry saying documents were
    // removed when there were never any is a claim that something happened.
    if (!before.id_doc_front && !before.id_doc_back && !before.id_photo) {
      return fail("That account has no ID documents stored", 400);
    }

    const { data, error } = await db()
      .from("users")
      .update({
        id_doc_front: null,
        id_doc_back: null,
        id_photo: null,
        id_fields: null,
        id_signals: null,
        id_provider: null,
        // The identifying columns go too. `id-login` matches on exactly these two,
        // so keeping either would leave a deleted card able to name this account.
        id_doc_number: null,
        id_doc_type: null,
        id_card_hash: null,
        verification_status: "unverified",
        verification_notes: null,
        verified_at: null,
        verified_by: null,
      })
      .eq("id", id)
      .select(REVIEW_COLUMNS)
      .maybeSingle();

    if (error) return dbFail(error);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "USER_ID_PURGE",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        had_back: Boolean(before.id_doc_back),
        had_photo: Boolean(before.id_photo),
        // A boolean, never the number itself: the log is append-only.
        had_number: Boolean(before.id_doc_number),
        previous_status: before.verification_status,
      },
      { ip: clientIp(req) }
    );

    return ok({ user: data });
  }
);
