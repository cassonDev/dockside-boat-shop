-- ============================================================================
-- Dockside / Lessard Marine Works — Supabase schema (Auth + RLS + Audit)
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- Safe to re-run: uses "if not exists" / "or replace" / "drop policy if exists".
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. profiles  (one row per auth.users row, created by trigger on signup)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text not null check (char_length(trim(full_name)) > 0),
  role text not null default 'mechanic' check (role in ('shop_owner', 'mechanic')),
  active boolean not null default true,
  out_of_office boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- 2. work_orders
-- ---------------------------------------------------------------------------
create table if not exists public.work_orders (
  id text primary key,                            -- short job/tag code, e.g. "7G2MH"
  customer_name text not null default '',
  phone text not null default '',
  boat_year text not null default '',
  boat_make text not null default '',
  boat_model text not null default '',
  boat_make_model text not null default '',        -- derived display string (year + make + model)
  issue text not null default '',
  photos jsonb not null default '[]'::jsonb,
  size text not null default 'M' check (size in ('S','M','L')),
  priority text not null default 'normal' check (priority in ('normal','high')),
  assigned_mechanic uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open','in progress','done')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  intake_raw_notes text not null default '',
  entries jsonb not null default '[]'::jsonb,       -- array of {timestamp, findings, fix, timeSpent, materials, rawNotes, photos}
  active boolean not null default true,             -- soft-delete flag
  archived_at timestamptz,
  archived_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create index if not exists work_orders_status_idx on public.work_orders (status);
create index if not exists work_orders_mechanic_idx on public.work_orders (assigned_mechanic);
create index if not exists work_orders_active_idx on public.work_orders (active);

-- Safe to re-run against a database created before the year/make/model split:
-- adds the new columns without touching any existing data.
alter table public.work_orders add column if not exists boat_year text not null default '';
alter table public.work_orders add column if not exists boat_make text not null default '';
alter table public.work_orders add column if not exists boat_model text not null default '';

alter table public.work_orders enable row level security;

-- ---------------------------------------------------------------------------
-- 3. work_order_comments  (free-text notes, separate from formal work-log entries)
-- ---------------------------------------------------------------------------
create table if not exists public.work_order_comments (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  author_name text not null default '',
  author_role text not null default '',
  body text not null,
  created_at timestamptz not null default now(),
  active boolean not null default true,
  archived_at timestamptz,
  archived_by uuid references public.profiles(id)
);

create index if not exists work_order_comments_wo_idx on public.work_order_comments (work_order_id);

alter table public.work_order_comments enable row level security;

-- ---------------------------------------------------------------------------
-- 4. audit_log  (append-only; never editable/deletable from the frontend)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_name text not null default '',
  actor_role text not null default '',
  action text not null,                -- e.g. 'insert','update','archive','restore'
  table_name text not null,
  record_id text not null,
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default (now() at time zone 'utc')
);

create index if not exists audit_log_record_idx on public.audit_log (table_name, record_id);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);

alter table public.audit_log enable row level security;

-- ---------------------------------------------------------------------------
-- 5. helper functions (SECURITY DEFINER — bypass RLS for internal lookups)
-- ---------------------------------------------------------------------------
create or replace function public.current_profile()
returns public.profiles
language sql security definer stable
set search_path = public
as $$
  select * from public.profiles where id = auth.uid();
$$;

create or replace function public.is_shop_owner()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select coalesce((select role = 'shop_owner' and active from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_active_user()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------
-- 6. new-user provisioning: create a profile row when an auth user is created.
--    Role/name/active come from user_metadata set at signup or by the invite
--    function (see manage-users Netlify function) — defaults to 'mechanic'.
-- ---------------------------------------------------------------------------
-- SECURITY NOTE: role/active are read from raw_app_meta_data, NOT
-- raw_user_meta_data. app_metadata can only be set by the service-role key
-- (i.e. from the Netlify Function, never from the browser SDK), so a
-- self-signed-up user can never grant themselves shop_owner by passing
-- role in their own signUp() call — self-signup always lands as 'mechanic'.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_app_meta_data->>'role', 'mechanic'),
    coalesce((new.raw_app_meta_data->>'active')::boolean, true)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- 7. audit logging trigger function (SECURITY DEFINER — bypasses RLS on insert
--    into audit_log so it can never be skipped or forged by frontend code)
-- ---------------------------------------------------------------------------
create or replace function public.write_audit_log()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  actor public.profiles;
  act text;
  rec_id text;
begin
  select * into actor from public.profiles where id = auth.uid();

  if tg_op = 'INSERT' then
    act := 'insert';
  elsif tg_op = 'UPDATE' then
    act := case
      when tg_table_name = 'work_orders' and new.active = false and old.active = true then 'archive'
      when tg_table_name = 'work_orders' and new.active = true and old.active = false then 'restore'
      when tg_table_name = 'profiles' and new.active = false and old.active = true then 'deactivate'
      when tg_table_name = 'profiles' and new.active = true and old.active = false then 'reactivate'
      else 'update'
    end;
  elsif tg_op = 'DELETE' then
    act := 'delete';
  end if;

  rec_id := case when tg_op = 'DELETE' then old.id::text else new.id::text end;

  insert into public.audit_log (actor_id, actor_name, actor_role, action, table_name, record_id, old_value, new_value)
  values (
    auth.uid(),
    coalesce(actor.full_name, ''),
    coalesce(actor.role, ''),
    act,
    tg_table_name,
    rec_id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('UPDATE','INSERT') then to_jsonb(new) else null end
  );

  return new;
end;
$$;

drop trigger if exists audit_work_orders on public.work_orders;
create trigger audit_work_orders
  after insert or update on public.work_orders
  for each row execute function public.write_audit_log();

drop trigger if exists audit_work_order_comments on public.work_order_comments;
create trigger audit_work_order_comments
  after insert or update on public.work_order_comments
  for each row execute function public.write_audit_log();

drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles
  after insert or update on public.profiles
  for each row execute function public.write_audit_log();

-- ---------------------------------------------------------------------------
-- 8. column-level guardrail for mechanics editing work_orders:
--    mechanics may only touch status/entries/photos on jobs assigned to them;
--    everything else (reassignment, archive, customer/boat/issue fields) is
--    shop_owner-only. Enforced in a trigger since RLS alone is row-level only.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_work_order_edits()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if public.is_shop_owner() then
    return new; -- shop owner: no restrictions
  end if;

  -- mechanics: must be the assigned mechanic on the existing row
  if old.assigned_mechanic is distinct from auth.uid() then
    raise exception 'Not permitted: you are not assigned to this work order';
  end if;

  -- mechanics cannot change these fields
  if new.assigned_mechanic is distinct from old.assigned_mechanic
     or new.customer_name is distinct from old.customer_name
     or new.phone is distinct from old.phone
     or new.boat_make_model is distinct from old.boat_make_model
     or new.issue is distinct from old.issue
     or new.priority is distinct from old.priority
     or new.size is distinct from old.size
     or new.active is distinct from old.active
     or new.archived_at is distinct from old.archived_at
     or new.archived_by is distinct from old.archived_by then
    raise exception 'Not permitted: mechanics may only update status, work-log entries, and photos';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_work_order_edits on public.work_orders;
create trigger guard_work_order_edits
  before update on public.work_orders
  for each row execute function public.enforce_work_order_edits();

-- ---------------------------------------------------------------------------
-- 9. RLS policies
-- ---------------------------------------------------------------------------

-- profiles ----------------------------------------------------------------
drop policy if exists "profiles: shop_owner full access" on public.profiles;
drop policy if exists "profiles: self read" on public.profiles;
drop policy if exists "profiles: self update limited" on public.profiles;

create policy "profiles: shop_owner full access" on public.profiles
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

create policy "profiles: self read" on public.profiles
  for select using (id = auth.uid());

-- mechanics may update only their own out_of_office flag (not role/active/name)
create policy "profiles: self update limited" on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles p where p.id = auth.uid()) and active = (select active from public.profiles p where p.id = auth.uid()));

-- work_orders ---------------------------------------------------------------
drop policy if exists "work_orders: shop_owner full access" on public.work_orders;
drop policy if exists "work_orders: mechanic read active" on public.work_orders;
drop policy if exists "work_orders: mechanic update own" on public.work_orders;
drop policy if exists "work_orders: mechanic insert" on public.work_orders;

create policy "work_orders: shop_owner full access" on public.work_orders
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

create policy "work_orders: mechanic read active" on public.work_orders
  for select using (public.is_active_user() and active = true);

create policy "work_orders: mechanic update own" on public.work_orders
  for update using (public.is_active_user() and assigned_mechanic = auth.uid())
  with check (public.is_active_user() and assigned_mechanic = auth.uid());

-- THE FIX: no insert policy existed for non-shop-owner users at all. Only
-- "work_orders: shop_owner full access" (a `for all` policy) covered inserts,
-- so any authenticated mechanic creating a job from New Job Intake hit
-- "new row violates row-level security policy for table work_orders" —
-- Postgres's generic message for "no policy permitted this row". This grants
-- active mechanics insert rights, scoped so they can only ever create rows
-- attributed to themselves (created_by must match their own auth uid) —
-- they still cannot read/update anything the read/update policies above
-- don't already allow.
create policy "work_orders: mechanic insert" on public.work_orders
  for insert
  with check (public.is_active_user() and created_by = auth.uid());

-- work_order_comments ---------------------------------------------------------
drop policy if exists "comments: shop_owner full access" on public.work_order_comments;
drop policy if exists "comments: read active" on public.work_order_comments;
drop policy if exists "comments: insert own" on public.work_order_comments;

create policy "comments: shop_owner full access" on public.work_order_comments
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

create policy "comments: read active" on public.work_order_comments
  for select using (public.is_active_user() and active = true);

create policy "comments: insert own" on public.work_order_comments
  for insert with check (public.is_active_user() and author_id = auth.uid());

-- audit_log — readable by shop_owner only; never writable from the frontend
-- (rows are inserted exclusively by the SECURITY DEFINER trigger above)
drop policy if exists "audit_log: shop_owner read only" on public.audit_log;
create policy "audit_log: shop_owner read only" on public.audit_log
  for select using (public.is_shop_owner());
-- Intentionally: no insert/update/delete policy exists for any client role.

-- ---------------------------------------------------------------------------
-- 10. work_order_photos + Storage bucket
--    Unified photo gallery for a work order. Every photo captured anywhere in
--    the app (intake, work log, ad-hoc) lands here as ONE row, tagged with
--    one or more categories, instead of being duplicated into separate
--    intake-photo / log-photo JSON blobs. Only metadata + storage paths live
--    in Postgres — actual image bytes live in the 'work-order-photos'
--    Storage bucket (never base64/data-URLs in the DB or in JSON payloads),
--    so this scales to hundreds of photos per work order without bloating
--    rows or slowing down `select *` on work_orders.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('work-order-photos', 'work-order-photos', true)
on conflict (id) do nothing;

create table if not exists public.work_order_photos (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete cascade,
  storage_path text not null,          -- full-resolution original, e.g. "<job_id>/<photo_id>-orig.jpg"
  thumb_path text not null,            -- small thumbnail used everywhere in-app, e.g. "<job_id>/<photo_id>-thumb.jpg"
  width int,
  height int,
  mime_type text not null default 'image/jpeg',
  size_bytes int,
  caption text not null default '',
  categories text[] not null default '{}',   -- e.g. {"Before Repair","Damage"} — free-form, app-validated list
  display_order int not null default 0,
  customer_visible boolean not null default true,
  annotations jsonb not null default '[]'::jsonb,   -- reserved for future markup/drawing overlays
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  active boolean not null default true,        -- soft delete, same pattern as work_orders/comments
  archived_at timestamptz,
  archived_by uuid references public.profiles(id)
);

create index if not exists work_order_photos_wo_idx on public.work_order_photos (work_order_id, active, display_order, created_at);
create index if not exists work_order_photos_categories_idx on public.work_order_photos using gin (categories);

alter table public.work_order_photos enable row level security;

drop trigger if exists audit_work_order_photos on public.work_order_photos;
create trigger audit_work_order_photos
  after insert or update on public.work_order_photos
  for each row execute function public.write_audit_log();

-- work_order_photos RLS ------------------------------------------------------
drop policy if exists "photos: shop_owner full access" on public.work_order_photos;
drop policy if exists "photos: read active" on public.work_order_photos;
drop policy if exists "photos: mechanic insert own job" on public.work_order_photos;
drop policy if exists "photos: uploader update own" on public.work_order_photos;

create policy "photos: shop_owner full access" on public.work_order_photos
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

create policy "photos: read active" on public.work_order_photos
  for select using (public.is_active_user() and active = true);

create policy "photos: mechanic insert own job" on public.work_order_photos
  for insert
  with check (
    public.is_active_user()
    and created_by = auth.uid()
    and exists (
      select 1 from public.work_orders wo
      where wo.id = work_order_id and wo.assigned_mechanic = auth.uid()
    )
  );

-- Uploader can edit/soft-delete their own photo's metadata (caption,
-- categories, customer_visible, active) but never reassign it to another job.
create policy "photos: uploader update own" on public.work_order_photos
  for update using (public.is_active_user() and created_by = auth.uid())
  with check (public.is_active_user() and created_by = auth.uid());

-- Storage RLS -----------------------------------------------------------------
-- The bucket is public for READS (simplest way to serve thumbnails/full-res
-- images fast without signed-URL churn — nothing in it is more sensitive than
-- what a customer walking the lot could photograph themselves). Writes are
-- still locked down: only a shop_owner, or the mechanic assigned to the work
-- order named by the object's own path prefix ("<job_id>/..."), may upload.
drop policy if exists "work-order-photos: shop_owner full access" on storage.objects;
drop policy if exists "work-order-photos: mechanic insert own job" on storage.objects;

create policy "work-order-photos: shop_owner full access" on storage.objects
  for all using (bucket_id = 'work-order-photos' and public.is_shop_owner())
  with check (bucket_id = 'work-order-photos' and public.is_shop_owner());

create policy "work-order-photos: mechanic insert own job" on storage.objects
  for insert
  with check (
    bucket_id = 'work-order-photos'
    and public.is_active_user()
    and exists (
      select 1 from public.work_orders wo
      where wo.id = (storage.foldername(name))[1] and wo.assigned_mechanic = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 12. Realtime: work_order_comments
--    Without this, a comment posted from one device only appears on another
--    device the next time that device opens the job (comments are fetched
--    once on open, not pushed). Adding the table to the supabase_realtime
--    publication lets the client subscribe to live INSERTs instead.
-- ---------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.work_order_comments;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Seed data note
-- ---------------------------------------------------------------------------
-- No anonymous seed rows are inserted here on purpose — every work_order and
-- profile must be tied to a real authenticated user. Create your first
-- shop_owner account via Supabase Auth (see SUPABASE_SETUP.md), then run:
--
--   update public.profiles set role = 'shop_owner', full_name = 'Your Name'
--   where email = 'you@yourshop.com';
--
-- Additional mechanic accounts should be created via the "Invite mechanic"
-- action in the app (Mechanics screen), which calls the secure
-- manage-users Netlify Function — never by inserting into auth.users
-- directly from the frontend.
