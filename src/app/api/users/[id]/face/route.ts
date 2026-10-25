import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, clientIp, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { parseEmbedding, formatEmbedding, distance, REPLACEMENT_MISMATCH_DISTANCE } from "@/lib/face";
import { readFaceImage } from "@/lib/face-image";
import { getFaceDutyHours } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * A staff member's reference face: enrol, replace, remove, view, and the manager
 * override that lets someone in when a camera will not cooperate.
 *
 *   POST    multipart — the photo and the embedding, both produced in the browser
 *   DELETE            — remove an enrolment
 *   PATCH             — manager override: waive this person's current duty check
 *   GET               — the reference photo, for the admin who enrolled it
 *
 * Three verbs in one file because they are three verbs on one resource and share
 * the same lookup. They do not share handlers: POST validates two inputs with
 * different rules, and folding that into one branchy handler is how a validation
 * ends up skipped on the path nobody tested.
 *
 * **Staff only.** Admins are never gated by the duty check — they are the people
 * who grant permissions, reset passwords and approve submissions — so an admin
 * account is refused here rather than quietly accepted and never used. It would
 * be a row that could never do anything.
 *
 * This is a separate route from /api/users, which stays JSON. The staff list is
 * loaded on every page load and the suites create accounts through it; making it
 * multipart would put a 30KB blob and a second content type into the hot path of
 * both for nothing. Creating an account and enrolling a face are two calls from
 * the UI, which also means a failed photo can be retried without leaving a
 * duplicate account behind.
 */

/** Never selects password_hash, and never selects face_embedding outside POST. */
const USER_COLUMNS =
  "id, username, full_name, role, qr_token, can_manage_items, approval_code, " +
  "is_active, deactivation_reason, deactivated_at, created_at, " +
  "face_enabled, face_enrolled_at, face_enrolled_by, last_face_verified_at";

/* ---------------------------------------------------------------- POST ---- */

export const POST = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    /*
     * multipart, not readBody().
     *
     * readBody() calls req.text() and JSON.parse, which turns a multipart body
     * into one unreadable string. That is the right behaviour for every other
     * route in the app and the wrong one here, so this route reads the form
     * directly. Nothing else in src/ does this yet.
     */
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail("Expected a multipart upload with a photo", 400);
    }

    // Read the row first, so a 404 is answered before any upload work, and so
    // the audit entry records what changed rather than only what was attempted.
    // The previous embedding comes back in the same read — it is needed for the
    // different-person warning below, and a second query to fetch what was
    // already in hand would spend a round trip on a 1.5KB text column.
    const { data: before } = await db()
      .from("users")
      .select(
        "id, username, full_name, role, is_active, face_enabled, face_enrolled_at, face_embedding"
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    if (before.role !== "staff") {
      return fail("Only staff accounts can have a face enrolled", 400);
    }

    // Embedding first: it is the part the server actually trusts, and a bad one
    // makes the whole enrolment worthless, so it should not cost a photo upload
    // to find out.
    const embedding = parseEmbedding(form.get("embedding"));
    if (!embedding) {
      return fail(
        "The face data was missing or malformed. Take the photo again — " +
          "the face could not be read from it."
      );
    }

    const image = await readFaceImage(form.get("image"));
    if (!image.ok) return fail(image.message);

    const { data, error } = await db()
      .from("users")
      .update({
        face_image: image.dataUrl,
        face_embedding: formatEmbedding(embedding),
        face_enabled: true,
        face_enrolled_at: new Date().toISOString(),
        face_enrolled_by: admin.id,
        // A fresh enrolment is not a pass. Someone re-photographed because the
        // old one was unusable should still have to turn up for the check.
        last_face_verified_at: null,
      })
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("User not found", 404);

    /*
     * Warn when a replacement looks like a different person.
     *
     * The realistic mistake is an admin photographing the wrong staff member, and
     * without this the symptom appears weeks later as a barista who cannot get in
     * and no record of why. The distance goes to the *admin*, who submitted it,
     * never to the person being enrolled — see the rule that a similarity figure
     * must never reach the face being checked.
     */
    let possiblyDifferentPerson = false;
    let previousDistance: number | null = null;

    const previousEmbedding = parseEmbedding(before.face_embedding);
    if (previousEmbedding) {
      previousDistance = distance(previousEmbedding, embedding);
      // A loose bar on purpose: the same person's captures vary more than this
      // under ordinary conditions — lighting, glasses, a long shift — while a
      // different person sits well outside it, so only a real mismatch trips it.
      possiblyDifferentPerson = previousDistance > REPLACEMENT_MISMATCH_DISTANCE;
    }

    await audit(
      admin,
      "USER_FACE_ENROLL",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        replaced: Boolean(previousEmbedding),
        image_bytes: image.bytes,
        image_type: image.type,
        possibly_different_person: possiblyDifferentPerson,
        previous_distance:
          previousDistance === null ? null : Number(previousDistance.toFixed(4)),
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      // Null on a first enrolment, where there is nothing to compare against.
      warning: possiblyDifferentPerson
        ? "This photo looks like a different person than the one already enrolled."
        : null,
    });
  }
);

/* -------------------------------------------------------------- DELETE ---- */

export const DELETE = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data: before } = await db()
      .from("users")
      .select("id, username, full_name, role, face_enabled")
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    // Refusing a no-op keeps the trail honest: an entry saying a face was
    // removed when there was never one is a claim that something happened.
    if (!before.face_enabled) {
      return fail("That account has no face enrolled", 400);
    }

    // The photo and the embedding go together, and the last pass goes with them.
    // Keeping the vector after an explicit removal would mean "remove" did not
    // remove, and the next person enrolled on that account would inherit a face
    // they never agreed to.
    const { data, error } = await db()
      .from("users")
      .update({
        face_image: null,
        face_embedding: null,
        face_enabled: false,
        face_enrolled_at: null,
        face_enrolled_by: null,
        last_face_verified_at: null,
      })
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "USER_FACE_REVOKE",
      "user",
      data.id,
      { username: data.username, full_name: data.full_name },
      { ip: clientIp(req) }
    );

    return ok({ user: data });
  }
);

/* --------------------------------------------------------------- PATCH ---- */

/**
 * The manager override: let this person in without a face check.
 *
 * The last resort behind a phone with no camera, a dead webcam, or a face the
 * model will not read at the cafe's lighting. It stamps the same column a real
 * check would, so the window behaves identically — and it is *not* a way to
 * switch the feature off for one person, because it only buys them this one
 * window. Tomorrow they are back in front of the camera, which is the point.
 *
 * A reason is mandatory. Without one, the audit log records that someone was let
 * through with no explanation, which is precisely the entry an owner needs to be
 * able to explain to themselves a week later.
 */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    // JSON, not multipart — this one carries no file, and readBody() is right
    // for it. The two shapes on one route is the cost of putting all four verbs
    // in one place.
    const body = await readBody(req);
    const reason = String(body.reason ?? "").trim();

    if (reason.length < 3) {
      return fail("Give a reason for the override — it goes in the audit log");
    }
    if (reason.length > 300) {
      return fail("Reason must be 300 characters or fewer");
    }

    const { data: before } = await db()
      .from("users")
      .select("id, username, full_name, role, is_active, face_enabled, last_face_verified_at")
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    if (before.role !== "staff") {
      return fail("Only staff accounts are subject to the duty check", 400);
    }
    if (!before.is_active) {
      return fail("That account is deactivated", 400);
    }

    const hours = await getFaceDutyHours();
    const now = new Date().toISOString();

    const { data, error } = await db()
      .from("users")
      .update({ last_face_verified_at: now })
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("User not found", 404);

    await audit(
      admin,
      "FACE_VERIFY_OVERRIDE",
      "user",
      data.id,
      {
        username: data.username,
        full_name: data.full_name,
        reason,
        duty_hours: hours,
        // Whether this actually let someone in, or just renewed a window they
        // already had. Worth distinguishing: the second means someone is using
        // the override as a default and not noticing.
        was_already_verified: Boolean(before.last_face_verified_at),
      },
      { ip: clientIp(req) }
    );

    return ok({
      user: data,
      duty_hours: hours,
      next_due: new Date(Date.now() + hours * 3_600_000).toISOString(),
    });
  }
);

/* ----------------------------------------------------------------- GET ---- */

/**
 * The reference photo.
 *
 * Served rather than inlined into the user list: the list is fetched on every page
 * load and each photo is ~30KB of base64, so embedding them would make the staff
 * list twenty times heavier for a thumbnail that appears in exactly two places.
 *
 * Admin-only, and deliberately not "anyone signed in". The proxy has established
 * that *a* session exists; it says nothing about which account, so a route that
 * trusted that would let any staff member read any other staff member's
 * photograph.
 */
export const GET = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("users")
      .select("face_image")
      .eq("id", id)
      .maybeSingle();

    if (error) return fail(error.message, 500);
    if (!data) return fail("User not found", 404);

    const stored = String(data.face_image ?? "");
    if (!stored.startsWith("data:")) return fail("No face enrolled", 404);

    const match = /^data:([^;,]+);base64,(.*)$/.exec(stored);
    if (!match) return fail("No face enrolled", 404);

    const [, type, base64] = match;

    // Private and short-lived. This is biometric data about a named person: it
    // must not sit in a shared cache, and a stale thumbnail after a re-enrolment
    // would be the wrong face beside the right name.
    return new Response(Buffer.from(base64, "base64"), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
);
