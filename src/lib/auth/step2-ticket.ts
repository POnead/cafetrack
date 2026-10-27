import { SignJWT, jwtVerify } from "jose";
import { createHmac, randomBytes } from "node:crypto";
import { resolveAuthSecret } from "../secret";

/**
 * The second step of staff sign-in: proof that the face belongs to the person
 * who typed the password.
 *
 * ## Why this is a separate file, and separate key
 *
 * Step one proves a password and must NOT mint a session, because the password
 * alone is no longer enough to get in. But a half-finished sign-in still has to
 * carry *who* is signing in from step one to step two, and it has to carry it in
 * something that cannot be mistaken for a session.
 *
 * The obvious shape — sign a JWT with the same key and the same claims, and add
 * a `purpose` claim to tell them apart — does not work here. `readSessionToken`
 * in ../auth.ts reads `id`, `username`, `fullName` and `role` and nothing else;
 * it has no notion of a purpose to check. A ticket shaped like a session is
 * therefore read as one, and step two becomes skippable by anyone who walks
 * straight past the panel.
 *
 * So the separation is made in the key rather than in a claim. This module signs
 * with a value derived from AUTH_SECRET that the session code never holds, so a
 * ticket presented as a session cookie fails `jwtVerify` outright. The bypass is
 * closed by construction instead of by a check somebody can forget to add later.
 *
 * ## Single use
 *
 * A ticket carries a nonce, and the nonce is written to `users.step2_nonce` when
 * the ticket is minted. Redeeming checks the two still agree and then overwrites
 * the column, which burns the ticket. That survives a restart and works across
 * processes, which an in-memory "used" set would not.
 */

const AUTH_SECRET = resolveAuthSecret();

/**
 * Derived, not random: a restart must not invalidate every ticket in flight,
 * and this must never be the same value the session code signs with.
 */
const TICKET_SECRET = new TextEncoder().encode(
  createHmac("sha256", AUTH_SECRET).update("cafetrack.step2.v1").digest("hex")
);

/**
 * Five minutes.
 *
 * Long enough to walk to a bag, find a card and hold it up. Short enough that a
 * ticket left on a shared till machine is worthless by the time anyone thinks
 * to use it.
 */
export const STEP2_TTL_SECONDS = 300;

export type Step2Ticket = {
  userId: string;
  username: string;
  nonce: string;
};

/** A fresh nonce for one ticket. 128 bits, hex, so it is safe in a JWT claim. */
export function newStep2Nonce(): string {
  return randomBytes(16).toString("hex");
}

export async function signStep2Ticket(
  ticket: Step2Ticket,
  seconds: number = STEP2_TTL_SECONDS
): Promise<string> {
  return await new SignJWT({
    id: ticket.userId,
    username: ticket.username,
    nonce: ticket.nonce,
    purpose: "step2",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(TICKET_SECRET);
}

/**
 * Returns null for anything that is not a live, well-formed step-two ticket:
 * a session token, a ticket from another deployment, a tampered one, an expired
 * one, or plain rubbish.
 *
 * The caller must still compare the nonce against the database. This function
 * proves the ticket was *minted* here and has not expired; it says nothing about
 * whether it has already been spent.
 */
export async function readStep2Ticket(token: string): Promise<Step2Ticket | null> {
  try {
    const { payload } = await jwtVerify(token, TICKET_SECRET);

    if (payload.purpose !== "step2") return null;

    const userId = typeof payload.id === "string" ? payload.id : "";
    const username = typeof payload.username === "string" ? payload.username : "";
    const nonce = typeof payload.nonce === "string" ? payload.nonce : "";

    if (!userId || !nonce) return null;

    return { userId, username, nonce };
  } catch {
    return null;
  }
}