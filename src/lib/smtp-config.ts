import { db } from "./supabase";
import { getSetting } from "./settings";
import { decryptSecret, encryptSecret } from "./credential-store";

/**
 * Where the SMTP connection details come from (FR-11).
 *
 * Two sources, and the order matters:
 *
 *   1. **Website** — an admin saved them from Settings → Email. These live in
 *      the `settings` table, with the password encrypted (see credential-store).
 *      This is the preferred source because it can be changed without editing a
 *      file and restarting, which is the whole point of letting the owner point
 *      the system at their own Gmail account.
 *   2. **Environment** — `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`
 *      from `.env.local`. A fallback for a fresh install or a hosted deployment
 *      where the operator manages configuration outside the app.
 *
 * The website value wins when both exist. That is deliberate: an admin saving a
 * new account expects it to take effect, not to be silently ignored because a
 * value was left in an env file months ago.
 *
 * `source` is reported alongside the config so the UI can say where the current
 * settings came from, which is the first question anyone asks when a change
 * appears not to have worked.
 */

export type SmtpSource = "website" | "environment" | "none";

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  /** Decrypted. Never leaves the server. */
  pass: string;
  /** From address. Defaults to the user when unset. */
  from: string;
  /** True for port 465 (implicit TLS). Otherwise STARTTLS is used. */
  secure: boolean;
  source: SmtpSource;
};

/** Settings keys. The `_enc` suffix marks the one value that is encrypted. */
const KEY_HOST = "smtp_host";
const KEY_PORT = "smtp_port";
const KEY_USER = "smtp_user";
const KEY_PASS = "smtp_pass_enc";

const DEFAULT_PORT = 587;

/**
 * Read the active SMTP configuration, or null when nothing is usable.
 *
 * Returns null for every incomplete combination — a host with no password, or a
 * password that will not decrypt — because half a configuration produces a
 * confusing SMTP failure much later. Callers treat null as "not configured" and
 * say so.
 */
export async function readSmtpConfig(): Promise<SmtpConfig | null> {
  const fromWebsite = await readWebsiteConfig();
  if (fromWebsite) return fromWebsite;

  const fromEnv = readEnvConfig();
  if (fromEnv) return fromEnv;

  return null;
}

async function readWebsiteConfig(): Promise<SmtpConfig | null> {
  const host = (await getSetting(KEY_HOST))?.trim();
  const user = (await getSetting(KEY_USER))?.trim();
  const storedPass = await getSetting(KEY_PASS);

  // No host or no user means the admin has not filled this in, which is the
  // normal state — not an error.
  if (!host || !user) return null;

  const pass = decryptSecret(storedPass);
  // A stored value that will not decrypt (usually a rotated AUTH_SECRET) is
  // treated as absent so the UI can prompt for it again rather than every send
  // failing on a bad password.
  if (!pass) return null;

  const portRaw = Number((await getSetting(KEY_PORT)) ?? DEFAULT_PORT);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.round(portRaw) : DEFAULT_PORT;

  const from = (await getSetting("email_from"))?.trim() || user;

  return {
    host,
    port,
    user,
    pass,
    from,
    secure: port === 465,
    source: "website",
  };
}

function readEnvConfig(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST || "").trim();
  const user = (process.env.SMTP_USER || "").trim();
  const pass = process.env.SMTP_PASS || "";

  if (!host || !user || !pass) return null;

  const portRaw = Number(process.env.SMTP_PORT || DEFAULT_PORT);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.round(portRaw) : DEFAULT_PORT;

  return {
    host,
    port,
    user,
    pass,
    from: (process.env.EMAIL_FROM || "").trim() || user,
    secure: port === 465,
    source: "environment",
  };
}

/**
 * What the Email page needs to show: is it configured, where did it come from,
 * and which account — but never the password.
 */
export async function describeSmtpConfig(): Promise<{
  configured: boolean;
  source: SmtpSource;
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  /** True when something is stored but cannot be decrypted (rotated secret). */
  unreadable: boolean;
}> {
  const config = await readSmtpConfig();

  // Distinguish "never set" from "set but unreadable", because they need
  // different things from the user: nothing, versus "re-enter the password".
  const storedPass = await getSetting(KEY_PASS);
  const storedHost = (await getSetting(KEY_HOST))?.trim();

  if (config) {
    return {
      configured: true,
      source: config.source,
      host: config.host,
      port: config.port,
      user: config.user,
      from: config.from,
      unreadable: false,
    };
  }

  return {
    configured: false,
    source: storedHost ? "website" : "none",
    host: storedHost ?? null,
    port: null,
    user: (await getSetting(KEY_USER))?.trim() ?? null,
    from: (await getSetting("email_from"))?.trim() ?? null,
    unreadable: Boolean(storedPass) && storedPass !== "",
  };
}

/** What the admin submitted, after rejecting the obviously wrong shapes. */
export type SmtpInput = {
  host?: string;
  port?: string | number;
  user?: string;
  pass?: string;
  from?: string;
};

export type SmtpValidation =
  | { ok: true; values: { host: string; port: number; user: string; pass: string } }
  | { ok: false; error: string };

/**
 * Validate a submitted configuration.
 *
 * `pass` may be an empty string, which means "keep the password already stored".
 * That is what lets an admin change the port or the from-address without having
 * to retype an app password they cannot see — the UI never shows the current one.
 */
export function validateSmtp(input: SmtpInput, existingPass: string | null): SmtpValidation {
  const host = String(input.host ?? "").trim();
  const user = String(input.user ?? "").trim();

  if (!host) return { ok: false, error: "Enter the SMTP server address" };
  // A bare hostname check: rejecting a space or a scheme is enough to catch a
  // pasted URL, without pretending to validate every provider's format.
  if (/\s/.test(host)) return { ok: false, error: "The server address cannot contain spaces" };
  if (/^https?:\/\//i.test(host)) {
    return { ok: false, error: "Use just the server name, e.g. smtp.gmail.com — not a URL" };
  }

  if (!user) return { ok: false, error: "Enter the account email address" };
  // A near-miss here is almost always a missing @, and Gmail reports it only as
  // a 535 much later.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) {
    return { ok: false, error: "That does not look like an email address" };
  }

  const submitted = String(input.pass ?? "");
  const pass = submitted || existingPass || "";
  if (!pass) {
    return {
      ok: false,
      error: "Enter an app password. For Gmail this is a 16-character App Password, not your account password.",
    };
  }

  const portRaw = Number(input.port ?? DEFAULT_PORT);
  if (!Number.isFinite(portRaw) || portRaw < 1 || portRaw > 65535) {
    return { ok: false, error: "Port must be a number between 1 and 65535" };
  }

  return { ok: true, values: { host, port: Math.round(portRaw), user, pass } };
}

/**
 * Save a configuration. The password is encrypted on the way in and never
 * written in the clear.
 *
 * Returns the decrypted-from-now-on value so the caller can build a transport,
 * but that value never goes back out through an API response.
 */
export async function saveSmtpConfig(values: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from?: string;
}): Promise<void> {
  const rows: { key: string; value: string }[] = [
    { key: KEY_HOST, value: values.host },
    { key: KEY_PORT, value: String(values.port) },
    { key: KEY_USER, value: values.user },
    { key: KEY_PASS, value: encryptSecret(values.pass) },
  ];

  if (values.from) rows.push({ key: "email_from", value: values.from });

  for (const row of rows) {
    // Update-then-insert rather than upsert, so this works identically in local
    // mode (whose adapter has no upsert) and on Supabase.
    const { data } = await db()
      .from("settings")
      .update({ value: row.value })
      .eq("key", row.key)
      .select("key")
      .maybeSingle();

    if (!data) {
      const { error } = await db()
        .from("settings")
        .insert({ key: row.key, value: row.value });
      if (error) throw new Error(`Could not save ${row.key}: ${error.message}`);
    }
  }
}

/** Forget the website configuration, falling back to the environment if any. */
export async function clearSmtpConfig(): Promise<void> {
  for (const key of [KEY_HOST, KEY_PORT, KEY_USER, KEY_PASS]) {
    await db().from("settings").update({ value: "" }).eq("key", key);
  }
}

/** Presets offered in the UI, so the common cases need no typing. */
export const SMTP_PRESETS: { key: string; label: string; host: string; port: number }[] = [
  { key: "gmail", label: "Gmail", host: "smtp.gmail.com", port: 587 },
  { key: "outlook", label: "Outlook / Hotmail", host: "smtp.office365.com", port: 587 },
];