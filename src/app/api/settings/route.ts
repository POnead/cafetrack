import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clearSettingsCache } from "@/lib/settings";
import { emailStatus } from "@/lib/email";

export const runtime = "nodejs";

/**
 * Keys never returned by GET, however they came to be in the table.
 *
 * `smtp_pass_enc` holds the encrypted mail app password. Even as ciphertext it
 * has no business in a general settings response — it is not a setting, it is a
 * credential, and anything that ships it to a browser widens the number of
 * places it can leak from. The Email page describes the account through
 * /api/email instead, which returns only whether a password exists.
 *
 * Blocked by key rather than deleted, so adding another credential later fails
 * closed instead of publishing it.
 */
const SECRET_KEYS = new Set(["smtp_pass_enc"]);

/**
 * Read the tunable company settings.
 *
 * Admin-only, because the same page is the only place these can be written
 * (see PATCH below) and the values are operational policy rather than trivia.
 * `requireAdmin()` throws a 403 for staff, which `handler` turns into a clean
 * JSON response.
 */
export const GET = handler(async () => {
  await requireAdmin();

  const { data, error } = await db().from("settings").select("key, value").order("key");

  if (error) return fail(error.message, 500);

  const values: Record<string, string> = {};
  for (const row of (data ?? []) as { key: string; value: string }[]) {
    if (SECRET_KEYS.has(row.key)) continue;
    values[row.key] = row.value;
  }

  return ok({ settings: values });
});

/**
 * The editable settings, with the same bounds lib/settings.ts clamps to.
 * Kept here so the API rejects an out-of-range value at the door rather than
 * silently storing it and relying on every reader to re-clamp.
 *
 * `decimals` exists because the rest of this map counts things — days, minutes,
 * hours, attempts — and a count rounded to a whole number is the right answer.
 * The face match threshold is not a count: 0.60 rounded is 1, which is both a
 * different value and outside the 0.30-0.80 range it lives in, so it would be
 * rejected as out of range rather than stored. Unset means whole numbers, which
 * is every existing setting and so changes nothing for any of them.
 */
const EDITABLE: Record<
  string,
  { min: number; max: number; label: string; decimals?: number }
> = {
  session_timeout_minutes: { min: 1, max: 480, label: "Session timeout" },
  expiry_warning_days: { min: 1, max: 365, label: "Expiry warning window" },
  // Email (FR-11).
  email_dedupe_hours: { min: 1, max: 168, label: "Duplicate alert window" },
  email_max_attempts: { min: 1, max: 10, label: "Delivery attempts" },
  email_daily_summary_hour: { min: 0, max: 23, label: "Daily summary hour" },
  // Duty verification. A whole number of hours, so no `decimals` here.
  face_duty_hours: { min: 1, max: 24, label: "Duty length" },
  /*
   * Cosine distance, so a fraction between 0 and 2 rather than a count. Lower
   * is stricter.
   *
   * Measured over the real recognition model: the same person re-captured ten
   * ways lands at 0.0000-0.0301, five known-different faces at 0.0362-0.0684.
   * The default of 0.033 sits in that gap. The numbers live beside
   * DEFAULT_MATCH_THRESHOLD in lib/face.ts.
   *
   * Three decimals, because the whole useful range is a hundredth wide. At two
   * decimals a value like 0.033 cannot even be stored — it would round to 0.03,
   * which is a different, stricter setting the cafe never chose.
   */
  face_match_threshold: {
    min: 0.01,
    max: 0.5,
    decimals: 3,
    label: "Face match threshold",
  },
  /*
   * The ID-card portrait threshold, which is a different number from the one
   * above and for a different reason.
   *
   * face_match_threshold compares two photographs of one person taken seconds
   * apart; this compares a *printed* portrait against a live photo. The second
   * is a much harder problem and every vendor uses a much looser threshold for
   * it. The bounds are MIN/MAX_ID_MATCH_THRESHOLD from lib/id-verification/local.ts,
   * which also carries the reasoning and the caveat that the default is reasoned
   * rather than measured.
   */
  id_face_match_threshold: {
    min: 0.1,
    max: 0.95,
    decimals: 3,
    label: "ID portrait match threshold",
  },
};

/**
 * Free-text settings have a length cap instead of a numeric range.
 *
 * `allowEmpty` is for a setting whose unset state is meaningful and has to be
 * reachable from this form. Without it, "no value" and "the wrong value" would
 * both be un-sayable and an admin could only ever set one.
 *
 * `validate` returns an error message, or null when the value is acceptable. It
 * exists for the one rule a length cap cannot express.
 */
const TEXT_SETTINGS: Record<
  string,
  {
    maxLength: number;
    label: string;
    allowEmpty?: boolean;
    validate?: (value: string) => string | null;
  }
> = {
  business_name: { maxLength: 120, label: "Business name" },
  email_from: { maxLength: 200, label: "Sender address" },
  // The address a staff phone opens to run the check, when the register itself
  // has no camera. Blank is the normal state and means no phone fallback.
  //
  // The https rule is enforced here rather than left to the reader because it is
  // the one value in the table whose failure is invisible: `http://192.168.1.5`
  // loads fine on the phone and then cannot open a camera, because browsers only
  // grant camera access to a secure origin. The user gets a dead camera and no
  // error, so it is worth refusing the value where an admin can still be told.
  face_verify_public_url: {
    maxLength: 200,
    label: "Verification address",
    allowEmpty: true,
    validate: (value) => {
      if (!/^https:\/\/[^\s/$.?#].[^\s]*$/i.test(value)) {
        return "Verification address must start with https:// — a phone cannot open a camera over plain http";
      }
      return null;
    },
  },
  /*
   * Which engine reads an ID. Free text with a whitelist rather than a closed
   * list, because "auto" is a real and useful value here and the set of
   * providers grows by adding a file.
   *
   * A name that is not available is accepted on purpose. The orchestrator falls
   * back to whatever *is* configured, so a typo leaves the feature working with
   * fewer checks rather than taking it down — see chooseProviders.
   */
  id_provider: {
    maxLength: 40,
    label: "ID verification provider",
    allowEmpty: true,
    validate: (value) => {
      const v = value.trim().toLowerCase();
      if (!v) return null;
      if (!["auto", "local", "local_ocr", "hyperverge"].includes(v)) {
        return 'Provider must be "auto", "local", "local_ocr" or "hyperverge"';
      }
      return null;
    },
  },
  /*
   * Which face engine the cafe runs: "legacy" or "sface".
   *
   * A closed list, because unlike `id_provider` there is no safe fallback — an
   * unrecognised value here would mean "compare against vectors from a model
   * that does not exist", and the safe reading of that is legacy, which is what
   * the reader does. Refusing the value at the door means the admin is told
   * rather than quietly getting the old engine back.
   *
   * There is deliberately no control for this on the Settings page yet. The
   * capture screens still compute the legacy embedding, so switching to sface
   * today would leave every staff member unable to pass a check until each was
   * re-enrolled. The switch is stored, and enforced at matching time — which is
   * what makes the staged migration possible once the capture path lands.
   */
  face_engine: {
    maxLength: 10,
    label: "Face engine",
    validate: (value) => {
      const v = value.trim().toLowerCase();
      if (!["legacy", "sface"].includes(v)) {
        return 'Face engine must be "legacy" or "sface"';
      }
      return null;
    },
  },
};

/**
 * Off/on switches, stored as the strings "0" and "1" because that is what the
 * settings table holds and what the email code reads.
 *
 * Separate from the numeric bounds above so a stray `email_enabled: "banana"`
 * cannot be coerced into a truthy number by `Number()`.
 */
const TOGGLES: Record<string, string> = {
  email_enabled: "Email notifications",
  face_verification_enabled: "Duty face verification",
  face_login_enabled: "Sign in with a face",
  // Off by default, and the wording matters: this makes an *unverified* account
  // unable to sign in. It does not make an account verified — that still needs a
  // document and an admin pressing Approve. See lib/id-gate.ts.
  id_verification_required: "Require a checked ID before sign-in",
  /*
   * The on-device text reader. On by default when the key is absent, so an
   * existing install gets it without a migration.
   *
   * Separate from `id_provider` because that setting chooses *which* engine runs
   * and this one switches one engine off. Without a way to disable it, a café whose
   * cards the hand-written templates misread would have to remove the whole ID
   * verification feature — see the header note in
   * src/lib/id-verification/ocr/templates.ts on why that is a realistic thing to
   * need.
   */
  local_ocr_enabled: "Read ID text on this machine (free — nothing leaves the device)",
  /*
   * Sign in by ID card and face rather than badge and password.
   *
   * Off by default, and not because it is unfinished — because it needs the text
   * model downloaded and a staff account with a card on file, and turning it on
   * without those presents a sign-in button that cannot work. See the header of
   * src/app/api/auth/id-login/route.ts for what the card does and does not prove.
   */
  id_login_enabled: "Sign in with an ID card and your face",
};

/**
 * Update settings. Accepts a partial object, e.g. `{ expiry_warning_days: "14" }`.
 *
 * The local adapter has no `upsert`, so each key is updated and inserted only
 * if no row came back — that keeps this working in both local and Supabase mode
 * without extending the adapter.
 */
export const PATCH = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const changes: Record<string, string> = {};

  for (const [key, raw] of Object.entries(body ?? {})) {
    // Credentials are written through /api/email, which encrypts them. Letting
    // them be set here as plain text would put an unencrypted value in the
    // table under a key the rest of the app assumes is ciphertext.
    if (SECRET_KEYS.has(key)) {
      return fail(`"${key}" cannot be set here`, 400);
    }

    const numeric = EDITABLE[key];
    const text = TEXT_SETTINGS[key];
    const toggle = TOGGLES[key];

    if (!numeric && !text && !toggle) {
      return fail(`"${key}" is not a setting you can change`, 400);
    }

    if (toggle) {
      // Only the two canonical forms. Accepting anything else would mean
      // "off" and "maybe" both silently becoming true, which for a switch that
      // starts sending email is the wrong direction to be wrong in.
      const s = String(raw ?? "").trim().toLowerCase();
      if (s !== "0" && s !== "1" && s !== "true" && s !== "false") {
        return fail(`${toggle} must be on or off`);
      }
      changes[key] = s === "1" || s === "true" ? "1" : "0";
    } else if (numeric) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fail(`${numeric.label} must be a number`);
      if (n < numeric.min || n > numeric.max) {
        return fail(
          `${numeric.label} must be between ${numeric.min} and ${numeric.max}`
        );
      }
      // Rounded to the setting's own precision before it is stored, so a value
      // like 14.6 cannot be read back raw and a threshold cannot pick up digits
      // the admin never typed. `decimals` undefined means whole numbers, which is
      // every setting that counts something.
      changes[key] = String(
        numeric.decimals === undefined ? Math.round(n) : Number(n.toFixed(numeric.decimals))
      );
    } else {
      const s = String(raw ?? "").trim();
      if (!s) {
        // Only a setting that says so can be blank; for the others an empty value
        // is a mistake, not a request to unset something.
        if (!text!.allowEmpty) return fail(`${text!.label} cannot be empty`);
        changes[key] = "";
      } else if (s.length > text!.maxLength) {
        return fail(`${text!.label} must be under ${text!.maxLength} characters`);
      } else {
        const problem = text!.validate?.(s);
        if (problem) return fail(problem);
        changes[key] = s;
      }
    }
  }

  if (Object.keys(changes).length === 0) {
    return fail("No settings to update");
  }

  // Switching email on requires an account and a recipient.
  //
  // The Email page disables the toggle until both exist, but the API has to hold
  // the same line: this route is reachable directly, and an admin who enabled it
  // before adding a recipient would get a system that reports itself as on, sends
  // nothing, and says nothing about why. Refusing here means the two can never
  // disagree, whoever made the request.
  //
  // Turning it *off* is never blocked, and neither is setting other settings in
  // the same call, so nothing here can trap a cafe out of its own feature.
  if (changes.email_enabled === "1") {
    const { setup } = await emailStatus();
    if (!setup.ready) {
      const missing = setup.steps.filter((s) => !s.done).map((s) => s.need);
      return fail(
        `Email needs ${missing.join(" and ")} before it can be switched on.`,
        400
      );
    }
  }

  for (const [key, value] of Object.entries(changes)) {
    const { data, error } = await db()
      .from("settings")
      .update({ value })
      .eq("key", key)
      .select("key");

    if (error) return fail(error.message, 500);

    // No row matched — the key is new to this database, so add it.
    if (!data || data.length === 0) {
      const { error: insertError } = await db()
        .from("settings")
        .insert({ key, value });
      if (insertError) return fail(insertError.message, 500);
    }
  }

  // The readers in lib/settings.ts cache for a minute; without this an admin
  // would save a new threshold and not see it take effect for up to 60s.
  clearSettingsCache();

  await audit(admin, "SETTINGS_UPDATE", "settings", null, changes);

  return ok({ settings: changes });
});
