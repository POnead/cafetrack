import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption for credentials an admin types into the app — currently the SMTP
 * app password (FR-11).
 *
 * Why this exists at all: the feature requirement is that an owner can point the
 * system at their own Gmail account from the website, without editing a file and
 * restarting. That means the password has to live in the database, and a bare
 * password column would put a working credential in every backup, every export
 * and every `select *` an admin page ever runs.
 *
 * So it is encrypted at rest with AES-256-GCM, keyed from AUTH_SECRET — the same
 * secret that already signs session cookies and that the app refuses to start
 * without in production.
 *
 * What this does and does not buy:
 *
 *   - The password is not readable in the database, in a backup, or through any
 *     API response. The routes return "configured" and never the value.
 *   - GCM is authenticated, so a row edited by hand fails to decrypt rather than
 *     silently yielding garbage.
 *   - It is NOT protection from anyone who can run code in this process, or who
 *     holds both the database and AUTH_SECRET. That is the same trust boundary
 *     the session cookies already live inside, and pretending otherwise would be
 *     the more dangerous claim.
 *
 * Rotating AUTH_SECRET invalidates every stored credential. That is deliberate
 * and detectable: `decryptSecret` returns null rather than throwing, and
 * `credentialStatus` reports it so the UI can say "re-enter the password" instead
 * of every send failing with a confusing auth error.
 */

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
/** Fixed salt. Not a secret — it only separates this key from any other use. */
const KEY_SALT = "cafetrack-credential-store-v1";

let cachedKey: Buffer | null = null;

/**
 * The 32-byte encryption key, derived from AUTH_SECRET.
 *
 * scrypt rather than a bare hash because AUTH_SECRET is already high-entropy
 * random data, so this is about keeping the two uses cryptographically separate
 * rather than about stretching a weak password. The result is memoised because it
 * is needed per send and scrypt is deliberately slow.
 *
 * `resolveAuthSecret()` throws in production when AUTH_SECRET is missing, which
 * is the behaviour we want: no secret, no key, no stored credentials readable.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  // Imported lazily so this module has no import-time dependency on auth.ts,
  // matching the import-cycle rule the other lib modules follow.
  const { resolveAuthSecret } = require("./secret") as typeof import("./secret");
  cachedKey = scryptSync(resolveAuthSecret(), KEY_SALT, 32);
  return cachedKey;
}

/**
 * Encrypt a secret for storage. Output is
 * `v1.<iv>.<authTag>.<ciphertext>`, all base64.
 *
 * A fresh 12-byte IV per call: GCM nonce reuse under one key would be
 * catastrophic, and "once per save" makes a collision implausible.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a stored value. Returns null when it cannot be read — wrong version,
 * malformed, tampered with, or the key changed.
 *
 * Null rather than a throw on purpose. A corrupted credential should surface as
 * "please re-enter this", not as a 500 on every email send.
 */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;

  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  } catch {
    // Wrong key (AUTH_SECRET rotated) or a failed auth tag. Either way the value
    // is unreadable and must be entered again.
    return null;
  }
}

/** True when a stored value is a well-formed, currently-decryptable secret. */
export function credentialReadable(stored: string | null | undefined): boolean {
  return decryptSecret(stored) !== null;
}

/**
 * Test seam: drops the memoised key. Only useful if a test ever runs with two
 * different AUTH_SECRET values in one process.
 */
export function resetCredentialKey(): void {
  cachedKey = null;
}