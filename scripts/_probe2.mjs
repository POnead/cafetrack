const BASE = "http://localhost:3000";
(async () => {
  const l = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }),
  });
  const A = (l.headers.getSetCookie?.() ?? []).map((x) => x.split(";")[0]).join("; ");
  const call = async (m, p, b) => {
    const r = await fetch(BASE + p, { method: m, headers: { "content-type": "application/json", cookie: A }, body: JSON.stringify(b) });
    return { s: r.status, d: await r.json().catch(() => null) };
  };
  const seed = await (await fetch(BASE + "/api/items", { headers: { cookie: A } })).json();
  const t = seed.items[0];

  let r = await call("POST", "/api/items", { name: "Thr NaN", low_stock_threshold: "abc" });
  console.log("POST threshold 'abc':", r.s, r.s === 201 ? `SILENTLY SAVED AS ${r.d.item.low_stock_threshold}` : r.d?.error);
  if (r.s === 201) await call("DELETE", `/api/items/${r.d.item.id}`, {});

  r = await call("POST", "/api/items", { name: "Date Bad", quantity: 1, expiration_date: "2026-13-45" });
  console.log("POST date 2026-13-45:", r.s, r.d?.error);
  if (r.s === 201) await call("DELETE", `/api/items/${r.d.item.id}`, {});

  r = await call("PATCH", `/api/items/${t.id}`, { low_stock_threshold: "abc" });
  console.log("PATCH threshold 'abc':", r.s, r.d?.error);

  r = await call("PATCH", `/api/items/${t.id}`, { expiration_date: "not-a-date" });
  console.log("PATCH date garbage:", r.s, r.d?.error);

  r = await call("PATCH", `/api/items/${t.id}`, { low_stock_threshold: null });
  console.log("PATCH threshold null:", r.s, r.d?.error ?? (r.s === 201 ? `SAVED AS ${r.d.item.low_stock_threshold}` : ""));

  r = await call("PATCH", `/api/items/${t.id}`, { unit: { evil: true } });
  console.log("PATCH unit object:", r.s, r.d?.error);
})();
