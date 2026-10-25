import { handler, ok } from "@/lib/api";
import { getFaceEngine } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * Which face engine the capture screens should use.
 *
 *   GET -> { engine: "legacy" | "sface" }
 *
 * Public, and deliberately so. The sign-in screen has to know which embedding to
 * compute *before* anyone has identified themselves, and the answer says nothing
 * about any account — it is a property of the cafe's configuration. Every other
 * capture screen asks the same question and gets the same answer, so a stale page
 * and a fresh one cannot disagree about which model they are running.
 *
 * No threshold, no counts, no per-account data: nothing here that a stranger
 * could use to probe who is enrolled.
 */
export const GET = handler(async () => {
  return ok({ engine: await getFaceEngine() });
});
