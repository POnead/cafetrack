export type SessionRole = "admin" | "staff";

export const SESSION_IDLE_TIMEOUT_MINUTES: Record<SessionRole, number> = {
  admin: 5,
  staff: 10,
};
