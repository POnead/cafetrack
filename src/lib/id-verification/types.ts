/**
 * The shape of an ID check, and the interface a provider has to satisfy.
 *
 * This is the file that makes the rest of the feature swappable. Everything
 * downstream — the routes, the audit entries, the review screen — is written
 * against `IdVerificationProvider` and never against a vendor. Adding a provider
 * means writing one file that implements this interface and adding it to the list
 * in ./index.ts; nothing else in the app changes.
 *
 * ## Why signals and not a verdict
 *
 * A provider returns a list of **signals**, each labelled and each carrying its
 * own reasoning, and the route stores that list. It does not return
 * `verified: true | false`, and no provider is asked to make that call.
 *
 * Two reasons, both learned the hard way elsewhere in this app:
 *
 *   - A machine cannot verify that a Philippine driver's licence is genuine. The
 *     card has no MRZ, no PDF417 barcode, and no open template library exists to
 *     check it against. What a machine *can* do is compare the portrait on the
 *     card with a photo of the person, read some text off it, and notice an
 *     image that has been obviously doctored. Those are three pieces of evidence,
 *     not a verdict.
 *   - A single pass/fail hides its own reasoning, so an admin who disagrees with
 *     it has nothing to argue with. "Face distance 0.61, threshold 0.55" is a
 *     sentence an admin can act on. "FAILED" is not.
 *
 * So the signals are shown beside the two images and an admin decides. See the
 * `verified_at` column comment in db/schema.sql — only a human moves the status.
 */

/** The document types the review screen offers. */
export const ID_DOC_TYPES = [
  "philsys",
  "lto_license",
  "passport",
  "sss",
  "umid",
  "philhealth",
  "voters",
  "other",
] as const;

export type IdDocType = (typeof ID_DOC_TYPES)[number];

/** Human labels, kept beside the values so the UI never re-derives them. */
export const ID_DOC_TYPE_LABELS: Record<IdDocType, string> = {
  philsys: "PhilSys National ID",
  lto_license: "LTO Driver's Licence",
  passport: "Passport",
  sss: "SSS ID",
  umid: "UMID / GSIS",
  philhealth: "PhilHealth ID",
  voters: "Voter's ID",
  other: "Other",
};

export function isIdDocType(value: unknown): value is IdDocType {
  return typeof value === "string" && (ID_DOC_TYPES as readonly string[]).includes(value);
}

/**
 * How a signal should read on screen.
 *
 * `unknown` is a real outcome and not a soft pass. It means the check could not
 * run — no provider configured, no back of the card, the model would not read
 * the image — and folding it into `pass` would tell an admin something was
 * checked when it was not. It is visually distinct for the same reason.
 */
export type IdSignalTone = "pass" | "warn" | "fail" | "unknown";

export type IdSignal = {
  /** Stable id, so the UI can key on it and a test can assert on it. */
  id: string;
  /** Short label for the badge. */
  label: string;
  tone: IdSignalTone;
  /**
   * A sentence explaining the reading, with the numbers in it.
   *
   * "Face distance 0.61 (threshold 0.55) — further apart than two photos of one
   * person usually are" rather than "Face check failed". The admin is the only
   * reader of this and they are making a decision about a person.
   */
  detail: string;
  /**
   * Never shown to the person being verified.
   *
   * Carried explicitly rather than left to the UI to know, because the same rule
   * already exists for the duty face check (see lib/face.ts on cosineDistance,
   * where the value must never reach a client) and it is easy to forget by the
   * time a new screen is written.
   */
  adminOnly?: boolean;
};

/** What a provider managed to read off the document. */
export type IdExtractedFields = {
  full_name?: string | null;
  id_number?: string | null;
  date_of_birth?: string | null;
  date_of_expiry?: string | null;
};

/** One image handed to a provider. Bytes, not a data URL — see ./index.ts. */
export type IdImage = {
  bytes: Uint8Array;
  /** The sniffed media type, never the declared one. See lib/id-document.ts. */
  type: string;
};

export type IdVerificationInput = {
  /** The front of the ID. Required. */
  front: IdImage;
  /** The back, where the document has one. Optional and often null. */
  back?: IdImage | null;
  /** A photo of the applicant, for the portrait comparison. Optional. */
  photo?: IdImage | null;

  /** The document type the admin selected. A hint, not a certainty. */
  docType: IdDocType;

  /** The number the admin typed in, if they read one off the card. */
  declaredNumber?: string | null;

  /** The name on the account, used to flag a card that reads as someone else. */
  expectedName?: string | null;

  /**
   * The 128-float descriptor of the portrait printed on the card, and of the
   * applicant photo, both computed in the browser by lib/face-client.
   *
   * Sent as two vectors rather than a distance so the comparison happens here,
   * on the same `cosineDistance` every other face comparison in this app uses.
   * A browser-computed number would be a second implementation of the same idea,
   * and the two would drift.
   */
  cardEmbedding?: Float32Array | null;
  photoEmbedding?: Float32Array | null;
};

export type IdVerificationResult = {
  /** Which provider produced this. Stored on the user row. */
  provider: string;
  signals: IdSignal[];
  fields: IdExtractedFields;
  /**
   * The provider's own response, kept for debugging only.
   *
   * Never shown in the UI and never written to the audit log — a vendor
   * response can carry the document image back as a base64 echo, and the audit
   * log is append-only and hash-chained, which means anything written there can
   * never be taken back out.
   */
  raw?: unknown;
};

export type IdVerificationProvider = {
  id: string;
  label: string;
  /**
   * Can this provider run right now?
   *
   * Checked by the orchestrator rather than caught from a thrown error, so a
   * missing API key reads as "fall back to the local checker" and not as a 500.
   */
  available(): boolean;
  verify(input: IdVerificationInput): Promise<IdVerificationResult>;
};

/**
 * A provider that is not configured, or that failed.
 *
 * Never thrown as a 500 to the admin: the whole point of having more than one
 * provider is that the feature keeps working when one is down. The orchestrator
 * catches, records the failure as an `unknown` signal, and carries on with the
 * next provider.
 */
export class IdProviderError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IdProviderError";
    this.provider = provider;
  }
}
