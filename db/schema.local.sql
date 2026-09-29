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
  ('business_name', 'Merrylane Cafe Foodhub')
on conflict (key) do nothing;

-- ---------- users ----------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  password_hash text not null,
  full_name     text not null,
  role          text not null check (role in ('admin','staff')),
  qr_token      text unique,
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
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Migration for items created before per-box packaging existed.
alter table items add column if not exists units_per_box numeric(12,3);

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
  created_at  timestamptz not null default now()
);

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
  p_details     jsonb
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

  insert into audit_log (actor_id, actor_name, action, entity_type, entity_id, details, prev_hash, entry_hash)
  values (p_actor_id, p_actor_name, p_action, p_entity_type, p_entity_id,
          coalesce(p_details, '{}'::jsonb), v_prev, '')
  returning * into v_row;

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
  where i.quantity <= i.low_stock_threshold
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
  where i.expiration_date is not null
    and i.expiration_date <= current_date + (v_days || ' days')::interval
    and not exists (
      select 1 from alerts a
      where a.item_id = i.id and a.resolved = false
        and a.type in ('near_expiry','expired')
    );

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
