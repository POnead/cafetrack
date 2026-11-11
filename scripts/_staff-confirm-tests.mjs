/**
 * Compatibility entry point for the retired password-then-face sign-in suite.
 * Password sign-in creates a session when no face check is due; due face checks
 * are confirmed through the step-two ticket.
 */
await import("./_duty-gate-tests.mjs");
