import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody } from "@/lib/api";
import { hashPassword, newStaffToken, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/** Never select password_hash — it must not leave the database. */
const USER_COLUMNS =
  "id, username, full_name, role, qr_token, is_active, deactivation_reason, deactivated_at, created_at";

/* ---------------- list ---------------- */
export const GET = handler(async () => {
  await requireAdmin();

  const { data, error } = await db()
    .from("users")
    .select(USER_COLUMNS)
    .order("role", { ascending: true })
    .order("full_name", { ascending: true });

  if (error) return fail(error.message, 500);

  return ok({ users: data ?? [] });
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

  if (username.length < 3) return fail("Username must be at least 3 characters");
  if (!fullName) return fail("Full name is required");
  if (password.length < 6) return fail("Password must be at least 6 characters");
  if (role !== "admin" && role !== "staff") return fail("Invalid role");

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
      full_name: fullName,
      password_hash: hashPassword(password),
      role,
      // Staff sign in with the printed barcode code; admins sign in with a
      // username. The column is still called qr_token for historical reasons.
      qr_token: role === "staff" ? newStaffToken() : null,
    })
    .select(USER_COLUMNS)
    .single();

  if (error) return fail(error.message, 500);

  await audit(admin, "USER_CREATE", "user", data.id, {
    username: data.username,
    role: data.role,
    has_qr: Boolean(data.qr_token),
  });

  return ok({ user: data }, 201);
});
