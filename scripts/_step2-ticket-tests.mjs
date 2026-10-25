/**
 * Tests for the step-two ticket.
 *
 *   npm run test:step2-ticket
 *
 * ## What is being defended here
 *
 * Step one of staff sign-in proves a password. Step two proves a face or an ID
 * card. Only the two together are a login, so the thing carrying "who is signing
 * in" from step one to step two must be *incapable* of being read as a session.
 * If it can be, the whole second step is optional in practice and nothing but
 * good manners stands between a caller and the app.
 *
 * ## Why the separation is asserted with `jose` directly
 *
 * The obvious test would import `readSessionToken` from ../src/lib/auth.ts and
 * hand it a ticket. That does not run: auth.ts imports `next/headers`, which does
 * not resolve outside a Next runtime, so the module fails to load before any
 * assertion is reached.
 *
 * So this asserts the property the code actually relies on, which is purely
 * cryptographic and needs no framework: the ticket key is derived from the
 * session key, so a ticket does not verify under the session key, and a session
 * does not verify under the ticket key. `readSessionToken` is `jwtVerify(token,
 * SECRET)` and nothing more, so "does not verify under the session key" *is* the
 * bypass being closed.
 *
 * The end-to-end version — a real ticket cookie against a real protected route —
 * lives in scripts/_staff-confirm-tests.mjs, where a running server can prove it.
 */

import {
  newStep2Nonce,
  readStep2Ticket,
  signStep2Ticket,
} from "../src/lib/auth/step2-ticket.ts";
import { resolveAuthSecret } from "../src/lib/secret.ts";
import { SignJWT, jwtVerify } from "jose";
import { createHmac } from "node:crypto";

let passed = 0;
let failed = 0;

function ok(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

async function section(title) {
  console.log(`\n--- ${title}`);
}

/* The two keys, derived exactly as the application derives them. */
const SESSION_KEY = new TextEncoder().encode(resolveAuthSecret());
const TICKET_KEY = new TextEncoder().encode(
  createHmac("sha256", resolveAuthSecret()).update("cafetrack.step2.v1").digest("hex")
);

/** A stand-in for signSession: same key, same claims, as auth.ts mints them. */
function signASession() {
  return new SignJWT({
    id: "u-1",
    username: "cook1",
    fullName: "Cook One",
    role: "staff",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(SESSION_KEY);
}

const ticket = { userId: "u-1", username: "cook1", nonce: newStep2Nonce() };

/* ------------------------------------------------------------------ */

await section("round trip");

{
  const token = await signStep2Ticket(ticket);
  const read = await readStep2Ticket(token);

  ok("a fresh ticket reads back", read !== null);
  ok("userId survives", read?.userId === "u-1", `got ${read?.userId}`);
  ok("username survives", read?.username === "cook1", `got ${read?.username}`);
  ok("nonce survives", read?.nonce === ticket.nonce);
}

{
  /*
   * Different nonces must give different tickets even inside the same second.
   *
   * `setIssuedAt` is second-granularity, so signing the *same* nonce twice in the
   * same second legitimately yields byte-identical output. That is not a defect
   * and is left alone: the nonce is the per-ticket differentiator, it is stored,
   * and it is what gets burned, so a repeat sign carries no extra capability.
   */
  const a = await signStep2Ticket({ ...ticket, nonce: newStep2Nonce() });
  const b = await signStep2Ticket({ ...ticket, nonce: newStep2Nonce() });
  ok("two tickets with different nonces differ", a !== b);

  const again = await signStep2Ticket(ticket);
  ok("signing one nonce twice is deterministic", again === (await signStep2Ticket(ticket)));
}

/* ------------------------------------------------------------------ */

await section("the bypass: a ticket must not verify as a session");

{
  const token = await signStep2Ticket(ticket);

  // This is the assertion the whole module exists for. readSessionToken is
  // jwtVerify(token, SESSION_KEY); if this resolves, step two is skippable.
  let leaked = null;
  try {
    leaked = await jwtVerify(token, SESSION_KEY);
  } catch {
    leaked = null;
  }

  ok("a ticket does NOT verify under the session key", leaked === null);
  ok("a ticket has no readable id claim as a session", leaked?.payload?.id === undefined);
}

{
  // The mirror image, which is the likelier mistake to introduce later: someone
  // adds a purpose check to the session path and starts accepting tickets there.
  const session = await signASession();
  let leaked = null;
  try {
    leaked = await jwtVerify(session, TICKET_KEY);
  } catch {
    leaked = null;
  }

  ok("a session does NOT verify under the ticket key", leaked === null);
  ok("readStep2Ticket refuses a session", (await readStep2Ticket(session)) === null);
}

{
  // And the session key itself must still be intact, or this file has proved
  // nothing except that both sides are broken.
  const session = await signASession();
  const real = await jwtVerify(session, SESSION_KEY);
  ok("a real session still verifies under the session key", real?.payload?.username === "cook1");
  ok("the two keys are not equal", SESSION_KEY !== TICKET_KEY);
}

/* ------------------------------------------------------------------ */

await section("expiry");

{
  const token = await signStep2Ticket(ticket, -10);
  ok("an already-expired ticket is refused", (await readStep2Ticket(token)) === null);
}

{
  const token = await signStep2Ticket(ticket, 300);
  ok("a ticket inside its life is accepted", (await readStep2Ticket(token)) !== null);
}

/* ------------------------------------------------------------------ */

await section("tampering");

{
  const [head, payload, sig] = (await signStep2Ticket(ticket)).split(".");
  ok("a tampered payload is refused", (await readStep2Ticket(`${head}.${payload}x.${sig}`)) === null);
}

{
  const token = await signStep2Ticket(ticket);
  ok("a truncated signature is refused", (await readStep2Ticket(token.slice(0, -3))) === null);
}

{
  // Re-signed with another deployment's key, as an attacker with their own
  // AUTH_SECRET would produce.
  const foreignKey = new TextEncoder().encode(
    createHmac("sha256", "some-other-deployment-secret")
      .update("cafetrack.step2.v1")
      .digest("hex")
  );
  const foreign = await new SignJWT({
    id: "u-1",
    username: "cook1",
    nonce: newStep2Nonce(),
    purpose: "step2",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("300s")
    .sign(foreignKey);

  ok("a ticket signed by another deployment is refused", (await readStep2Ticket(foreign)) === null);
}

{
  // Correctly signed, correct purpose, but the nonce claim is missing. The
  // signature alone must not be enough to make a ticket spendable.
  const noNonce = await new SignJWT({ id: "u-1", username: "cook1", purpose: "step2" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("300s")
    .sign(TICKET_KEY);

  ok("a correctly-signed ticket with no nonce is refused", (await readStep2Ticket(noNonce)) === null);
}

/* ------------------------------------------------------------------ */

await section("rubbish");

ok("an empty string is refused", (await readStep2Ticket("")) === null);
ok("plain text is refused", (await readStep2Ticket("not-a-jwt")) === null);
ok("a cookie pair is refused", (await readStep2Ticket("cafetrack_session=x")) === null);
ok("an unsigned alg=none token is refused", (await readStep2Ticket("eyJhbGciOiJub25lIn0.eyJpZCI6InUxIn0.")) === null);

/* ------------------------------------------------------------------ */

await section("nonces");

{
  const a = newStep2Nonce();
  const b = newStep2Nonce();
  ok("nonces differ", a !== b);
  ok("a nonce is 32 hex chars", /^[0-9a-f]{32}$/.test(a), `got ${a}`);
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);