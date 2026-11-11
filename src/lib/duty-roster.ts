export type DutyStaffIdentity = {
  id: string;
  name: string;
};

export type DutyAuditEvent = {
  actor_id: string | null;
  actor_name: string;
  /** For FACE_VERIFY_RESET the staff member whose check was reset (the admin
   * who performed it is `actor_id`). Undefined for login/verify events. */
  entity_id?: string | null;
  action: string;
  details: Record<string, unknown> | null;
  outcome: string | null;
  created_at: string;
};

export type DutyTransaction = {
  actor_id: string | null;
  type: string;
};

export type DutyActivityCounts = {
  checkout: number;
  restock: number;
  waste: number;
};

export function countDutyActivity(
  transactions: readonly DutyTransaction[]
): DutyActivityCounts {
  const counts: DutyActivityCounts = { checkout: 0, restock: 0, waste: 0 };
  for (const transaction of transactions) {
    if (transaction.type === "checkout") counts.checkout += 1;
    else if (transaction.type === "restock") counts.restock += 1;
    else if (transaction.type === "waste") counts.waste += 1;
  }
  return counts;
}

export type DutyRosterEntry = {
  id: string;
  name: string;
  signedInAt: string | null;
  faceVerified: boolean;
  faceReset: boolean;
  checkout: number;
  restock: number;
  waste: number;
};

function isFaceLogin(event: DutyAuditEvent): boolean {
  const method = event.details?.method;
  return (
    method === "face_login" ||
    method === "id_login" ||
    (method === "staff_step2" && event.details?.matched_by === "face")
  );
}

export function buildDutyRoster(input: {
  staff: readonly DutyStaffIdentity[];
  logins: readonly DutyAuditEvent[];
  faceVerifications: readonly DutyAuditEvent[];
  /** Today's successful `FACE_VERIFY_RESET` audit rows. `entity_id` names the
   * staff member whose check was reset. A reset after a verification clears
   * it; a verification after a reset re-establishes it — latest event wins. */
  faceResetEvents: readonly DutyAuditEvent[];
  transactions: readonly DutyTransaction[];
}): DutyRosterEntry[] {
  const staffById = new Map(input.staff.map((staff) => [staff.id, staff]));
  const roster = new Map<string, DutyRosterEntry>();
  /** Latest face-state event per staff member, keyed by staff id. */
  const latestFaceByStaff = new Map<string, { kind: "verify" | "reset"; when: Date }>();

  const getEntry = (id: string, actorName?: string) => {
    const identity = staffById.get(id);
    if (!identity) return null;
    let entry = roster.get(id);
    if (!entry) {
      entry = {
        id,
        name: identity.name || actorName || "Staff member",
        signedInAt: null,
        faceVerified: false,
        faceReset: false,
        checkout: 0,
        restock: 0,
        waste: 0,
      };
      roster.set(id, entry);
    }
    return entry;
  };

  const recordFaceState = (
    staffId: string,
    createdAt: string,
    kind: "verify" | "reset"
  ) => {
    const when = new Date(createdAt);
    const existing = latestFaceByStaff.get(staffId);
    if (!existing || when > existing.when) {
      latestFaceByStaff.set(staffId, { kind, when });
    }
  };

  for (const login of input.logins) {
    if (login.outcome !== "success" || !login.actor_id) continue;
    const entry = getEntry(login.actor_id, login.actor_name);
    if (!entry) continue;
    if (
      !entry.signedInAt ||
      new Date(login.created_at).getTime() < new Date(entry.signedInAt).getTime()
    ) {
      entry.signedInAt = login.created_at;
    }
    if (isFaceLogin(login)) recordFaceState(login.actor_id, login.created_at, "verify");
  }

  for (const verification of input.faceVerifications) {
    if (
      verification.outcome === "success" &&
      verification.details?.result === "matched" &&
      verification.actor_id
    ) {
      const entry = getEntry(verification.actor_id, verification.actor_name);
      if (entry) recordFaceState(verification.actor_id, verification.created_at, "verify");
    }
  }

  for (const reset of input.faceResetEvents) {
    if (reset.outcome === "success" && reset.entity_id) {
      const entry = getEntry(reset.entity_id, reset.actor_name);
      if (entry) recordFaceState(reset.entity_id, reset.created_at, "reset");
    }
  }

  // The latest face-state event for each signed-in staffer decides the badge.
  for (const [staffId, state] of latestFaceByStaff) {
    const entry = roster.get(staffId);
    if (!entry) continue;
    if (state.kind === "reset") {
      entry.faceVerified = false;
      entry.faceReset = true;
    } else {
      entry.faceVerified = true;
      entry.faceReset = false;
    }
  }

  for (const transaction of input.transactions) {
    if (!transaction.actor_id) continue;
    const entry = roster.get(transaction.actor_id);
    if (!entry) continue;
    if (transaction.type === "checkout") entry.checkout += 1;
    else if (transaction.type === "restock") entry.restock += 1;
    else if (transaction.type === "waste") entry.waste += 1;
  }

  return [...roster.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function cafeDayRange(now: Date): {
  day: string;
  start: string;
  end: string;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const day = `${values.year}-${values.month}-${values.day}`;
  const start = new Date(`${day}T00:00:00+08:00`).toISOString();
  const nextMidnightUtc =
    Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1) -
    8 * 60 * 60 * 1000;
  return { day, start, end: new Date(nextMidnightUtc).toISOString() };
}
