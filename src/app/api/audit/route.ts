import { db } from "@/lib/supabase";
import { handler, ok, fail, dbFail } from "@/lib/api";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuditRow = Record<string, unknown> & {
  action?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  details?: Record<string, unknown> | null;
};

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function textFromDetails(
  details: Record<string, unknown> | null | undefined,
  keys: readonly string[]
): string | null {
  if (!details) return null;
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 160);
    }
  }
  return null;
}

/**
 * A readable label for a transaction entry.
 *
 * The movement itself is the entity, and its id is a UUID: useful as a
 * reference, useless to an owner reading the audit trail. The item names in
 * `details.items` are the thing a person actually recognises, so the label is
 * built from those. Without this, every checkout and restock shows the same
 * "transaction" plus an opaque id.
 */
function transactionLabel(entry: AuditRow): string {
  const details = entry.details ?? {};
  const items = Array.isArray(details.items) ? details.items : [];
  const names = items
    .map((line) => {
      if (typeof line !== "object" || line === null) return null;
      const record = line as Record<string, unknown>;
      for (const key of ["name", "item_name", "sku"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return null;
    })
    .filter((name): name is string => Boolean(name));

  const action = entry.action ?? "";
  const verb = action.startsWith("STOCK_RESTOCK")
    ? "Restock"
    : action.startsWith("WASTE_LOG")
      ? "Waste log"
      : action.startsWith("STOCK_CHECKOUT")
        ? "Checkout"
        : "Stock movement";

  if (names.length === 0) return verb;
  const shown = names.slice(0, 3).join(", ");
  return `${verb}: ${shown}${names.length > 3 ? ` +${names.length - 3} more` : ""}`;
}

/**
 * Hash-chained audit trail, newest first.
 *
 * Every entry is stored with the id of the record it touched, not the record's
 * name. A name can change (a staff member is renamed, an item is relabelled)
 * or disappear (an account is deleted), so the id is what belongs in the
 * permanent log. The API resolves those ids to names for the reading, and
 * falls back to the name captured in `details` for records that no longer
 * exist. The UI must never present a bare UUID as the answer to "what
 * happened": that is a reference for an engineer, not an audit trail for an
 * owner.
 */
export const GET = handler(async (req: Request) => {
  await requireAdmin();

  const { searchParams } = new URL(req.url);
  const requested = Number(searchParams.get("limit") ?? 100);
  const limit = Math.min(
    Math.max(Number.isFinite(requested) ? requested : 100, 1),
    500
  );

  // Paging (NFR-05). `audit_log` is append-only and grows forever, so offset
  // paging over the whole table would mean an ever-growing OFFSET scan and a
  // table that eventually refuses to answer. `before` is the seq to start below,
  // which is stable: the chain only ever appends, so a row that has a seq now
  // still has it later, and a page fetched twice returns the same rows.
  //
  // The previous page's `before` is simply the seq of its oldest entry, so the
  // client needs no page numbers — which is also why the UI says "newest 200 of
  // 1,940" rather than pretending it is showing page 1 of 10.
  const beforeRaw = searchParams.get("before");
  const before = Number(beforeRaw);
  // `>= 0` rather than `> 0`: a `before` of 0 is a legitimate request for the
  // rows before the first sequence number, and the honest answer to it is an
  // empty page. Treating it as absent would silently hand back the newest page
  // instead, which looks like the request was ignored.
  const hasBefore =
    beforeRaw !== null && Number.isSafeInteger(before) && before >= 0;

  let query = db()
    .from("audit_log")
    .select(
      // ip_address and outcome are written by lib/audit.ts but were never
      // selected here, so they were stored and then invisible — an ERD column
      // nobody can read is not a feature.
      "seq, actor_id, actor_name, action, entity_type, entity_id, details, ip_address, outcome, created_at"
    )
    .order("seq", { ascending: false })
    .limit(limit + 1);

  if (hasBefore) query = query.lt("seq", before);

  // Two queries in parallel: the newest page of rows, and the total number of
  // rows in the table. The total is what lets the UI say "200 of 388" instead
  // of silently showing a window whose first row looks like a random start.
  const [page, count] = await Promise.all([
    query,
    db()
      .from("audit_log")
      .select("seq", { count: "exact", head: true }),
  ]);

  if (page.error) return dbFail(page.error, { context: "audit page" });
  if (count.error) return dbFail(count.error, { context: "audit count" });

  const rows = (page.data ?? []) as AuditRow[];

  // One row over the limit is fetched so this can say "there is another page"
  // without a second count query — the UI needs that answer to decide whether
  // to offer "load older".
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;

  /*
   * Resolve the ids on this page in a handful of batched lookups rather than
   * one query per row. The audit log stores ids; the reader wants names. Doing
   * that at read time keeps the log immutable (a rename does not rewrite
   * history) while still making today's entry for a renamed item readable.
   */
  const entityIds = (type: string) => [
    ...new Set(
      entries
        .filter(
          (entry) =>
            entry.entity_type === type &&
            typeof entry.entity_id === "string" &&
            UUID_RE.test(entry.entity_id)
        )
        .map((entry) => entry.entity_id as string)
    ),
  ];

  const usersById = new Map<string, { name: string; username: string | null }>();
  const itemsById = new Map<string, { name: string; sku: string | null }>();
  const categoriesById = new Map<string, string>();
  const locationsById = new Map<string, string>();
  const suppliersById = new Map<string, string>();
  const recipientsById = new Map<string, string>();

  const load = async (
    ids: string[],
    table: string,
    columns: string,
    apply: (row: Record<string, unknown>) => void
  ) => {
    if (ids.length === 0) return;
    const { data, error } = await db().from(table).select(columns).in("id", ids);
    if (error) {
      // A lookup failure must not take the whole trail down. The entry still
      // has its type and details; only the friendly name is missing.
      console.error(`audit entity lookup failed for ${table}:`, error.message);
      return;
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) apply(row);
  };

  await Promise.all([
    load(entityIds("user"), "users", "id, full_name, username", (row) => {
      const id = String(row.id);
      const fullName =
        typeof row.full_name === "string" ? row.full_name.trim() : "";
      const username = typeof row.username === "string" ? row.username : null;
      usersById.set(id, {
        name: fullName || username || "Unnamed account",
        username,
      });
    }),
    load(entityIds("item"), "items", "id, name, sku", (row) => {
      const id = String(row.id);
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const sku = typeof row.sku === "string" ? row.sku : null;
      itemsById.set(id, { name: name || sku || "Unnamed item", sku });
    }),
    load(entityIds("category"), "categories", "id, name", (row) => {
      if (typeof row.name === "string") {
        categoriesById.set(String(row.id), row.name.trim());
      }
    }),
    load(entityIds("location"), "locations", "id, name", (row) => {
      if (typeof row.name === "string") {
        locationsById.set(String(row.id), row.name.trim());
      }
    }),
    load(entityIds("supplier"), "suppliers", "id, name", (row) => {
      if (typeof row.name === "string") {
        suppliersById.set(String(row.id), row.name.trim());
      }
    }),
    load(
      entityIds("email_recipient"),
      "email_recipients",
      "id, email_address",
      (row) => {
        if (typeof row.email_address === "string") {
          recipientsById.set(String(row.id), row.email_address.trim());
        }
      }
    ),
  ]);

  const resolveEntity = (
    entry: AuditRow
  ): { name: string; username: string | null } | null => {
    const id = typeof entry.entity_id === "string" ? entry.entity_id : null;
    const details = entry.details ?? null;

    switch (entry.entity_type) {
      case "user": {
        const user = id ? usersById.get(id) : undefined;
        const historicalName = textFromDetails(details, [
          "full_name",
          "requester_name",
          "user_name",
          "display_name",
        ]);
        const username =
          user?.username ??
          textFromDetails(details, ["username", "requester_username"]);

        if (user) return { name: user.name, username: user.username };
        if (historicalName) return { name: historicalName, username };
        if (username) return { name: `@${username}`, username };
        return { name: "Deleted user account", username: null };
      }

      case "item": {
        const item = id ? itemsById.get(id) : undefined;
        if (item) return { name: item.name, username: null };

        const name = textFromDetails(details, ["item_name", "name"]);
        const sku = textFromDetails(details, ["sku"]);
        if (name && sku) return { name: `${name} (${sku})`, username: null };
        return {
          name: name ?? sku ?? "Deleted inventory item",
          username: null,
        };
      }

      case "category":
        return {
          name:
            (id ? categoriesById.get(id) : null) ??
            textFromDetails(details, ["name"]) ??
            "Deleted category",
          username: null,
        };

      case "location":
        return {
          name:
            (id ? locationsById.get(id) : null) ??
            textFromDetails(details, ["name"]) ??
            "Deleted location",
          username: null,
        };

      case "supplier":
        return {
          name:
            (id ? suppliersById.get(id) : null) ??
            textFromDetails(details, ["name"]) ??
            "Deleted supplier",
          username: null,
        };

      case "email_recipient":
        return {
          name:
            (id ? recipientsById.get(id) : null) ??
            textFromDetails(details, ["email_address", "email"]) ??
            "Removed email recipient",
          username: null,
        };

      case "alert": {
        const message = textFromDetails(details, ["message"]);
        const type = textFromDetails(details, ["type"]);
        return {
          name:
            message ??
            (type ? `${humanize(type)} alert` : "Stock alert"),
          username: null,
        };
      }

      case "transaction":
        return { name: transactionLabel(entry), username: null };

      case "staff_position":
        return {
          name:
            textFromDetails(details, [
              "position",
              "previous_position",
              "name",
              "from",
            ]) ?? "Staff position",
          username: null,
        };

      case "settings":
        return {
          name:
            entry.action === "EMAIL_SMTP_SAVE" ||
            entry.action === "EMAIL_SMTP_CLEAR"
              ? "Email settings"
              : "System settings",
          username: null,
        };

      case "report":
        return { name: "Stock report", username: null };

      case "system":
        return { name: "System", username: null };

      default:
        return entry.entity_type
          ? { name: humanize(entry.entity_type), username: null }
          : null;
    }
  };

  return ok({
    entries: entries.map((entry) => {
      const entity = resolveEntity(entry);
      if (!entity) return entry;

      return {
        ...entry,
        entity_name: entity.name,
        entity_username: entity.username,
      };
    }),
    total: count.count ?? 0,
    has_more: hasMore,
    // The seq to send back as `before`. Null on the last page.
    next_before: hasMore ? entries[entries.length - 1]?.seq ?? null : null,
  });
});
