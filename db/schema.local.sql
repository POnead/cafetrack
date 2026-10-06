-- ============================================================
-- CafeTrack — LOCAL schema (PGlite). GENERATED FILE — do not edit by hand.
--
-- Built from db/schema.sql by:  node scripts/build-local-schema.mjs
-- Differences: no pgcrypto extension, core sha256() instead of digest().
-- Hash values are identical to the Supabase schema, so audit chains match.
-- ============================================================

-- ============================================================
-- CafeTrack — Database Schema (PostgreSQL / Supabase)
-- Run this in Supabase SQL Editor, once, top to bottom.
-- ============================================================

-- pgcrypto is not required locally: gen_random_uuid() and sha256() are
-- core functions in the PostgreSQL build that PGlite ships.

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
  ('email_daily_summary_hour', '7')
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
  correction_reason  text
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
  qty_after      numeric(12,3) not null
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
  v_hash := encode(sha256(convert_to((
      v_row.seq::text || '|' || v_prev || '|' || p_actor_name || '|' || p_action || '|' ||
      coalesce(p_entity_type,'') || '|' || coalesce(p_entity_id,'') || '|' ||
      coalesce(p_details, '{}'::jsonb)::text), 'UTF8')), 'hex');

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

    v_expected := encode(sha256(convert_to((
        r.seq::text || '|' || r.prev_hash || '|' || r.actor_name || '|' || r.action || '|' ||
        coalesce(r.entity_type,'') || '|' || coalesce(r.entity_id,'') || '|' ||
        r.details::text), 'UTF8')), 'hex');

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
      (transaction_id, item_id, sku, item_name, quantity, qty_before, qty_after)
    values
      (v_txn_id, v_row.id, v_row.sku, v_row.name, v_req.qty, v_row.quantity, v_new_qty);

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

  -- open expiry alerts
  insert into alerts (item_id, type, message)
  select i.id,
         case when i.expiration_date < current_date then 'expired' else 'near_expiry' end,
         case when i.expiration_date < current_date
              then i.name || ' expired on ' || i.expiration_date
              else i.name || ' expires on ' || i.expiration_date
         end
  from items i
  where i.item_status = 'active'
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
         and (i.expiration_date is null
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

-- No policies created = no access for anon/authenticated roles.
-- The service role bypasses RLS, which is what our API routes use.
