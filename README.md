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

Open <http://localhost:3100> and sign in:

> **Note the port: CafeTrack runs on 3100, not 3000.** Port 3000 is used by
> another project on this machine (HabitTrack, in `Downloads\adbmsproj1`). Pinning
> CafeTrack to its own port means the two can never collide — without a pin,
> `next dev` silently slides to the next free port and you end up looking at the
> wrong project without any error being shown.

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

## Opening it on a phone or tablet

`npm run dev` prints the LAN address to use:

```
[cafetrack] LAN origins allowed: 192.168.1.7, mypc, mypc.local
[cafetrack] open on a phone/tablet at http://192.168.1.7:3100
```

The phone has to be on the **same Wi-Fi** as this machine. Then browse to that
address — or to `http://mypc.local:3100`, which survives the router handing out
a different address.

Both work without editing any file. Next blocks dev-only requests (including the
hot-reload socket) from any address it does not recognise, and when it blocks one
it fails *quietly*: the page loads but arrives unstyled and never hydrates, so
nothing is clickable and it can look like a completely different website. To stop
that, `next.config.mjs` reads this machine's real network addresses and its own
computer name on every start, rather than trusting an address hardcoded earlier
that the router has since changed.

If it stops working after a reboot or a network change, check the printed line
above — it is the fastest way to see which address the server expects. Restarting
`npm run dev` re-reads the interfaces and picks up a new address.

**If the page is unstyled and unclickable, you are probably running the wrong
copy of the project.** An older CafeTrack (Next 14, no origin allowlist, no mobile
layout, not a git repository) was found at `Documents\cafetrack`. It has been
renamed to `Documents\cafetrack-OLD-DELETE-ME` so it is no longer easy to open by
accident, and it is safe to delete whenever you no longer need it. Always run this
one, from `Downloads\cafetrack`.



---

## What it does

- **Checkout & Restock** — scan or type an item, set the quantity, commit with
  your password. Waste has its own mode, so spoilage is never mixed into a
  normal checkout. While you scan you are told when an item is at or below its
  low-stock threshold, out of stock, or expiring, and again if the movement you
  just recorded pushed something under its threshold. **A restock can carry the
  new batch's expiry date**, one date per cart line, because receiving stock is
  the only moment that date is actually known. Leaving the field blank keeps
  the item's existing date rather than clearing it, and only a restock ever sets
  one — a checkout or a waste log cannot move an expiry, so discarding a spoiled
  item never extends its life.
- **Per-box packaging** — an item can record how many of its unit arrive in one
  box. A restock can then be entered as a box count, and the conversion to the
  item's own unit is done by the database, which owns the factor, so the browser
  can never disagree with the server about it. 3 boxes of 12 lands as 36. A box
  count is only accepted for a restock, and only for an item that actually has a
  packaging factor.
- **Minimum shelf life on arrival** — a storage location can refuse a delivery
  that arrives too close to its date; a freezer set to 30 days will reject a
  batch with 5 days left, naming the item, the date and the rule. It is stored
  per location rather than hardcoded to "Freezer", so a chiller can carry the
  same rule and dry storage can carry none. A line with no date is not its
  business, and clearing the rule lets the same delivery through.
- **Inventory** — items with SKU, category, location, physical form, unit,
  units per box, quantity, low-stock threshold and expiry date. Search, filter by
  category, and sort by clicking any column header. Barcode labels for the whole
  filtered list or one at a time.
- **Staff can add ingredients, two ways** — an admin grants *item management* to
  a staff member from their account, and their additions, edits and deletions take
  effect immediately. Without that grant they can still submit a new ingredient;
  it is saved, audited and listed under **Approvals**, but it is **not stock** until
  an admin approves it. A pending item raises no alerts, cannot be checked out or
  restocked, and its barcode says it is waiting rather than "no item matches" — so
  the approval step cannot be bypassed by accident. Edit and delete stay
  admin-only unless item management is granted, and revoking it takes effect on the
  next request rather than at next sign-in.
- **Email notifications** — low stock, out of stock, expiring soon, expired, a daily
  summary, rejected sign-ins, and the stock report on demand. **Off until an admin
  turns it on** in Settings → Email and adds a recipient, so the feature cannot
  start sending from someone's café by accident. Alerts are queued by the database
  during the movement that caused them and sent afterwards, so a slow or dead mail
  server never slows down the till; a failed send is retried, up to three times by
  default. The same alert is not sent twice inside a suppression window (24 hours by
  default), and the delivery log shows what went out, what is queued, and why
  anything failed.

### Setting up email

An admin sets the sending account from **Settings → Email** — no file editing and
no restart. Gmail, Outlook and anything else that speaks SMTP work the same way;
Gmail and Outlook are one-click presets that fill in the server and port.

**Gmail needs an App Password, not your account password.** Google stopped
accepting the real password for SMTP in 2022. Turn on 2-Step Verification, then
create one at <https://myaccount.google.com/apppasswords> and paste the 16
characters into the app-password field.

**The From address must be the account itself, or a verified alias of it.** Gmail
rejects anything else, and reports it only as an unreadable `553`.

Where the details are stored:

| | |
| --- | --- |
| Saved on the website | `settings`, host/port/user in the clear, **password encrypted** |
| `SMTP_*` in `.env.local` | A fallback, used only when nothing is saved on the website |
| Precedence | The website wins — an admin saving a new account expects it to take effect |

The app password is encrypted with AES-256-GCM keyed from `AUTH_SECRET` before it
is stored, so it is not readable in the database, in a backup, or through any API.
It is never displayed again, not even to the admin who set it — the form shows only
whether one exists, and leaving that field blank keeps the stored one. Changing
`AUTH_SECRET` invalidates it, which the app reports as "re-enter the password"
rather than failing every send. `GET /api/settings` refuses to return the key at
all, so it fails closed for any credential added later.

TLS is required: with the default port 587 the connection upgrades with STARTTLS,
and if a server does not offer it the send is refused rather than handing over the
password in cleartext. `SMTP_ALLOW_INSECURE=1` lifts that for a relay on the same
machine with no certificate — an explicit choice, not a silent fallback.
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
  business name, and add or remove item categories and storage locations. Each
  location also carries its minimum shelf life on arrival, editable in place.
  Changes take effect immediately, not after the settings cache expires.
- **Staff accounts** — admins create staff and admin accounts, print a staff
  barcode, reset passwords, and deactivate an account **with a reason**. The
  reason is shown to that person the next time they try to sign in.
- **Reports** — stock snapshot, movement summary, top movers, soonest expiries,
  filterable by date range, movement type, staff and category, with a CSV or PDF
  export of whatever is currently in view.
- **Audit trail** — every stock movement and account change, hash-chained so
  entries cannot be edited or removed without it showing, with a "verify chain"
  button that walks the whole chain. Each entry also records **where it came from**
  (IP) and **how it turned out** (success, denied, failed). Those two sit beside
  the hash rather than inside it: adding them to the digest would invalidate every
  entry already written, and a chain that does not verify is worth nothing.

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

### The automatic daily backup

The server takes one on its own, once a day, so nothing has to be remembered:

- **When** — after 3am (`CAFETRACK_BACKUP_HOUR`), and only if today's has not been
  taken. It checks every ten minutes rather than scheduling a precise tick, which
  also means a machine that was off at 3am takes the backup on its first start
  instead of skipping the day.
- **Where** — `backups/cafetrack-auto-<timestamp>/`, keeping the newest 3
  (`CAFETRACK_BACKUP_KEEP`). Only `cafetrack-auto-*` is ever pruned, so a manual
  `npm run db:backup` in the same folder is left alone.
- **How** — PGlite's own `dumpDataDir()`, taken from inside the running process.
  This is what makes it different from `npm run db:backup`, which copies the
  directory and therefore refuses to run while the server is up. The automatic
  one needs no downtime.
- **Turning it off** — set `CAFETRACK_DISABLE_AUTO_BACKUP=1`.

Each snapshot is a `pgdata.tar.gz` plus a `manifest.json` of per-table row counts.
**The two backup types are not interchangeable:** `npm run db:restore` expects the
directory-copy layout that `npm run db:backup` makes, so restoring an automatic
one means stopping the server and extracting the tar over the database directory.
The manifest says which it is and spells this out.

Under Supabase this does nothing — that platform takes its own backups.

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
`.pglite.replaced` unless you pass `--force`.

Old backups are pruned after each successful run, keeping the newest **3** — set
`CAFETRACK_BACKUP_KEEP` to change it. Each one is a full copy of the database
directory, so without a limit repeated runs quietly fill the disk. Pruning runs
*after* the new backup is written, never before, so a failure cannot leave you
with nothing. `backups/` is gitignored.

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
| `CAFETRACK_BACKUP_KEEP`      | no                   | How many local backups to keep. Defaults to 3.                      |
| `CAFETRACK_BACKUP_HOUR`      | no                   | Hour the automatic daily backup runs. Defaults to 3.                |
| `CAFETRACK_DISABLE_AUTO_BACKUP` | no              | Set to `1` to stop the automatic backup.                           |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | no      | Mail server **fallback**, used only when nothing is saved on Settings → Email. |
| `SMTP_PORT`                  | no                   | Fallback mail port. Defaults to 587.                              |
| `SMTP_ALLOW_INSECURE`        | no                   | Set to `1` to permit a mail server offering no TLS. Off by default. |
| `CAFETRACK_DISABLE_EMAIL`    | no                   | Set to `1` to stop the mail scheduler and dispatch entirely.        |
| `BASE_URL`                   | no                   | Target for the test scripts. Defaults to `http://localhost:3100`.  |
| `NEXT_PUBLIC_SUPABASE_*`     | Supabase only        | Project URL and anon key.                                         |
| `SUPABASE_SERVICE_ROLE_KEY`  | Supabase only        | Server-side key. Never exposed to the browser.                    |

`.env.example` is a commented template covering all of these.

---

## Scripts

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run dev`       | Development server on :3100                            |
| `npm run build`     | Production build                                       |
| `npm start`         | Serve the production build                             |
| `npm run lint`      | ESLint                                                |
| `npm run seed`      | Seed **Supabase** (local mode seeds itself)            |
| `npm run db:schema` | Regenerate `db/schema.local.sql` from `db/schema.sql`  |
| `npm run db:migrate`| Write `db/migrate.sql` — paste-ready, data-safe updates for a hosted project |
| `npm run db:reset`  | Delete the local database                              |
| `npm run db:wipe`   | Clear local data, keep admin + reference lists         |

### Tests

There is no unit-test runner. The scripts drive a running server, so start
`npm run dev` first:

```bash
npm run test:smoke    # full API walk-through; makes and cleans up its own data
npm run test:edge     # hostile and edge-case inputs
npm run test:pages    # every page renders, for an admin and a staff session
npm run test:journeys # six end-to-end user stories, asserted on their outcomes
npm run test:ui       # drives part of the real UI in Chrome; writes ui-screenshots/
npm run test:tour     # drives the whole site in Chrome, as a café actually works
npm run perf          # measures the spec's performance targets
npm run test:all      # all seven in order, stopping at the first failure
```

**Prefer `npm run test:isolated` — see below. It keeps the suites off your
working data.**

`test:smoke` currently reports **68 passed, 0 failed**. `test:edge` reports
**102 passed, 0 failed**, `test:pages` **21 passed, 0 failed**,
`test:journeys` **117 passed, 0 failed**, `test:ui` **36 passed, 0 failed**,
and `test:tour` **147 passed, 0 failed**.

Two of those counts grew with the item-approval and email work. `test:edge` now
covers the submission path properly — that staff *can* submit, that the result is
pending rather than stock, that it is invisible to the stock list, unscanable at
the till, and still not editable or deletable by the person who submitted it.
`test:pages` renders `/approvals` and `/email` for a staff session, since neither
should crash for someone who follows a link.

`test:smoke` and `test:ui` need a **freshly seeded** database — both assert
against the seeded items. `npm run db:reset` clears and re-seeds;
`npm run db:wipe` is not enough, because it removes the items and the users
those suites count.

### Running the suites without polluting your data

The suites write: they check stock out, restock it, create and delete
accounts, and add to the movement ledger. They clean up the stock and the
reference rows, but **not the transactions** — the ledger is append-only by
design (`transaction_items` keeps a name snapshot, and `item_id` is
`on delete set null`), so the history of a deleted item deliberately survives.
Run repeatedly against your working database, that history piles up and
eventually tops the dashboard's *In-Demand Items* and the report's *Most
checked out* with ingredients that no longer exist.

So give the suites a database of their own:

```bash
npm run dev:test        # terminal 1 — a second server on :3101
npm run test:isolated   # terminal 2 — all seven suites against it
```

`dev:test` points `CAFETRACK_DB_DIR` at `.pglite-test/` and gives itself its
own `.next-test/` build directory, because Next locks `.next/dev` and a second
server in the same folder refuses to start. Your `.pglite/` is never opened.
`npm run db:test:wipe` throws the throwaway database away.

The plumbing already existed — `local-db.ts` and all five `db:*` scripts read
`CAFETRACK_DB_DIR`, and every suite reads `BASE_URL`. These two scripts just
connect them, and `test:isolated` refuses to run against port 3100 so it
cannot point at your real server by accident.

#### The suites refuse to write to a live database

Every API response carries `x-cafetrack-db: test|live`, set in `lib/api.ts` and
on the proxy's own 401s. Each suite that writes calls `assertTestTarget()` from
`scripts/_guard.mjs` before it does anything, and **stops** if the target is
`live`:

```
Refusing to run against http://127.0.0.1:3100.

That server reports a live database (x-cafetrack-db: live).
This suite writes to the movement ledger, which is append-only, so what it
records cannot be removed afterwards.

Use the throwaway database instead:
    npm run dev:test          (terminal 1)
    npm run test:isolated     (terminal 2)

Or, if you really mean to test against real data:
    CAFETRACK_ALLOW_LIVE_DB=1 npm run <this suite>
```

That covers `smoke`, `edge`, `journeys`, `ui`, `tour` and `perf`. `_pages` is
read-only, so it is not guarded. The override prints a `!!!!` banner and then
runs, which is the record of having used it.

Without this, `npm run test:all` against a normal `npm run dev` was enough to
put deleted test ingredients at the top of the dashboard's *In-Demand Items*
permanently — the items get cleaned up, their name snapshots do not.

### `test:tour` — the whole site, driven as a person

`test:ui` and `test:tour` are the two that open a browser. Both use
`playwright-core` against the Chrome already installed on the machine, so
nothing is downloaded, and both write screenshots to `ui-screenshots/`, which
is gitignored.

`test:ui` covers the till and the role split. **`test:tour` is the broad one**:
it walks the entire application in the order a café works — sign in, take
movements at the till, receive a delivery, spoil something, chase the alerts
that fall out of it, read the report, onboard a hire, close the day — and
records every console error, uncaught exception and 5xx response on every page
it visits.

### The browser suites need `localhost`, not `127.0.0.1`

`test:ui` and `test:tour` drive a real page, and against `127.0.0.1` the HMR
websocket is refused as a cross-origin dev request — `next.config.mjs` allowlists
this machine's LAN addresses and names, and the loopback IP is not among them. The
symptom is not a clear failure: the page loads but never hydrates, so
`waitForTimeout` is followed by a locator that times out waiting for a login field,
and the suite reports "suite crashed" for what is really a config mismatch.

```bash
BASE_URL=http://localhost:3101 npm run test:ui    # works
BASE_URL=http://127.0.0.1:3101 npm run test:ui   # crashes on the HMR socket
```

Adding `127.0.0.1` to `allowedDevOrigins` would fix it for anyone who prefers the
numeric form; `localhost` is what the suites use now.

It is the suite that covers the behaviour a real user actually depends on and
that a request-level test cannot see:

- **Per-box packaging** — tick *Count by the box*, enter 3, and watch the
  operator-facing conversion read *3 boxes × 12 pcs = 36 pcs added*; then
  confirm the database really stored 36, not 3.
- **A restock that carries the new batch's expiry date** — and the guarantee
  that checkout and waste can never move one. Spoiling a batch must not
  resurrect its date.
- **Minimum shelf life on arrival** — a location set to 30 days refuses a
  delivery with 3 days left. The tour drives the whole arc: the client-side
  warning, the server's refusal naming the item, the date and the rule, that
  stock did not move, that the confirmation dialog stays open so the cart
  survives, and that a corrected date then goes through.
- **Validation** — a blank quantity, a zero units-per-box and an in-use
  reference delete are each refused in words a person can act on, rather than
  saving a silent zero or returning a raw constraint violation.
- **Every page** — including `/reports`, `/users`, `/settings` and `/audit`,
  which no browser test previously opened — for an admin *and* a staff
  session, plus sign-out, the CSV download, and the restock controls at 390px.

It cleans up after itself: the two test ingredients and both reference rows
are deleted, the hire is parked inactive, and the settings it read are written
back, so it is safe to run twice in a row. It reads the database back only
where the UI cannot show the value being asserted — stock levels and the
stored expiry date.

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
    (app)/             signed-in area: dashboard, checkout, items, approvals,
                       alerts, reports, audit, users, settings, email
    api/               every API route
    login/             sign-in page
  components/          Nav, ScanInput, BarcodeView, ui primitives, icons,
                       BrandArt (the cafe illustrations)
public/
  brand/               storefront, barista and table illustrations (JPEG)
  lib/
    supabase.ts        picks local or Supabase — the only place that decides
    local-db.ts        PGlite + a small PostgREST-compatible query adapter
    auth.ts            sessions, password hashing
    secret.ts          the AUTH_SECRET rule
    rate-limit.ts      sign-in throttling
    status.ts          shared status wording and colours
    ref-delete.ts      shared in-use guard for the reference lists
    report-print.tsx   print/PDF view of the stock report
    permissions.ts     can this person manage items? (FR-03)
    email.ts           SMTP delivery, the queue, the daily-summary timer
    backup.ts          the automatic daily snapshot
  proxy.ts           JWT check for every route (was middleware.ts before Next 16)
```

---

## Security notes

- **Passwords** are hashed with scrypt (Node's `crypto`, no dependency) using a
  per-user salt. Hashes are never selected by any API route.
- **`AUTH_SECRET`** signs the session JWT. In production the app refuses to
  start without a real one instead of falling back to the value published in
  this repository, and the middleware answers `503` rather than verify a token
  with a key it cannot trust. It is also the key the mail app password is
  encrypted with, so it cannot be rotated casually — doing so makes the stored
  password unreadable, which the app reports rather than hiding.
- **The mail app password is encrypted at rest** (AES-256-GCM, key derived from
  `AUTH_SECRET`) and never returned by any route — `GET /api/settings` excludes
  the key entirely, and the Email page reports only whether a password exists.
  Only an admin can set, change or remove it.
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
- **Email cannot be verified from a test run.** The notification path is checked
  against a throwaway SMTP server, which proves messages are queued, addressed,
  deduped and delivered — but not that a real provider accepts them, nor how a
  given inbox treats them. Send a test message from Settings → Email first.
- **`upsert()` takes `onConflict` as a string or an array — locally.** Supabase-js
  accepts either, so a call written for Supabase passes a bare
  `onConflict: "column"`. The local adapter now normalises both, because it
  declared only the array form and called `.map()` on the value: the string threw
  a `TypeError` inside the adapter, its own error handling turned that into an
  `error` result, and a caller that did not check `error` saw a write that
  silently never happened. That is exactly how every emailed report and test
  message ended up queued with a null recipient. Prefer the array form anyway,
  and **check `error`** on any `upsert()` whose failure would not otherwise be
  visible.
- **Rotating `AUTH_SECRET` discards the saved mail password.** That is the point of
  deriving the key from it, but a rotation then costs one field to re-enter.
- **The mail password is encrypted, not hidden.** It is safe in the database and in
  backups, and no API returns it. It is still readable by anything that can run code
  in the server process — the same trust boundary the session cookies sit inside,
  which no amount of encryption changes.
- **`ip_address` in the audit trail is best-effort.** It prefers
  `x-forwarded-for`, which is client-controlled. That is safe *because* the column
  sits outside the hash chain: a forged address cannot make a forged entry look
  authentic, since the digest covers the action and its details instead.
- **Two kinds of backup, not interchangeable.** `npm run db:backup` makes a
  directory copy that `npm run db:restore` understands. The automatic daily one
  writes `pgdata.tar.gz` because it has to run while the server is up, so
  restoring it means stopping the server and extracting the tar by hand. Both
  manifests say which kind they are.
- **A rejected item cannot be re-submitted.** It stays as `rejected` with the
  admin's reason. Correcting it means adding a new item; there is no "edit and
  resubmit", because a submission that could edit itself into stock would skip
  the approval it exists to get.
- **A pending item has no barcode.** One is drawn only once the item is approved,
  so a label cannot be printed for stock that is not stock yet.
