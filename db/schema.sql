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
  name text unique not null
);

-- ---------- items (ingredients) ----------
create table if not exists items (
  id                 uuid primary key default gen_random_uuid(),
  sku                text unique not null,
  name               text not null,
  category_id        uuid references categories(id) on delete set null,
  location_id        uuid references locations(id) on delete set null,
  physical_form      text not null default 'solid' check (physical_form in ('liquid','powder','solid')),
  unit               text not null default 'pcs',
  quantity           numeric(12,3) not null default 0 check (quantity >= 0),
  low_stock_threshold numeric(12,3) not null default 5,
  expiration_date    date,
  version            integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

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
  p_items      jsonb,   -- [{"sku":"CT-COF-1234","qty":2}, ...]
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
    select (e->>'sku') as sku, (e->>'qty')::numeric as qty
    from jsonb_array_elements(p_items) e
  loop
    if v_req.qty is null or v_req.qty <= 0 then
      raise exception 'invalid quantity for %', v_req.sku;
    end if;

    select * into v_row from items where sku = v_req.sku for update;
    if not found then
      raise exception 'item not found: %', v_req.sku;
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

    update items
       set quantity = v_new_qty,
           version = version + 1,
           updated_at = now()
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
      'after', v_new_qty
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
-- Auto-resolves alerts that no longer apply.
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
