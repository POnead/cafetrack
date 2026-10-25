import { db } from "./supabase";
import nodemailer, { type Transporter } from "nodemailer";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readSmtpConfig, describeSmtpConfig, type SmtpConfig } from "./smtp-config";
import { describeSmtpFailure, type SmtpDiagnosis } from "./smtp-errors";

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

/** One prerequisite on the way to working email, done or not. */
export type SetupStep = {
  key: "account" | "recipient";
  label: string;
  /** What to do about it, when it is not done. */
  hint: string;
  /**
   * The missing thing as a noun phrase, so an error can name it: "email needs a
   * sending account". Kept apart from `label`, which is written to be read as a
   * checklist line rather than spliced into a sentence.
   */
  need: string;
  done: boolean;
};

export type EmailSetup = {
  /** In the order they have to be done: account, then recipient. */
  steps: SetupStep[];
  /** True when both steps are done and the toggle may be flipped on. */
  ready: boolean;
  /** Why the toggle is unavailable, or null when it is available. */
  blocked: string | null;
};

/**
 * Whether email can actually be sent, and if not, exactly what is missing.
 *
 * Checks the resolved configuration rather than the environment directly, so the
 * answer is the same one a send would give — an admin who set it on the website
 * is told it works, and one who has not is told what to do.
 *
 * `setup` is the part that was previously implicit. Email needs an account and a
 * recipient before it means anything, in that order, and nothing about a page
 * full of independent controls forces an admin to discover the order. Deriving it
 * here rather than in the UI means the checklist and a real send always agree.
 *
 * `detail` is gone. It was one sentence saying "what is missing", which is the
 * same job as `setup.steps[].hint` — so the two could disagree, and the one
 * worth acting on (a recipient is missing) was the one the page could not reach:
 * it led with "switched off", which is the absence of a fault rather than a
 * fault. Callers that want a sentence should read the outstanding step's hint.
 */
export async function emailStatus(): Promise<{
  enabled: boolean;
  configured: boolean;
  from: string;
  recipients: number;
  source: "website" | "environment" | "none";
  user: string | null;
  unreadable: boolean;
  setup: EmailSetup;
}> {
  const enabled = (await getSetting("email_enabled", "0")) === "1";
  const smtp = await describeSmtpConfig();

  const { count } = await db()
    .from("email_recipients")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true);

  const recipients = count ?? 0;

  const steps: SetupStep[] = [
    {
      key: "account",
      label: "Set the account email is sent from",
      // A password that will not decrypt is worth naming separately: it is a
      // different problem from never having set one, and "not configured" would
      // send the admin looking for a field that is already filled in.
      hint: smtp.unreadable
        ? "The saved app password can no longer be read — enter it again."
        : "Choose Gmail or Outlook, then paste an app password.",
      need: "a sending account",
      done: smtp.configured,
    },
    {
      key: "recipient",
      label: "Add someone to send to",
      hint: "Add at least one email address to receive the alerts.",
      need: "at least one recipient",
      done: recipients > 0,
    },
  ];

  const setup: EmailSetup = {
    steps,
    ready: steps.every((s) => s.done),
    blocked: steps.every((s) => s.done)
      ? null
      : "Finish the setup above before switching email on.",
  };

  return {
    enabled,
    configured: smtp.configured,
    from: smtp.from ?? "",
    recipients,
    source: smtp.source,
    user: smtp.user,
    unreadable: smtp.unreadable,
    setup,
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

/* ------------------------------------------------------------------ */
/* verification                                                       */
/* ------------------------------------------------------------------ */

export type VerifyResult =
  | {
      ok: true;
      /** How long the send took, so the page can say it rather than imply it. */
      ms: number;
      /** The address that was reached. */
      to: string;
    }
  | ({ ok: false; to: string } & SmtpDiagnosis & { server: string });

/**
 * Send one real message and report what happened, in words the admin can act on.
 *
 * This is deliberately *not* the queue. Two reasons, and both matter:
 *
 *   - The queue skips everything when email is switched off, so verifying through
 *     it would only be possible once the feature is on — which is the wrong
 *     order. Verifying is how you find out whether the account works, so it has
 *     to work while the switch is still off.
 *   - A queued failure is reported as "queued, will retry", which reads like
 *     patience rather than a problem. A misconfigured account would sit in the
 *     log looking like a transient hiccup.
 *
 * Nothing is recorded in the delivery log. This is a connection check, not
 * something the café was told would be emailed to them, and a log row that
 * appears with no visible cause is its own confusion.
 */
export async function verifySmtpAccount(to: string): Promise<VerifyResult> {
  const address = String(to).trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return {
      ok: false,
      to: address,
      title: "That is not an email address.",
      fix: "Check the address it should be sent to.",
      transient: false,
      server: "",
    };
  }

  const config = await readSmtpConfig();
  if (!config) {
    return {
      ok: false,
      to: address,
      title: "There is no sending account saved yet.",
      fix: "Set the server, account and app password first, then check again.",
      transient: false,
      server: "",
    };
  }

  const started = Date.now();
  try {
    await transport(config).sendMail({
      from: config.from,
      to: address,
      subject: "CafeTrack: your email is set up",
      text: [
        "This is a test message from CafeTrack.",
        "",
        "If you are reading it, email notifications are working.",
        "Nothing else was sent — no alerts, no summary.",
      ].join("\n"),
    });

    return { ok: true, ms: Date.now() - started, to: address };
  } catch (e) {
    return { ok: false, to: address, ...describeSmtpFailure(e) };
  }
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

  // Look the address up before writing anything.
  //
  // This used to be an `upsert` on email_address that supplied display_name,
  // is_active and subscriptions, which silently *replaced* those columns on a row
  // that already existed. So the owner adds themselves as a recipient for
  // alerts, ticks "low stock", then emails themselves a report — and their
  // subscriptions are rewritten to `["reports"]`, after which
  // `enqueue_email_alerts` correctly skips them and no alert mail ever arrives
  // again. It is invisible: nothing errors, the delivery log looks normal, and
  // the cafe just quietly stops being told when it runs out of milk.
  //
  // An existing recipient is therefore left exactly as the admin configured it.
  // Only a genuinely new address is created, and it is created subscribed to
  // reports alone — sending a one-off report to a stranger should not enrol that
  // stranger in anything.
  const { data: existing } = await db()
    .from("email_recipients")
    .select("id")
    .eq("email_address", address)
    .maybeSingle();

  let recipientId: string | null = existing?.id ?? null;

  if (!recipientId) {
    const { data: inserted, error: insertError } = await db()
      .from("email_recipients")
      .insert({
        email_address: address,
        display_name: "Report recipient",
        is_active: true,
        subscriptions: ["reports"],
      })
      .select("id")
      .single();

    if (insertError) throw new Error(`Could not save the recipient: ${insertError.message}`);
    recipientId = inserted?.id ?? null;
  }

  await db().from("email_notifications").insert({
    recipient_id: recipientId,
    kind: "report",
    subject,
    body,
    // No dedupe key: each request is a deliberate action by a person, so two
    // clicks should send two emails rather than one being silently swallowed.
    dedupe_key: null,
  });
}