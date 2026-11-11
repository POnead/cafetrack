import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp, dbFail } from "@/lib/api";
import { clearSessionCache, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clearSettingsCache } from "@/lib/settings";
import {
  parseStaffPositionProfiles,
  STAFF_POSITIONS_SETTING,
  validateStaffPositionProfiles,
} from "@/lib/staff-positions";

export const runtime = "nodejs";

export const GET = handler(async () => {
  await requireAdmin();

  const [{ data: setting, error: settingError }, { data: users, error: usersError }] =
    await Promise.all([
      db().from("settings").select("value").eq("key", STAFF_POSITIONS_SETTING).maybeSingle(),
      db().from("users").select("position, role, is_active"),
    ]);
  if (settingError) return dbFail(settingError, { context: "staff positions read" });
  if (usersError) return dbFail(usersError, { context: "staff positions users" });

  let profiles;
  try {
    profiles = parseStaffPositionProfiles(setting?.value ?? null);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not read staff positions", 500);
  }

  const byName = new Map(
    profiles.map((profile) => [profile.name.toLocaleLowerCase(), profile])
  );
  for (const user of (users ?? []) as { position: string | null }[]) {
    const name = user.position?.trim();
    if (name && !byName.has(name.toLocaleLowerCase())) {
      byName.set(name.toLocaleLowerCase(), { name, access: "staff" });
    }
  }
  if (byName.size === 0) byName.set("barista", { name: "Barista", access: "staff" });

  const assignedCounts = new Map<string, number>();
  for (const user of (users ?? []) as { position: string | null }[]) {
    const name = user.position?.trim().toLocaleLowerCase();
    if (name) assignedCounts.set(name, (assignedCounts.get(name) ?? 0) + 1);
  }

  return ok({
    positions: [...byName.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((profile) => ({
        ...profile,
        originalName: profile.name,
        assignedCount: assignedCounts.get(profile.name.toLocaleLowerCase()) ?? 0,
      })),
  });
});

export const PUT = handler(async (req: Request) => {
  const admin = await requireAdmin();
  const body = await readBody(req);
  const validated = validateStaffPositionProfiles(body.positions);
  if (validated.profiles === null) return fail(validated.error ?? "Staff positions are invalid");
  const profiles = validated.profiles;
  const requestedPositions = body.positions as { name: string; originalName?: string }[];

  const { data: savedSetting, error: savedSettingError } = await db()
    .from("settings")
    .select("value")
    .eq("key", STAFF_POSITIONS_SETTING)
    .maybeSingle();
  if (savedSettingError) return dbFail(savedSettingError, { context: "staff positions readback" });
  let savedProfiles;
  try {
    savedProfiles = parseStaffPositionProfiles(savedSetting?.value ?? null);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not read saved positions", 500);
  }

  const { data: users, error: usersError } = await db()
    .from("users")
    .select("id, position, role, is_active");
  if (usersError) return dbFail(usersError, { context: "staff positions rename list" });

  const usersWithPosition = (users ?? []) as {
    id: string;
    position: string | null;
    role: string;
    is_active: boolean;
  }[];
  const previousProfiles = new Map(
    savedProfiles.map((profile) => [profile.name.toLocaleLowerCase(), profile])
  );
  const assignedCounts = new Map<string, number>();
  for (const user of usersWithPosition) {
    const name = user.position?.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    assignedCounts.set(key, (assignedCounts.get(key) ?? 0) + 1);
    if (!previousProfiles.has(key)) {
      previousProfiles.set(key, { name, access: "staff" });
    }
  }
  const knownOldNames = new Set([
    ...savedProfiles.map((profile) => profile.name.toLocaleLowerCase()),
    ...usersWithPosition
      .map((user) => user.position?.trim().toLocaleLowerCase())
      .filter((name): name is string => Boolean(name)),
  ]);
  const renames = new Map<string, string>();
  // Each entry becomes its own audit row as well as part of the summary, so
  // "added Barista" and "renamed Cook" can be found without opening a details
  // dialog. The summary keeps the full before/after picture in one place.
  const changes: {
    action: string;
    change: string;
    details: Record<string, unknown>;
  }[] = [];
  const requestedSources = new Set<string>();
  for (let index = 0; index < requestedPositions.length; index += 1) {
    const rawOriginalName = requestedPositions[index]?.originalName;
    if (rawOriginalName !== undefined && typeof rawOriginalName !== "string") {
      return fail("Position rename source must be a name.");
    }
    const originalName = rawOriginalName?.trim();
    const nextName = profiles[index]?.name;
    const nextProfile = profiles[index];
    if (originalName) requestedSources.add(originalName.toLocaleLowerCase());
    else if (nextName) requestedSources.add(nextName.toLocaleLowerCase());

    const previousName = originalName || nextName;
    const previousProfile = previousName
      ? previousProfiles.get(previousName.toLocaleLowerCase())
      : undefined;
    if (!previousProfile && nextProfile) {
      changes.push({
        action: "STAFF_POSITION_ADD",
        change: "Position added",
        details: {
          position: nextProfile.name,
          access: nextProfile.access,
        },
      });
    } else if (previousProfile && nextProfile) {
      if (originalName && originalName.toLocaleLowerCase() !== nextProfile.name.toLocaleLowerCase()) {
        changes.push({
          action: "STAFF_POSITION_RENAME",
          change: "Position renamed",
          details: {
            previous_position: previousProfile.name,
            position: nextProfile.name,
            assigned_accounts:
              assignedCounts.get(previousProfile.name.toLocaleLowerCase()) ?? 0,
          },
        });
      }
      if (previousProfile.access !== nextProfile.access) {
        changes.push({
          action: "STAFF_POSITION_ACCESS",
          change: "Access changed",
          details: {
            position: nextProfile.name,
            previous_access: previousProfile.access,
            access: nextProfile.access,
            assigned_accounts:
              assignedCounts.get(previousProfile.name.toLocaleLowerCase()) ?? 0,
          },
        });
      }
    }

    if (!originalName || !nextName || originalName.toLocaleLowerCase() === nextName.toLocaleLowerCase()) {
      continue;
    }
    const source = originalName.toLocaleLowerCase();
    if (!knownOldNames.has(source)) {
      return fail(`Position "${originalName}" no longer exists. Reload the page and try again.`);
    }
    if (renames.has(source)) return fail(`Position "${originalName}" is being renamed more than once.`);
    renames.set(source, nextName);
  }

  for (const previousProfile of previousProfiles.values()) {
    if (!requestedSources.has(previousProfile.name.toLocaleLowerCase())) {
      changes.push({
        action: "STAFF_POSITION_REMOVE",
        change: "Position removed",
        details: {
          position: previousProfile.name,
          assigned_accounts:
            assignedCounts.get(previousProfile.name.toLocaleLowerCase()) ?? 0,
        },
      });
    }
  }

  const renameSources = new Set(renames.keys());
  for (const [source, target] of renames) {
    const targetKey = target.toLocaleLowerCase();
    if (
      targetKey !== source &&
      knownOldNames.has(targetKey) &&
      !renameSources.has(targetKey)
    ) {
      return fail(`A position named "${target}" already exists.`);
    }
  }

  const configuredNames = new Set(
    profiles.map((profile) => profile.name.toLocaleLowerCase())
  );
  const resolvedPosition = (position: string | null) => {
    const current = position?.trim() ?? "";
    return renames.get(current.toLocaleLowerCase()) ?? current;
  };
  const removedAssigned = usersWithPosition
    .map((user) => resolvedPosition(user.position).toLocaleLowerCase())
    .find((name) => name && !configuredNames.has(name));
  if (removedAssigned) {
    return fail("A position assigned to an account cannot be removed. Reassign those accounts first.");
  }

  const accessByName = new Map(
    profiles.map((profile) => [profile.name.toLocaleLowerCase(), profile.access])
  );
  const keepsAdminAccess = usersWithPosition.some(
    (user) =>
      user.is_active &&
      (user.role === "admin" ||
        (user.role === "staff" &&
          accessByName.get(resolvedPosition(user.position).toLocaleLowerCase()) === "admin"))
  );
  if (!keepsAdminAccess) {
    return fail("At least one active account must keep full admin access.");
  }

  const renamedUsers: { id: string; oldName: string }[] = [];
  for (const user of usersWithPosition) {
    const position = user.position?.trim();
    const renamedTo = position ? renames.get(position.toLocaleLowerCase()) : undefined;
    if (!position || !renamedTo) continue;

    const { error: renameError } = await db()
      .from("users")
      .update({ position: renamedTo })
      .eq("id", user.id);
    if (renameError) {
      for (const changedUser of renamedUsers) {
        const { error: rollbackError } = await db()
          .from("users")
          .update({ position: changedUser.oldName })
          .eq("id", changedUser.id);
        if (rollbackError) {
          console.error("Could not roll back a staff position rename:", rollbackError.message);
        }
      }
      return dbFail(renameError, { context: "staff position rename" });
    }
    renamedUsers.push({ id: user.id, oldName: position });
  }

  const value = JSON.stringify(profiles);
  const { data, error } = await db()
    .from("settings")
    .update({ value })
    .eq("key", STAFF_POSITIONS_SETTING)
    .select("key");
  if (error) {
    await rollbackPositionRenames(renamedUsers);
    return dbFail(error, { context: "staff positions save" });
  }
  if (!data || data.length === 0) {
    const { error: insertError } = await db()
      .from("settings")
      .insert({ key: STAFF_POSITIONS_SETTING, value });
    if (insertError) {
      await rollbackPositionRenames(renamedUsers);
      return dbFail(insertError, { context: "staff positions save (insert)" });
    }
  }

  clearSettingsCache();
  clearSessionCache();
  const ip = clientIp(req);

  // Summary first, then one row per change. The audit trail is read newest
  // first, so the individual "added / renamed / access changed / removed"
  // rows appear above the summary and are visible without opening a dialog.
  await audit(
    admin,
    "STAFF_POSITIONS_UPDATE",
    "settings",
    null,
    {
      changes: changes.map(({ change, details }) => ({ change, ...details })),
      position_count: profiles.length,
    },
    { ip }
  );

  for (const change of changes) {
    await audit(
      admin,
      change.action,
      "staff_position",
      null,
      { change: change.change, ...change.details },
      { ip }
    );
  }

  return ok({ positions: profiles });
});

async function rollbackPositionRenames(users: { id: string; oldName: string }[]) {
  for (const user of users) {
    const { error } = await db()
      .from("users")
      .update({ position: user.oldName })
      .eq("id", user.id);
    if (error) {
      console.error("Could not roll back a staff position rename:", error.message);
    }
  }
}
