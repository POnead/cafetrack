import { getSetting } from "@/lib/settings";

export const STAFF_POSITIONS_SETTING = "staff_position_profiles";

export type PositionAccess = "staff" | "admin";

export type StaffPositionProfile = {
  name: string;
  access: PositionAccess;
};

export function parseStaffPositionProfiles(raw: string | null): StaffPositionProfile[] {
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Saved staff positions are not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("Saved staff positions must be a list");

  return parsed.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      !["staff", "admin"].includes(entry.access)
    ) {
      throw new Error("A saved staff position is invalid");
    }
    return {
      name: entry.name.trim(),
      access: entry.access as PositionAccess,
    };
  });
}

export async function getPositionAccess(position: string | null | undefined): Promise<PositionAccess> {
  const profiles = await getSavedStaffPositionProfiles();
  return getPositionAccessFromProfiles(position, profiles);
}

export async function getSavedStaffPositionProfiles(): Promise<StaffPositionProfile[]> {
  return parseStaffPositionProfiles(await getSetting(STAFF_POSITIONS_SETTING));
}

export function getPositionAccessFromProfiles(
  position: string | null | undefined,
  profiles: readonly StaffPositionProfile[]
): PositionAccess {
  if (!position?.trim()) return "staff";
  return profiles.find(
    (profile) => profile.name.toLocaleLowerCase() === position.trim().toLocaleLowerCase()
  )?.access ?? "staff";
}

export function validateStaffPositionProfiles(
  input: unknown
): { profiles: StaffPositionProfile[]; error: null } | { profiles: null; error: string } {
  if (!Array.isArray(input) || input.length > 100) {
    return { profiles: null, error: "Provide up to 100 staff positions" };
  }

  const profiles: StaffPositionProfile[] = [];
  const names = new Set<string>();
  for (const entry of input) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      typeof entry.access !== "string"
    ) {
      return { profiles: null, error: "Each position needs a name and access profile" };
    }
    const name = entry.name.trim();
    if (!name || name.length > 80) {
      return { profiles: null, error: "Position names must be between 1 and 80 characters" };
    }
    const key = name.toLocaleLowerCase();
    if (names.has(key)) return { profiles: null, error: `Position "${name}" is listed more than once` };
    if (entry.access !== "staff" && entry.access !== "admin") {
      return { profiles: null, error: `Choose a valid access profile for "${name}"` };
    }
    names.add(key);
    profiles.push({ name, access: entry.access });
  }
  return { profiles, error: null };
}
