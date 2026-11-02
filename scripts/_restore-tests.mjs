import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = mkdtempSync(join(tmpdir(), "cafetrack-restore-test-"));
const restoreScript = join(dirname(fileURLToPath(import.meta.url)), "restore-local-db.mjs");

function restore(backup, target) {
  return spawnSync(process.execPath, [restoreScript, backup], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CAFETRACK_DB_DIR: target,
      CAFETRACK_BACKUP_DIR: join(root, "backups"),
    },
  });
}

async function open(path) {
  const pg = new PGlite(path);
  await pg.waitReady;
  return pg;
}

try {
  const source = join(root, "source");
  let pg = await open(source);
  await pg.exec("create table restore_probe (value text); insert into restore_probe values ('one'), ('two')");
  const archive = await pg.dumpDataDir("gzip");
  const expected = await pg.query("select count(*)::int as n from restore_probe");
  await pg.close();

  const automaticBackup = join(root, "backups", "cafetrack-auto-test");
  mkdirSync(automaticBackup, { recursive: true });
  writeFileSync(
    join(automaticBackup, "pgdata.tar.gz"),
    Buffer.from(await archive.arrayBuffer())
  );
  writeFileSync(
    join(automaticBackup, "manifest.json"),
    JSON.stringify({
      archive: "pgdata.tar.gz",
      tables: {
        restore_probe: Number(expected.rows[0].n),
        table_absent_at_backup: -1,
      },
    })
  );

  const automaticTarget = join(root, "automatic-target");
  const automaticResult = restore(automaticBackup, automaticTarget);
  assert.equal(automaticResult.status, 0, automaticResult.stderr || automaticResult.stdout);
  pg = await open(automaticTarget);
  const restored = await pg.query("select value from restore_probe order by value");
  assert.deepEqual(restored.rows, [{ value: "one" }, { value: "two" }]);
  await pg.close();
  console.log("PASS automatic tar backup restores and verifies before swap");

  const manualSource = join(root, "manual-source");
  pg = await open(manualSource);
  await pg.exec("create table manual_probe (value text); insert into manual_probe values ('backup')");
  await pg.close();

  const manualBackup = join(root, "backups", "cafetrack-manual-test");
  cpSync(manualSource, manualBackup, { recursive: true });
  writeFileSync(
    join(manualBackup, "manifest.json"),
    JSON.stringify({ tables: { manual_probe: 999 } })
  );

  const protectedTarget = join(root, "protected-target");
  pg = await open(protectedTarget);
  await pg.exec("create table protected_probe (value text); insert into protected_probe values ('keep')");
  await pg.close();

  const rejected = restore(manualBackup, protectedTarget);
  assert.notEqual(rejected.status, 0);
  pg = await open(protectedTarget);
  const unchanged = await pg.query("select value from protected_probe");
  assert.deepEqual(unchanged.rows, [{ value: "keep" }]);
  await pg.close();
  assert.equal(existsSync(join(protectedTarget, "manifest.json")), false);
  console.log("PASS invalid manual backup is rejected without changing the live database");
} finally {
  rmSync(root, { recursive: true, force: true });
}
