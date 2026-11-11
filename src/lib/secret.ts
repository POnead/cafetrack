/**
 * The one rule for AUTH_SECRET, shared by the session code and the middleware
 * so the two can never disagree about whether a deployment is configured.
 *
 * The failure this prevents: a deployment that starts without AUTH_SECRET
 * falls back to a string that is published in this repository, so every
 * session cookie in that deployment can be forged by anyone who has read the
 * source. Refusing to start is far better than that.
 */

/** Comfortably longer than an HMAC key needs, and catches obvious mistakes. */
const MIN_LENGTH = 32;

/*
 * Values that are long enough but are still templates, not secrets. The copy
 * in .env.example and this repo's .env.local is 48+ characters — so a plain
 * length check happily accepts it, and a deployment that copied the example
 * verbatim would sign every session with a key published in the repository.
 * Placeholders are recognised by words no random hex/base64 key contains.
 */
const PLACEHOLDER = /change[-_ ]?me|replace[-_ ]?me|your[-_ ]?(?:own|secret|key)|example|dev[-_ ]?secret|test[-_ ]?secret|placeholder/i;

const HOW_TO_GENERATE =
  "Generate one with: openssl rand -hex 32 " +
  '(or on Windows: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")';

function isPlaceholderSecret(value: string): boolean {
  return PLACEHOLDER.test(value);
}

/** True when AUTH_SECRET is set, long enough, and not a published placeholder. */
export function isAuthSecretConfigured(value = process.env.AUTH_SECRET): boolean {
  const secret = (value ?? "").trim();
  return secret.length >= MIN_LENGTH && !isPlaceholderSecret(secret);
}

/**
 * The signing key. Throws in production when AUTH_SECRET is missing or too
 * short. In development it warns once and carries on, so a fresh clone still
 * runs with no setup at all.
 */
export function resolveAuthSecret(): string {
  const secret = (process.env.AUTH_SECRET ?? "").trim();

  if (secret.length >= MIN_LENGTH && !isPlaceholderSecret(secret)) return secret;

  // Fail closed in ALL environments. A published dev secret means every session
  // cookie can be forged by anyone who has read the source.
  throw new Error(
    `AUTH_SECRET must be set to a real random value of at least ${MIN_LENGTH} characters. ` +
      HOW_TO_GENERATE
  );
}
