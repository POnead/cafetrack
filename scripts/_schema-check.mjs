/**
 * Proves db/schema.local.sql actually applies.
 *
 *   node scripts/_schema-check.mjs
 *
 * The most expensive mistake in this repo is editing db/schema.sql, forgetting to
 * run `npm run db:schema`, and only finding out when a route selects a column
 * local mode does not have. Both generators are silent about it — they write a
 * file, they do not check it — and the failure surfaces much later as a runtime
 * error rather than as a build failure.
 *
 * So this runs the generated file against a throwaway PGlite, twice, because a
 * real boot runs it on every start and the schema is written to be re-runnable.
 * It then reports what the tables, columns, seeds and constraints actually are,
 * so a change to db/schema.sql that does not survive the round trip into
 * db/schema.local.sql shows up here rather than in production.
 *
 * The throwaway database is removed afterwards. Nothing here touches ./.pglite.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, rmSync } from "node:fs";

const DIR = ".pglite-verify";
rmSync(DIR, { recursive: true, force: true });

const pg = new PGlite(DIR);
const schema = readFileSync("db/schema.local.sql", "utf8");

await pg.exec(schema);
console.log("first exec: OK");

await pg.exec(schema);
console.log("second exec: OK (idempotent, as every boot does)");

const tables = await pg.query(
  `select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('users','face_challenges','login_attempts')
    order by 1`
);
console.log("\ntables:", tables.rows.map((r) => r.table_name).join(", "));

const cols = await pg.query(
  `select column_name, data_type, column_default from information_schema.columns
    where table_name = 'users'
      and (column_name like 'face%' or column_name like 'last_face%')
    order by column_name`
);
console.log("\nusers.face* / last_face* columns:");
for (const r of cols.rows) {
  console.log(`   ${r.column_name.padEnd(24)} ${r.data_type.padEnd(26)} default=${r.column_default}`);
}

const seeds = await pg.query(
  `select key, value from settings where key like 'face%' order by key`
);
console.log("\nsettings seeds:");
for (const r of seeds.rows) console.log(`   ${r.key.padEnd(28)} = '${r.value}'`);

const rls = await pg.query(
  `select relname, relrowsecurity from pg_class
    where relname in ('users','face_challenges','login_attempts') order by 1`
);
console.log("\nrow level security:");
for (const r of rls.rows) console.log(`   ${r.relname.padEnd(18)} enabled=${r.relrowsecurity}`);

const unique = await pg.query(
  `select count(*)::int as n from pg_constraint
    where conrelid = 'face_challenges'::regclass and contype = 'u'`
);
console.log(`\nface_challenges unique constraints: ${unique.rows[0].n} (the phone looks a challenge up by code)`);

await pg.close();
rmSync(DIR, { recursive: true, force: true });
console.log("\ncleaned up");
