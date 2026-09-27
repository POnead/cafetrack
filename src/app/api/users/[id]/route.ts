import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { hashPassword, newStaffToken, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const USER_COLUMNS =
  "id, username, full_name, role, qr_token, is_active, deactivation_reason, deactivated_at, created_at";

/** Update a staff/admin account: name, password, status, staff code. */
export const PATCH = handler(
  async (req: Request, { params }: { params: { id: string } }) => {
    const admin = await requireAdmin();
    const body = await req.json();

    const { data: before } = await db()
      .from("users")
      .select("id, username, full_name, role, is_active")
      .eq("id", params.id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    const patch: Record<string, unknown> = {};
    const changed: string[] = [];

    // Optional note explaining why an account is being switched off. It is
    // shown to the person on the sign-in screen, so it is length-capped and
    // never allowed to be a secret.
    let reason: string | null | undefined;
    if (body.deactivation_reason !== undefined) {
      const raw = String(body.deactivation_reason ?? "").trim();
      if (raw.length > 500) {
        return fail("Deactivation reason must be 500 characters or fewer");
      }
      reason = raw.length > 0 ? raw : null;
    }

    if (body.full_name !== undefined) {
      const name = String(body.full_name).trim();
      if (!name) return fail("Full name cannot be empty");
      patch.full_name = name;
      changed.push("full_name");
    }

    if (body.password !== undefined) {
      const pw = String(body.password);
      if (pw.length < 6) return fail("Password must be at least 6 characters");
      patch.password_hash = hashPassword(pw);
      changed.push("password");
    }

    if (body.regenerate_token === true) {
      patch.qr_token = newStaffToken();
      changed.push("qr_token");
    }

    if (body.is_active !== undefined) {
      const active = body.is_active === true;

      if (!active) {
        // Guard against locking every admin out of the system.
        if (before.id === admin.id) {
          return fail("You cannot deactivate your own account", 400);
        }

        if (before.role === "admin") {
          const { data: admins } = await db()
            .from("users")
            .select("id, role, is_active")
            .eq("role", "admin");

          const others = ((admins ?? []) as { id: string; is_active: boolean }[]).filter(
            (a) => a.is_active && a.id !== before.id
          );

          if (others.length === 0) {
            return fail(
              "This is the last active admin — promote another admin before deactivating this one.",
              400
            );
          }
        }
      }

      patch.is_active = active;
      changed.push("is_active");

      if (!active) {
        patch.deactivation_reason = reason ?? null;
        patch.deactivated_at = new Date().toISOString();
        if (reason) changed.push("deactivation_reason");
      } else {
        // Re-activating clears the trail, so a stale reason can never be shown
        // on the sign-in screen afterwards.
        patch.deactivation_reason = null;
        patch.deactivated_at = null;
      }
    }

    // Editing the note on an account that is already switched off.
    if (
      reason !== undefined &&
      body.is_active === undefined &&
      before.is_active === false
    ) {
      patch.deactivation_reason = reason;
      changed.push("deactivation_reason");
    }

    if (changed.length === 0) return fail("Nothing to update");

    const { data, error } = await db()
      .from("users")
      .update(patch)
      .eq("id", params.id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message, 409);
    if (!data) return fail("User not found", 404);

    // Records which fields changed — never the secret values themselves. The
    // deactivation reason is included because it is deliberately not private:
    // the person signing in is shown it.
    await audit(admin, "USER_UPDATE", "user", data.id, {
      username: data.username,
      changed,
      ...(data.is_active === false
        ? {
            deactivation_reason: data.deactivation_reason ?? null,
            deactivated_at: data.deactivated_at ?? null,
          }
        : {}),
    });

    return ok({ user: data });
  }
);
