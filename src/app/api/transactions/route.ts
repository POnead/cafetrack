import { db } from "@/lib/supabase";
import { handler, ok, fail, readBody, clientIp } from "@/lib/api";
import { requireUser, verifyPassword } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { dispatchSoon } from "@/lib/email";
import { FieldError, parseExpiryDate, parseBoxCount } from "@/lib/item-validation";
import { eventBus, Events } from "@/lib/events";
import { requireDutyVerified } from "@/lib/face-gate";

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
  const offsetValue = searchParams.get("offset") ?? "0";
  const offset = Number(offsetValue);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > Number.MAX_SAFE_INTEGER - limit + 1
  ) {
    return fail("Offset must be a non-negative whole number");
  }
  const type = searchParams.get("type");

  // Date range. The spec asks for reports "filtered by date range", so `from`
  // and `to` bound created_at. `to` is inclusive: a date-only value covers the
  // whole of that day, which is what a person picking "up to 27 Sep" means.
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const staff = searchParams.get("staff");

  // A malformed date is ignored rather than passed to Postgres, where it would
  // surface as a 500 from what is really a bad request.
  const isoDay = (v: string | null) =>
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

  let query = db()
    .from("transactions")
    .select(
      `id, type, actor_id, actor_name, note, created_at,
       transaction_items(id, sku, item_name, quantity, qty_before, qty_after, expiration_date)`
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (type) query = query.eq("type", type);

  const fromDay = isoDay(from);
  if (fromDay) query = query.gte("created_at", `${fromDay}T00:00:00.000Z`);

  const toDay = isoDay(to);
  if (toDay) query = query.lte("created_at", `${toDay}T23:59:59.999Z`);

  // `actor_id` is the uuid; `actor_name` is what the UI shows, so accept a name.
  if (staff) {
    if (/^[0-9a-f-]{36}$/i.test(staff)) query = query.eq("actor_id", staff);
    else query = query.eq("actor_name", staff);
  }

  const { data, error } = await query;
  if (error) return fail(error.message, 500);

  return ok({ transactions: data ?? [] });
});

/* ---------------- commit a movement ---------------- */
export const POST = handler(async (req: Request) => {
  const session = await requireUser();

  // The duty check is enforced here, not only on the screen that asks for it.
  // A redirect in the browser is a convenience; this is the route that actually
  // moves stock, so a staff member inside the app but outside a duty window is
  // refused with a 403 whatever they call it from. Admins and staff with no
  // reference photo are never gated — see verificationRequired.
  await requireDutyVerified(session);

  const body = await readBody(req);

  const type = String(body.type ?? "") as TxnType;
  if (!TYPES.includes(type)) return fail("Invalid transaction type");

  const lines: unknown[] = Array.isArray(body.items) ? body.items : [];

  // A malformed date is a bad request, not a server fault, so it is answered
  // as a 400 here — the same rule and the same wording that POST /api/items
  // applies, rather than letting Postgres throw on it as a 409. A line with no
  // date is left alone: the item keeps the expiry it already had.
  let items: { sku: string; qty: number; exp: string | null; boxes: number | null }[];
  try {
    items = lines
      .map((l) => {
        const line = (l ?? {}) as {
          sku?: unknown;
          qty?: unknown;
          exp?: unknown;
          boxes?: unknown;
        };
        return {
          sku: String(line.sku ?? "").trim(),
          qty: Number(line.qty),
          exp: parseExpiryDate(line.exp),
          // `boxes` is an alternative to `qty` for a restock, not an addition to
          // it — the database converts it using the item's own units_per_box, so
          // the two are never both used. A blank or absent value means "not by
          // the box" and is sent as null rather than 0, which would be rejected.
          boxes: parseBoxCount(line.boxes),
        };
      })
      .filter(
        (l: { sku: string; qty: number; boxes: number | null }) =>
          l.sku.length > 0 &&
          ((Number.isFinite(l.qty) && l.qty > 0) || l.boxes !== null)
      );
  } catch (err) {
    if (err instanceof FieldError) return fail(err.message, 400);
    throw err;
  }

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
    await audit(
      session,
      `${AUDIT_ACTION[type]}_DENIED`,
      "transaction",
      null,
      {
        reason: "bad_password",
        lines: items.length,
      },
      { ip: clientIp(req), outcome: "denied" }
    );
    return fail("Incorrect password", 401);
  }

  /*
   * Which supplier delivered this restock.
   *
   * Optional, because a delivery can arrive without anyone recording who sent
   * it, but when given it is written back to every restocked item as its
   * `supplier_id`. That is what turns the field into "the supplier named on the
   * most recent restock that named one" rather than a field somebody has to
   * remember to update by hand - and it is what the low-stock alert reads when it
   * tells the owner who to call. Leaving it blank keeps the previous link: a
   * delivery with no name is not evidence that the old supplier stopped
   * supplying.
   *
   * Only a restock has a supplier. A checkout or a waste log is stock leaving,
   * and silently rewriting the supplier from either would turn the field into
   * "whoever touched it last".
   */
  const supplierId =
    type === "restock" ? String(body.supplier_id ?? "").trim() || null : null;

  if (supplierId) {
    const { data: supplier } = await db()
      .from("suppliers")
      .select("id")
      .eq("id", supplierId)
      .maybeSingle();
    if (!supplier) return fail("That supplier no longer exists");
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

  /*
   * Link the items to the supplier they were just received from.
   *
   * After the movement, not before: if process_transaction rejects the restock
   * (short stock, a stale expiry, a concurrent edit) then nothing was received
   * and the supplier should not change either. The movement is already committed
   * by this point, so a failed link is logged rather than turned into a 500 that
   * would suggest the stock was not added.
   */
  if (type === "restock" && supplierId) {
    const restocked = (data?.items ?? items) as { sku?: string }[];
    const skus = [
      ...new Set(restocked.map((line) => line.sku).filter(Boolean)),
    ] as string[];

    if (skus.length > 0) {
      const { error: linkError } = await db()
        .from("items")
        .update({ supplier_id: supplierId })
        .in("sku", skus);

      if (linkError) {
        console.error(
          "could not record the restock supplier on items:",
          linkError.message
        );
      }
    }
  }

  await audit(
    session,
    AUDIT_ACTION[type],
    "transaction",
    data?.transaction_id ?? null,
    {
      note: body.note ?? null,
      supplier_id: supplierId,
      items: data?.items ?? items,
    },
    { ip: clientIp(req), outcome: "success" }
  );

  // Fire-and-forget: emit real-time event so connected clients update instantly.
  // We don't await this — a slow connection must not hold up the till.
  eventBus.emit(Events.STOCK_CHANGED, {
    type,
    transaction_id: data?.transaction_id ?? null,
    actor_name: session.fullName,
  });

  // refresh_alerts queues the emails this movement may have caused (an item
  // crossing its threshold, or a new batch arriving close to its date). Dispatch
  // is fired without awaiting so a slow mail server cannot hold up the till.
  await db().rpc("refresh_alerts");
  // Stock moved, so the item list is out of date as well as the movements and the
  // alerts — three separate pages that each hold their own copy of these numbers.
  eventBus.emit(Events.ITEMS_CHANGED, {
    action: type,
    skus: (data?.items ?? []).map((line: any) => line.sku),
  });

  // The alert pass has just run, so anything it opened or escalated is current.
  eventBus.emit(Events.ALERTS_CHANGED, { type: "new", count: 0 });

  dispatchSoon();

  return ok({ result: data }, 201);
});
