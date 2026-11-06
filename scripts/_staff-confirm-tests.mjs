/**
 * Compatibility entry point for the retired password-then-face sign-in suite.
 * Password sign-in now creates a session; duty face checks are tested separately.
 */
await import("./_duty-gate-tests.mjs");
