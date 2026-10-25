-- ============================================================
-- CafeTrack — Database Schema (PostgreSQL / Supabase)
-- Run this in Supabase SQL Editor, once, top to bottom.
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- settings ----------
create table if not exists settings (
  key   text primary key,
  value text not null
);

insert into settings (key, value) values
  ('expiry_warning_days', '7'),
  ('session_timeout_minutes', '15'),
  ('business_name', 'Merrylane Cafe Foodhub'),
  -- Email (FR-11). off by default: adding a feature must not start sending mail
  -- from someone's cafe until they have asked for it. An admin turns it on and
  -- adds a recipient from Settings > Email.
  ('email_enabled', '0'),
  ('email_dedupe_hours', '24'),
  ('email_max_attempts', '3'),
  ('email_from', 'CafeTrack <no-reply@cafetrack.local>'),
  ('email_daily_summary_hour', '7'),
  -- Duty verification. Off by default for the same reason email is: this one
  -- puts a camera prompt between a staff member and the till, so it must not
  -- start until an admin has asked for it AND enrolled the people it covers.
  --
  -- face_duty_hours is the rolling window. A barista who verifies at 7am is not
  -- asked again until 4pm, which is roughly a cafe duty rather than a fixed
  -- shift grid — someone covering an early shift one day and a late one the next
  -- should not be tied to a timetable the cafe does not really keep.
  ('face_verification_enabled', '0'),
  ('face_duty_hours', '9'),
  ('face_match_threshold', '0.033'),
  -- Signing in with a face instead of a password (staff only).
  --
  -- Off by default, and separate from face_verification_enabled on purpose: one
  -- asks for a face every duty, the other changes how someone gets *into* the
  -- app at all. A cafe that wants both should be able to turn on the second
  -- without implying anything about the first, and an admin trialling face sign-in
  -- should not silently switch their staff over to duty checks as well.
  ('face_login_enabled', '0'),
  -- The https address a staff phone can open, when the register itself has no
  -- camera. Empty until a tunnel exists: a QR pointing at `localhost` gives the
  -- user a page with a dead camera and no explanation.
  ('face_verify_public_url', ''),
  -- ID verification at hiring. Off by default for the same reason the rest of the
  -- switches are: adding a feature must not change what an admin can do until an
  -- admin has asked for it. While this is off an account can be verified (the
  -- admin can still upload an ID and get the checks) but nothing is *required* —
  -- no account is refused a sign-in.
  ('id_verification_required', '0'),
  -- Which engine reads the ID. Empty means "use the best one that is configured",
  -- which is the local checker until a vendor key is present in the environment.
  -- Setting it to a name that is not available falls back to the same choice
  -- rather than failing — a feature that stops working when a key expires is
  -- worse than one that quietly gets less thorough.
  ('id_provider', ''),
  -- Read the text off the card on this machine, for free, with nothing sent
  -- anywhere. '1' is the default; store '0' to turn the on-device reader off
  -- without removing ID verification. Absent is read as on, so this row existing
  -- at all is a convenience rather than a requirement.
  --
  -- Its templates are hand-written, not trained — see
  -- src/lib/id-verification/ocr/templates.ts for why no open library exists for
  -- PhilSys or LTO — so this is the switch to reach for if it reads a card wrong.
  ('local_ocr_enabled', '1'),
  -- Whether a check asks for the turned-head angles as well as a straight-on
  -- face, once those angles have been enrolled.
  --
  -- '1' means the person presents front, then their left, then their right, and
  -- all three have to match. That is a slower check and a stronger one: a still
  -- photograph cannot produce a turned-head descriptor, so it is the one part of
  -- this feature that resists a printed photo being held up at a till.
  --
  -- '0' keeps the turned-head photos on the account as reference images for an
  -- admin but verifies on the straight-on shot alone. This is the switch to
  -- reach for if real staff are refused at the side angles — the descriptors for
  -- a turned head are the least reliable thing this model produces, and no set of
  -- captured side samples has been measured here yet. Accounts enrolled before
  -- the side angles existed are unaffected either way: they simply have no side
  -- samples, so a check for them is one shot.
  ('face_require_profile_angles', '1'),
  -- Which face engine the cafe is using: 'legacy' (the 128-float model this app
  -- shipped with) or 'sface' (YuNet + SFace, see src/lib/face-sface.ts).
  --
  -- The two produce embeddings in different spaces and cannot be compared. Every
  -- stored sample records which engine made it, and a check only ever compares
  -- against samples from the engine in use — so flipping this does not silently
  -- compare a new embedding against an old one and call a real person a stranger.
  -- What it does instead is report that the account needs re-enrolling, which is
  -- the honest state: switching engines invalidates every stored vector.
  --
  -- Deliberately not exposed as a switch on the Settings page yet. The capture
  -- screens still compute the legacy embedding, so flipping it would lock every
  -- staff member out until their face was re-enrolled. It is stored and enforced
  -- at matching time; the control arrives with the re-enrolment flow.
  ('face_engine', 'legacy'),
  -- How close the portrait printed on the card and the photo of the person must
  -- be to count as the same person. Cosine distance, like every other threshold
  -- in this app, so lower is stricter — but see lib/id-verification/local.ts,
  -- where the default is far looser than face_match_threshold and the reason is
  -- measured rather than chosen.
  ('id_face_match_threshold', '0.55')
on conflict (key) do nothing;

-- ---------- roles ----------
-- The conceptual ERD carries ROLE as its own entity. It became a text column on
-- USER first, because the system recognises exactly two roles and a join to look
-- them up was cost without benefit. This table exists so the ERD matches the
-- schema and so a third role can be added without a migration, but users.role
-- stays the column the application reads: moving every query onto a role_id join
-- would be a large change to the hot authentication path for no runtime gain.
-- roles.name is the single source of truth for the vocabulary; users.role is
-- constrained to it by the check below, so the two cannot drift apart.
create table if not exists roles (
  id          serial primary key,
  name        text unique not null,
  description text
);

insert into roles (name, description) values
  ('admin', 'Owner or manager. Full access, including user and settings management.'),
  ('staff', 'Cook or barista. Performs movements and submits new items.')
on conflict (name) do nothing;

-- ---------- users ----------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  password_hash text not null,
  full_name     text not null,
  role          text not null check (role in ('admin','staff')),
  qr_token      text unique,
  -- Whether this account may add, edit and delete items directly, instead of
  -- having an admin approve each new ingredient first. Granted per person by an
  -- admin (FR-03). null/false means the submit-then-approve path.
  can_manage_items boolean not null default false,
  -- Personal code a staff member can type when adding/editing an item, to
  -- skip the admin approval queue for that one submission (FR-03). Set by an
  -- admin; null means the staff member always goes through the queue.
  approval_code text,
  is_active     boolean not null default true,
  -- Why and when an admin switched the account off. Surfaced to the person
  -- trying to sign in, so they know who to talk to.
  deactivation_reason text,
  deactivated_at      timestamptz,
  created_at    timestamptz not null default now()
);

-- Migration for databases created before the deactivation trail existed.
-- `create table if not exists` never alters an existing table, so the columns
-- are added separately — and idempotently, which keeps this file re-runnable.
alter table users add column if not exists deactivation_reason text;
alter table users add column if not exists deactivated_at timestamptz;
alter table users add column if not exists can_manage_items boolean not null default false;
alter table users add column if not exists approval_code text;

-- Employment details an admin records when hiring. Both optional, both editable
-- later — a cafe learns them after the interview: someone starts as "Crew" and is
-- a Barista a fortnight in, and a start date is often only settled once the first
-- payroll has been run.
--
-- `start_date` is a plain date, not a timestamp: "the day they started" has no
-- time of day, and storing one only invites a timezone to be interpreted against
-- it later.
alter table users add column if not exists position   text;
alter table users add column if not exists start_date date;

-- First name and surname, kept apart because that is how a cafe refers to the
-- people it hires — "who is on bar today" — and because a roster sorted by
-- surname is a different thing from one sorted by full name.
--
-- `full_name` stays as the canonical display string rather than being replaced,
-- so every screen that already shows a name — the staff list, the printed badge
-- label, the audit log, transaction history — keeps working untouched, and an
-- account enrolled before these columns existed is not left nameless. The two are
-- composed on the way in; see api/users.
--
-- Both nullable, and both empty on every row that predates this. The staff page
-- falls back to the stored full_name when either is missing, so nothing renders
-- blank for an existing account.
alter table users add column if not exists first_name text;
alter table users add column if not exists last_name text;

-- ---------- duty face verification ----------
-- Staff confirm who they are once per duty, at the point where they would
-- otherwise walk straight into the app. After that they work normally until the
-- window runs out — this is a gate on entering, not a check on every action.
--
-- The reference photo and the face embedding taken from it. Both are `text`,
-- deliberately: supabase-js returns a `bytea` column in one representation and
-- PGlite in another, and src/lib/local-db.ts is a hand-written subset of the
-- PostgREST builder that would then have to know both. Text arrives identically
-- from both. The cost is ~33% over base64, which is nothing — a 256x256 JPEG at
-- q0.85 is ~30KB and the embedding ~1.5KB.
alter table users add column if not exists face_image       text;
alter table users add column if not exists face_embedding   text;
alter table users add column if not exists face_enabled     boolean not null default false;
alter table users add column if not exists face_enrolled_at timestamptz;
-- Which admin took the picture. Kept apart from the photo because "who put this
-- face on this account" is the first question when a barista who looks nothing
-- like the picture cannot get in.
alter table users add column if not exists face_enrolled_by uuid references users(id) on delete set null;

-- When this person last passed the check. The whole window is one comparison
-- against this column, so it is on `users` rather than in a table: the history
-- of individual attempts is already in the hash-chained audit log, and a query
-- per page load does not want a join to find one timestamp.
--
-- Null means never, which always reads as "must verify" — the safe direction for
-- an account that has a face enrolled.
alter table users add column if not exists last_face_verified_at timestamptz;

-- ---------- ID verification ----------
-- When an admin hires someone they photograph the person's government ID and a
-- photo of the person, and decide whether the two agree. The account cannot be
-- used until an admin has done that.
--
-- Nothing here is automatic. The checks a machine can run — reading the text off
-- the card, comparing the printed portrait with the photo, spotting an obviously
-- doctored image — produce *signals* that the admin sees beside the two images.
-- `verification_status` is only ever moved by a human pressing Approve or Reject.
-- That is deliberate: a false "verified" is a stranger with a till, and a false
-- "rejected" is a real hire who cannot work, so the call has to be someone's.
--
-- The images are `text`, for the same reason users.face_image is: supabase-js and
-- PGlite serialise `bytea` differently and src/lib/local-db.ts is a hand-written
-- subset of the PostgREST builder that would otherwise have to know both.
--
-- The cost is real and it is why these columns are never in the users list
-- query. A front ID plus a back plus a portrait, base64-encoded, is a few hundred
-- kilobytes per person; USER_COLUMNS is selected on every page load. See
-- api/users/route.ts.
alter table users add column if not exists id_doc_front  text;
alter table users add column if not exists id_doc_back   text;
alter table users add column if not exists id_photo      text;

-- What kind of ID it is, and the number printed on it. The number is kept because
-- an admin re-checking a hire months later needs to know which card was seen, and
-- a cafe verifying its staff is not a regulated KYC process with a retention
-- schedule — it is a small business keeping a record of who works there.
alter table users add column if not exists id_doc_type   text;
alter table users add column if not exists id_doc_number text;

-- A 64-bit perceptual fingerprint of the front of the card, as 16 hex characters.
--
-- Compared against every other account's fingerprint to catch one card covering two
-- people — the reuse that actually happens in a cafe, and the one no format check
-- or portrait comparison can see. See src/lib/id-verification/card-hash.ts.
--
-- A fingerprint, not the image and not anything reversible: 64 bits describing
-- where the light and dark fall across the card. It cannot be turned back into a
-- photograph, and the photograph is already in `id_doc_front` next to it.
alter table users add column if not exists id_card_hash  text;

-- The live step-two ticket for this account, or null.
--
-- Staff sign-in is two steps: a password, then a face or an ID card. The ticket
-- carrying "who is signing in" between them keeps its nonce here, and redeeming
-- it overwrites this column. That is what makes a ticket single-use across a
-- restart and across processes, which an in-memory "already spent" set is not.
-- See src/lib/auth/step2-ticket.ts.
alter table users add column if not exists step2_nonce text;

-- What the checks read off the document, and what they concluded. Both jsonb:
-- the shape of a provider's answer is not something to freeze into a migration,
-- and neither backend needs a column list for them. `id_signals` is the evidence
-- shown to the admin beside the images — never a bare verdict.
alter table users add column if not exists id_fields  jsonb;
alter table users add column if not exists id_signals jsonb;

-- Which provider produced `id_signals`, so an admin looking at a stored result
-- six months later can tell whether it came from a local check or a vendor call.
alter table users add column if not exists id_provider text;

-- Added nullable first, then backfilled, then constrained — see below. A plain
-- `add column not null default` would be one statement and would also be wrong,
-- because the default would then apply to the very rows being grandfathered.
alter table users add column if not exists verification_status text;

-- Who was hired, who was rejected, and why.
--
-- 'unverified' is the only status a new account starts in. The seeded first-run
-- accounts are grandfathered to 'verified' below, because they were created by
-- the setup script rather than by an admin who had an ID in front of them, and
-- locking the owner out of a fresh install on the first sign-in would make the
-- app look broken.
update users set verification_status = 'verified' where verification_status is null;

alter table users alter column verification_status set default 'unverified';

alter table users drop constraint if exists users_verification_status_check;
alter table users add constraint users_verification_status_check
  check (verification_status in ('unverified','verified','rejected'));

-- The note an admin gave when rejecting. Kept beside the status rather than only
-- in the audit log because it is the thing they will want to read first when
-- someone asks why this account was refused.
alter table users add column if not exists verification_notes text;
alter table users add column if not exists verified_at timestamptz;
alter table users add column if not exists verified_by uuid references users(id) on delete set null;

-- A pending "check this person on their phone instead" handover, for a register
-- with no camera of its own.
--
-- The code is the credential here and nowhere else: it identifies *which* duty
-- check is being confirmed and proves nothing about *who* is confirming. The
-- match is against the embedding already enrolled for `user_id`, which the phone
-- never gets to choose. So a photographed QR, a guessed code and a stranger's
-- phone all still need the enrolled person's actual face.
create table if not exists face_challenges (
  id          uuid primary key default gen_random_uuid(),
  -- 128 bits of randomness. The QR encodes this and nothing else.
  code        text unique not null,
  -- The session that asked, as a hash of its cookie rather than the cookie
  -- itself: a challenge must die with the session that made it, and a database
  -- that leaked should not leak a live session token. Same technique as
  -- tokenKey() in src/lib/rate-limit.ts.
  session_key text not null,
  user_id     uuid not null references users(id) on delete cascade,
  attempts    int not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  -- Set the moment a face matches. A challenge is single-use: a QR left on a
  -- till for a shift must not stay good for the next person who photographs it.
  consumed_at timestamptz
);

-- Sweeping expired and spent rows walks this; the session lookup uses the other.
create index if not exists idx_face_challenges_session on face_challenges(session_key);
create index if not exists idx_face_challenges_live    on face_challenges(expires_at)
  where consumed_at is null;

-- ---------- categories / locations ----------
create table if not exists categories (
  id   uuid primary key default gen_random_uuid(),
  name text unique not null
);

create table if not exists locations (
  id   uuid primary key default gen_random_uuid(),
  name text unique not null,
  -- Minimum shelf life a batch must still have when it is received, in days.
  -- 7 means "refuse a delivery expiring in under a week"; null (the default)
  -- means this location has no such rule, which is right for dry storage where
  -- shelf life is not the deciding factor. Set per location rather than per
  -- item so the rule is a property of the storage, not of the stock.
  min_shelf_life_days integer check (min_shelf_life_days is null or min_shelf_life_days >= 0)
);

-- Migration for locations created before the minimum shelf life rule existed.
alter table locations add column if not exists min_shelf_life_days integer;

-- ---------- items (ingredients) ----------
create table if not exists items (
  id                 uuid primary key default gen_random_uuid(),
  sku                text unique not null,
  name               text not null,
  category_id        uuid references categories(id) on delete set null,
  location_id        uuid references locations(id) on delete set null,
  physical_form      text not null default 'solid' check (physical_form in ('liquid','powder','solid')),
  unit               text not null default 'pcs',
  -- How many `unit`s arrive in one box of this item, when it is supplied in
  -- boxes rather than loose. 12 means a delivery of 3 boxes is 36 pcs. null
  -- (the default) means the item is counted by its own unit only, which is the
  -- right answer for anything not actually supplied in cartons.
  units_per_box      numeric(12,3) check (units_per_box is null or units_per_box > 0),
  quantity           numeric(12,3) not null default 0 check (quantity >= 0),
  low_stock_threshold numeric(12,3) not null default 5,
  expiration_date    date,
  version            integer not null default 0,
  -- 'active'  — counts as stock, appears everywhere.
  -- 'pending' — submitted by staff without item-management permission; held for
  --             an admin to approve or reject (FR-03). Excluded from stock
  --             figures, alerts and transactions until approved, so an unapproved
  --             ingredient can never be checked out or counted.
  -- 'rejected'— refused by an admin, kept with the reason for the record.
  item_status text not null default 'active'
    check (item_status in ('active','pending','rejected')),
  -- Who submitted it, and who decided. Both nullable: an item added by an admin
  -- needs no approval, and a row predating this has neither.
  submitted_by  uuid references users(id) on delete set null,
  submitted_at  timestamptz,
  reviewed_by   uuid references users(id) on delete set null,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Migration for items created before per-box packaging existed.
alter table items add column if not exists units_per_box numeric(12,3);

-- Migration for the submit-then-approve flow (FR-03).
alter table items add column if not exists item_status text not null default 'active';
alter table items add column if not exists submitted_by uuid references users(id) on delete set null;
alter table items add column if not exists submitted_at timestamptz;
alter table items add column if not exists reviewed_by uuid references users(id) on delete set null;
alter table items add column if not exists reviewed_at timestamptz;
alter table items add column if not exists review_note text;

-- Smart inventory columns (added 2026-10-09).
alter table items add column if not exists expirable boolean not null default true;
alter table items add column if not exists par_level numeric(12,3);
alter table items add column if not exists target_days numeric(12,3);

-- Enforce: a non-expirable item must not carry an expiry date.
alter table items drop constraint if exists items_expirable_check;
alter table items add constraint items_expirable_check
  check (expirable = true or expiration_date is null);

-- Approving a submission or rejecting one is an ordinary item update with two
-- things a plain UPDATE cannot do: it must refuse to run on an item that is not
-- actually awaiting a decision, and it must stamp who decided. Both in one
-- statement, so a route cannot mark an item reviewed and then fail before
-- recording it.
create or replace function review_item(
  p_item_id  uuid,
  p_actor_id uuid,
  p_decision text,     -- 'approve' | 'reject'
  p_note     text default null
) returns items
language plpgsql
security definer
as $$
declare
  v_row items;
begin
  if p_decision not in ('approve','reject') then
    raise exception 'decision must be approve or reject, got %', p_decision;
  end if;

  update items
     set item_status = case when p_decision = 'approve' then 'active' else 'rejected' end,
         reviewed_by = p_actor_id,
         reviewed_at = now(),
         review_note = p_note,
         updated_at = now()
   where id = p_item_id
     -- Only a pending item is awaiting a decision. Re-reviewing an active item
     -- would silently overwrite its reviewer, so it is refused here.
     and item_status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'item is not awaiting approval';
  end if;

  return v_row;
end;
$$;

-- ---------- item change requests (FR-03) ----------
-- A staff member without item-management permission cannot edit a live item
-- directly: their change is queued here and only lands on the item when an
-- admin approves it. review_change_request applies that atomically, so an
-- approved edit and its reviewer are recorded together.
create table if not exists item_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid references items(id) on delete cascade,
  requested_by       uuid references users(id) on delete set null,
  requested_at       timestamptz not null default now(),
  status             text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  reviewed_by        uuid references users(id) on delete set null,
  reviewed_at        timestamptz,
  review_note        text,
  -- What the item looked like when this was requested, so approving a stale
  -- proposal is refused rather than silently overwriting a newer edit.
  base_version       integer not null default 0,
  -- Proposed values; null means "leave unchanged".
  name               text,
  category_id        uuid references categories(id) on delete set null,
  location_id        uuid references locations(id) on delete set null,
  physical_form      text check (physical_form in ('liquid','powder','solid')),
  unit               text,
  units_per_box      numeric(12,3),
  quantity           numeric(12,3) check (quantity is null or quantity >= 0),
  low_stock_threshold numeric(12,3),
  expiration_date    date,
  correction_reason  text,
  unit_price        numeric(12,2)
);

create or replace function review_change_request(
  p_request_id uuid,
  p_actor_id   uuid,
  p_decision   text,     -- 'approve' | 'reject'
  p_note       text default null
) returns item_change_requests
language plpgsql
security definer
as $$
declare
  v_req item_change_requests;
  v_item items;
begin
  if p_decision not in ('approve','reject') then
    raise exception 'decision must be approve or reject, got %', p_decision;
  end if;

  update item_change_requests
     set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
         reviewed_by = p_actor_id,
         reviewed_at = now(),
         review_note = p_note
   where id = p_request_id
     and status = 'pending'
  returning * into v_req;

  if not found then
    raise exception 'change request is not awaiting approval';
  end if;

  if p_decision = 'approve' then
    update items
       set name = coalesce(v_req.name, name),
           category_id = coalesce(v_req.category_id, category_id),
           location_id = coalesce(v_req.location_id, location_id),
           physical_form = coalesce(v_req.physical_form, physical_form),
           unit = coalesce(v_req.unit, unit),
           units_per_box = coalesce(v_req.units_per_box, units_per_box),
           quantity = coalesce(v_req.quantity, quantity),
           low_stock_threshold = coalesce(v_req.low_stock_threshold, low_stock_threshold),
           expiration_date = coalesce(v_req.expiration_date, expiration_date),
           unit_price = coalesce(v_req.unit_price, unit_price),
           version = version + case when v_req.quantity is not null then 1 else 0 end,
           updated_at = now()
     where id = v_req.item_id
       and version = v_req.base_version
    returning * into v_item;

    if not found then
      raise exception 'item was changed after this request was made — reject it and ask again';
    end if;
  end if;

  return v_req;
end;
$$;

-- ---------- transactions ----------
create table if not exists transactions (
  id         uuid primary key default gen_random_uuid(),
  type       text not null check (type in ('checkout','restock','waste')),
  actor_id   uuid references users(id) on delete set null,
  actor_name text not null,
  note       text,
  created_at timestamptz not null default now()
);

create table if not exists transaction_items (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  item_id        uuid references items(id) on delete set null,
  sku            text not null,
  item_name      text not null,
  quantity       numeric(12,3) not null,
  qty_before     numeric(12,3) not null,
  qty_after      numeric(12,3) not null,
  expiration_date date
);

-- ---------- audit trail (hash chained, append-only) ----------
create table if not exists audit_log (
  seq         bigserial primary key,
  actor_id    uuid,
  actor_name  text not null,
  action      text not null,
  entity_type text,
  entity_id   text,
  details     jsonb not null default '{}'::jsonb,
  prev_hash   text not null,
  entry_hash  text not null,
  -- Where the action came from, and how it turned out.
  --
  -- Deliberately NOT part of entry_hash. The digest is computed over the fields
  -- above, which are the ones that were already covered when the chain started;
  -- adding these two would make every existing row fail verify_audit_chain,
  -- because the stored hash could not be recomputed under a formula that did not
  -- exist at write time. A chain is only worth having if it verifies, so these
  -- sit beside the hash rather than inside it. They are still append-only in
  -- practice (nothing in the app updates audit_log) and they answer "where from"
  -- and "did it work", which the action name alone cannot.
  ip_address  text,
  outcome     text,
  created_at  timestamptz not null default now()
);

-- Migration for chains created before these two columns existed.
alter table audit_log add column if not exists ip_address text;
alter table audit_log add column if not exists outcome text;

-- ---------- alerts ----------
create table if not exists alerts (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid references items(id) on delete cascade,
  type        text not null check (type in ('low_stock','out_of_stock','near_expiry','expired')),
  message     text not null,
  resolved    boolean not null default false,
  resolved_by text,
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------- failed / successful login attempts ----------
create table if not exists login_attempts (
  id         bigserial primary key,
  username   text,
  method     text not null,
  success    boolean not null,
  created_at timestamptz not null default now()
);

-- ---------- email (FR-11) ----------
-- Recipients and the queue. Alerts are raised by refresh_alerts() as before;
-- this only decides who hears about them.

create table if not exists email_recipients (
  id            uuid primary key default gen_random_uuid(),
  email_address text unique not null,
  display_name  text,
  is_active     boolean not null default true,
  -- Which alert families this address wants. Empty means "everything", which is
  -- the right default for a single-owner cafe: a recipient added by the owner
  -- should not silently miss the low-stock mail they signed up for by ticking
  -- the wrong box. A non-empty list is an explicit opt-out from the rest.
  --   low_stock | near_expiry | out_of_stock | expired | daily_summary
  --   | failed_login | reports
  subscriptions text[] not null default '{}',
  created_at    timestamptz not null default now()
);

-- One row per queued message. Written when an alert fires, marked sent once
-- SMTP accepts it. `attempts` and `last_error` drive the retry; `dedupe_key`
-- is what stops the same alert becoming the same email repeatedly (NFR-07).
create table if not exists email_notifications (
  id           uuid primary key default gen_random_uuid(),
  alert_id     uuid references alerts(id) on delete cascade,
  recipient_id uuid references email_recipients(id) on delete cascade,
  -- low_stock | near_expiry | out_of_stock | expired | daily_summary
  -- | failed_login | report
  kind         text not null,
  subject      text not null,
  body         text not null,
  -- queued | sending | sent | failed
  status       text not null default 'queued'
    check (status in ('queued','sending','sent','failed')),
  attempts     integer not null default 0,
  last_error   text,
  -- Identifies the trigger so a repeat within the suppression window is dropped.
  -- Alerts use 'alert:<alert_id>', the daily summary uses the date.
  dedupe_key   text,
  queued_at    timestamptz not null default now(),
  sent_at      timestamptz,
  -- Set when a row was created but not sent because the same dedupe_key had
  -- already gone out inside the window. Kept for the admin's own visibility.
  suppressed   boolean not null default false
);

create index if not exists idx_email_notif_status on email_notifications(status);
create index if not exists idx_email_notif_dedupe on email_notifications(dedupe_key);
create index if not exists idx_items_status      on items(item_status);
create index if not exists idx_items_submitted   on items(submitted_at desc);

-- ---------- indexes ----------
create index if not exists idx_items_sku       on items(sku);
create index if not exists idx_items_expiry    on items(expiration_date);
create index if not exists idx_audit_seq       on audit_log(seq);
create index if not exists idx_alerts_resolved on alerts(resolved);
create index if not exists idx_txn_created     on transactions(created_at desc);
create index if not exists idx_txn_items_txn   on transaction_items(transaction_id);

-- ---------- indexes for the queries the app actually makes ----------
--
-- The item list is the busiest query in the app: it runs on every page of the
-- list, behind the search box on every keystroke, and under the checkout page's
-- 500-row fetch. These cover what it does that was unindexed.
--
-- On the embeds: local-db.ts renders `category:categories(id, name)` as a
-- correlated subquery, `... where c.id = t.category_id`, which probes
-- categories' *primary* key once per row. So the embed never needed an index on
-- the foreign key. These two exist because `?category=` is a real filter
-- (api/items/route.ts) and because locations and categories are deleted with
-- `on delete set null`, which has to find their items first — the same reason
-- idx_items_supplier exists below.
create index if not exists idx_items_category    on items(category_id);
create index if not exists idx_items_location    on items(location_id);

-- The default sort for GET /api/items is name, sku. Without this the list
-- sorted every matching row on every request; with it Postgres walks the index
-- and only sorts ties.
create index if not exists idx_items_name        on items(name);

-- `?submitted_by=me` is how a barista sees their own submissions across every
-- approval state (api/items/route.ts).
create index if not exists idx_items_submitted_by on items(submitted_by);

-- History and reports both filter transactions by kind and by who moved the
-- stock; idx_txn_created above covers the date window these combine with. The
-- staff filter takes a uuid or a display name, so it needs both.
create index if not exists idx_txn_type        on transactions(type);
create index if not exists idx_txn_actor_id    on transactions(actor_id);
create index if not exists idx_txn_actor_name  on transactions(actor_name);

-- ============================================================
-- FUNCTION: append_audit  (atomic hash-chained append)
-- ============================================================
create or replace function append_audit(
  p_actor_id    uuid,
  p_actor_name  text,
  p_action      text,
  p_entity_type text,
  p_entity_id   text,
  p_details     jsonb,
  -- Optional, and deliberately outside the hash. See the column comments on
  -- audit_log: adding these to the digest would invalidate every row written
  -- under the earlier formula, and a chain that does not verify is worthless.
  -- They have defaults so existing six-argument callers keep working unchanged.
  p_ip_address  text default null,
  p_outcome     text default null
) returns audit_log
language plpgsql
security definer
as $$
declare
  v_prev  text;
  v_row   audit_log;
  v_hash  text;
begin
  -- serialize writers so the chain can't fork
  lock table audit_log in exclusive mode;

  select entry_hash into v_prev from audit_log order by seq desc limit 1;
  v_prev := coalesce(v_prev, 'GENESIS');

  insert into audit_log (actor_id, actor_name, action, entity_type, entity_id, details, prev_hash, entry_hash, ip_address, outcome)
  values (p_actor_id, p_actor_name, p_action, p_entity_type, p_entity_id,
          coalesce(p_details, '{}'::jsonb), v_prev, '', p_ip_address, p_outcome)
  returning * into v_row;

  -- Unchanged from the original formula on purpose. Do not add p_ip_address or
  -- p_outcome here without reading the note above.
  v_hash := encode(digest(
      v_row.seq::text || '|' || v_prev || '|' || p_actor_name || '|' || p_action || '|' ||
      coalesce(p_entity_type,'') || '|' || coalesce(p_entity_id,'') || '|' ||
      coalesce(p_details, '{}'::jsonb)::text,
      'sha256'), 'hex');

  update audit_log set entry_hash = v_hash where seq = v_row.seq returning * into v_row;
  return v_row;
end;
$$;

-- ============================================================
-- FUNCTION: verify_audit_chain
-- Returns rows where the chain breaks. Empty = intact.
-- ============================================================
create or replace function verify_audit_chain()
returns table(broken_seq bigint, reason text)
language plpgsql
as $$
declare
  r          record;
  v_prev     text := 'GENESIS';
  v_expected text;
begin
  for r in select * from audit_log order by seq asc loop
    if r.prev_hash <> v_prev then
      broken_seq := r.seq; reason := 'prev_hash mismatch'; return next; return;
    end if;

    v_expected := encode(digest(
        r.seq::text || '|' || r.prev_hash || '|' || r.actor_name || '|' || r.action || '|' ||
        coalesce(r.entity_type,'') || '|' || coalesce(r.entity_id,'') || '|' ||
        r.details::text,
        'sha256'), 'hex');

    if v_expected <> r.entry_hash then
      broken_seq := r.seq; reason := 'entry_hash mismatch'; return next; return;
    end if;

    v_prev := r.entry_hash;
  end loop;
end;
$$;

-- ============================================================
-- FUNCTION: process_transaction
-- Atomic multi-item checkout / restock / waste.
-- Uses row locks + optimistic version check. Cannot go negative.
-- ============================================================
create or replace function process_transaction(
  p_type       text,
  p_actor_id   uuid,
  p_actor_name text,
  p_items      jsonb,   -- [{"sku":"CT-COF-1234","qty":2,"exp":"2026-04-01"}, ...]
  p_note       text default null
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_txn_id  uuid;
  v_req     record;
  v_row     items;
  v_new_qty numeric(12,3);
  v_exp     date;
  v_min_days integer;
  v_loc     text;
  v_results jsonb := '[]'::jsonb;
begin
  if p_type not in ('checkout','restock','waste') then
    raise exception 'invalid transaction type: %', p_type;
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'no items in transaction';
  end if;

  insert into transactions (type, actor_id, actor_name, note)
  values (p_type, p_actor_id, p_actor_name, p_note)
  returning id into v_txn_id;

  for v_req in
    select (e->>'sku') as sku, (e->>'qty')::numeric as qty,
           nullif(btrim(e->>'exp'), '') as exp_text,
           (e->>'boxes')::numeric as boxes
    from jsonb_array_elements(p_items) e
  loop
    -- The quantity is checked at the END of this block, not here. A line that
    -- gives `boxes` instead of `qty` arrives with no quantity at all, so a check
    -- up front would reject every box restock as "invalid quantity" before the
    -- conversion had a chance to fill it in.

    -- Postgres rolls an impossible day like 2026-02-30 over into March rather
    -- than rejecting it, so the expiry alerts would then be driven by a date
    -- nobody entered. Cast to date and re-format to catch that, and reject
    -- anything that is not YYYY-MM-DD outright.
    v_exp := null;
    if v_req.exp_text is not null then
      if v_req.exp_text !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'invalid expiry date for %', v_req.sku;
      end if;
      begin
        v_exp := v_req.exp_text::date;
      exception when others then
        raise exception 'invalid expiry date for %', v_req.sku;
      end;
      if to_char(v_exp, 'YYYY-MM-DD') <> v_req.exp_text then
        raise exception 'invalid expiry date for %', v_req.sku;
      end if;
    end if;

    select * into v_row from items where sku = v_req.sku for update;
    if not found then
      raise exception 'item not found: %', v_req.sku;
    end if;

    -- A submitted-but-unapproved item is not stock (FR-03). It must not be
    -- moved, restocked or written off before an admin has seen it, or the
    -- approval step becomes decorative.
    if v_row.item_status <> 'active' then
      if v_row.item_status = 'pending' then
        raise exception
          '% is awaiting admin approval and cannot be used yet', v_row.name;
      else
        raise exception '% was rejected by an admin and is not in use', v_row.name;
      end if;
    end if;

    -- Per-box packaging. A restock may be counted in boxes instead of the
    -- item's own unit, which is what a supplier invoice actually says. The
    -- conversion happens here rather than in the UI because the factor lives on
    -- the item, and a client that guessed it would put the wrong number in
    -- stock. Stock is always ultimately stored in the item's own unit.
    if v_req.boxes is not null then
      if p_type <> 'restock' then
        raise exception 'boxes can only be given for a restock of %', v_req.sku;
      end if;
      if v_req.boxes <= 0 then
        raise exception 'invalid box count for %', v_req.sku;
      end if;
      if v_row.units_per_box is null then
        raise exception '% is not stocked by the box', v_row.name;
      end if;
      v_req.qty := v_req.boxes * v_row.units_per_box;
    end if;

    -- Now that any box count has been converted, there must be a real quantity
    -- to move. This is the only place it is checked, so a line that gave neither
    -- a quantity nor a box count is refused here rather than becoming a
    -- zero-value movement.
    if v_req.qty is null or v_req.qty <= 0 then
      raise exception 'invalid quantity for %', v_req.sku;
    end if;

    -- Minimum shelf life on receipt. A location can refuse stock that arrives
    -- already too close to its date — the point of a freezer is that things keep
    -- for months, so a delivery with days left is not worth taking. Only a
    -- restock with a date can be judged; a line with no date is not this
    -- function's business, and a checkout or waste log never has new stock.
    if p_type = 'restock' and v_exp is not null then
      select l.min_shelf_life_days, l.name into v_min_days, v_loc
        from locations l where l.id = v_row.location_id;

      if v_min_days is not null
         and v_exp < current_date + (v_min_days || ' days')::interval then
        raise exception
          '% expires on % — % needs at least % more day(s) of shelf life on arrival',
          v_row.name, v_exp, coalesce(v_loc, 'that location'), v_min_days;
      end if;
    end if;

    if p_type in ('checkout','waste') then
      if v_row.quantity <= 0 then
        raise exception 'cannot deduct from % — out of stock (have 0, need %)',
          v_row.sku, v_req.qty;
      end if;
      if v_row.quantity < v_req.qty then
        raise exception 'insufficient stock for % (have %, need %)',
          v_row.sku, v_row.quantity, v_req.qty;
      end if;
      v_new_qty := v_row.quantity - v_req.qty;
    else
      v_new_qty := v_row.quantity + v_req.qty;
    end if;

    -- A restock may carry the new batch's expiry date. checkout and waste
    -- deliberately do not: receiving stock is the only moment the date is
    -- known, and leaving it alone everywhere else keeps a stale date from
    -- being silently extended or cleared. A line with no date keeps whatever
    -- the item already had, rather than nulling it.
    update items
       set quantity = v_new_qty,
           version = version + 1,
           updated_at = now(),
           expiration_date = case
             when p_type = 'restock' and v_exp is not null then v_exp
             else expiration_date
           end
     where id = v_row.id and version = v_row.version;

    if not found then
      raise exception 'concurrent modification on % — please retry', v_row.sku;
    end if;

    insert into transaction_items
      (transaction_id, item_id, sku, item_name, quantity, qty_before, qty_after, expiration_date)
    values
      (v_txn_id, v_row.id, v_row.sku, v_row.name, v_req.qty, v_row.quantity, v_new_qty,
       case
         when p_type = 'restock' and v_exp is not null then v_exp
         else v_row.expiration_date
       end);

    v_results := v_results || jsonb_build_object(
      'sku', v_row.sku,
      'name', v_row.name,
      'unit', v_row.unit,
      'before', v_row.quantity,
      'after', v_new_qty,
      -- What was actually added, in the item's own unit. When the line was
      -- given in boxes this is the converted figure, so the caller can show
      -- "3 boxes = 36 pcs" rather than silently restocking the wrong amount.
      'added', v_new_qty - v_row.quantity,
      'boxes', case when v_req.boxes is not null then v_req.boxes end,
      'units_per_box', v_row.units_per_box,
      -- The date as it now stands, so a caller can see whether a supplied
      -- expiry was applied or the previous one kept.
      'expiration', case
        when p_type = 'restock' and v_exp is not null
          then to_char(v_exp, 'YYYY-MM-DD')
        else to_char(v_row.expiration_date, 'YYYY-MM-DD')
      end
    );
  end loop;

  return jsonb_build_object(
    'transaction_id', v_txn_id,
    'type', p_type,
    'items', v_results
  );
end;
$$;

-- ============================================================
-- FUNCTION: enqueue_email_alerts  (FR-11)
-- Turns newly-open alerts into queued email_notifications rows.
--
-- Called from refresh_alerts() after the alert rows exist, and safe to call
-- repeatedly: the dedupe_key below is what stops one alert becoming fifty
-- emails, since refresh_alerts runs after every movement.
--
-- Returns the number of rows queued. Zero is the normal case on a cafe with no
-- recipients configured, and is not an error.
-- ============================================================
create or replace function enqueue_email_alerts()
returns integer
language plpgsql
security definer
as $$
declare
  v_window_hours integer;
  v_queued       integer := 0;
  v_total        integer := 0;
  v_body         text;
  v_alert        record;
begin
  -- Suppression window (NFR-07: no duplicate for the same item within 24h).
  select coalesce(value::int, 24) into v_window_hours
    from settings where key = 'email_dedupe_hours';
  v_window_hours := coalesce(v_window_hours, 24);

  -- No recipients, no work. Checked first so the common case is one index probe.
  if not exists (select 1 from email_recipients where is_active) then
    return 0;
  end if;

  for v_alert in
    select a.id, a.type, a.message, a.created_at
      from alerts a
     where a.resolved = false
       -- Only alerts raised from here on. Without this a backfill would mail
       -- the owner about every open alert the day the feature was switched on.
       and a.created_at > now() - make_interval(hours => v_window_hours)
  loop
    v_body := v_alert.message || ' (' || v_alert.type || ')';

    insert into email_notifications
      (alert_id, recipient_id, kind, subject, body, dedupe_key)
    select v_alert.id,
           r.id,
           v_alert.type,
           'CafeTrack: ' || initcap(replace(v_alert.type, '_', ' ')),
           v_body,
           'alert:' || v_alert.id::text || ':' || v_alert.type
      from email_recipients r
     where r.is_active
       -- Empty subscriptions means "send everything" — see the column comment.
       and (cardinality(r.subscriptions) = 0
            or v_alert.type = any (r.subscriptions))
       -- The suppression window, per recipient. Deliberately covers `queued` and
       -- `sending`, not just `sent`: refresh_alerts() runs after every
       -- movement, so an alert raised by a checkout and then by the restock a
       -- minute later would otherwise queue twice before either is sent. A
       -- `failed` row does not suppress — that one is meant to be retried.
       and not exists (
         select 1 from email_notifications e
          where e.dedupe_key = 'alert:' || v_alert.id::text || ':' || v_alert.type
            and e.recipient_id = r.id
            and e.status in ('queued','sending','sent')
            and e.queued_at > now() - make_interval(hours => v_window_hours)
       )
     on conflict do nothing;

    -- ROW_COUNT is per statement inside a loop, so it has to be accumulated
    -- rather than assigned — the loop body's last statement is the insert.
    GET DIAGNOSTICS v_queued = ROW_COUNT;
    v_total := v_total + v_queued;
  end loop;

  return v_total;
end;
$$;

-- The dedupe guarantee, enforced by the database rather than only by the loop
-- above, so two concurrent refreshes cannot both queue the same alert.
--
-- `failed` is excluded on purpose: an exhausted message must stay retryable, and
-- a unique index over every status would block the retry that NFR-07 requires.
-- The window itself is enforced by the loop; this index is the backstop against
-- a race, not the primary mechanism.
create unique index if not exists uq_email_notif_dedupe
  on email_notifications (dedupe_key, recipient_id)
  where status in ('queued','sending','sent') and dedupe_key is not null;

-- ============================================================
-- FUNCTION: enqueue_daily_summary  (FR-11)
-- One message a day covering what happened, not just what is open.
-- Dedupe key is the date, so running it twice in a day sends once.
-- ============================================================
create or replace function enqueue_daily_summary()
returns integer
language plpgsql
security definer
as $$
declare
  v_body   text;
  v_count  integer := 0;
begin
  if not exists (select 1 from email_recipients where is_active) then
    return 0;
  end if;

  select
      'Movements: ' || count(*)
   || E'\n  checked out: ' || count(*) filter (where type = 'checkout')
   || E'\n  restocked:   ' || count(*) filter (where type = 'restock')
   || E'\n  waste:       ' || count(*) filter (where type = 'waste')
  into v_body
    from transactions
   where created_at >= date_trunc('day', now());

  v_body := v_body || E'\n\nStill open: '
    || (select count(*) from alerts where resolved = false)
    || E'\n  low/out of stock: '
    || (select count(*) from alerts where resolved = false and type in ('low_stock','out_of_stock'))
    || E'\n  expiring/expired: '
    || (select count(*) from alerts where resolved = false and type in ('near_expiry','expired'))
    || E'\n\nFailed sign-in attempts today: '
    || (select count(*) from login_attempts where success = false and created_at >= date_trunc('day', now()));

  insert into email_notifications
    (recipient_id, kind, subject, body, dedupe_key)
  select r.id,
         'daily_summary',
         'CafeTrack daily summary — ' || to_char(current_date, 'DD Mon YYYY'),
         v_body,
         'daily_summary:' || current_date::text
    from email_recipients r
   where r.is_active
     and (cardinality(r.subscriptions) = 0 or 'daily_summary' = any (r.subscriptions))
     and not exists (
       select 1 from email_notifications e
        where e.dedupe_key = 'daily_summary:' || current_date::text
          and e.recipient_id = r.id
          and e.status in ('queued','sending','sent')
     )
  on conflict do nothing;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  return v_count;
end;
$$;

-- ============================================================
-- FUNCTION: enqueue_failed_login_alert  (FR-11)
-- Called by the sign-in routes after a rejected attempt. One message per
-- burst, not per keystroke: the dedupe key collapses repeats inside the
-- suppression window so a person fumbling their password does not generate
-- a dozen emails, while a real attempt an hour later still gets through.
-- ============================================================
create or replace function enqueue_failed_login_alert(p_username text, p_method text, p_reason text)
returns integer
language plpgsql
security definer
as $$
declare
  v_count integer := 0;
  v_body  text;
begin
  if not exists (select 1 from email_recipients where is_active) then
    return 0;
  end if;

  -- Deliberately does not name the credential: an unknown code is logged as a
  -- hash prefix, and putting the raw value in an email would undo that.
  v_body := 'A sign-in attempt was rejected.'
    || E'\n  method: ' || p_method
    || E'\n  reason: ' || p_reason
    || E'\n  when:   ' || to_char(now(), 'DD Mon YYYY HH24:MI')
    || E'\n\nIf this was not you, change the password for that account.';

  insert into email_notifications
    (recipient_id, kind, subject, body, dedupe_key)
  select r.id,
         'failed_login',
         'CafeTrack: rejected sign-in attempt',
         v_body,
         'failed_login:' || p_method || ':' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24')
    from email_recipients r
   where r.is_active
     and (cardinality(r.subscriptions) = 0 or 'failed_login' = any (r.subscriptions))
     and not exists (
       select 1 from email_notifications e
        where e.dedupe_key = 'failed_login:' || p_method || ':'
              || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24')
          and e.recipient_id = r.id
          and e.status in ('queued','sending','sent')
     )
  on conflict do nothing;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  return v_count;
end;
$$;

-- ============================================================
-- FUNCTION: refresh_alerts
-- Recomputes low-stock / out-of-stock / near-expiry / expired.
-- Auto-resolves alerts that no longer apply, and escalates an open
-- alert when the underlying condition gets worse.
-- ============================================================
create or replace function refresh_alerts()
returns void
language plpgsql
security definer
as $$
declare
  v_days int;
begin
  select coalesce(value::int, 7) into v_days from settings where key = 'expiry_warning_days';
  v_days := coalesce(v_days, 7);

  -- Escalate an open stock alert in place, before opening new ones.
  --
  -- The insert below only fires for an item with no open stock alert, so an
  -- item that drops below its threshold and then reaches zero used to keep
  -- saying "is low on stock (1 pcs left)" about an item sitting at zero. This
  -- rewrites the type and the message to match the item's current severity.
  -- The alert keeps its identity (same id, no new row), so nothing duplicates
  -- and the operator's history of it stays intact.
  update alerts a
     set type = case when i.quantity <= 0 then 'out_of_stock' else 'low_stock' end,
         message = case when i.quantity <= 0
                        then i.name || ' is out of stock'
                        else i.name || ' is low on stock (' || i.quantity || ' ' || i.unit || ' left)'
                   end
    from items i
   where i.id = a.item_id
     and a.resolved = false
     and a.type in ('low_stock','out_of_stock')
     and a.type is distinct from
         (case when i.quantity <= 0 then 'out_of_stock' else 'low_stock' end);

  -- Same for expiry: an item that crosses its date while its warning is open
  -- is expired, not merely expiring.
  update alerts a
     set type = case when i.expiration_date < current_date then 'expired' else 'near_expiry' end,
         message = case when i.expiration_date < current_date
                        then i.name || ' expired on ' || i.expiration_date
                        else i.name || ' expires on ' || i.expiration_date
                   end
    from items i
   where i.id = a.item_id
     and a.resolved = false
     and a.type in ('near_expiry','expired')
     and a.type is distinct from
         (case when i.expiration_date < current_date then 'expired' else 'near_expiry' end);

  -- open stock alerts
  insert into alerts (item_id, type, message)
  select i.id,
         case when i.quantity <= 0 then 'out_of_stock' else 'low_stock' end,
         case when i.quantity <= 0
              then i.name || ' is out of stock'
              else i.name || ' is low on stock (' || i.quantity || ' ' || i.unit || ' left)'
         end
  from items i
  -- item_status: a submitted or rejected ingredient is not stock yet, so it
  -- must not raise a low-stock or expiry alert. Without this a staff submission
  -- arriving at quantity 0 would email the owner about an item that does not
  -- officially exist.
  where i.item_status = 'active'
    and i.quantity <= i.low_stock_threshold
    and not exists (
      select 1 from alerts a
      where a.item_id = i.id and a.resolved = false
        and a.type in ('low_stock','out_of_stock')
    );

  -- open expiry alerts (skip non-expirable items)
  insert into alerts (item_id, type, message)
  select i.id,
         case when i.expiration_date < current_date then 'expired' else 'near_expiry' end,
         case when i.expiration_date < current_date
              then i.name || ' expired on ' || i.expiration_date
              else i.name || ' expires on ' || i.expiration_date
         end
  from items i
  where i.item_status = 'active'
    and i.expirable = true
    and i.expiration_date is not null
    and i.expiration_date <= current_date + (v_days || ' days')::interval
    and not exists (
      select 1 from alerts a
      where a.item_id = i.id and a.resolved = false
        and a.type in ('near_expiry','expired')
    );

  -- Email (FR-11). Queue one message per newly-opened alert, per recipient who
  -- subscribed to that family. Wrapped so a cafe with no recipients, or with
  -- email switched off, still gets its alerts: enqueue_email_alerts is called
  -- on every refresh_alerts, so it must never be able to fail the refresh.
  begin
    perform enqueue_email_alerts();
  exception when others then
    -- Swallowed on purpose. An alert that was raised must not be lost because
    -- the mail side had a problem; the queue is a convenience, not the record.
    null;
  end;

  -- auto-resolve stock alerts that cleared
  update alerts a
     set resolved = true, resolved_by = 'system', resolved_at = now()
   where a.resolved = false
     and a.type in ('low_stock','out_of_stock')
     and exists (
       select 1 from items i
       where i.id = a.item_id and i.quantity > i.low_stock_threshold
     );

  -- auto-resolve expiry alerts that cleared
  update alerts a
     set resolved = true, resolved_by = 'system', resolved_at = now()
   where a.resolved = false
     and a.type in ('near_expiry','expired')
     and exists (
       select 1 from items i
       where i.id = a.item_id
         and (i.expirable = false
              or i.expiration_date is null
              or i.quantity <= 0
              or i.expiration_date > current_date + (v_days || ' days')::interval)
     );
end;
$$;

-- ============================================================
-- RLS: lock everything down. The app talks to the DB through
-- the service-role key on the server only. No anon access.
-- ============================================================
alter table users             enable row level security;
alter table items             enable row level security;
alter table categories        enable row level security;
alter table locations         enable row level security;
alter table transactions      enable row level security;
alter table transaction_items enable row level security;
alter table audit_log         enable row level security;
alter table alerts            enable row level security;
alter table login_attempts    enable row level security;
alter table settings          enable row level security;
alter table face_challenges   enable row level security;

-- ============================================================
-- SMART INVENTORY additions (appended 2026-10-09)
-- ============================================================

-- ---------- category_defaults ----------
-- Default physical properties for new items in a category. When a new item is
-- added under a category that has a row here, the form pre-fills with these
-- values. One row per category (category_id is the primary key).
create table if not exists category_defaults (
  category_id          uuid primary key references categories(id) on delete cascade,
  default_unit         text,
  default_physical_form text
    check (default_physical_form is null
           or default_physical_form in ('liquid','powder','solid')),
  default_expirable    boolean not null default true
);

-- ---------- waste_events ----------
-- Detailed waste tracking. Each row is one waste event for one item, with the
-- reason and who recorded it. Separate from the transaction log so waste can
-- be analysed on its own (e.g. total waste cost per item per week) without
-- having to filter transactions by type.
create table if not exists waste_events (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id) on delete cascade,
  quantity    numeric(12,3) not null check (quantity > 0),
  reason      text not null,
  recorded_by uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_waste_events_item    on waste_events(item_id);
create index if not exists idx_waste_events_created on waste_events(created_at desc);

-- RLS on new tables (same pattern as the rest of the schema)
alter table category_defaults enable row level security;
alter table waste_events     enable row level security;

-- No policies created = no access for anon/authenticated roles.
-- The service role bypasses RLS, which is what our API routes use.

-- ============================================================
-- SUPPLIERS (appended 2026-10-09)
-- ============================================================

-- ---------- suppliers ----------
create table if not exists suppliers (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contact_name text,
  phone        text,
  email        text,
  created_at   timestamptz not null default now()
);

-- Add supplier_id to items (nullable, references suppliers(id) on delete set null)
alter table items add column if not exists supplier_id uuid references suppliers(id) on delete set null;

-- RLS on new table
alter table suppliers enable row level security;

-- Index for the foreign key
create index if not exists idx_items_supplier on items(supplier_id);

-- ============================================================
-- ACTIVE SESSION TRACKING (FR-16)
-- ============================================================
alter table users add column if not exists session_token text;
create unique index if not exists idx_users_session_token on users(session_token) where session_token is not null;
-- ============================================================
-- COST PRICE tracking (appended 2026-10-09)
-- ============================================================
alter table items add column if not exists unit_price numeric(12,2);
alter table item_change_requests add column if not exists unit_price numeric(12,2);

-- The ID-card sign-in lookup reads the staff rows and compares an OCR'd number
-- against this column. Indexed so that is a lookup rather than a scan as the table
-- grows; deliberately not unique, because two accounts holding one card is
-- something an admin resolves on the review screen, not something the database
-- should refuse outright. See db/migrate.sql for the full reasoning.
create index if not exists idx_users_id_doc_number on users(id_doc_number)
  where id_doc_number is not null;

-- ============================================================
-- THREE-ANGLE FACE ENROLMENT (appended 2026-10-25)
-- ============================================================
-- One row per angle a staff member's face was enrolled from: straight on, and
-- turned to their left and to their right.
--
-- Why a table rather than three more `text` columns on `users`
-- ------------------------------------------------------------
-- The embedding is the easy part to store either way. The hard part is that a
-- turned-head sample is only *usable* if the capture recorded how far the head
-- actually was from straight on, and that number has nowhere honest to live
-- beside a single `face_embedding` column. Two details made this concrete: an
-- angle stored without its measured turn cannot be told apart from a sample the
-- admin thought was a side view and was not, which is exactly the question that
-- makes "why does this person never verify" unanswerable months later.
--
-- A second reason is the delete. `users.face_embedding` is one column, so
-- revoking a face is one update; with three more columns it becomes four, and
-- adding a fourth angle later becomes a migration on the widest table in the
-- app. Here, revoking is `delete from user_face_samples where user_id = $1` and
-- a new angle is a one-line change to the check constraint below.
--
-- `users.face_embedding` and `users.face_image` are NOT removed. They keep being
-- written with the straight-on sample, because every account enrolled before
-- this table existed has exactly that and nothing else, and every check has to
-- keep working for it.
create table if not exists user_face_samples (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  -- Which way the head was turned. A check constraint rather than an enum so a
  -- fourth angle is a one-line change to this line in both schemas.
  pose        text not null check (pose in ('front', 'left', 'right')),
  -- 128 floats in the same comma-joined text form as users.face_embedding,
  -- written by formatEmbedding so the round trip through the database is exact.
  -- `text` for the same reason it is there: PGlite and supabase-js serialise a
  -- bytea column differently, and both of them return text identically.
  embedding   text not null,
  -- The frame this vector came from, ~30KB at 256x256 q0.85. Stored per angle
  -- rather than as one composite so an admin can see *which* angle was bad; a
  -- single image cannot answer that, which is the whole reason for the review.
  image       text,
  -- How far the head was turned, as the normalised signal lib/face.ts derives
  -- from the 68 landmarks (roughly -1 to 1, positive when the subject turned to
  -- their own left). A *proxy*, not a measured angle in degrees: face-api gives
  -- 2D landmarks and there is no head-pose solver here, so the honest thing to
  -- record is what the classification actually uses. See poseFromSignal.
  yaw_signal  real,
  -- Detector confidence for the frame, 0..1. Kept so the review screen can say
  -- "this sample was weak" rather than leaving a poor enrolment to be discovered
  -- as a person who cannot get in.
  quality     real,
  -- Which engine produced `embedding`: 'legacy' or 'sface'.
  --
  -- Load-bearing rather than bookkeeping. The two engines use different vector
  -- spaces, so comparing one against the other is meaningless — a genuine person
  -- would look like a stranger and the failure would be indistinguishable from a
  -- bad camera. Matching filters on this column, which also makes a staged
  -- migration possible: old samples keep working until each person is re-enrolled.
  model       text not null default 'legacy',
  captured_at timestamptz not null default now(),
  -- Who took it. Same reasoning as users.face_enrolled_by: it is the first
  -- question asked when an account holds a face that does not work.
  captured_by uuid references users(id) on delete set null
  -- The uniqueness key is declared below the table, as an index, so that a fresh
  -- install and a migrated one end up with exactly the same thing. One row per
  -- angle *per engine*: a migration needs both, so an account re-captured under
  -- the new engine keeps its old rows working until the cafe switches over.
);
-- No separate index: the unique constraint above is already an index whose
-- leading column is user_id, which is how every match reads these rows (all of
-- one person's samples, in one query).

alter table user_face_samples enable row level security;

-- `create table if not exists` above does nothing on an existing database, so the
-- engine column is also added explicitly. Installs that predate the two-engine
-- split get 'legacy', which is what every stored vector in them actually is.
alter table user_face_samples add column if not exists model text not null default 'legacy';

-- The key widened from (user_id, pose) to (user_id, pose, model), so that a
-- person can hold samples from both engines while their account is migrated.
-- Dropping by name if it is there keeps this re-runnable on every boot.
alter table user_face_samples drop constraint if exists user_face_samples_user_id_pose_key;
create unique index if not exists idx_user_face_samples_user_pose_model
  on user_face_samples(user_id, pose, model);

-- No policies created = no access for anon/authenticated roles. The service role
-- bypasses RLS, which is what the API routes use. Same pattern as every other
-- table here.
