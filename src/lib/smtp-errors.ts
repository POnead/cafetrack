/**
 * Turning an SMTP failure into something a café owner can act on (FR-11).
 *
 * Every one of these errors is a real, correctly-reported problem. What is wrong
 * with the raw versions is that they are written for a mail administrator:
 *
 *   "Invalid login: 535 5.7.8 Username and Password not accepted. Try again."
 *   "Message failed: 553 5.7.1 <from> The email account that you tried to reach
 *    does not exist."
 *
 * The second one is the clearest example. It does not say *why* it thinks the
 * account does not exist, when the actual cause is that the From address is not
 * an address this account is allowed to send as. An admin reads that, concludes
 * their Gmail is broken, and gives up — which is exactly the outcome a stock
 * system that silently stops warning you about milk is meant to avoid.
 *
 * So each diagnosis is two parts: what happened, and what to change. The "what
 * to change" is the part that was missing, and it is the reason this is a module
 * rather than a string replacement at the call site.
 */

/** A failure explained for the person who has to fix it. */
export type SmtpDiagnosis = {
  /** One plain sentence. What went wrong. */
  title: string;
  /** What to change about the settings. Never a raw protocol string. */
  fix: string;
  /**
   * True when the same settings would probably work later, so the advice is "wait"
   * rather than "change something". A café should not be told to re-enter an app
   * password because their provider was briefly rate-limiting them.
   */
  transient: boolean;
};

/**
 * SMTP reply codes worth naming, keyed by the number the server sent.
 *
 * Deliberately incomplete. Only codes that change what a person should do are
 * here; everything else falls through to a generic refusal that still reports the
 * server's own words.
 */
const RESPONSE_CODES: Record<number, SmtpDiagnosis> = {
  // The password or username was rejected. Nearly always the account password
  // where an app password is required, or an app password that has been revoked
  // (Google lets you delete one at any time without touching the account).
  535: {
    title: "The mail server rejected the password.",
    fix: "Gmail and Outlook will not accept your normal account password for sending. Use a 16-character app password instead — for Gmail, create one at myaccount.google.com/apppasswords.",
    transient: false,
  },
  // The sender is refused. Gmail uses this for a From address it has no
  // permission to send as, and phrases it as though the account does not exist.
  553: {
    title: "The mail server refused the From address.",
    fix: "The From address must be the sending account itself, or an alias that account has verified. Clear the From field to send as the account's own address.",
    transient: false,
  },
  // A blanket refusal. Usually the From address on providers that don't give a
  // better reason, which is why the fix names it first.
  550: {
    title: "The mail server refused to send the message.",
    fix: "Most often the From address is not one this account may send as — it must be the account itself or a verified alias. If the From is right, the recipient's server may be rejecting it.",
    transient: false,
  },
  554: {
    title: "The mail server refused the message.",
    fix: "Usually the From address. It must be the sending account itself, or an alias that account has verified.",
    transient: false,
  },
  // 4xx is the server saying "not now". These are the codes that must not send
  // anyone off to re-enter a password that was perfectly good.
  421: {
    title: "The mail server is not accepting connections right now.",
    fix: "This is the provider throttling the connection — too many connections too quickly. Nothing to change; try again in a few minutes.",
    transient: true,
  },
  450: {
    title: "The mail server is temporarily refusing the message.",
    fix: "Usually a sending limit that resets after a while. Nothing to change; try again shortly.",
    transient: true,
  },
  452: {
    title: "The mail server is temporarily refusing the message.",
    fix: "Usually a sending limit or a full mailbox on the recipient's side. Nothing to change; try again shortly.",
    transient: true,
  },
};

/** nodemailer's own error codes, for failures that never got an SMTP reply. */
const CLIENT_ERRORS: Record<string, SmtpDiagnosis> = {
  // Raised by nodemailer when requireTLS is on and the server offered no
  // STARTTLS. Its own message ("Must use STARTTLS") describes our policy, not
  // what the admin typed.
  ETLS: {
    title: "The server did not offer an encrypted connection.",
    fix: "Check the port. 587 upgrades the connection with STARTTLS; 465 connects with TLS from the start. A server offering neither is one this app will not send a password to.",
    transient: false,
  },
  // Could not open the connection at all. Almost always host or port.
  ECONNECTION: {
    title: "Could not reach the mail server.",
    fix: "Check the server address and port. Gmail is smtp.gmail.com on 587 and Outlook is smtp.office365.com on 587 — the Use Gmail / Use Outlook buttons fill these in.",
    transient: false,
  },
  ECONNREFUSED: {
    title: "The mail server refused the connection.",
    fix: "Check the server address and port. Gmail is smtp.gmail.com on 587 and Outlook is smtp.office365.com on 587 — the Use Gmail / Use Outlook buttons fill these in.",
    transient: false,
  },
  ENOTFOUND: {
    title: "That mail server address does not exist.",
    fix: "Check the spelling, and that you entered just the server name — smtp.gmail.com — rather than a full web address.",
    transient: false,
  },
  ETIMEDOUT: {
    title: "The mail server did not respond in time.",
    fix: "Usually the server address or port is wrong, or the network is blocking it. Check that the server address is reachable from this machine.",
    transient: true,
  },
  // Wrong credentials, where the server said so in a way nodemailer could not map
  // to a reply code.
  EAUTH: {
    title: "The mail server rejected the password.",
    fix: "Gmail and Outlook will not accept your normal account password for sending. Use a 16-character app password instead — for Gmail, create one at myaccount.google.com/apppasswords.",
    transient: false,
  },
  EENVELOPE: {
    title: "The mail server refused the sender or the recipient.",
    fix: "Check the From address — it must be the sending account itself, or a verified alias — and that the address being sent to is spelled correctly.",
    transient: false,
  },
  ESOCKET: {
    title: "The connection to the mail server dropped.",
    fix: "Usually a temporary network problem. Try again; if it keeps happening, check that the server address is reachable from this machine.",
    transient: true,
  },
};

/**
 * Used when nothing matched. Still honest about what it does not know: it says
 * the send failed and repeats what the server said, without inventing a cause.
 */
const UNKNOWN: SmtpDiagnosis = {
  title: "The mail server did not accept the message.",
  fix: "Check the sending account details and try again. The server's own message is below.",
  transient: false,
};

function diagnoseResponseCode(e: any): SmtpDiagnosis | null {
  const code = typeof e?.responseCode === "number" ? e.responseCode : null;
  return code !== null ? RESPONSE_CODES[code] ?? null : null;
}

/**
 * Used when the underlying system error is ECONNREFUSED / ENOTFOUND but
 * nodemailer has wrapped it as a more general ESOCKET — the classic "connect
 * ECONNREFUSED 127.0.0.1:587" arrived as code ESOCKET in a live check, so the
 * generic branch alone would have told the admin the network was flaky rather
 * than that their server address or port is wrong.
 */
const SYSTEM_ERRORS: [string, SmtpDiagnosis][] = [
  ["ECONNREFUSED", CLIENT_ERRORS.ECONNREFUSED],
  ["ENOTFOUND", CLIENT_ERRORS.ENOTFOUND],
];

function diagnoseSystemError(e: any): SmtpDiagnosis | null {
  const text = `${e?.message ?? ""} ${e?.code ?? ""} ${e?.command ?? ""}`;
  for (const [needle, diagnosis] of SYSTEM_ERRORS) {
    if (text.includes(needle)) return diagnosis;
  }
  return null;
}

/**
 * The server's own words, cleaned up enough to show an admin.
 *
 * Nodemailer prefixes its message with the failing command ("Message failed:",
 * "Connection timeout:") and the SMTP server's text follows. The raw part is worth
 * keeping — it is the only authoritative detail — but the prefix and any command
 * scaffolding are noise.
 */
function serverText(e: any): string {
  const message = String(e?.message ?? e ?? "").trim();
  const withoutPrefix = message.replace(
    /^(Message failed|Connection timeout|Greeting never received|Invalid login|Sending failed|Login denied)\s*:\s*/i,
    ""
  );
  return withoutPrefix || message;
}

/**
 * Explain an SMTP failure. Never throws — this is called while already handling
 * a failure, and a second error thrown here would replace a real message with a
 * less useful one.
 */
export function explainSmtpError(e: unknown): SmtpDiagnosis {
  try {
    const err = e as any;

    const byResponse = diagnoseResponseCode(err);
    if (byResponse) return byResponse;

    const bySystem = diagnoseSystemError(err);
    if (bySystem) return bySystem;

    const clientCode = String(err?.code ?? "");
    const byClient = CLIENT_ERRORS[clientCode];
    if (byClient) return byClient;

    // `requireTLS` on a server with no STARTTLS does not always arrive as ETLS;
    // nodemailer sometimes reports it as a plain message with a code of ECONN
    // or with none at all.
    if (/must use STARTTLS|STARTTLS|all connections must use ssl/i.test(serverText(err))) {
      return CLIENT_ERRORS.ETLS;
    }

    if (/getaddrinfo ENOTFOUND/i.test(serverText(err))) {
      return CLIENT_ERRORS.ENOTFOUND;
    }

    if (/connect ECONNREFUSED/i.test(serverText(err))) {
      return CLIENT_ERRORS.ECONNREFUSED;
    }

    return UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/**
 * The failure as it should reach the browser: the diagnosis, plus whatever the
 * server actually said.
 *
 * The server text is included deliberately. The diagnosis covers the causes this
 * module knows about, and a café on a provider nobody has heard of is exactly the
 * case where the server's own words are the only useful thing available.
 */
export function describeSmtpFailure(e: unknown): SmtpDiagnosis & { server: string } {
  const diagnosis = explainSmtpError(e);
  let server = "";
  try {
    server = serverText(e).slice(0, 300);
  } catch {
    server = "";
  }
  return { ...diagnosis, server };
}