/**
 * Seed and restore a large catalogue in the ISOLATED test database.
 *
 *   node scripts/_stress-seed.mjs create   → creates STRESS-VERIFY items
 *   node scripts/_stress-seed.mjs cleanup  → deletes them again
 *
 * Only ever pointed at the isolated test server. Not part of any suite.
 */
import { assertTestTarget } from "./_guard.mjs";
const BASE = process.env.BASE_URL || "http://localhost:3101";
const ADMIN = { username: "admin", password: process.env.SEED_ADMIN_PASSWORD || "admin123" };

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie[0].split(";")[0];
  const contentType = res.headers.get("content-type") || "";
  return { status: res.status, data: contentType.includes("json") ? await res.json() : null };
}

const COUNT = Number(process.env.STRESS_COUNT || 510);

async function login() {
  const res = await call("POST", "/api/auth/login", ADMIN);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
}

async function main() {
  await assertTestTarget(BASE);
  const mode = process.argv[2] || "create";
  await login();

  if (mode === "create") {
    const created = [];
    for (let i = 1; i <= COUNT; i += 1) {
      const stock = i % 17 === 0 ? 0 : i % 23 === 0 ? 3 : 40;
      const res = await call("POST", "/api/items", {
        name: `STRESS-VERIFY-${String(i).padStart(4, "0")}`,
        quantity: stock,
        unit: "pcs",
        low_stock_threshold: 10,
        unit_price: 25,
      });
      if (res.status !== 201 || !res.data?.item?.id) {
        console.error(`create ${i} failed:`, res.status, JSON.stringify(res.data).slice(0, 200));
        process.exitCode = 1;
        break;
      }
      created.push(res.data.item.id);
      if (i % 50 === 0) console.log(`created ${i}/${COUNT}`);
    }
    console.log(JSON.stringify({ created: created.length, firstId: created[0], lastId: created[created.length - 1] }));
    // Save ids for cleanup.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(".stress-seed-ids.json", JSON.stringify(created));
    console.log("ids written to .stress-seed-ids.json");
    return;
  }

  if (mode === "cleanup") {
    const { readFileSync } = await import("node:fs");
    const ids = JSON.parse(readFileSync(".stress-seed-ids.json", "utf8"));
    let ok = 0;
    for (const id of ids) {
      const res = await call("DELETE", `/api/items/${id}`, { password: ADMIN.password });
      if (res.status === 200) ok += 1;
      else console.error(`delete ${id} failed: ${res.status}`);
    }
    console.log(`deleted ${ok}/${ids.length}`);
    return;
  }

  console.error("usage: node scripts/_stress-seed.mjs create|cleanup");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
