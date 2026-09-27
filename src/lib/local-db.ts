/**
 * Local, no-signup database mode.
 *
 * PGlite is PostgreSQL compiled to WebAssembly, so this is a real Postgres
 * (v18) with plpgsql, jsonb and the same functions db/schema.sql defines —
 * just running in-process and persisting to ./.pglite.
 *
 * The app's API routes were written against the supabase-js query builder, so
 * this module translates exactly the subset of that API they use:
 *
 *   from(t).select(str).eq(c,v).order(c,{ascending}).limit(n)   -> SELECT
 *   .single() / .maybeSingle()                                  -> row shaping
 *   from(t).insert(obj).select(str).single()                    -> INSERT .. RETURNING
 *   from(t).update(obj).eq(c,v).select(str).maybeSingle()       -> UPDATE .. RETURNING
 *   from(t).delete().eq(c,v)                                    -> DELETE
 *   rpc(name, params)                                           -> SELECT fn(..)
 *
 * Select strings may contain PostgREST-style embeds (`alias:table(cols)`);
 * the join paths for the four embeds the app uses live in RELATIONS below.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashPassword, newStaffToken } from "./auth";

type Row = Record<string, any>;

export type DbResult<T = any> = {
  data: T;
  error: { message: string } | null;
};

/* ------------------------------------------------------------------ */
/* Select-string parsing                                              */
/* ------------------------------------------------------------------ */

/** Splits on top-level commas only; double-quoted sections are opaque. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let escaped = false;
  let current = "";

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inQuotes) {
      if (ch === "\\") {
        current += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        current += ch;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  parts.push(current);
  return parts;
}

/** Undoes PostgREST value quoting ("a,b" -> a,b), resolving backslash escapes. */
function unquoteValue(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return v;
}

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * How to reach each embedded resource. PostgREST infers this from foreign
 * keys; here the four paths the app actually selects are declared explicitly.
 * For `many` relations localKey is on the parent and foreignKey on the child.
 */
const RELATIONS: Record<
  string,
  { table: string; localKey: string; foreignKey: string; many: boolean }
> = {
  "items.category": {
    table: "categories",
    localKey: "category_id",
    foreignKey: "id",
    many: false,
  },
  "items.location": {
    table: "locations",
    localKey: "location_id",
    foreignKey: "id",
    many: false,
  },
  "alerts.item": {
    table: "items",
    localKey: "item_id",
    foreignKey: "id",
    many: false,
  },
  "transactions.transaction_items": {
    table: "transaction_items",
    localKey: "id",
    foreignKey: "transaction_id",
    many: true,
  },
};

type Embed = { alias: string; table: string; cols: string[] };

function parseSelect(select: string): {
  star: boolean;
  plain: string[];
  embeds: Embed[];
} {
  const star = false;
  const plain: string[] = [];
  const embeds: Embed[] = [];
  let all = star;

  for (const raw of splitTopLevel(select)) {
    const part = raw.trim();
    if (!part) continue;

    if (part === "*") {
      all = true;
      continue;
    }

    const paren = part.indexOf("(");
    if (paren === -1) {
      plain.push(part);
      continue;
    }

    const head = part.slice(0, paren).trim();
    const inner = part.slice(paren + 1, part.lastIndexOf(")"));
    const [maybeAlias, maybeTable] = head.split(":");

    embeds.push({
      alias: (maybeTable ? maybeAlias : head).trim(),
      table: (maybeTable ?? head).trim(),
      cols: splitTopLevel(inner)
        .map((c) => c.trim())
        .filter(Boolean),
    });
  }

  return { star: all, plain, embeds };
}

/* ------------------------------------------------------------------ */
/* Connection + bootstrap                                             */
/* ------------------------------------------------------------------ */

const DB_DIR = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");

// Next.js re-evaluates modules on hot reload, so keep the instance on
// globalThis — otherwise dev mode would open the same database twice.
const holder: { pending: Promise<PGlite> | null } = ((
  globalThis as any
).__cafetrackLocalDb ??= { pending: null });

async function bootstrap(): Promise<PGlite> {
  const pg = new PGlite(DB_DIR);
  await pg.waitReady;

  // Idempotent: every statement is `create ... if not exists` or
  // `create or replace function`, so this is safe on every boot.
  await pg.exec(
    readFileSync(join(process.cwd(), "db", "schema.local.sql"), "utf8")
  );

  await seedIfEmpty(pg);

  console.log(`CafeTrack: local PGlite database ready at ${DB_DIR}`);
  return pg;
}

export function localDbReady(): Promise<PGlite> {
  if (!holder.pending) {
    const attempt = bootstrap();
    holder.pending = attempt;
    attempt.catch(() => {
      // Don't cache a rejected promise — let the next request try again.
      if (holder.pending === attempt) holder.pending = null;
    });
  }
  return holder.pending;
}

/* ------------------------------------------------------------------ */
/* First-run seed, so login works without any extra command           */
/* ------------------------------------------------------------------ */

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function seedIfEmpty(pg: PGlite) {
  const existing = await pg.query<{ n: number }>(
    `select count(*)::int as n from users`
  );
  if (Number(existing.rows[0]?.n ?? 0) > 0) return;

  const adminPw = process.env.SEED_ADMIN_PASSWORD || "admin123";
  const staffPw = process.env.SEED_STAFF_PASSWORD || "staff123";
  const barista1Token = newStaffToken();

  await pg.query(
    `insert into users (username, password_hash, full_name, role, qr_token)
     values ('admin',    $1, 'Cafe Owner',     'admin', null),
            ('barista1', $2, 'Juan Dela Cruz', 'staff', $3),
            ('barista2', $2, 'Maria Santos',   'staff', $4)`,
    [hashPassword(adminPw), hashPassword(staffPw), barista1Token, newStaffToken()]
  );

  await pg.exec(`
    insert into categories (name) values ('Coffee'),('Milk'),('Syrup'),('Powder'),('Tea'),('Bakery'),('Packaging')
      on conflict (name) do nothing;
    insert into locations (name) values ('Dry Storage'),('Chiller'),('Freezer'),('Bar Station')
      on conflict (name) do nothing;
  `);

  const seedItems: [string, string, string, string, string, number, number, string | null][] = [
    ["Arabica Coffee Beans", "Coffee", "Dry Storage", "solid", "kg", 12, 4, inDays(120)],
    ["Robusta Coffee Beans", "Coffee", "Dry Storage", "solid", "kg", 3, 5, inDays(90)],
    ["Fresh Milk", "Milk", "Chiller", "liquid", "L", 8, 6, inDays(4)],
    ["Condensed Milk", "Milk", "Dry Storage", "liquid", "can", 24, 10, inDays(200)],
    ["Vanilla Syrup", "Syrup", "Bar Station", "liquid", "bottle", 5, 3, inDays(300)],
    ["Caramel Syrup", "Syrup", "Bar Station", "liquid", "bottle", 1, 3, inDays(280)],
    ["Matcha Powder", "Powder", "Dry Storage", "powder", "kg", 2, 2, inDays(2)],
    ["Cocoa Powder", "Powder", "Dry Storage", "powder", "kg", 6, 3, inDays(150)],
    ["Black Tea Leaves", "Tea", "Dry Storage", "solid", "kg", 0, 2, inDays(60)],
    ["Croissant Dough", "Bakery", "Freezer", "solid", "pack", 15, 5, inDays(-1)],
    ["16oz Paper Cups", "Packaging", "Dry Storage", "solid", "pcs", 500, 100, null],
    ["Cup Lids", "Packaging", "Dry Storage", "solid", "pcs", 80, 100, null],
  ];

  for (const [name, cat, loc, form, unit, qty, low, exp] of seedItems) {
    await pg.query(
      `insert into items
         (sku, name, category_id, location_id, physical_form, unit,
          quantity, low_stock_threshold, expiration_date)
       values (
         'CT-' || upper(substr(regexp_replace($1, '[^A-Za-z]', '', 'g'), 1, 3))
                || '-' || upper(substr(md5(random()::text), 1, 4)),
         $1,
         (select id from categories where name = $2),
         (select id from locations where name = $3),
         $4, $5, $6, $7, $8
       )`,
      [name, cat, loc, form, unit, qty, low, exp]
    );
  }

  await pg.query(`select refresh_alerts()`);
  await pg.query(`select append_audit($1,$2,$3,$4,$5,$6::jsonb)`, [
    null,
    "system",
    "SEED",
    "system",
    null,
    JSON.stringify({
      note: "Local PGlite seed",
      users: 3,
      items: seedItems.length,
    }),
  ]);

  console.log("CafeTrack: seeded the local database");
  console.log(`    admin    / ${adminPw}   (username + password)`);
  console.log(`    barista1 / ${staffPw}   (barcode code + password)`);
  console.log(`    barista1 barcode code: ${barista1Token}`);
}

/* ------------------------------------------------------------------ */
/* Query builder                                                      */
/* ------------------------------------------------------------------ */

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "or"; clauses: { column: string; op: string; value: string }[] };

type Mode = "select" | "insert" | "update" | "delete";

const OPS: Record<string, string> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  like: "like",
  ilike: "ilike",
};

class LocalQuery implements PromiseLike<DbResult> {
  private mode: Mode = "select";
  private selectStr: string | null = null;
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orders: string[] = [];
  private limitCount: number | null = null;
  private shape: "many" | "single" | "maybe" = "many";
  private run: Promise<DbResult> | null = null;

  constructor(private table: string) {}

  /* ---- chainable surface ---- */

  select(columns = "*") {
    this.selectStr = columns;
    return this;
  }

  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }

  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  /** Supports the PostgREST form `col.op.value,col.op.value` (treated as OR). */
  or(expression: string) {
    const clauses = splitTopLevel(expression).map((raw) => {
      const [column, op = "eq", ...rest] = raw.trim().split(".");
      return {
        column: column.trim(),
        op: OPS[op] ?? "=",
        value: unquoteValue(rest.join(".")),
      };
    });
    this.filters.push({ kind: "or", clauses });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push(
      `${quoteId(column)} ${options?.ascending === false ? "desc" : "asc"}`
    );
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.shape = "single";
    return this;
  }

  maybeSingle() {
    this.shape = "maybe";
    return this;
  }

  /* ---- execution ---- */

  then<T = DbResult, E = never>(
    onFulfilled?: ((value: DbResult) => T | PromiseLike<T>) | null,
    onRejected?: ((reason: unknown) => E | PromiseLike<E>) | null
  ): PromiseLike<T | E> {
    if (!this.run) this.run = this.execute();
    return this.run.then(onFulfilled, onRejected) as PromiseLike<T | E>;
  }

  private async execute(): Promise<DbResult> {
    try {
      const pg = await localDbReady();
      const { text, values } = this.build();
      const result = await pg.query(text, values);
      return this.shapeRows(result.rows as Row[]);
    } catch (e: any) {
      // Match supabase-js: query failures come back as { error }, not throws.
      return { data: null, error: { message: e?.message || String(e) } };
    }
  }

  private shapeRows(rows: Row[]): DbResult {
    // Insert/update/delete with no .select() return no body, like PostgREST.
    if (this.mode !== "select" && this.selectStr === null) {
      return { data: null, error: null };
    }

    if (this.shape === "single") {
      if (rows.length !== 1) {
        return {
          data: null,
          error: {
            message: "JSON object requested, multiple (or no) rows returned",
          },
        };
      }
      return { data: rows[0], error: null };
    }

    if (this.shape === "maybe") {
      if (rows.length > 1) {
        return { data: null, error: { message: "Multiple rows returned" } };
      }
      return { data: rows[0] ?? null, error: null };
    }

    return { data: rows, error: null };
  }

  /* ---- SQL generation ---- */

  private build(): { text: string; values: unknown[] } {
    if (this.mode === "insert") return this.buildInsert();
    if (this.mode === "update") return this.buildUpdate();
    if (this.mode === "delete") return this.buildDelete();
    return this.buildSelect();
  }

  private buildSelect() {
    const alias = "t";
    const { star, plain, embeds } = parseSelect(this.selectStr ?? "*");
    const cols: string[] = [];

    if (star) cols.push(`${alias}.*`);
    for (const column of plain) cols.push(`${alias}.${quoteId(column)}`);

    for (const embed of embeds) {
      const key = `${this.table}.${embed.alias}`;
      const relation =
        RELATIONS[key] ?? RELATIONS[`${this.table}.${embed.table}`];
      if (!relation) {
        throw new Error(`local-db: no relation mapped for ${key}`);
      }

      const object = `json_build_object(${embed.cols
        .map((c) => `'${c}', s.${quoteId(c)}`)
        .join(", ")})`;
      const join = `s.${quoteId(relation.foreignKey)} = ${alias}.${quoteId(
        relation.localKey
      )}`;

      cols.push(
        relation.many
          ? `(select coalesce(json_agg(${object}), '[]'::json) from ${relation.table} s where ${join}) as ${quoteId(embed.alias)}`
          : `(select ${object} from ${relation.table} s where ${join}) as ${quoteId(embed.alias)}`
      );
    }

    if (cols.length === 0) cols.push(`${alias}.*`);

    const where = this.buildWhere(alias, 0);
    let text = `select ${cols.join(", ")} from ${this.table} ${alias}${where.sql}`;

    if (this.orders.length) text += ` order by ${this.orders.join(", ")}`;
    if (this.limitCount !== null) {
      text += ` limit ${Math.max(0, Math.floor(this.limitCount))}`;
    }

    return { text, values: where.values };
  }

  private buildInsert() {
    const rows = Array.isArray(this.payload)
      ? this.payload
      : [this.payload as Row];
    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];

    const values: unknown[] = [];
    const tuples = rows.map(
      (row) =>
        `(${columns
          .map((column) => {
            values.push(row[column] ?? null);
            return `$${values.length}`;
          })
          .join(", ")})`
    );

    let text = `insert into ${this.table} (${columns
      .map(quoteId)
      .join(", ")}) values ${tuples.join(", ")}`;

    const returning = this.returningList();
    if (returning) text += ` returning ${returning}`;

    return { text, values };
  }

  private buildUpdate() {
    const patch = this.payload as Row;
    if (this.filters.length === 0) {
      throw new Error("local-db: refusing an unfiltered update");
    }

    const values: unknown[] = [];
    const sets = Object.keys(patch).map((column) => {
      values.push(patch[column] ?? null);
      return `${quoteId(column)} = $${values.length}`;
    });

    const where = this.buildWhere("t", values.length);
    let text = `update ${this.table} as t set ${sets.join(", ")}${where.sql}`;

    const returning = this.returningList();
    if (returning) text += ` returning ${returning}`;

    return { text, values: [...values, ...where.values] };
  }

  private buildDelete() {
    if (this.filters.length === 0) {
      throw new Error("local-db: refusing an unfiltered delete");
    }

    const where = this.buildWhere("t", 0);
    let text = `delete from ${this.table} as t${where.sql}`;

    const returning = this.returningList();
    if (returning) text += ` returning ${returning}`;

    return { text, values: where.values };
  }

  private buildWhere(alias: string, offset: number) {
    const values: unknown[] = [];

    const parts = this.filters.map((filter) => {
      if (filter.kind === "eq") {
        if (filter.value === null) {
          return `${alias}.${quoteId(filter.column)} is null`;
        }
        values.push(filter.value);
        return `${alias}.${quoteId(filter.column)} = $${offset + values.length}`;
      }

      const clauses = filter.clauses.map((clause) => {
        values.push(clause.value);
        return `${alias}.${quoteId(clause.column)} ${clause.op} $${
          offset + values.length
        }`;
      });
      return `(${clauses.join(" or ")})`;
    });

    return {
      sql: parts.length ? ` where ${parts.join(" and ")}` : "",
      values,
    };
  }

  private returningList(): string | null {
    if (this.selectStr === null) return null;
    const { star, plain } = parseSelect(this.selectStr);
    if (star || plain.length === 0) return "*";
    return plain.map(quoteId).join(", ");
  }
}

/* ------------------------------------------------------------------ */
/* rpc() — the four Postgres functions the app calls                  */
/* ------------------------------------------------------------------ */

const RPC: Record<
  string,
  { sql: string; args: (params: Row) => unknown[]; list?: boolean }
> = {
  append_audit: {
    sql: `select to_jsonb(x) as out from append_audit($1,$2,$3,$4,$5,$6::jsonb) as x`,
    args: (p) => [
      p.p_actor_id ?? null,
      p.p_actor_name ?? "anonymous",
      p.p_action,
      p.p_entity_type ?? null,
      p.p_entity_id ?? null,
      JSON.stringify(p.p_details ?? {}),
    ],
  },
  process_transaction: {
    sql: `select process_transaction($1,$2,$3,$4::jsonb,$5) as out`,
    args: (p) => [
      p.p_type,
      p.p_actor_id ?? null,
      p.p_actor_name,
      JSON.stringify(p.p_items ?? []),
      p.p_note ?? null,
    ],
  },
  refresh_alerts: { sql: `select refresh_alerts() as out`, args: () => [] },
  verify_audit_chain: {
    sql: `select * from verify_audit_chain()`,
    args: () => [],
    list: true,
  },
};

function rpcCall(name: string, params: Row): PromiseLike<DbResult> {
  let run: Promise<DbResult> | null = null;

  const start = async (): Promise<DbResult> => {
    const spec = RPC[name];
    if (!spec) {
      return {
        data: null,
        error: { message: `local-db: unknown function ${name}` },
      };
    }

    try {
      const pg = await localDbReady();
      const rows = (await pg.query(spec.sql, spec.args(params))).rows as Row[];
      return { data: spec.list ? rows : rows[0]?.out ?? null, error: null };
    } catch (e: any) {
      // raise exception from plpgsql (e.g. insufficient stock) arrives here.
      return { data: null, error: { message: e?.message || String(e) } };
    }
  };

  return {
    then: (onFulfilled: any, onRejected: any) =>
      (run ??= start()).then(onFulfilled, onRejected),
  } as PromiseLike<DbResult>;
}

/* ------------------------------------------------------------------ */
/* Facade consumed by src/lib/supabase.ts                             */
/* ------------------------------------------------------------------ */

export type LocalDbFacade = {
  from: (table: string) => LocalQuery;
  rpc: (name: string, params?: Row) => PromiseLike<DbResult>;
};

export function localDb(): LocalDbFacade {
  return {
    from: (table: string) => new LocalQuery(table),
    rpc: (name: string, params: Row = {}) => rpcCall(name, params),
  };
}
