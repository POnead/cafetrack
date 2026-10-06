import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { emailStatus, dispatchQueued, queueDirectEmail } from "@/lib/email";
import {
  describeSmtpConfig,
  validateSmtp,
  saveSmtpConfig,
  clearSmtpConfig,
  SMTP_PRESETS,
} from "@/lib/smtp-config";
import { clearSettingsCache } from "@/lib/settings";
import { decryptSecret } from "@/lib/credential-store";

export const runtime = "nodejs";

/** The families a recipient can subscribe to, and how the UI labels them. */
export const KINDS = [
  { key: "low_stock", label: "Low stock" },
  { key: "out_of_stock", label: "Out of stock" },
  { key: "near_expiry", label: "Expiring soon" },
  { key: "expired", label: "Expired" },
  { key: "daily_summary", label: "Daily summary" },
  { key: "failed_login", label: "Rejected sign-in attempts" },
  { key: "reports", label: "Reports sent by email" },
] as const;

/**
 * Recipient settings and the queue log (FR-11).
 *
 * Everything here is admin-only: who receives the cafe's stock warnings, and
 * which messages went out, are owner-level facts. Staff have no route to any of
 * it, which also means a staff account cannot learn an owner's address or read
 * alert mail.
 */
export const GET = handler(async (req: Request) => {
  await requireAdmin();

  const { searchParams } = new URL(req.url);
  const wantsQueue = searchParams.get("queue") === "1";

  const [status, recipients] = await Promise.all([
    emailStatus(),
    db()
      .from("email_recipients")
      .select("id, email_address, display_name, is_active, subscriptions, created_at")
      .order("created_at", { ascending: true }),
  ]);

  if (recipients.error) return fail(recipients.error.message, 500);

  const smtp = await describeSmtpConfig();

  const payload: Record<string, unknown> = {
    status,
    kinds: KINDS,
    presets: SMTP_PRESETS,
    // Enough to refill the form, and nothing that would let a caller read the
    // password: `has_password` says one is stored, the value never leaves the
    // server. Host and user survive a key rotation, so the form only has to ask
    // for the one field it cannot recover.
    smtp: { ...smtp, has_password: smtp.configured || Boolean(smtp.host) },
    recipients: recipients.data ?? [],
  };

  // The queue is only fetched when asked for: the log grows without bound, and
  // the settings page opens far more often than anyone reads it.
  if (wantsQueue) {
    const queue = await db()
      .from("email_notifications")
      .select(
        `id, kind, subject, status, attempts, last_error, queued_at, sent_at,
         email_recipients(email_address, display_name)`
      )
      .order("queued_at", { ascending: false })
      .limit(50);
    if (queue.error) return fail(queue.error.message, 500);
    payload.queue = queue.data ?? [];
  }

  return ok(payload);
});

/** Add or edit a recipient. */
export const POST = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);

  const id = String(body.id || "").trim();
  const address = String(body.email_address || "").trim().toLowerCase();
  const displayName = body.display_name ? String(body.display_name).slice(0, 120) : null;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return fail("That does not look like an email address");
  }

  // Only known families are accepted, so a typo cannot silently create a
  // subscription that matches nothing and quietly stops the mail arriving.
  const requested: unknown[] = Array.isArray(body.subscriptions) ? body.subscriptions : [];
  const allowed = new Set<string>(KINDS.map((k) => k.key));
  const subscriptions = requested.map((s) => String(s)).filter((s) => allowed.has(s));
  const rejected = requested.filter((s) => !allowed.has(String(s)));
  if (rejected.length) {
    return fail(`Unknown notification type: ${rejected.map(String).join(", ")}`);
  }

  const isActive = body.is_active === undefined ? true : body.is_active === true;

  if (id) {
    const malformed = badId(id, "recipient");
    if (malformed) return malformed;

    const { data, error } = await db()
      .from("email_recipients")
      .update({ email_address: address, display_name: displayName, is_active: isActive, subscriptions })
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) return fail(error.message, 500);
    if (!data) return fail("Recipient not found", 404);

    await audit(admin, "EMAIL_RECIPIENT_UPDATE", "email_recipient", id, {
      email_address: address,
      is_active: isActive,
      subscriptions,
    });

    return ok({ recipient: data });
  }

  const { data, error } = await db()
    .from("email_recipients")
    .insert({ email_address: address, display_name: displayName, is_active: isActive, subscriptions })
    .select()
    .single();

  // A duplicate address is a re-add, not a failure — but the caller is told, so
  // the UI can say "already there" rather than appearing to save.
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      return fail(`${address} is already a recipient`, 409);
    }
    return fail(error.message, 500);
  }

  await audit(admin, "EMAIL_RECIPIENT_CREATE", "email_recipient", data.id, {
    email_address: address,
    subscriptions,
  });

  return ok({ recipient: data }, 201);
});

/** Remove a recipient. Queued mail for them goes with it (cascade). */
export const DELETE = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  const malformed = badId(id, "recipient");
  if (malformed) return malformed;

  const { data: before } = await db()
    .from("email_recipients")
    .select("id, email_address")
    .eq("id", id)
    .maybeSingle();
  if (!before) return fail("Recipient not found", 404);

  const { error } = await db().from("email_recipients").delete().eq("id", id);
  if (error) return fail(error.message, 500);

  await audit(admin, "EMAIL_RECIPIENT_DELETE", "email_recipient", id, {
    email_address: before.email_address,
  });

  return ok({ ok: true });
});

/**
 * Actions from the Email settings page, all on PATCH so the route stays small:
 *   { action: 'save_smtp', ... } set or change the sending account
 *   { action: 'clear_smtp' }     forget it and fall back to the environment
 *   { action: 'send_now' }       try to deliver whatever is queued
 *   { action: 'retry_failed' }   return failed rows to the queue
 *   { action: 'test', to }       send one message to prove the account works
 *   { action: 'summary_now' }    queue the daily summary without waiting for it
 */
export const PATCH = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const action = String(body.action || "");

  /* ---- the sending account ---- */

  if (action === "save_smtp") {
    // A blank password means "keep the one already stored", so an admin can
    // change the port or the from-address without retyping a credential the UI
    // never shows them. The stored value is fetched and decrypted here rather
    // than taken from describeSmtpConfig(), which reports only whether one
    // exists.
    const stored = (
      await db().from("settings").select("value").eq("key", "smtp_pass_enc").maybeSingle()
    ).data?.value;

    const checked = validateSmtp(body, decryptSecret(stored));
    if (!checked.ok) return fail(checked.error);

    await saveSmtpConfig({
      host: checked.values.host,
      port: checked.values.port,
      user: checked.values.user,
      pass: checked.values.pass,
      from: body.from ? String(body.from).trim() : undefined,
    });

    // The settings cache is a minute long; clearing it is what makes this take
    // effect on the very next send instead of up to a minute later.
    clearSettingsCache();

    // The account is recorded, but never the password — not even a length.
    await audit(admin, "EMAIL_SMTP_SAVE", "settings", null, {
      host: checked.values.host,
      port: checked.values.port,
      user: checked.values.user,
      password_changed: Boolean(body.pass),
    });

    return ok({ smtp: await describeSmtpConfig(), saved: true });
  }

  if (action === "clear_smtp") {
    await clearSmtpConfig();
    clearSettingsCache();

    await audit(admin, "EMAIL_SMTP_CLEAR", "settings", null, {});
    return ok({ smtp: await describeSmtpConfig(), cleared: true });
  }

  if (action === "send_now") {
    const result = await dispatchQueued(50);
    return ok(result);
  }

  if (action === "retry_failed") {
    const { data, error } = await db()
      .from("email_notifications")
      .update({ status: "queued", attempts: 0, last_error: null })
      .eq("status", "failed")
      .select("id");
    if (error) return fail(error.message, 500);

    const result = await dispatchQueued(50);
    return ok({ requeued: (data ?? []).length, ...result });
  }

  if (action === "summary_now") {
    const { data, error } = await db().rpc("enqueue_daily_summary");
    if (error) return fail(error.message, 500);

    const queued = Number((data as any)?.out ?? 0);
    if (queued === 0) {
      return fail(
        "Today's summary has already been sent. It goes out once a day, so try again tomorrow.",
        409
      );
    }

    const result = await dispatchQueued(10);
    return ok({ queued, ...result });
  }

  if (action === "test") {
    const to = String(body.to || "").trim();
    try {
      await queueDirectEmail(
        to,
        "CafeTrack: test message",
        [
          "This is a test message from CafeTrack.",
          "",
          "If you are reading it, email notifications are working.",
          "Nothing else was sent — no alerts, no summary.",
        ].join("\n")
      );
    } catch (e: any) {
      return fail(e?.message || "Could not queue the test message");
    }

    const result = await dispatchQueued(5);

    // A queued-but-unsent message is a real failure to report. "Send test" that
    // answers "ok" while nothing went out is worse than no button.
    if (result.sent === 0) {
      const detail =
        result.errors[0] ||
        "Email is switched off, or SMTP_HOST / SMTP_USER / SMTP_PASS are not set in .env.local.";
      return fail(`Test message was not sent. ${detail}`, 502);
    }

    return ok({ sent: result.sent });
  }

  return fail("Unknown action");
});