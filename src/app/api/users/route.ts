import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, dbFail } from "@/lib/api";
import { hashPassword, newStaffToken, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { currentSampleUserIds } from "@/lib/face-samples";
import { getFaceEngine, getFaceLoginSettings } from "@/lib/settings";
import { getDutyWindow } from "@/lib/face-gate";
import { FACE_POSES, type FacePose } from "@/lib/face";

export const runtime = "nodejs";

/**
 * Never select password_hash — it must not leave the database.
 *
 * face_image is deliberately absent. It is ~30KB of base64 per enrolled person
 * and this list is fetched on every page load; the two places a photo appears get
 * it from /api/users/:id/face-image instead. The cheap face_* columns are here so
 * the staff list can show who is enrolled and who is due a check without a second
 * request.
 *
 * The id_doc_* columns are absent for the same reason and more sharply: a front,
 * a back and a photo is a few hundred kilobytes of base64 *per person*, so
 * selecting them here would multiply the weight of the roster by two orders of
 * magnitude on a page an admin opens constantly. What is included instead is the
 * three small scalars the roster actually renders — status, document type and
 * when it was approved. The images, the signals and the extracted fields come
 * from /api/users/:id/id/status, which is only fetched when someone is reviewing.
 */
const USER_COLUMNS =
  "id, username, recovery_email, full_name, role, qr_token, can_manage_items, is_active, deactivation_reason, deactivated_at, created_at, position, start_date, first_name, last_name, face_enabled, face_enrolled_at, last_face_verified_at, profile_photo_updated_at, verification_status, id_doc_type, verified_at";

/* ---------------- list ---------------- */
export const GET = handler(async () => {
  await requireAdmin();

  const { data, error } = await db()
    .from("users")
    .select(USER_COLUMNS)
    .order("role", { ascending: true })
    .order("full_name", { ascending: true });

  if (error) return dbFail(error);

  /*
   * Which enrolled faces the current engine can actually compare.
   *
   * This is the forced re-enrolment state made visible. A descriptor is only
   * meaningful to the engine and reader version that produced it, so switching
   * engine (or fixing the reader, which is what version 2 did) leaves older
   * enrolments stored but unusable. Without this flag the roster shows "enrolled"
   * for somebody who will be refused at the till, and the first anyone hears of it
   * is that person being turned away mid-shift.
   *
   * One extra query for the whole list, not one per person.
   */
  const users = (data ?? []) as Record<string, unknown>[];
  const engine = await getFaceEngine();
  const current = await currentSampleUserIds(
    users.map((u) => String(u.id)),
    engine
  );
  const userIds = users.map((u) => String(u.id));
  const { data: samples, error: samplesError } = users.length
    ? await db()
        .from("user_face_samples")
        .select("user_id, pose")
        .in("user_id", userIds)
    : { data: [], error: null };

  if (samplesError) return dbFail(samplesError, { context: "staff face samples" });

  const posesByUser = new Map<string, Set<FacePose>>();
  for (const sample of (samples ?? []) as { user_id: string; pose: string }[]) {
    if (!FACE_POSES.includes(sample.pose as FacePose)) continue;
    const poses = posesByUser.get(sample.user_id) ?? new Set<FacePose>();
    poses.add(sample.pose as FacePose);
    posesByUser.set(sample.user_id, poses);
  }

  /*
   * Whether each person is inside their duty window right now.
   *
   * Derived here rather than left to the browser, because the answer depends on
   * the admin-configured duty hours and on the server's clock. The panel used to
   * show only "last passed", which reads identically whether the check is still
   * good or ran out hours ago — and an override that stamps a fresh timestamp
   * then looked like no change at all. Settings are cached in-process, so this
   * is arithmetic per row, not a query per row.
   */
  const facePolicy = await getFaceLoginSettings();
  const duty = await Promise.all(
    users.map((u) =>
      getDutyWindow({
        userId: String(u.id),
        role: String(u.role),
        faceEnabled: u.face_enabled === true,
        lastVerifiedAt: (u.last_face_verified_at as string | null) ?? null,
      }, facePolicy)
    )
  );

  return ok({
    users: users.map((u, i) => ({
      ...u,
      profile_photo_url: u.profile_photo_updated_at
        ? `/api/users/${String(u.id)}/profile-photo?v=${encodeURIComponent(String(u.profile_photo_updated_at))}`
        : null,
      face_needs_enrolment: Boolean(u.face_enabled) && !current.has(String(u.id)),
      face_poses: u.face_enabled
        ? FACE_POSES.filter(
            (pose) => pose === "front" || posesByUser.get(String(u.id))?.has(pose)
          )
        : [],
      duty_window_open: duty[i].open,
      duty_check_enabled: duty[i].enabled,
      duty_next_due_at: duty[i].until,
      duty_bypassed: duty[i].bypassed,
    })),
  });
});

/* ---------------- create ---------------- */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const username = String(body.username ?? "")
    .trim()
    .toLowerCase();
  const fullName = String(body.full_name ?? "").trim();
  const password = String(body.password ?? "");
  const role = String(body.role ?? "staff");
  const position = String(body.position ?? "").trim();
  const startDate = String(body.start_date ?? "").trim();
  const firstName = String(body.first_name ?? "").trim();
  const lastName = String(body.last_name ?? "").trim();
  const recoveryEmail = String(body.recovery_email ?? "").trim().toLowerCase();

  // Composed here so everything downstream can keep reading full_name — that is
  // what the printed badge label, the audit log and the movement history use.
  const composedName =
    firstName || lastName ? `${firstName} ${lastName}`.trim() : fullName;

  if (username.length < 3) return fail("Username must be at least 3 characters");
  if (!composedName) return fail("Full name is required");
  if (firstName.length > 60 || lastName.length > 60) {
    return fail("Names must be 60 characters or fewer");
  }
  // Same minimum as change-password and the admin reset — one policy, whichever
  // door the password arrives through.
  if (password.length < 8) return fail("Password must be at least 8 characters");
  if (role !== "admin" && role !== "staff") return fail("Invalid role");
  if (role === "admin" && !recoveryEmail) {
    return fail("A recovery email is required for admin accounts");
  }
  if (
    role === "admin" &&
    (recoveryEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recoveryEmail))
  ) {
    return fail("Enter a valid admin recovery email address");
  }
  if (position.length > 80) return fail("Position must be 80 characters or fewer");

  // Shape-checked rather than left to the insert, for the same reason the edit
  // route does: a bad date is a type error in Postgres, which would surface as a
  // 500 and read to an admin as the page being broken.
  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    return fail("Start date must be a date (YYYY-MM-DD)");
  }

  const { data: taken } = await db()
    .from("users")
    .select("id")
    .eq("username", username)
    .maybeSingle();

  if (taken) return fail("That username is already taken", 409);

  const { data, error } = await db()
    .from("users")
    .insert({
      username,
      recovery_email: role === "admin" ? recoveryEmail : null,
      full_name: composedName,
      first_name: firstName || null,
      last_name: lastName || null,
      password_hash: hashPassword(password),
      role,
      // Staff sign in with the printed barcode code; admins sign in with a
      // username. The column is still called qr_token for historical reasons.
      qr_token: role === "staff" ? newStaffToken() : null,
      is_active: true,
      deactivation_reason: null,
      deactivated_at: null,
      // FR-03. Grantable at creation so a trusted hire starts with it rather
      // than needing a second trip to the admin. Only meaningful for staff —
      // an admin can already manage items.
      can_manage_items: role === "staff" ? body.can_manage_items === true : false,
      // Employment details, both optional. Staff only — an admin is not on the
      // payroll, so a position or a start date would be meaningless for them.
      position: role === "staff" && position ? position : null,
      start_date: role === "staff" && startDate ? startDate : null,
      // Staff only, and always 'unverified' here. The column default is the same
      // value, but naming it means the intent is visible at the insert rather than
      // being something a reader has to go and look up in the schema — and this
      // is the one status that makes an account's next step obvious.
      //
      // Note that this is only a *record* requirement. Whether it stops anyone
      // signing in is settings.id_verification_required, which is off by default;
      // see lib/id-gate.ts.
      verification_status: role === "staff" ? "unverified" : "verified",
    })
    .select(USER_COLUMNS)
    .single();

  if (error) return dbFail(error);

  await audit(admin, "USER_CREATE", "user", data.id, {
    username: data.username,
    role: data.role,
    has_qr: Boolean(data.qr_token),
    can_manage_items: data.can_manage_items,
    position: data.position,
    start_date: data.start_date,
    verification_status: data.verification_status,
  });

  return ok({ user: data }, 201);
});
