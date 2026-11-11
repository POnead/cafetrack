import { db } from "@/lib/supabase";
import { handler, fail, ok, dbFail } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import {
  buildDutyRoster,
  cafeDayRange,
  countDutyActivity,
  type DutyAuditEvent,
  type DutyTransaction,
} from "@/lib/duty-roster";

export const runtime = "nodejs";

const PAGE_SIZE = 500;
const MAX_ROWS = 10_000;

async function readTodayRows<T>(
  table: string,
  columns: string,
  start: string,
  end: string,
  action?: string,
  actorId?: string
): Promise<{ rows: T[] | null; error: { message: string } | null }> {
  const rows: T[] = [];
  while (rows.length < MAX_ROWS) {
    let query = db()
      .from(table)
      .select(columns)
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: true })
      .range(rows.length, Math.min(rows.length + PAGE_SIZE, MAX_ROWS) - 1);
    if (action) query = query.eq("action", action);
    if (actorId) query = query.eq("actor_id", actorId);

    const result = await query;
    if (result.error) return { rows: null, error: result.error };
    const page = (result.data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return { rows, error: null };
}

export const GET = handler(async () => {
  const session = await requireUser();
  const { day, start, end } = cafeDayRange(new Date());
  if (session.role !== "admin") {
    const result = await readTodayRows<DutyTransaction>(
      "transactions",
      "actor_id, type",
      start,
      end,
      undefined,
      session.id
    );
    if (result.error) return dbFail(result.error, { context: "duty read" });
    if (result.rows?.length === MAX_ROWS) {
      return fail("Today's staff activity exceeds the dashboard display limit.", 503);
    }
    return ok({
      visible: false,
      day,
      activity: countDutyActivity(result.rows ?? []),
    });
  }

  const [staffResult, loginResult, verificationResult, resetResult, transactionResult] =
    await Promise.all([
      db()
        .from("users")
        .select("id, full_name, username")
        .eq("role", "staff"),
      readTodayRows<DutyAuditEvent>(
        "audit_log",
        "actor_id, actor_name, action, details, outcome, created_at",
        start,
        end,
        "LOGIN"
      ),
      readTodayRows<DutyAuditEvent>(
        "audit_log",
        "actor_id, actor_name, action, details, outcome, created_at",
        start,
        end,
        "FACE_VERIFY"
      ),
      readTodayRows<DutyAuditEvent>(
        "audit_log",
        "actor_id, actor_name, entity_id, action, details, outcome, created_at",
        start,
        end,
        "FACE_VERIFY_RESET"
      ),
      readTodayRows<DutyTransaction>(
        "transactions",
        "actor_id, type",
        start,
        end
      ),
    ]);

  const error =
    staffResult.error ??
    loginResult.error ??
    verificationResult.error ??
    resetResult.error ??
    transactionResult.error;
  if (error) return dbFail(error);
  if (
    loginResult.rows?.length === MAX_ROWS ||
    verificationResult.rows?.length === MAX_ROWS ||
    resetResult.rows?.length === MAX_ROWS ||
    transactionResult.rows?.length === MAX_ROWS
  ) {
    return fail("Today's staff activity exceeds the dashboard display limit.", 503);
  }

  const staff = (staffResult.data ?? []).map(
    (row: { id: string; full_name: string | null; username: string }) => ({
      id: row.id,
      name: row.full_name?.trim() || row.username,
    })
  );

  return ok({
    visible: true,
    day,
    staff: buildDutyRoster({
      staff,
      logins: loginResult.rows ?? [],
      faceVerifications: verificationResult.rows ?? [],
      faceResetEvents: resetResult.rows ?? [],
      transactions: transactionResult.rows ?? [],
    }),
  });
});
