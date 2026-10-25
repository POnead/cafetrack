import { db } from "@/lib/supabase";
import { handler, ok, fail, badId, readBody } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { emailStatus, dispatchQueued, verifySmtpAccount } from "@/lib/email";
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

/**
 * The families a recipient can subscribe to, and how the UI labels them.
 *
 * Not exported: a route module may only export the HTTP handlers and the
 * config keys Next documents (`runtime`, `dynamic`, ...). Anything else is
 * rejected by the generated route types, so this stays local to the file.
 */
const KINDS = [
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
        // `body` is selected deliberately. The delivery log is how an admin
        // answers "why did I get that email?", and a low-stock message is titled
        // "CafeTrack: Low Stock" for every item — the item is named only in the
        // body. Without it the log shows a column of identical subjects and
        // cannot answer the question it exists for.
        `id, kind, subject, body, status, attempts, last_error, queued_at, sent_at,
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
 *   { action: 'test', to }       send one message directly to prove the account
 *                               works, whether or not email is switched on
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

    // Verify straight away, and say what failed.
    //
    // Saving an account and then being told "now go and find the test button and
    // hope" is how a café ends up believing email works when it does not: nothing
    // happens for days, and the first sign of it is a stockout nobody was warned
    // about. The send is the only proof that exists, so it happens here, while the
    // password that was just typed is still the thing being checked.
    //
    // The save is kept even when verification fails. An account that is correct
    // but temporarily unreachable — the provider rate-limiting, the network down —
    // is still worth having stored, and throwing it away would mean retyping an
    // app password over a transient outage. So the failure is reported alongside
    // the save, not instead of it.
    const verifyTo = String(body.verify_to || checked.values.user).trim();
    const verification =
      body.verify === false
        ? null
        : await verifySmtpAccount(verifyTo).catch((e) => ({
            ok: false as const,
            to: verifyTo,
            title: "Could not check the account.",
            fix: "The details were saved. Try checking again in a moment.",
            transient: true,
            server: String(e?.message ?? e ?? "").slice(0, 300),
          }));

    return ok({ smtp: await describeSmtpConfig(), saved: true, verification });
  }

  if (action === "clear_smtp") {
    await clearSmtpConfig();
    clearSettingsCache();

    await audit(admin, "EMAIL_SMTP_CLEAR", "settings", null, {});
    return ok({ smtp: await describeSmtpConfig(), cleared: true });
  }

  if (action === "send_now") {
    // The dispatcher swallows "email is off" into a zero-count result, which is
    // correct for its scheduler caller but reads as "0 sent, success" here. For a
    // person pressing a button the answerable question is "was anything sent?",
    // and the honest one is often "no, and the reason is…".
    const status = await emailStatus();
    if (!status.enabled) return fail("Email is switched off.", 409);
    if (!status.configured) return fail("No sending account is set up.", 409);

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

    const queued = Number(
      // `enqueue_daily_summary` returns an integer, so the value arrives
      // unwrapped: the local adapter hands back `rows[0].out`, and PostgREST
      // hands back the scalar itself. Reading `data.out` therefore found
      // `undefined`, `Number(undefined)` was 0, and this branch answered "already
      // sent today" every time — the summary queued correctly and was then
      // reported as a failure, so an admin could never send one on demand and had
      // no way to tell that from the real condition. Both shapes are accepted
      // rather than assuming one, because being wrong here is a silent no-op.
      typeof data === "number" ? data : (data as any)?.out ?? 0
    );
    if (queued === 0) {
      // Two quite different reasons produce a zero, and naming the wrong one
      // sends the admin hunting for a summary they already received.
      const status = await emailStatus();
      if (status.recipients === 0) {
        return fail("There is nobody to send it to. Add an email recipient first.");
      }
      return fail(
        "Today's summary has already been sent. It goes out once a day, so try again tomorrow.",
        409
      );
    }

    const result = await dispatchQueued(10);
    return ok({ queued, ...result });
  }

  if (action === "test") {
    // A direct send rather than a queued one.
    //
    // This used to queue the message and dispatch it, which meant it could only
    // work once email was switched on — so the button was dead exactly when it was
    // needed. Verifying an account is what you do *before* switching it on; asking
    // someone to switch on a feature they are trying to find out whether it works
    // is asking them to take the risk in order to reduce it.
    //
    // The failure now carries a diagnosis, so "535" arrives as an instruction.
    const to = String(body.to || "").trim();
    const result = await verifySmtpAccount(to).catch((e) => ({
      ok: false as const,
      to,
      title: "Could not check the account.",
      fix: "Try again in a moment.",
      transient: true,
      server: String(e?.message ?? e ?? "").slice(0, 300),
    }));

    if (!result.ok) {
      return fail(result.title, 502, {
        fix: result.fix,
        transient: result.transient,
        server: result.server,
        to: result.to,
      });
    }

    return ok({ sent: 1, to: result.to, ms: result.ms });
  }

  return fail("Unknown action");
});