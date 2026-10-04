const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";

let pass = 0;
let fail = 0;

function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  " + detail : ""}`);
  }
}

async function loginAs(username, password) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return (r.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
}

async function getPage(path, cookie) {
  const r = await fetch(BASE + path, { headers: cookie ? { cookie } : {} });
  const t = await r.text();
  const crashed = /Application error|Unhandled Server Error/.test(t);
  return { status: r.status, html: t, crashed };
}

(async () => {
  const admin = await loginAs("admin", "admin123");
  check("admin sign-in for page render", Boolean(admin));

  console.log("\n== every page renders for an admin ==");
  for (const p of ["/", "/dashboard", "/checkout", "/items", "/reports", "/audit", "/alerts", "/users", "/login"]) {
    const r = await getPage(p, admin);
    check(`${p} renders`, r.status === 200 && !r.crashed, r.crashed ? r.html.slice(0, 120) : String(r.status));
  }

  // The alert detail page needs a real id, so it cannot join the list above.
  const list = await (await fetch(BASE + "/api/alerts?status=all&limit=1", { headers: { cookie: admin } })).json();
  const alertId = list.alerts?.[0]?.id;
  check("an alert id was available to render", Boolean(alertId), alertId ?? "none found");

  console.log("\n== alerts list renders ==");
  const adminList = await getPage("/alerts", admin);
  check("/alerts renders for admin", adminList.status === 200 && !adminList.crashed,
    adminList.crashed ? adminList.html.slice(0, 120) : String(adminList.status));
  // These pages are client components, so the server response is only the app
  // shell plus the loading state; the list itself is fetched after hydration.
  // Asserting on rendered content here would be testing the wrong thing, so the
  // page check is "did it respond 200 without a server error" (above) and the
  // data behind it is covered by the API tests.
  check("admin alert page returned the app shell", /Loading|__next_f/.test(adminList.html), adminList.html.length + " bytes");

  if (alertId) {
    console.log("\n== alerts detail renders for both roles ==");
    const adminDetail = await getPage(`/alerts/${alertId}`, admin);
    check("/alerts/[id] renders for admin", adminDetail.status === 200 && !adminDetail.crashed,
      adminDetail.crashed ? adminDetail.html.slice(0, 120) : String(adminDetail.status));

    // A staff session must reach the same page without a server error. The
    // resolve controls are hidden client-side by role; the API refuses them
    // regardless, which the edge suite covers.
    const users = await (await fetch(BASE + "/api/users", { headers: { cookie: admin } })).json();
    const staff = users.users?.find((u) => u.role === "staff" && u.is_active);
    if (staff?.qr_token) {
      const sr = await fetch(BASE + "/api/auth/staff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: staff.qr_token, password: "staff123" }),
      });
      const sc = (sr.headers.getSetCookie?.() || []).map((x) => x.split(";")[0]).join("; ");
      check("staff sign-in for page render", Boolean(sc), staff.username);

      const staffList = await getPage("/alerts", sc);
      check("/alerts renders for staff", staffList.status === 200 && !staffList.crashed,
        staffList.crashed ? staffList.html.slice(0, 120) : String(staffList.status));

      const staffDetail = await getPage(`/alerts/${alertId}`, sc);
      check("/alerts/[id] renders for staff", staffDetail.status === 200 && !staffDetail.crashed,
        staffDetail.crashed ? staffDetail.html.slice(0, 120) : String(staffDetail.status));
    } else {
      check("an active staff account was available", false, "none found");
    }
  }

  console.log(`\n${"-".repeat(46)}`);
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
