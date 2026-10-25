/**
 * A throwaway SMTP server, for testing the notification path (FR-11).
 *
 * CafeTrack's email code is real and runs on every movement, but until now
 * nothing drove it: no suite had ever caused a message to be queued or sent.
 * That left the largest requirement in the project verified only by reading it.
 * This closes the gap without a real mailbox and without a new dependency.
 *
 * It speaks enough of RFC 5321 for nodemailer to complete a delivery: greeting,
 * EHLO, AUTH LOGIN and PLAIN, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT. Every
 * accepted message is recorded so a suite can assert on what the owner would
 * actually have received — the recipient, the subject, the body — rather than
 * only on the queue row that claims it was sent.
 *
 * Failure injection is the part that earns its keep. `failNext` makes the next
 * DATA command be refused, so the retry path and the give-up-after-N-attempts
 * path are exercised for real rather than mocked. Those are the two behaviours
 * most likely to be wrong and least likely to be noticed: a cafe whose alerts
 * silently stopped retrying would look identical to one receiving no alerts.
 *
 * Plain TCP, no TLS. `email.ts` refuses to send over an unencrypted connection
 * unless `SMTP_ALLOW_INSECURE=1`, which is exactly the case here — a relay on
 * the same machine — so the dev:test server sets that flag. The consequence is
 * that this stub cannot also be used to prove TLS is required; that remains a
 * documented review item rather than a test.
 *
 * Used two ways:
 *   - as a module:   `const stub = await startSmtpStub(); stub.messages`
 *   - standalone:    `node scripts/_smtp-stub.mjs`  (prints the two ports)
 *
 * The control API is over HTTP because the suite and the server are separate
 * processes — the suite needs to read what arrived and steer the next failure,
 * and an in-process object cannot cross that boundary.
 */
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** SMTP port. High and unprivileged, and unlikely to collide with a real relay. */
export const SMTP_PORT = Number(process.env.SMTP_STUB_PORT || 2525);

/** Control API port, a sibling of the SMTP one. */
export const CONTROL_PORT = Number(process.env.SMTP_STUB_CONTROL_PORT || 2526);

/** What the stub demands as credentials. Any other pair is refused. */
export const STUB_USER = process.env.SMTP_STUB_USER || "cafe@cafetrack.test";
export const STUB_PASS = process.env.SMTP_STUB_PASS || "stub-password";

/**
 * Where a running stub records the ports it actually got.
 *
 * The two ports are asked for as 0 (`ephemeral`) so a stub can never collide
 * with a real relay or with a second copy of itself, which means the number is
 * chosen by the OS and is not knowable in advance. `dev:test` starts the stub
 * and the suites run in a different process, so the *only* way the suite can
 * find the control API is for the starter to write the answer down. Before
 * this file existed, `_email-tests.mjs` fell back to the 2526 default and the
 * suite failed with ECONNREFUSED under `npm run test:isolated` — while passing
 * when run by hand with the port exported, which is the worst way for a suite
 * to fail.
 *
 * `.cache/` is gitignored, and a stale file is not dangerous: the preflight in
 * the suite reports a dead control API as "start dev:test", which is the
 * actual problem.
 */
export const STUB_PORTS_FILE = join(process.cwd(), ".cache", "smtp-stub.json");

/** Write down where this stub is listening. Best effort: a suite must not fail over a hint. */
export function recordStubPorts(stub) {
  try {
    mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
    writeFileSync(
      STUB_PORTS_FILE,
      JSON.stringify(
        { smtpPort: stub.smtpPort, controlPort: stub.controlPort, pid: process.pid },
        null,
        2
      )
    );
  } catch {
    // A read-only checkout, a full disk — none of which should stop a test run.
  }
}

/**
 * The control API URL for a suite: the environment first, then the recorded
 * file, then the documented default.
 *
 * The environment wins so a developer can point a suite at a stub they started
 * by hand, which is what `test:email` alone needs.
 */
export function resolveStubControlUrl() {
  const fromEnv = process.env.SMTP_STUB_CONTROL_PORT;
  if (fromEnv) return `http://127.0.0.1:${fromEnv}`;

  try {
    const recorded = JSON.parse(readFileSync(STUB_PORTS_FILE, "utf8"));
    const port = Number(recorded?.controlPort);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return `http://127.0.0.1:${port}`;
    }
  } catch {
    // No file, unreadable file, or not JSON: fall through to the default.
  }

  return `http://127.0.0.1:${CONTROL_PORT}`;
}

/**
 * One recorded message.
 *
 * `raw` is kept because a failing assertion about a header is nearly impossible
 * to diagnose from a parsed object — the whole envelope has to be visible.
 */
/**
 * Decode an RFC 2047 encoded-word.
 *
 * Nodemailer encodes any header value containing non-ASCII as
 * `=?UTF-8?Q?...?=` or `=?UTF-8?B?...?=`. The daily summary's subject contains
 * an em dash, so it arrives encoded — and a suite that regex-matches the
 * subject against plain text silently finds nothing. Decoding here means the
 * recorded messages read the way the owner's inbox would show them.
 *
 * Adjacent encoded words are joined without the space RFC 2047 says to drop
 * between them, which is why the summary's date is one run rather than two.
 */
function decodeHeaderValue(value) {
  if (!value.includes("=?")) return value;

  return value
    .replace(
      /=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g,
      (_match, charset, encoding, payload) => {
        try {
          const bytes =
            encoding.toUpperCase() === "B"
              ? Buffer.from(payload, "base64")
              : quotedPrintableDecode(payload);
          return bytes.toString(charset.toLowerCase() === "utf-8" ? "utf8" : "latin1");
        } catch {
          // An undecodable word is left alone rather than dropping the header.
          return _match;
        }
      }
    )
    .replace(/\?=\s+=\?/g, "?==?");
}

/** The `Q` encoding, which is quoted-printable with spaces written as `_`. */
function quotedPrintableDecode(input) {
  return Buffer.from(
    input
      .replace(/_/g, " ")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))),
    "binary"
  );
}

function parseMessage(raw) {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? "" : text.slice(split + 2);

  const headers = {};
  // Unfold continuation lines first: RFC 5322 allows a header to wrap, and a
  // naive split leaves half of it in the previous value.
  for (const line of head.split("\n")) {
    if (/^\s/.test(line) && headers.__last) {
      headers[headers.__last] += " " + line.trim();
      continue;
    }
    const at = line.indexOf(":");
    if (at === -1) continue;
    headers.__last = line.slice(0, at).trim();
    headers[headers.__last] = line.slice(at + 1).trim();
  }
  delete headers.__last;

  return {
    envelope: { from: headers.__envelopeFrom, to: headers.__envelopeTo },
    from: decodeHeaderValue(headers.From ?? ""),
    to: decodeHeaderValue(headers.To ?? ""),
    subject: decodeHeaderValue(headers.Subject ?? ""),
    headers: Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, decodeHeaderValue(v)])
    ),
    body,
    raw,
  };
}

/**
 * Start the stub. Resolves once both ports are listening.
 *
 * Returns the handle a suite steers it with:
 *   `messages`    everything accepted so far, oldest first
 *   `failNext`    how many more DATA commands to refuse (settable)
 *   `reset()`     forget every message and clear the failure counter
 *   `close()`     shut both servers down
 */
export function startSmtpStub({
  smtpPort = SMTP_PORT,
  controlPort = CONTROL_PORT,
} = {}) {
  const messages = [];
  const handle = {
    messages,
    smtpPort,
    controlPort,
    /** Set by the control API: refuse this many more DATA commands. */
    failNext: 0,
    reset() {
      messages.length = 0;
      handle.failNext = 0;
    },
  };

  /* ---------------------------------------------------------------- */
  /* SMTP                                                              */
  /* ---------------------------------------------------------------- */

  const smtp = createServer((socket) => {
    // Nodemailer opens a connection per message by default (this app caches a
    // transporter, but a retry may still reconnect), so each socket handles one
    // or more messages and must not leak.
    socket.setEncoding("utf8");

    let buffer = "";
    /** null between commands. */
    let inData = false;
    let dataBuffer = "";
    let envelopeFrom = null;
    let envelopeTo = [];

    const write = (line) => socket.write(`${line}\r\n`);

    socket.write(`220 cafetrack-test ESMTP stub ready\r\n`);

    socket.on("data", (chunk) => {
      buffer += chunk;

      // Everything is line-oriented. DATA is handled separately because its
      // payload is not a command stream.
      while (true) {
        if (inData) {
          // RFC 5321: the payload ends at a line containing only a period. There
        // are two ways to see that here, and they must be handled identically:
        //
        //   end !== -1  the terminator arrived in the middle of this chunk
        //   bare        the chunk began with ".\r\n" — i.e. the terminator was
        //               split across two reads, which happens as soon as a body
        //               is more than one TCP segment
        //
        // Treating the second as anything other than a plain terminator is how
        // this stub ended up refusing every message while claiming it was
        // injecting a failure: the refusal text was printed for a message that
        // had been sent perfectly well.
        const end = buffer.indexOf("\r\n.\r\n");
        const bare = buffer.startsWith(".\r\n");

        if (end !== -1) {
          dataBuffer += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
        } else if (bare) {
          buffer = buffer.slice(3);
        } else {
          // Incomplete: keep the remainder and wait for the rest. The last
          // partial line is held back rather than appended, so a terminator
          // split mid-line is still recognised when it completes.
          const lastBreak = buffer.lastIndexOf("\r\n");
          if (lastBreak !== -1) {
            dataBuffer += buffer.slice(0, lastBreak + 2);
            buffer = buffer.slice(lastBreak + 2);
          }
          return;
        }

        inData = false;

        if (handle.failNext > 0) {
          handle.failNext--;
          // A permanent refusal, which is what a bad address looks like. The
          // message is not recorded: it was not accepted.
          write("550 5.7.1 stub refused this message (failure injected)");
        } else {
          const parsed = parseMessage(dataBuffer);
          parsed.envelope = { from: envelopeFrom, to: [...envelopeTo] };
          messages.push(parsed);
          write("250 2.0.0 Ok: queued");
        }

        dataBuffer = "";
        envelopeFrom = null;
        envelopeTo = [];
        continue;
        }

        const nl = buffer.indexOf("\r\n");
        if (nl === -1) return;

        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);

        const upper = line.toUpperCase();
        const verb = upper.split(" ")[0];

        if (verb === "EHLO" || verb === "HELO") {
          if (verb === "EHLO") {
            // Advertise AUTH so nodemailer picks a mechanism. LOGIN first,
            // because it is what every provider uses and what nodemailer
            // prefers; PLAIN is offered as well so a client that insists on it
            // is not refused.
            write("250-cafetrack-test greets you");
            write("250-SIZE 10485760");
            write("250-8BITMIME");
            write("250-AUTH LOGIN PLAIN");
            write("250 HELP");
          } else {
            write("250 cafetrack-test");
          }
          continue;
        }

        if (verb === "AUTH") {
          const mechanism = (upper.split(" ")[1] || "").toUpperCase();

          if (mechanism === "LOGIN") {
            // Two more round trips: username, then password. The client may
            // have sent the username already after AUTH LOGIN — not in
            // practice, but handled by checking the argument.
            const inline = line.slice(line.indexOf(" ") + 1).trim();
            if (inline && inline.length > 1) {
              finishAuth(inline);
            } else {
              write("334 " + Buffer.from(STUB_USER).toString("base64"));
              // The next line is the username; the one after is the password.
              pendingAuth = "user";
            }
            continue;
          }

          if (mechanism === "PLAIN") {
            // AUTH PLAIN [initial-response], base64 of \0user\0pass.
            const b64 = line.slice(line.lastIndexOf(" ") + 1).trim();
            const decoded = Buffer.from(b64, "base64").toString("utf8");
            const parts = decoded.split("\0");
            finishAuth(parts[1], parts[2]);
            continue;
          }

          write("504 5.5.4 Unrecognized authentication type");
          continue;
        }

        if (pendingAuth === "user") {
          pendingAuth = "pass";
          continue;
        }
        if (pendingAuth === "pass") {
          finishAuth(STUB_USER, line.trim());
          continue;
        }

        if (verb === "MAIL") {
          envelopeFrom = /<([^>]*)>/.exec(line)?.[1] ?? null;
          write("250 2.1.0 Ok");
          continue;
        }

        if (verb === "RCPT") {
          envelopeTo.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          write("250 2.1.5 Ok");
          continue;
        }

        if (verb === "DATA") {
          if (!envelopeFrom || envelopeTo.length === 0) {
            write("503 5.5.1 Need MAIL and RCPT before DATA");
            continue;
          }
          inData = true;
          dataBuffer = "";
          write("354 End data with <CR><LF>.<CR><LF>");
          continue;
        }

        if (verb === "RSET") {
          envelopeFrom = null;
          envelopeTo = [];
          dataBuffer = "";
          write("250 2.0.0 Ok");
          continue;
        }

        if (verb === "NOOP") {
          write("250 2.0.0 Ok");
          continue;
        }

        if (verb === "QUIT") {
          write("221 2.0.0 Bye");
          socket.end();
          continue;
        }

        write("502 5.5.2 Command not implemented");
      }
    });

    let pendingAuth = null;

    function finishAuth(user, pass) {
      pendingAuth = null;
      if (user === STUB_USER && pass === STUB_PASS) {
        write("235 2.7.0 Authentication successful");
      } else {
        write("535 5.7.8 Authentication credentials invalid");
      }
    }

    socket.on("error", () => {
      // A client that hangs up mid-command is ordinary, not a failure. The
      // suite asserts on what was accepted, so a dropped connection needs no
      // reporting.
    });
  });

  /* ---------------------------------------------------------------- */
  /* control API                                                       */
  /* ---------------------------------------------------------------- */

  const control = createHttpServer((req, res) => {
    const send = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/messages") {
      send(200, {
        count: messages.length,
        failNext: handle.failNext,
        messages: messages.map((m) => ({
          from: m.from,
          to: m.to,
          subject: m.subject,
          body: m.body,
          envelope: m.envelope,
        })),
      });
      return;
    }

    if (url.pathname === "/reset") {
      handle.reset();
      send(200, { ok: true });
      return;
    }

    if (url.pathname === "/fail") {
      // Body: a bare integer, or JSON. Kept liberal because a suite setting
      // this is in a hurry and a parse failure would be noise.
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let n = Number(raw.trim());
        if (Number.isNaN(n)) {
          try {
            n = Number(JSON.parse(raw).count);
          } catch {
            n = 0;
          }
        }
        handle.failNext = Number.isFinite(n) ? n : 0;
        send(200, { failNext: handle.failNext });
      });
      return;
    }

    send(404, { error: "unknown control endpoint" });
  });

  return new Promise((resolve, reject) => {
    const fail = (e) => reject(new Error(`SMTP stub failed to start: ${e.message}`));
    smtp.once("error", fail);
    control.once("error", fail);

    smtp.listen(smtpPort, "127.0.0.1", () => {
      const actualSmtpPort = smtp.address()?.port ?? smtpPort;
      handle.smtpPort = actualSmtpPort;

      control.listen(controlPort, "127.0.0.1", () => {
        const actualControlPort = control.address()?.port ?? controlPort;
        handle.controlPort = actualControlPort;

        resolve(
          Object.assign(handle, {
            close: () =>
              new Promise((done) => {
                smtp.close(() => control.close(() => done()));
              }),
          })
        );
      });
    });
  });
}

/**
 * A small client for the control API, for a suite in another process.
 *
 * The stub runs inside the dev server's world (or beside it); the suite cannot
 * reach the returned handle, so it steers the stub over HTTP instead.
 */
export function stubControl(base = `http://127.0.0.1:${CONTROL_PORT}`) {
  return {
    async messages() {
      const r = await fetch(`${base}/messages`);
      if (!r.ok) throw new Error(`stub control /messages -> ${r.status}`);
      return r.json();
    },
    async reset() {
      await fetch(`${base}/reset`, { method: "POST" });
    },
    /** Refuse the next `n` deliveries. */
    async failNext(n) {
      const r = await fetch(`${base}/fail`, {
        method: "POST",
        body: String(n),
      });
      if (!r.ok) throw new Error(`stub control /fail -> ${r.status}`);
      return r.json();
    },
  };
}

// Standalone: `node scripts/_smtp-stub.mjs`
if (process.argv[1] && process.argv[1].endsWith("_smtp-stub.mjs")) {
  const stub = await startSmtpStub();
  console.log(
    `SMTP stub listening on 127.0.0.1:${stub.smtpPort}\n` +
      `control API on http://127.0.0.1:${stub.controlPort}\n` +
      `accepts ${STUB_USER} / ${STUB_PASS}\n` +
      `Ctrl-C to stop.`
  );
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stub.close().then(() => process.exit(0));
    });
  }
}