import { db } from "@/lib/supabase";
import { handler, ok, fail } from "@/lib/api";
import { requireUser, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const TYPES = ["checkout", "restock", "waste"] as const;
type TxnType = (typeof TYPES)[number];

const AUDIT_ACTION: Record<TxnType, string> = {
  checkout: "STOCK_CHECKOUT",
  restock: "STOCK_RESTOCK",
  waste: "WASTE_LOG",
};

/* ---------------- history ---------------- */
export const GET = handler(async (req: Request) => {
  await requireUser();

  const { searchParams } = new URL(req.url);
  const requested = Number(searchParams.get("limit") ?? 50);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 50, 1),
    500
  );
  const type = searchParams.get("type");

  let query = db()
    .from("transactions")
    .select(
      `id, type, actor_id, actor_name, note, created_at,
       transaction_items(id, sku, item_name, quantity, qty_before, qty_after)`
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (type) query = query.eq("type", type);

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  return ok({ transactions: data ?? [] });
});

/* ---------------- commit a movement ---------------- */
export const POST = handler(async (req: Request) => {
  const session = await requireUser();
  const body = await req.json();

  const type = String(body.type ?? "") as TxnType;
  if (!TYPES.includes(type)) return fail("Invalid transaction type");

  const lines: unknown[] = Array.isArray(body.items) ? body.items : [];
  const items = lines
    .map((l) => {
      const line = (l ?? {}) as { sku?: unknown; qty?: unknown };
      return { sku: String(line.sku ?? "").trim(), qty: Number(line.qty) };
    })
    .filter(
      (l: { sku: string; qty: number }) =>
        l.sku.length > 0 && Number.isFinite(l.qty) && l.qty > 0
    );

  if (items.length === 0) return fail("Add at least one item before committing");

  // Every movement is password-confirmed, so a terminal left unattended
  // can't silently write stock off.
  const password = String(body.password ?? "");
  if (!password) return fail("Enter your password to confirm");

  const { data: me, error: meErr } = await db()
    .from("users")
    .select("password_hash, is_active")
    .eq("id", session.id)
    .maybeSingle();

  if (meErr) return fail(meErr.message, 500);
  if (!me || !me.is_active) return fail("This account is inactive", 403);

  if (!verifyPassword(password, me.password_hash)) {
    await audit(session, `${AUDIT_ACTION[type]}_DENIED`, "transaction", null, {
      reason: "bad_password",
      lines: items.length,
    });
    return fail("Incorrect password", 401);
  }

  const { data, error } = await db().rpc("process_transaction", {
    p_type: type,
    p_actor_id: session.id,
    p_actor_name: session.fullName,
    p_items: items,
    p_note: body.note ? String(body.note).slice(0, 500) : null,
  });

  // process_transaction raises readable exceptions for short stock and
  // concurrent edits — surface those as conflicts, not server errors.
  if (error) return fail(error.message.replace(/^P0001:\s*/, ""), 409);

  await audit(
    session,
    AUDIT_ACTION[type],
    "transaction",
    data?.transaction_id ?? null,
    { note: body.note ?? null, items: data?.items ?? items }
  );

  await db().rpc("refresh_alerts");

  return ok({ result: data }, 201);
});
