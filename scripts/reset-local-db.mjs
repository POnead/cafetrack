/** Deletes the local PGlite database so the next request recreates + re-seeds it. */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CAFETRACK_DB_DIR || join(process.cwd(), ".pglite");

if (!existsSync(dir)) {
  console.log(`Nothing to reset — ${dir} does not exist yet.`);
  process.exit(0);
}

rmSync(dir, { recursive: true, force: true });
console.log(
  `Removed ${dir}.\nIt will be recreated and seeded on the next request (npm run dev).`
);
