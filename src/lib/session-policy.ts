export type SessionRole = "admin" | "staff";

/** Fallbacks used when role-specific timeout settings are unavailable. */
export const DEFAULT_ROLE_IDLE_TIMEOUT_MINUTES: Record<SessionRole, number> = {
  admin: 5,
  staff: 10,
};
