import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody } from "@/lib/api";
import { hashPassword, verifyPassword, newStaffToken, requireAdmin } from "@/lib/auth";
import { randomBytes } from "node:crypto";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * face_image is deliberately absent — see the same list in api/users/route.ts.
 * face_embedding is absent for a sharper reason: it is the biometric itself, and
 * this route has no reason to read it.
 */
const USER_COLUMNS =
  "id, username, full_name, first_name, last_name, role, qr_token, can_manage_items, approval_code, is_active, deactivation_reason, deactivated_at, created_at, position, start_date, face_enabled, face_enrolled_at, last_face_verified_at";

/** Update a staff/admin account: name, password, status, staff code. */
export const PATCH = handler(
  async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
    const admin = await requireAdmin();
    const { id } = await params;

    const malformed = badId(id, "user");
    if (malformed) return malformed;

    const body = await readBody(req);

    // `can_manage_items` and `approval_code` have to be read here, not just
    // written. The audit records below need the *previous* value to tell a real
    // grant or revocation from a no-op — and when this select omitted them, the
    // comparison was `Boolean(undefined) !== false`, which is always false, so
    // ITEM_PERMISSION_REVOKE could never fire. Taking away someone's ability to
    // edit the catalogue left no specific trace at all, which is the single
    // change on this route most worth being able to find afterwards.
    const { data: before } = await db()
      .from("users")
      .select(
        "id, username, full_name, first_name, last_name, role, is_active, can_manage_items, approval_code"
      )
      .eq("id", id)
      .maybeSingle();

    if (!before) return fail("User not found", 404);

    const patch: Record<string, unknown> = {};
    const changed: string[] = [];

    /**
     * Audit records to append, gathered while validating the request and
     * written only once the update has actually succeeded.
     *
     * The order matters. An audit entry that claims a change which then failed
     * is worse than no entry at all — it puts a lie in an append-only log that
     * is supposed to be the thing you can trust. (The item-permission grant
     * below predates this and records its intent before writing; these do it
     * the other way round, which is why they are collected here first.)
     */
    const specific: { action: string; details: Record<string, unknown> }[] = [];

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

    /*
     * First name and surname.
     *
     * Setting either recomposes full_name, which is the string every other screen
     * reads. Accepting one half alone would otherwise leave the printed badge and
     * the audit log showing half a name while the roster showed a whole one — two
     * truths about the same person, which is worse than either version.
     *
     * A blank means "not recorded" rather than an error: an account that predates
     * these columns has neither, and must stay editable.
     */
    if (body.first_name !== undefined || body.last_name !== undefined) {
      const first =
        body.first_name !== undefined
          ? String(body.first_name ?? "").trim()
          : (before.first_name ?? "");
      const last =
        body.last_name !== undefined
          ? String(body.last_name ?? "").trim()
          : (before.last_name ?? "");

      if (first.length > 60 || last.length > 60) {
        return fail("Names must be 60 characters or fewer");
      }

      const composed = `${first} ${last}`.trim();
      if (!composed) return fail("A name is required");

      patch.first_name = first || null;
      patch.last_name = last || null;
      patch.full_name = composed;
      changed.push("first_name", "last_name", "full_name");
    }

    /*
     * Employment details. Both optional, both clearable — an admin who typed the
     * wrong start date needs a way to remove it, not only a way to correct it.
     */
    if (body.position !== undefined) {
      const raw = String(body.position ?? "").trim();
      if (raw.length > 80) return fail("Position must be 80 characters or fewer");
      patch.position = raw.length > 0 ? raw : null;
      changed.push("position");
    }

    if (body.start_date !== undefined) {
      const raw = String(body.start_date ?? "").trim();
      if (raw === "") {
        patch.start_date = null;
      } else {
        // Checked by shape rather than by trying to insert it. Postgres reports a
        // bad date as a type error, which this route would turn into a 500, and
        // which reads to an admin as the page being broken.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          return fail("Start date must be a date (YYYY-MM-DD)");
        }
        const parsed = new Date(`${raw}T00:00:00Z`);
        if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
          return fail("That is not a real date");
        }
        patch.start_date = raw;
      }
      changed.push("start_date");
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
      specific.push({
        action: "STAFF_TOKEN_ROTATED",
        // The code itself is never recorded — it is a live credential, and this
        // log is append-only, so anything written here is kept forever. What an
        // owner needs is not the value but the consequence: a physical badge
        // stopped working, and it was on purpose.
        details: {
          username: before.username,
          full_name: before.full_name,
          previous_label_invalidated: true,
        },
      });
    }

    if (body.is_active !== undefined) {
      const active = body.is_active === true;

      if (!active) {
        // Guard against locking every admin out of the system.
        if (before.id === admin.id) {
          return fail("You cannot deactivate your own account", 400);
        }

        // An admin account is never switched off. They are the only role that can
        // grant permissions, reset passwords and promote anyone else, so
        // deactivating one leaves the cafe with nobody who can undo it — and the
        // "last active admin" guard below only catches the case where nobody else
        // is an admin yet.
        if (before.role === "admin") {
          return fail(
            "An admin account cannot be deactivated. Promote this person to staff first if they are leaving.",
            400
          );
        }

        /*
         * A reason is required, not optional.
         *
         * The person deactivated sees this text on the sign-in screen, and it is
         * also the only thing that tells the next person why an account with a
         * real barcode stopped working. Enforced here rather than only in the
         * dialog, because this route is reachable directly and a blank reason
         * writes a "no reason given" row that looks like a deliberate answer.
         */
        if (!reason) {
          return fail(
            "Give a reason for deactivating. The person will see it when they try to sign in.",
            400
          );
        }
      } else {
        /*
         * Re-activating asks the admin to type their own password.
         *
         * Deactivating is the safer direction — it takes a barcode away and
         * records why. Re-activating is the one that gives an account back, and
         * the session that can do it may have been left open and unattended on
         * the till all afternoon. Re-entering the admin's password is the
         * cheapest way to separate "the admin came back" from "someone found an
         * unlocked screen".
         *
         * Enforced here, not only in the dialog, for the same reason the reason
         * is: this route is reachable directly, and a dialog is not a control.
         */
        const confirmPassword = String(body.confirm_password ?? "");
        if (!confirmPassword) {
          return fail(
            "Confirm with your password to re-activate this account.",
            400
          );
        }

        const { data: adminRow } = await db()
          .from("users")
          .select("password_hash")
          .eq("id", admin.id)
          .maybeSingle();

        if (!adminRow?.password_hash || !verifyPassword(confirmPassword, adminRow.password_hash)) {
          return fail("That password is not correct", 401);
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

    // FR-03: per-person code for skipping the approval queue. Auto-generated
    // so the admin does not invent a weak one; clearing is explicit.
    if (body.regenerate_approval_code === true) {
      patch.approval_code = "CT-" + randomBytes(3).toString("hex").toUpperCase();
      changed.push("approval_code");
      // An approval code is the same kind of thing as the item-management grant
      // and it was the same gap: it lets one person bypass admin review, and the
      // only trace was a field name inside a generic USER_UPDATE. "Who was given
      // a standing pass on the approval queue" is exactly the question an owner
      // asks. The code value is deliberately not recorded — see the rotation
      // above for why.
      specific.push({
        action: "APPROVAL_CODE_ISSUED",
        details: {
          username: before.username,
          full_name: before.full_name,
          replaced: Boolean(before.approval_code),
        },
      });
    }
    if (body.approval_code === null || body.approval_code === "") {
      // Only a real revocation is worth recording — in the update or in the
      // trail. Nulling a field that was already null would otherwise append a
      // USER_UPDATE asserting that approval_code had changed, which is the same
      // class of lie as logging a change that then failed: it teaches you not to
      // trust the trail. With this, clearing a code that was never issued is a
      // no-op and answers "Nothing to update", exactly like an empty body.
      if (before.approval_code) {
        patch.approval_code = null;
        changed.push("approval_code");
        specific.push({
          action: "APPROVAL_CODE_REVOKED",
          details: { username: before.username, full_name: before.full_name },
        });
      }
    }

    // FR-03: grant or revoke the right to add, edit and delete items directly.
    // Recorded as its own audit action rather than a generic USER_UPDATE,
    // because it is the one change here that widens what a person can do to the
    // data, and "who gained write access to the catalogue, and who approved it"
    // is the question an owner would ask afterwards.
    if (body.can_manage_items !== undefined) {
      const grant = body.can_manage_items === true;
      patch.can_manage_items = grant;
      changed.push("can_manage_items");

      if (before.role !== "admin" && Boolean(before.can_manage_items) !== grant) {
        await audit(
          admin,
          grant ? "ITEM_PERMISSION_GRANT" : "ITEM_PERMISSION_REVOKE",
          "user",
          id,
          { username: before.username, full_name: before.full_name, can_manage_items: grant },
          { outcome: "success" }
        );
      }
    }

    if (changed.length === 0) return fail("Nothing to update");

    const { data, error } = await db()
      .from("users")
      .update(patch)
      .eq("id", id)
      .select(USER_COLUMNS)
      .maybeSingle();

    if (error) return fail(error.message, 409);
    if (!data) return fail("User not found", 404);

    // The update landed, so these can now honestly say so. Ahead of the generic
    // USER_UPDATE, which keeps the specific-then-summary ordering the
    // item-permission action already established.
    for (const entry of specific) {
      await audit(admin, entry.action, "user", data.id, entry.details, {
        outcome: "success",
      });
    }

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
