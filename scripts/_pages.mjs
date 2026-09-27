const BASE = "http://localhost:3000";
(async () => {
  const l = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const cookie = l.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
  let fail = 0;
  for (const p of ["/", "/dashboard", "/checkout", "/items", "/reports", "/audit", "/alerts", "/users", "/login"]) {
    const r = await fetch(BASE + p, { headers: { cookie } });
    const t = await r.text();
    const bad = r.status !== 200 || /Application error|Unhandled Server Error/.test(t);
    if (bad) fail++;
    console.log(bad ? "FAIL" : "PASS", p, r.status, bad ? t.slice(0, 120) : "");
  }
  process.exit(fail ? 1 : 0);
})();
