# CafeTrack

Stock, movement and expiry tracking for a small café, built for the counter:
scan a barcode, record what you used, and see what is running out before it
runs out.

It runs entirely on your own machine by default. The database is
[PGlite](https://pglite.dev) — real PostgreSQL compiled to WebAssembly, running
inside the Node process and stored in `./.pglite`. Nothing to install but npm,
no account to create, and no data leaving the machine.

---

## Quick start

Needs Node.js 18.17 or newer (this project is developed on 24.15) and npm.

```bash
npm install
cp .env.example .env.local     # optional — the app runs without it
npm run dev
```

Open <http://localhost:3000> and sign in:

| Role  | Username   | Password   |
| ----- | ---------- | ---------- |
| Admin | `admin`    | `admin123` |
| Staff | `barista1` | `staff123` |

On first start the app creates `.pglite`, applies the schema, and seeds a few
items, the reference lists (categories, locations) and three accounts. Staff
sign in with the barcode printed on their ID plus their password; admins use a
username and password.

To see it work without typing anything: **Inventory → All Items → Print visible
barcode labels**, print a sheet, then scan a label with the field on **Checkout
& Restock**. Typing a SKU by hand works exactly the same way — that is also the
fallback when a label is damaged.

---

## What it does

- **Checkout & Restock** — scan or type an item, set the quantity, commit with
  your password. Waste has its own mode, so spoilage is never mixed into a
  normal checkout. While you scan you are told when an item is at or below its
  low-stock threshold, out of stock, or expiring, and again if the movement you
  just recorded pushed something under its threshold.
- **Inventory** — items with SKU, category, location, physical form, unit,
  quantity, low-stock threshold and expiry date. Search, filter by category, and
  sort by clicking any column header. Barcode labels for the whole filtered
  list or one at a time.
- **Alerts** — low stock, out of stock, expired and expiring soon, raised by a
  database function. Every alert has a detail page with the item, its current
  stock and its full alert history. An open alert **escalates in place** when
  the item gets worse — low stock becomes out of stock, expiring becomes
  expired — keeping the same alert id, so the message always states the current
  severity and an item is never listed twice. Resolving an alert closes it; it
  never moves stock. Staff can read alerts, but **only an admin can resolve,
  re-open, or force a recompute** — the controls are hidden for staff and the
  API refuses them with `403`.
- **Settings** — admins set the expiry-warning window, session timeout and
  business name, and add or remove item categories and storage locations.
  Changes take effect immediately, not after the settings cache expires.
- **Staff accounts** — admins create staff and admin accounts, print a staff
  barcode, reset passwords, and deactivate an account **with a reason**. The
  reason is shown to that person the next time they try to sign in.
- **Reports** — stock snapshot, movement summary, top movers, soonest expiries,
  filterable by date range, movement type, staff and category, with a CSV or PDF
  export of whatever is currently in view.
- **Audit trail** — every stock movement and account change, hash-chained so
  entries cannot be edited or removed without it showing, with a "verify chain"
  button that walks the whole chain.

---

## The local database

- **Where it lives:** `./.pglite` (roughly 40 MB). Deleting that folder is
  always safe — it is rebuilt and reseeded on the next start.
- **When it is created:** lazily, on the first request, not at `npm install`.
- **PGlite is single-process.** Stop `npm run dev` before running `npm run
  db:reset` or `npm run db:wipe`, otherwise the running server still holds the
  database open.

### Changing the schema

`db/schema.sql` is the source of truth. `db/schema.local.sql` is **generated**
from it and is what local mode actually runs — never edit it by hand:

```bash
npm run db:schema      # regenerate db/schema.local.sql
```

Every statement in both files is idempotent (`create ... if not exists`,
`create or replace function`, `alter table ... add column if not exists`), so
they are re-applied on every start and adding a column means editing
`db/schema.sql` and re-running the command above. **If you edit `db/schema.sql`
and forget to regenerate, local mode silently keeps the old schema.**

### Other useful commands

```bash
npm run db:reset       # delete ./.pglite; rebuilt on the next request
npm run db:wipe        # clear the data, keep the admin account and the
                       # reference lists (categories, locations)
```

### Backup and restore

The spec asks for "backup and restore capability for inventory data". In local
mode the database *is* the `.pglite` directory, so a backup is a copy of it:

```bash
npm run db:backup                          # -> backups/cafetrack-<timestamp>/
npm run db:restore -- backups/cafetrack-<timestamp>
```

Both refuse to run while `npm run dev` is up, because PGlite is single-process
and copying or swapping the database underneath a running server is not safe.
A backup records a row count per table in `manifest.json`, and a restore compares
those counts against the live database afterwards, so restoring the wrong backup
is reported rather than silently accepted. The previous database is kept as
`.pglite.replaced` unless you pass `--force`. The ten most recent backups are
pruned; `backups/` is gitignored.

Under Supabase there is nothing to copy — that platform handles its own backups.

---

## Switching to Supabase

Local mode is the default; Supabase is optional and only used if you remove the
`CAFETRACK_DB` line from `.env.local`.

1. Create a project, then run `db/schema.sql` in the SQL Editor. It enables
   row-level security on every table and creates no policies, so the only access
   path is the service-role key used server-side.
2. Fill in the `SUPABASE_*` / `NEXT_PUBLIC_SUPABASE_URL` values in `.env.local`
   from **Project Settings → API**.
3. `npm run seed` — note this script talks to Supabase only; local mode seeds
   itself.

Both modes go through the same query layer (`src/lib/supabase.ts`), so the API
routes are identical either way.

### Updating a hosted project later

`db/schema.sql` is written to be re-runnable — it uses `if not exists` and
`create or replace` throughout, and never drops or truncates — so pasting the
whole file into the SQL Editor is always safe.

When the change is only to a stored function, `npm run db:migrate` is less
error-prone. It writes `db/migrate.sql`, containing just the `create or replace
function` statements and any `add column if not exists` migrations, each with a
header explaining the procedure. It cannot create, drop, or modify client data,
so it is safe to run against a live project. Paste the result into the SQL
Editor and run.

Two files in `db/` are generated — never edit them by hand or the next build
overwrites your change:

| File                  | Built by            | From            |
| --------------------- | ------------------- | --------------- |
| `db/schema.local.sql` | `npm run db:schema` | `db/schema.sql` |
| `db/migrate.sql`      | `npm run db:migrate`| `db/schema.sql` |

---

## Environment variables

| Variable                     | Required             | What it does                                                      |
| ---------------------------- | -------------------- | ----------------------------------------------------------------- |
| `CAFETRACK_DB`               | no (defaults local)  | `local` runs the bundled PGlite database. Delete it for Supabase.  |
| `CAFETRACK_DB_DIR`           | no                   | Where the local database lives. Defaults to `./.pglite`.           |
| `AUTH_SECRET`                | **yes in production** | Signs session cookies. At least 32 characters.                    |
| `SEED_ADMIN_PASSWORD`        | no                   | Admin password created on first run. Defaults to `admin123`.       |
| `SEED_STAFF_PASSWORD`        | no                   | Staff password created on first run. Defaults to `staff123`.       |
| `BASE_URL`                   | no                   | Target for the test scripts. Defaults to `http://localhost:3000`.  |
| `NEXT_PUBLIC_SUPABASE_*`     | Supabase only        | Project URL and anon key.                                         |
| `SUPABASE_SERVICE_ROLE_KEY`  | Supabase only        | Server-side key. Never exposed to the browser.                    |

`.env.example` is a commented template covering all of these.

---

## Scripts

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Development server on :3000                            |
| `npm run build`     | Production build                                       |
| `npm start`         | Serve the production build                             |
| `npm run lint`      | ESLint                                                |
| `npm run seed`      | Seed **Supabase** (local mode seeds itself)            |
| `npm run db:schema` | Regenerate `db/schema.local.sql` from `db/schema.sql`  |
| `npm run db:migrate`| Write `db/migrate.sql` — paste-ready, data-safe updates for a hosted project |
| `npm run db:reset`  | Delete the local database                              |
| `npm run db:wipe`   | Clear local data, keep admin + reference lists         |

### Tests

There is no unit-test runner. Two scripts drive a running server over HTTP, so
start `npm run dev` first:

```bash
npm run test:smoke    # full API walk-through; makes and cleans up its own data
npm run test:edge     # hostile and edge-case inputs
npm run test:pages    # every page renders, for an admin and a staff session
npm run test:journeys # six end-to-end user stories, asserted on their outcomes
npm run perf          # measures the spec's performance targets
```

`test:smoke` currently reports **68 passed, 0 failed**. `test:edge` reports
**83 passed, 0 failed**, `test:pages` **17 passed, 0 failed**, and
`test:journeys` **73 passed, 0 failed**.

`test:journeys` is the one to read for behaviour rather than status codes: it
drives whole stories (a new hire's first day, an ingredient running out and
being restocked, a full shift's arithmetic, the expiry and session settings
actually changing behaviour, and the in-use reference guard) and asserts on the
end result. It expects a freshly seeded database — run `npm run db:wipe` first —
and removes everything it creates, so the other suites still pass after it.

The page suite is the reason the alert pages carry a role check: it renders
`/alerts` and `/alerts/[id]` under both an admin and a staff session, so a
control that is hidden for staff cannot silently break the page for them.

The edge suite is safe to run repeatedly: it edits a seeded item to check the
optimistic-version guard and restores the name afterwards, so it does not drift
the database.

`npm run perf` times the three targets in the spec — item lookup under 100 ms,
dashboard refresh under 2 s, stock deduction under 1 s — and prints pass/fail per
target. It needs the dev server running, and it writes a real checkout then
restocks the same amount, so point it at a development database.

---

## Project layout

```
db/
  schema.sql           source of truth for the schema
  schema.local.sql     GENERATED from schema.sql, used by local mode
scripts/               seed, schema build, db reset/wipe, test scripts
src/
  app/
    (app)/             signed-in area: dashboard, checkout, items, alerts,
                       reports, audit, users, settings
    api/               every API route
    login/             sign-in page
  components/          Nav, ScanInput, BarcodeView, ui primitives, icons
  lib/
    supabase.ts        picks local or Supabase — the only place that decides
    local-db.ts        PGlite + a small PostgREST-compatible query adapter
    auth.ts            sessions, password hashing
    secret.ts          the AUTH_SECRET rule
    rate-limit.ts      sign-in throttling
    status.ts          shared status wording and colours
    ref-delete.ts      shared in-use guard for the reference lists
    report-print.tsx   print/PDF view of the stock report
  proxy.ts           JWT check for every route (was middleware.ts before Next 16)
```

---

## Security notes

- **Passwords** are hashed with scrypt (Node's `crypto`, no dependency) using a
  per-user salt. Hashes are never selected by any API route.
- **`AUTH_SECRET`** signs the session JWT. In production the app refuses to
  start without a real one instead of falling back to the value published in
  this repository, and the middleware answers `503` rather than verify a token
  with a key it cannot trust.
- **Sign-in throttling** — five consecutive failed attempts for one credential (or
  20 for a sign-in method as a whole) within 15 minutes are answered normally;
  the next attempt gets `429` with a `Retry-After` header. A successful sign-in
  clears the counter, so a shared till cannot lock a real person out
  permanently. Blocked attempts are deliberately not logged, or the lockout
  would extend itself forever. To clear a lockout early, stop the dev server
  and run `npm run db:wipe`.
- **Staff codes** are never written to the sign-in log for an unrecognised code
  — only a 12-character SHA-256 prefix of it.
- **Sessions** are `httpOnly`, `SameSite=Lax`, `secure` in production, and
  expire after `settings.session_timeout_minutes` (default 15) of inactivity.
- **Deactivating an account** records who did it, when, and why. The reason is
  shown to the account holder at sign-in, so it must not contain anything
  sensitive.

---

## Known limitations

- **A failed audit write is reported, not hidden.** `audit()` throws by default,
  so a change that could not be recorded answers `500` rather than a misleading
  success. The message says the change may have been applied but went
  unaudited, because the routes call `audit()` *after* the write commits.
  Sign-in attempts and sign-out pass `critical: false`, because a rejected
  password must stay a `401` and sign-out must always clear the session cookie.
- **A malformed request body answers `400`, not `500`.** Every route that reads a
  body goes through `readBody()` in `lib/api.ts`, so a missing, empty or
  unparseable body is a bad request rather than a server fault, and the raw
  parser message ("Unexpected end of JSON input") is never returned to a caller.
  An empty body is treated as `{}` so the route's own required-field check
  produces the useful message.
- **Input validation on `POST`/`PATCH /api/items`.** Quantity must be present and
  a real number — `null`, a missing field, and `""` are all rejected rather than
  defaulting to `0`, which used to silently empty a stocked item. `expiration_date`
  is checked for a real `YYYY-MM-DD` calendar day before it reaches the database,
  so a bad date is a `400` and not a `500`.
- **No pagination.** `/api/items` returns every row; transactions and the audit
  trail cap at 500. Fine for a single café, but `audit_log` grows without bound.
- **The local database adapter** (`src/lib/local-db.ts`) implements the subset
  of the Supabase query builder this app uses, with four explicit join paths
  (`items.category`, `items.location`, `alerts.item`,
  `transactions.transaction_items`). A new embed has to be added there or the
  query fails at runtime.
- **No password self-service.** Staff can only be given a new password by an
  admin, so anyone who forgets theirs is stuck until an admin acts.
- **Categories and locations are managed from the Settings page**, not by editing
  the database. Renaming is not supported — a reference row is deleted and
  re-added, and a row still assigned to an item cannot be deleted (409), so
  items never end up pointing at a missing category or location.
- **Printing is vector, scanning is not verified automatically.** Barcodes are
  drawn as SVG at whole-pixel module widths, which is what makes them
  scannable, but nothing here proves a printed label scans — that needs a
  physical print and a real scanner.
