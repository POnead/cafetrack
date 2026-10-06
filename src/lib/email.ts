import { db } from "./supabase";
import nodemailer, { type Transporter } from "nodemailer";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readSmtpConfig, describeSmtpConfig, type SmtpConfig } from "./smtp-config";

/**
 * Email notifications (FR-11).
 *
 * The shape of this is deliberate: the database decides *what* needs saying
 * (enqueue_email_alerts and friends queue rows), and this module only decides
 * *how* to say it. That split matters because enqueue runs inside
 * refresh_alerts, which every movement calls — if SMTP were reachable from that
 * path, a cafe with a slow or dead mail server would see every checkout slow
 * down or fail. Queueing is a cheap insert; delivery is a separate step that can
 * fail without touching inventory.
 *
 * Nothing here throws into a route. A mail failure is a mail failure, and the
 * caller is doing something else.
 */

const MAX_BODY = 20_000;

/** What a queued message turned out to be. */
export type SendOutcome = "sent" | "failed" | "skipped";

export type DispatchResult = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
};

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

async function getSetting(key: string, fallback = ""): Promise<string> {
  const { data } = await db().from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? fallback;
}

/**
 * Whether email can actually be sent, and if not, exactly what is missing.
 *
 * Checks the resolved configuration rather than the environment directly, so the
 * answer is the same one a send would give — an admin who set it on the website
 * is told it works, and one who has not is told what to do.
 */
export async function emailStatus(): Promise<{
  enabled: boolean;
  configured: boolean;
  detail: string;
  from: string;
  recipients: number;
  source: "website" | "environment" | "none";
  user: string | null;
  unreadable: boolean;
}> {
  const enabled = (await getSetting("email_enabled", "0")) === "1";
  const smtp = await describeSmtpConfig();

  const { count } = await db()
    .from("email_recipients")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);

  let detail = "";
  if (!enabled) {
    detail = "Email notifications are switched off in Settings.";
  } else if (!smtp.configured) {
    detail = smtp.unreadable
      ? "The saved mail password can no longer be read — re-enter it below."
      : "Set the sending account below (Settings > Email), or SMTP_HOST / SMTP_USER / SMTP_PASS in .env.local.";
  } else if (!count) {
    detail = "Add at least one recipient.";
  }

  return {
    enabled,
    configured: smtp.configured,
    detail,
    from: smtp.from ?? "",
    recipients: count ?? 0,
    source: smtp.source,
    user: smtp.user,
    unreadable: smtp.unreadable,
  };
}

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */

let cached: Transporter | null = null;
let cachedFor = "";

/**
 * The SMTP transport, built once per configuration.
 *
 * Reused across sends because nodemailer's default is a fresh connection per
 * message, and a cafe receiving several alerts at once would otherwise open (and
 * tear down) a TLS handshake for each. The cache key includes every setting that
 * changes the connection, so saving a new account from the website takes effect
 * on the next send without a restart.
 *
 * TLS: port 465 is implicit TLS (nodemailer's `secure`); anything else starts
 * plain and upgrades with STARTTLS.
 *
 * `requireTLS` is on by default, and that default matters: without it, a server
 * that did not advertise STARTTLS would receive the username and app password in
 * cleartext. Every hosted provider advertises it, so requiring it costs nothing.
 *
 * `SMTP_ALLOW_INSECURE=1` turns the requirement off, for the one case that needs
 * it — a mail relay on the same machine or LAN with no certificate. An explicit
 * opt-in rather than a silent fallback, because sending a credential unencrypted
 * should be something a person chose, not something that quietly happened.
 */
function transport(config: SmtpConfig): Transporter {
  // The password is part of the identity of this connection, so it has to be in
  // the key — otherwise saving a corrected app password would keep using the
  // transporter built with the old one, and the fix would appear to do nothing.
  //
  // A hash rather than the password itself: the key only ever needs to change
  // when the secret changes, and this string should never be able to leak it
  // into a log line or an error message.
  const key = [
    config.host,
    config.port,
    config.user,
    config.from,
    createHash("sha256").update(config.pass).digest("hex").slice(0, 16),
    process.env.SMTP_ALLOW_INSECURE === "1" ? "insecure" : "tls",
  ].join(":");

  if (cached && cachedFor === key) return cached;

  const allowInsecure = process.env.SMTP_ALLOW_INSECURE === "1";

  cached = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Refuse to send the credentials at all unless the connection is encrypted.
    requireTLS: !config.secure && !allowInsecure,
    auth: { user: config.user, pass: config.pass },
    // A cafe machine can be a few seconds slow to resolve or connect on a busy
    // morning. Without this, nodemailer defaults can hang a dispatch long enough
    // to look like a hang.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  cachedFor = key;
  return cached;
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

/**
 * Try to send everything currently queued.
 *
 * Called after the actions that generate mail and on a timer for the daily
 * summary. Claims rows one at a time by flipping `queued` to `sending`, so two
 * overlapping dispatches (a movement finishes while the timer fires) cannot send
 * the same message twice.
 *
 * `attempts` is incremented on the claim, so a message that has used up
 * email_max_attempts is abandoned rather than retried forever. NFR-07 asks for
 * three tries.
 */
export async function dispatchQueued(limit = 25): Promise<DispatchResult> {
  const result: DispatchResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const status = await emailStatus();
  if (!status.enabled || !status.configured) return result;

  // Resolved once per dispatch rather than per message: it is a settings read,
  // and a batch of twenty messages should not make twenty of them. Passing the
  // same config to every transport() call also means a config saved mid-batch
  // cannot send half the batch through one account and half through another.
  const config = await readSmtpConfig();
  if (!config) return result;

  const maxAttempts = Number(await getSetting("email_max_attempts", "3")) || 3;

  const { data: pending, error } = await db()
    .from("email_notifications")
    .select("id, recipient_id, kind, subject, body, attempts, email_recipients(email_address)")
    .eq("status", "queued")
    .order("queued_at", { ascending: true })
    .limit(limit);

  if (error || !pending?.length) return result;

  for (const row of pending as any[]) {
    if (row.attempts >= maxAttempts) {
      await db()
        .from("email_notifications")
        .update({ status: "failed", last_error: `Gave up after ${maxAttempts} attempts` })
        .eq("id", row.id);
      result.skipped++;
      continue;
    }

    // Claim it. The status guard means a row someone else already claimed comes
    // back empty and is skipped rather than sent twice.
    const { data: claimed } = await db()
      .from("email_notifications")
      .update({ status: "sending", attempts: row.attempts + 1 })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id")
      .maybeSingle();

    if (!claimed) {
      result.skipped++;
      continue;
    }

    result.attempted++;
    const to = row.email_recipients?.email_address;
    if (!to) {
      await failRow(row.id, "Recipient has no email address on file");
      result.failed++;
      continue;
    }

    try {
      await transport(config).sendMail({
        from: config.from,
        to,
        subject: row.subject,
        text: String(row.body ?? "").slice(0, MAX_BODY),
      });

      await db()
        .from("email_notifications")
        .update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
        .eq("id", row.id);
      result.sent++;
    } catch (e: any) {
      // Back to `queued` so a later dispatch retries it. `failed` is only for a
      // message that has run out of attempts, decided at the top of the loop.
      const message = String(e?.message || e).slice(0, 500);
      await db()
        .from("email_notifications")
        .update({ status: "queued", last_error: message })
        .eq("id", row.id);
      result.failed++;
      result.errors.push(`${to}: ${message}`);
    }
  }

  return result;
}

async function failRow(id: string, message: string) {
  await db()
    .from("email_notifications")
    .update({ status: "failed", last_error: message })
    .eq("id", id);
}

/**
 * Fire-and-forget dispatch, for use at the end of a request handler.
 *
 * The point is that the caller does not wait. `void` on the promise makes that
 * explicit, and the catch stops an unhandled rejection from taking down the
 * process — a broken mail server must never be able to crash the dev server or
 * a production request.
 */
export function dispatchSoon(): void {
  void dispatchQueued().catch((e) => {
    console.error("email dispatch failed:", e?.message || e);
  });
}

/* ------------------------------------------------------------------ */
/* send-by-hand                                                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* scheduler                                                           */
/* ------------------------------------------------------------------ */

let schedulerStarted = false;

/**
 * The periodic half of FR-11.
 *
 * Two jobs, on one ten-minute tick:
 *
 *   1. deliver anything queued — the alert emails are queued by
 *      refresh_alerts during a movement and dispatched straight away, but a
 *      send that failed has to be picked up again by something.
 *   2. queue and send the daily summary, once a day, at the hour the admin
 *      chose in Settings.
 *
 * Alert mail does not depend on this: it goes out during the movement that
 * caused it. This exists for the summary and for retries, so a summary still
 * arrives on a day when nobody checked any stock out.
 *
 * Suppressed in test mode. The suites create and resolve alerts constantly, and
 * a scheduler firing in the middle of one would queue mail at times no
 * assertion expects. `CAFETRACK_DB_DIR` is what marks a throwaway database —
 * the same signal the test suites already guard on.
 */
export function startEmailScheduler(): void {
  if (schedulerStarted) return;
  if (process.env.CAFETRACK_DISABLE_EMAIL === "1") return;

  const dir = process.env.CAFETRACK_DB_DIR;
  if (dir && dir !== join(process.cwd(), ".pglite")) {
    console.log("CafeTrack: email scheduler off (throwaway database)");
    return;
  }

  schedulerStarted = true;

  const tick = async () => {
    try {
      const status = await emailStatus();
      if (!status.enabled || !status.configured) return;

      const hour = Number(await getSetting("email_daily_summary_hour", "7")) || 7;
      const now = new Date();

      // Past the chosen hour, and the database decides whether today's summary
      // has already gone out — the dedupe key is the date, so this is safe to
      // run every ten minutes.
      if (now.getHours() >= hour) {
        const { data } = await db().rpc("enqueue_daily_summary");
        const queued = Number((data as any)?.out ?? 0);
        if (queued > 0) console.log(`CafeTrack: queued ${queued} daily summary email(s)`);
      }

      await dispatchQueued();
    } catch (e: any) {
      // A mail problem is never allowed to become an unhandled rejection.
      console.error("email scheduler tick failed:", e?.message || e);
    }
  };

  setTimeout(tick, 20_000);
  const timer = setInterval(tick, 10 * 60_000);
  timer.unref?.();
}

/**
 * Queue a one-off message to a specific address — the "email me this report"
 * button. Goes through the same queue as everything else rather than sending
 * directly, so it is retried on the same terms and shows up in the log.
 */
export async function queueDirectEmail(to: string, subject: string, body: string) {
  const address = String(to).trim();

  // A real address, or the queue holds something that can only ever fail.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    throw new Error("That does not look like an email address");
  }

  // `onConflict` is an ARRAY. Passing the bare string compiles under
  // supabase-js, whose option accepts either, but local-db declared
  // `string[]` and called `.map()` on it — so in local mode this threw
  // "this.upsertConflict.map is not a function", the adapter swallowed it into
  // `error`, and nothing below knew the recipient had not been written. Every
  // test message and every emailed report then queued with `recipient_id` null
  // and failed as "Recipient has no email address on file".
  const { error: upsertError } = await db()
    .from("email_recipients")
    .upsert(
      { email_address: address, display_name: "Report recipient", is_active: true, subscriptions: ["reports"] },
      { onConflict: ["email_address"] }
    );

  // Checked rather than ignored, so a future failure here is reported instead
  // of surfacing later as a message that mysteriously cannot be addressed.
  if (upsertError) throw new Error(`Could not save the recipient: ${upsertError.message}`);

  const { data: recipient, error: lookupError } = await db()
    .from("email_recipients")
    .select("id")
    .eq("email_address", address)
    .maybeSingle();

  if (lookupError) throw new Error(`Could not look up the recipient: ${lookupError.message}`);

  await db().from("email_notifications").insert({
    recipient_id: recipient?.id ?? null,
    kind: "report",
    subject,
    body,
    // No dedupe key: each request is a deliberate action by a person, so two
    // clicks should send two emails rather than one being silently swallowed.
    dedupe_key: null,
  });
}