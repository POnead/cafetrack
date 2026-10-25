/**
 * Turn a setting on the live app, so a flow that is gated behind it can be seen.
 *
 *   node scripts/_set-face-login.mjs on|off [baseUrl]
 *
 * Refuses rather than guesses on an unknown value, and prints what it changed
 * along with how to undo it — a security setting being flipped on someone's live
 * café without being able to put it back is not a thing to do quietly.
 */

const want = (process.argv[2] ?? "").toLowerCase();
const BASE = process.argv[3] || process.env.BASE_URL || "http://localhost:3100";

if (want !== "on" && want !== "off") {
  console.error("usage: node scripts/_set-face-login.mjs on|off [baseUrl]");
  process.exit(1);
}

let cookie = "";

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  for (const c of res.headers.getSetCookie?.() ?? []) {
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

const login = await call("POST", "/api/auth/login", { username: "admin", password: "admin123" });
if (login.status !== 200) {
  console.error(`could not sign in as admin (status ${login.status})`);
  process.exit(1);
}

const patch = await call("PATCH", "/api/settings", {
  face_login_enabled: want === "on" ? "1" : "0",
});

if (patch.status !== 200) {
  console.error(`the change was refused (status ${patch.status}): ${JSON.stringify(patch.data)}`);
  process.exit(1);
}

const probe = await call("GET", "/api/auth/face-login");
console.log(`face_login_enabled is now ${want}`);
console.log(`the login page will now see: ${JSON.stringify(probe.data)}`);
console.log(`\nto put it back: node scripts/_set-face-login.mjs off ${BASE}`);
