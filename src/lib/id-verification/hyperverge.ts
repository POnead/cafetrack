/**
 * HyperVerge — the external ID verification API.
 *
 * A commercial vendor with a dedicated Philippines region alongside India,
 * Vietnam, Indonesia and Nigeria, which is the reason it is here: the open-source
 * alternatives do not carry PhilSys or LTO templates, and a vendor without
 * Philippine document coverage would read a Philippine card about as well as it
 * reads a bank statement.
 *
 * Cost is per module rather than per check, and only four modules matter here:
 *
 *   ID Card OCR        $0.42   read the text off the card
 *   Face Match         $0.20   portrait vs the person's photo
 *   ID Forgery Checks  $0.04   has this image been doctored
 *   Document Quality   $0.04   is it even legible
 *
 * A full pass is roughly $0.70. A cafe hiring twenty people in a year spends
 * about fourteen dollars on it, so the pricing that matters is the contract, not
 * the per-check figure. Anything on the Grow tier or an annual commit should be
 * looked at carefully for an application this size.
 *
 * ## Authentication
 *
 * **Not confirmed against current documentation.** HyperVerge's docs site was
 * unreachable while this was written. Two schemes are in play:
 *
 *   - the older per-region v2.0 API (`api.hyperverge.co` / `ind-docs.hyperverge.co`)
 *     takes `appid` and `appkey` request headers;
 *   - HyperVerge ONE, the current platform, is documented separately and this
 *     file has not been able to read its auth section.
 *
 * Rather than guess and ship something that fails on the first call in a way that
 * looks like a bug, the scheme is configurable and the defaults below are the
 * older header pair. **Set these from the sandbox credentials, not from this
 * file** — see .env.example. The provider reports itself unavailable until
 * credentials are present, so an unset key degrades to the local checks instead
 * of erroring.
 */

import {
  IdProviderError,
  type IdSignal,
  type IdVerificationInput,
  type IdVerificationProvider,
  type IdVerificationResult,
} from "./types";

/**
 * How long a vendor call may take before it is abandoned.
 *
 * Short on purpose. This runs on a request an admin is waiting on, in a café
 * with one till, and a check that would have arrived in forty seconds is worth
 * less than one that arrives in eight and can be retried. A timeout is reported
 * as an `unknown` signal and the local checks still run.
 */
const REQUEST_TIMEOUT_MS = 12_000;

type AuthStyle = "headers" | "bearer";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * Read credentials from the environment.
 *
 * Returns null when either half is missing, which is what makes the provider
 * unavailable rather than throwing — a café that has not signed up for anything
 * should get the local checks, not an error page.
 */
function credentials(): { baseUrl: string; appId: string; appKey: string; style: AuthStyle } | null {
  const appId = env("HYPERVERGE_APP_ID");
  const appKey = env("HYPERVERGE_APP_KEY");
  if (!appId || !appKey) return null;

  return {
    baseUrl: (env("HYPERVERGE_BASE_URL") || "https://api.hyperverge.com").replace(/\/+$/, ""),
    appId,
    appKey,
    // `headers` is the documented scheme on the older v2.0 API; `bearer` is the
    // one HyperVerge ONE is generally described as using. Override if the
    // sandbox credentials turn out to differ.
    style: (env("HYPERVERGE_AUTH_STYLE") || "headers") === "bearer" ? "bearer" : "headers",
  };
}

export function hypervergeConfigured(): boolean {
  return credentials() !== null;
}

function authHeaders(auth: NonNullable<ReturnType<typeof credentials>>): Record<string, string> {
  return auth.style === "bearer"
    ? { Authorization: `Bearer ${auth.appKey}` }
    : { appid: auth.appId, appkey: auth.appKey };
}

/**
 * One call to a HyperVerge module.
 *
 * `image` is sent as a multipart file part named `image`, which is the field
 * name the vendor's own curl examples use. `extra` carries module-specific
 * fields (document type, the second image for face match) and is left out
 * entirely when empty, because a module that takes no extra fields should not
 * receive an empty object it may reject.
 */
async function call(
  module: string,
  image: { bytes: Uint8Array; type: string; filename: string },
  extra: Record<string, string> = {}
): Promise<any> {
  const auth = credentials();
  if (!auth) {
    throw new IdProviderError("hyperverge", "HyperVerge is not configured on this server.");
  }

  const form = new FormData();
  form.append(
    "image",
    new Blob([image.bytes as unknown as BlobPart], { type: image.type }),
    image.filename
  );
  for (const [key, value] of Object.entries(extra)) {
    if (value) form.append(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${auth.baseUrl}/api/v1/${module}`, {
      method: "POST",
      headers: authHeaders(auth),
      body: form,
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new IdProviderError(
        "hyperverge",
        `HyperVerge did not answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds.`
      );
    }
    // A network failure to a vendor should read as "that provider is unavailable",
    // which the orchestrator already handles, rather than as a fault in this app.
    throw new IdProviderError("hyperverge", `Could not reach HyperVerge: ${e?.message ?? "network error"}`);
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();

  if (!res.ok) {
    // The vendor's own error text is the useful part — it distinguishes a bad
    // key from a document it could not read, and the admin can act on that
    // difference. Capped so a large HTML error page cannot end up in the DB.
    throw new IdProviderError(
      "hyperverge",
      `HyperVerge ${module} returned ${res.status}: ${bodyText.slice(0, 300)}`
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new IdProviderError("hyperverge", `HyperVerge ${module} returned a non-JSON response.`);
  }
}

/**
 * Pull a name out of a response whose field names are not pinned down.
 *
 * Deliberately forgiving. The exact key has not been confirmed against current
 * documentation, and a provider that returns `name` when the code wants
 * `fullName` should degrade to "no name was read" rather than throwing — the
 * other three signals from the same call are still worth having.
 *
 * Walked rather than indexed so a deeply nested or differently-cased key still
 * resolves. Bounded to a shallow scan so a large response cannot make this
 * quadratic.
 */
function pickString(source: any, keys: string[], depth = 0): string | null {
  if (!source || typeof source !== "object" || depth > 3) return null;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const value of Object.values(source)) {
    if (value && typeof value === "object") {
      const found = pickString(value, keys, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/** A 0-1 similarity from a vendor response, or null when it sent none. */
function pickSimilarity(source: any): number | null {
  const raw = pickString(source, ["similarity", "match_score", "confidence", "score"]);
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Some modules return 0-1 and others 0-100. Anything above 1 is a percentage.
  return n > 1 ? n / 100 : n;
}

/**
 * The holder's name, from either of the two shapes a vendor sends it in.
 *
 * `pickString` only accepts a scalar, and that was the whole of name handling
 * here — so a response shaped `{ name: { first_name, middle_name, last_name } }`,
 * the more natural shape for a structured OCR result and the one HyperVerge ONE
 * is described as producing, found nothing at all. The name check then reported
 * "no name was read" on a card whose name had been read perfectly well, which is
 * worse than a vendor error because it looks like a bad photograph.
 *
 * Assembled as `SURNAME, GIVEN` rather than "Given Surname" because that is how
 * a Philippine card actually prints it, so what comes out is directly comparable
 * with what an admin reads off the card — and because name-signal.ts reads a
 * comma as "the surname is before this".
 */
function pickName(source: any): string | null {
  // The easy case: a single scalar field, whatever the vendor calls it.
  const flat = pickString(source, [
    "full_name",
    "fullName",
    "holder_name",
    "holderName",
    "name",
  ]);
  if (flat) return flat;

  /*
   * The structured case. Looked for as an object rather than by scanning the
   * whole response for component keys, because somewhere else in an OCR result
   * there may be a `last_name` belonging to a spouse or a guardian rather than
   * to the holder of this card.
   */
  const containers = [source?.name, source?.result?.name, source?.data?.name];

  for (const box of containers) {
    if (!box || typeof box !== "object") continue;

    const part = (...keys: string[]): string => {
      for (const k of keys) {
        const v = (box as Record<string, unknown>)[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };

    const last = part("last_name", "lastName", "surname", "family_name", "familyName");
    const first = part("first_name", "firstName", "given_name", "givenName");
    const middle = part("middle_name", "middleName");

    if (last || first) {
      const given = [first, middle].filter(Boolean).join(" ");
      return last ? `${last}${given ? `, ${given}` : ""}` : given;
    }
  }

  return null;
}

/**
 * HyperVerge publishes a 0.94 match threshold for its own face-match module, and
 * this is where that lands in the signal list. Kept as a named constant because
 * it is the vendor's number and not a measurement taken by this app — which is
 * the difference between it and face.ts's threshold, and the reason the two are
 * not the same value.
 */
const HYPERVERGE_FACE_MATCH_THRESHOLD = 0.94;

export const hypervergeProvider: IdVerificationProvider = {
  id: "hyperverge",
  label: "HyperVerge (external service)",

  available: hypervergeConfigured,

  async verify(input: IdVerificationInput): Promise<IdVerificationResult> {
    if (!hypervergeConfigured()) {
      throw new IdProviderError("hyperverge", "HyperVerge is not configured on this server.");
    }

    const signals: IdSignal[] = [];
    const fields = {
      full_name: null as string | null,
      id_number: null as string | null,
      date_of_birth: null as string | null,
      date_of_expiry: null as string | null,
    };

    /* ---- 1. read the front of the card ------------------------------- */

    let frontRaw: any = null;
    try {
      frontRaw = await call(
        "id-card-ocr",
        { bytes: input.front.bytes, type: input.front.type, filename: "id-front.jpg" },
        { document_type: input.docType }
      );

      fields.full_name = pickName(frontRaw);
      fields.id_number =
        pickString(frontRaw, ["id_number", "idNumber", "document_number", "documentNumber", "number"]) ??
        null;
      fields.date_of_birth =
        pickString(frontRaw, ["dob", "date_of_birth", "dateOfBirth", "birth_date"]) ?? null;
      fields.date_of_expiry =
        pickString(frontRaw, ["expiry", "expiration", "date_of_expiry", "dateOfExpiry", "valid_until"]) ??
        null;

      const read = fields.full_name ?? fields.id_number;

      signals.push(
        read
          ? {
              id: "hv_ocr",
              label: "Text read from the ID",
              tone: "pass",
              detail:
                `Read ${fields.full_name ? `the name "${fields.full_name}"` : "no name"}` +
                (fields.id_number ? ` and the number ${fields.id_number}` : "") +
                " off the card.",
            }
          : {
              id: "hv_ocr",
              label: "Text read from the ID",
              tone: "warn",
              detail:
                "HyperVerge accepted the card but read no name or number from it. Either the " +
                "document type is wrong or the image is too poor — check it against the card yourself.",
            }
      );
    } catch (e) {
      signals.push(unavailableSignal("hv_ocr", "Text read from the ID", e));
    }

    /* ---- 2. has the image been doctored? ------------------------------ */

    try {
      const forgery = await call(
        "id-forgery-check",
        { bytes: input.front.bytes, type: input.front.type, filename: "id-front.jpg" }
      );

      const verdict = (pickString(forgery, ["result", "status", "verdict", "outcome"]) ?? "").toLowerCase();
      const genuine = /authentic|genuine|pass|not.?detected|l|genuine_document/i.test(verdict);
      const flagged = /suspect|fake|forg|tamper|manipulat|fail/i.test(verdict);

      signals.push(
        flagged
          ? {
              id: "hv_forgery",
              label: "No sign of tampering",
              tone: "fail",
              detail: `HyperVerge flagged this image as ${verdict || "suspicious"}. Look closely at the card before approving.`,
            }
          : genuine
            ? {
                id: "hv_forgery",
                label: "No sign of tampering",
                tone: "pass",
                detail: "HyperVerge found no signs of digital manipulation in this image.",
              }
            : {
                id: "hv_forgery",
                label: "No sign of tampering",
                tone: "unknown",
                detail:
                  `HyperVerge answered "${verdict || "with something unrecognised"}", which is not a ` +
                  "verdict this app knows how to read. Nothing was concluded either way.",
              }
      );
    } catch (e) {
      signals.push(unavailableSignal("hv_forgery", "No sign of tampering", e));
    }

    /* ---- 3. does the portrait match the person? ----------------------- */

    if (input.photo) {
      try {
        const match = await call("face-match", {
          bytes: input.photo.bytes,
          type: input.photo.type,
          filename: "person.jpg",
        }, {
          // The card image is what the comparison is against. HyperVerge takes
          // the candidate face as the main part and the reference alongside it.
          reference_image_base64: Buffer.from(input.front.bytes).toString("base64"),
        });

        const similarity = pickSimilarity(match);

        if (similarity === null) {
          signals.push({
            id: "hv_face",
            label: "Vendor face match",
            tone: "unknown",
            detail: "HyperVerge returned no similarity score for this pair.",
          });
        } else {
          const pct = (similarity * 100).toFixed(1);
          signals.push(
            similarity >= HYPERVERGE_FACE_MATCH_THRESHOLD
              ? {
                  id: "hv_face",
                  label: "Vendor face match",
                  adminOnly: true,
                  tone: "pass",
                  detail:
                    `HyperVerge scored ${pct}% similarity between the card portrait and the photo ` +
                    `(its threshold is ${(HYPERVERGE_FACE_MATCH_THRESHOLD * 100).toFixed(0)}%).`,
                }
              : similarity >= HYPERVERGE_FACE_MATCH_THRESHOLD * 0.85
                ? {
                    id: "hv_face",
                    label: "Vendor face match",
                    adminOnly: true,
                    tone: "warn",
                    detail:
                      `HyperVerge scored ${pct}% similarity — below its ` +
                      `${(HYPERVERGE_FACE_MATCH_THRESHOLD * 100).toFixed(0)}% threshold but not far from it. ` +
                      "Compare the two images yourself.",
                  }
                : {
                    id: "hv_face",
                    label: "Vendor face match",
                    adminOnly: true,
                    tone: "fail",
                    detail: `HyperVerge scored only ${pct}% similarity between the card portrait and the photo.`,
                  }
          );
        }
      } catch (e) {
        signals.push(unavailableSignal("hv_face", "Vendor face match", e));
      }
    } else {
      signals.push({
        id: "hv_face",
        label: "Vendor face match",
        tone: "unknown",
        detail: "No photo of the person was attached, so there was nothing to compare the card against.",
      });
    }

    return { provider: "hyperverge", signals, fields, raw: frontRaw };
  },
};

/**
 * A provider that could not run, turned into a signal rather than an exception.
 *
 * The alternative — letting the orchestrator catch and drop the whole provider —
 * would throw away the other two checks from a call that mostly succeeded. A
 * café owner needs to know that forgery detection did not run, and needs to know
 * it without losing the name that was read off the card.
 */
function unavailableSignal(id: string, label: string, error: unknown): IdSignal {
  const message =
    error instanceof IdProviderError
      ? error.message
      : error instanceof Error
        ? error.message
        : "an unknown error";

  return {
    id,
    label,
    tone: "unknown",
    detail: `This check did not run: ${message} The other checks below still apply.`,
  };
}
