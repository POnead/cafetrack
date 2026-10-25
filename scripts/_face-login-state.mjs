/**
 * One-shot: report what the live app would need before face sign-in can be demoed.
 *
 *   node scripts/_face-login-state.mjs [baseUrl]
 *
 * Signs in as the seeded admin and reports, without changing anything:
 *
 *   - whether face sign-in and duty verification are switched on
 *   - which settings the login page depends on
 *   - every staff account, and whether it has a face enrolled
 *
 * Written because the face sign-in button on the login page is drawn from one
 * setting, and "the button is not there" has three quite different causes —
 * switched off, no staff enrolled, or a stale build. Reading the state is faster
 * than guessing which.
 */

const BASE = process.argv[2] || process.env.BASE_URL || "http://localhost:3100";

let cookie = "";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const first = c.split(";")[0];
    if (first.startsWith("cafetrack_session=")) cookie = first;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, data };
}

const login = await call("POST", "/api/auth/login", {
  username: "admin",
  password: "admin123",
});

if (login.status !== 200) {
  console.error(`could not sign in as admin (status ${login.status})`);
  console.error(JSON.stringify(login.data));
  process.exit(1);
}

console.log(`signed in to ${BASE} as admin\n`);

const settings = await call("GET", "/api/settings");
const s = settings.data?.settings ?? {};

const flags = ["face_login_enabled", "face_verification_enabled", "id_verification_required"];
console.log("=== settings that gate the face flow ===");
for (const key of flags) {
  console.log(`  ${key.padEnd(28)} = ${JSON.stringify(s[key])}`);
}

console.log(`\n  face_login_enabled as the login page sees it:`);
const probe = await call("GET", "/api/auth/face-login");
console.log(`    ${JSON.stringify(probe.data)}`);

const users = await call("GET", "/api/users");
const staff = (users.data?.users ?? []).filter((u) => u.role === "staff");

console.log(`\n=== staff accounts (${staff.length}) ===`);
if (staff.length === 0) {
  console.log("  none — the staff sign-in has nothing to offer");
}

for (const u of staff) {
  console.log(
    `  ${(u.username ?? "?").padEnd(18)} active=${String(u.is_active).padEnd(5)} ` +
      `face_enabled=${String(u.face_enabled ?? "?").padEnd(5)} ` +
      `enrolled=${u.face_enrolled_at ? "yes" : "NO "}  qr=${u.qr_token ?? "-"}`
  );
}

const enrolled = staff.filter((u) => u.face_enrolled_at && u.is_active);
console.log(`\n${enrolled.length} of ${staff.length} staff can actually sign in with a face.`);

if (!s.face_login_enabled || s.face_login_enabled === "0") {
  console.log("\nface_login_enabled is OFF, so the login page does not draw the option at all.");
}
if (enrolled.length === 0) {
  console.log("no staff account has an enrolled face, so nothing would match even once it is on.");
}
