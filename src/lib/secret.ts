/**
 * The one rule for AUTH_SECRET, shared by the session code and the middleware
 * so the two can never disagree about whether a deployment is configured.
 *
 * The failure this prevents: a deployment that starts without AUTH_SECRET
 * falls back to a string that is published in this repository, so every
 * session cookie in that deployment can be forged by anyone who has read the
 * source. Refusing to start is far better than that.
 */

const DEV_FALLBACK = "dev-only-secret-change-me-please-32-chars-min";

/** Comfortably longer than an HMAC key needs, and catches obvious mistakes. */
const MIN_LENGTH = 32;

const HOW_TO_GENERATE =
  "Generate one with: openssl rand -hex 32 " +
  '(or on Windows: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")';

/** True when AUTH_SECRET is set, long enough, and not the published fallback. */
export function isAuthSecretConfigured(value = process.env.AUTH_SECRET): boolean {
  const secret = (value ?? "").trim();
  return secret.length >= MIN_LENGTH && secret !== DEV_FALLBACK;
}

/**
 * The signing key. Throws in production when AUTH_SECRET is missing or too
 * short. In development it warns once and carries on, so a fresh clone still
 * runs with no setup at all.
 */
export function resolveAuthSecret(): string {
  const secret = (process.env.AUTH_SECRET ?? "").trim();

  if (secret.length >= MIN_LENGTH && secret !== DEV_FALLBACK) return secret;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `AUTH_SECRET must be set to at least ${MIN_LENGTH} characters in production. ` +
        HOW_TO_GENERATE
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    "[auth] AUTH_SECRET is not set — falling back to the published dev secret. " +
      "Sessions will not survive a restart and must never be trusted. " +
      HOW_TO_GENERATE
  );
  return DEV_FALLBACK;
}
