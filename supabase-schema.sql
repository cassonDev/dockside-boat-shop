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
  role text not null default 'mechanic' check (role in ('shop_owner', 'service_advisor', 'mechanic')),
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

create or replace function public.is_service_advisor()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select coalesce((select role = 'service_advisor' and active from public.profiles where id = auth.uid()), false);
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
  include_on_invoice boolean not null default false,  -- explicit curation flag: only these print on the customer invoice
  activity_id uuid references public.activities(id) on delete set null, -- which activity this photo was attached from (work log / customer note / standalone photo_added), if any
  annotations jsonb not null default '[]'::jsonb,   -- reserved for future markup/drawing overlays
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  active boolean not null default true,        -- soft delete, same pattern as work_orders/comments
  archived_at timestamptz,
  archived_by uuid references public.profiles(id)
);

-- Backfill for tables that already existed before this migration (must run
-- before the invoice index below, which depends on this column existing).
alter table public.work_order_photos add column if not exists include_on_invoice boolean not null default false;
alter table public.work_order_photos add column if not exists activity_id uuid references public.activities(id) on delete set null;

create index if not exists work_order_photos_wo_idx on public.work_order_photos (work_order_id, active, display_order, created_at);
create index if not exists work_order_photos_categories_idx on public.work_order_photos using gin (categories);
create index if not exists work_order_photos_invoice_idx on public.work_order_photos (work_order_id, include_on_invoice) where include_on_invoice = true;

alter table public.work_order_photos enable row level security;

drop trigger if exists audit_work_order_photos on public.work_order_photos;
create trigger audit_work_order_photos
  after insert or update on public.work_order_photos
  for each row execute function public.write_audit_log();

-- work_order_photos RLS ------------------------------------------------------
drop policy if exists "photos: shop_owner full access" on public.work_order_photos;
drop policy if exists "photos: read active" on public.work_order_photos;
drop policy if exists "photos: advisor insert any job" on public.work_order_photos;
drop policy if exists "photos: mechanic insert own job" on public.work_order_photos;
drop policy if exists "photos: uploader update own" on public.work_order_photos;

create policy "photos: shop_owner full access" on public.work_order_photos
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

create policy "photos: read active" on public.work_order_photos
  for select using (public.is_active_user() and active = true);

create policy "photos: advisor insert any job" on public.work_order_photos
  for insert
  with check (public.is_active_user() and public.is_service_advisor());

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

-- Service advisors curate which photos print on the customer invoice — they
-- may not have uploaded the photo themselves, so this is scoped separately
-- from "uploader update own" above (both can coexist on the same row).
drop policy if exists "photos: advisor curate any" on public.work_order_photos;
create policy "photos: advisor curate any" on public.work_order_photos
  for update using (public.is_active_user() and public.is_service_advisor())
  with check (public.is_active_user() and public.is_service_advisor());

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
-- 12. activities — unified work-order timeline. Every note, work-log entry,
--     status change, photo, and financial event on a job is one row here,
--     typed by activity_type. Replaces the old ad-hoc work_orders.entries
--     jsonb column and work_order_comments table going forward (both remain
--     in place, untouched, for historical rows already written).
-- ---------------------------------------------------------------------------
create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete cascade,
  activity_type text not null check (activity_type in (
    'work_log', 'inspection', 'ai_summary', 'mechanic_note', 'customer_note',
    'status_change', 'photo_added', 'quote_sent', 'approval_received',
    'invoice_generated', 'payment_received', 'part_ordered', 'part_received'
  )),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  body text not null default '',
  meta jsonb not null default '{}'::jsonb,        -- type-specific fields: findings/fix/timeSpent/materials, statusFrom/To, amount, partName, etc.
  attachments jsonb not null default '[]'::jsonb, -- array of work_order_photos ids shown inline on this activity
  ai_generated boolean not null default false,
  author_id uuid references public.profiles(id),
  author_name text not null default '',
  author_role text not null default '',
  parent_activity_id uuid references public.activities(id) on delete set null,
  version int not null default 1,
  edited_by uuid references public.profiles(id),
  edited_by_name text,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  active boolean not null default true
);

create index if not exists activities_wo_idx on public.activities (work_order_id, created_at desc);
create index if not exists activities_type_idx on public.activities (activity_type);

alter table public.activities enable row level security;

drop trigger if exists audit_activities on public.activities;
create trigger audit_activities
  after insert or update on public.activities
  for each row execute function public.write_audit_log();

-- ---------------------------------------------------------------------------
-- 13. activity_history — append-only prior versions. Written every time an
--     editable activity (customer_note) is edited; never updated or deleted
--     from the frontend. This is the audit trail the edit UI reads to show
--     "Edited" + full version history.
-- ---------------------------------------------------------------------------
create table if not exists public.activity_history (
  id bigint generated always as identity primary key,
  activity_id uuid not null references public.activities(id) on delete cascade,
  version int not null,
  previous_body text not null,
  previous_meta jsonb not null default '{}'::jsonb,
  edited_by uuid references public.profiles(id),
  edited_by_name text not null default '',
  edited_at timestamptz not null default now(),
  change_reason text not null default ''
);

create index if not exists activity_history_activity_idx on public.activity_history (activity_id, version);

alter table public.activity_history enable row level security;

-- ---------------------------------------------------------------------------
-- 14. guardrail: only customer_note activities may ever be edited in place
--     (version bumped, edited_by/edited_at set) — every other activity type
--     is an immutable event once written. Managers (shop_owner) bypass this.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_activity_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_shop_owner() then
    return new; -- managers may edit/restore/deactivate anything
  end if;

  if old.activity_type not in ('customer_note', 'work_log') and (
    new.body is distinct from old.body or new.meta is distinct from old.meta or new.active is distinct from old.active
  ) then
    raise exception 'Not permitted: only customer-facing notes and work-log customer updates can be edited after creation';
  end if;

  if old.activity_type in ('customer_note', 'work_log') and (new.body is distinct from old.body or new.meta is distinct from old.meta) then
    if not (old.author_id = auth.uid() or public.is_service_advisor()) then
      raise exception 'Not permitted: only the author, a service advisor, or a manager may edit this update';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_activity_edits on public.activities;
create trigger guard_activity_edits
  before update on public.activities
  for each row execute function public.enforce_activity_edits();

-- activities RLS --------------------------------------------------------------
drop policy if exists "activities: shop_owner full access" on public.activities;
drop policy if exists "activities: read active" on public.activities;
drop policy if exists "activities: insert own" on public.activities;
drop policy if exists "activities: author, advisor, or shop_owner update" on public.activities;

create policy "activities: shop_owner full access" on public.activities
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

create policy "activities: read active" on public.activities
  for select using (public.is_active_user() and active = true);

create policy "activities: insert own" on public.activities
  for insert with check (public.is_active_user() and author_id = auth.uid());

create policy "activities: author, advisor, or shop_owner update" on public.activities
  for update using (
    public.is_active_user() and (
      author_id = auth.uid()
      or public.is_shop_owner()
      or (activity_type in ('customer_note', 'work_log') and public.is_service_advisor())
    )
  )
  with check (public.is_active_user());

-- activity_history RLS ---------------------------------------------------------
-- readable by any active user (so the "view history" panel works for whoever
-- can see the activity); insertable only by the person recorded as the editor,
-- and never updatable/deletable from the frontend at all.
drop policy if exists "activity_history: read active" on public.activity_history;
drop policy if exists "activity_history: insert own" on public.activity_history;

create policy "activity_history: read active" on public.activity_history
  for select using (public.is_active_user());

create policy "activity_history: insert own" on public.activity_history
  for insert with check (public.is_active_user() and edited_by = auth.uid());

-- ---------------------------------------------------------------------------
-- 15. Job Details + Photo Details editing (2026-07)
--    - customer_email is a new persisted field on the Edit Job Details form.
--    - service_advisor previously had NO update policy on work_orders at all
--      (only shop_owner-full-access and mechanic-update-own existed), and the
--      column guardrail trigger blocked non-shop-owners from touching
--      customer/boat/issue/priority/size fields even if they had a row-level
--      policy. Both are fixed here so service advisors can edit full job
--      details, same as shop_owner, while mechanics remain limited to
--      status/entries/photos on jobs assigned to them (unchanged).
--    - job_edited is a new activities.activity_type so "Job details updated"
--      shows in the job's own activity timeline (distinct from the raw,
--      shop-owner-only audit_log, which already captured every field-level
--      change automatically via the existing audit_work_orders trigger).
-- ---------------------------------------------------------------------------
alter table public.work_orders add column if not exists customer_email text not null default '';

create or replace function public.enforce_work_order_edits()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if public.is_shop_owner() or public.is_service_advisor() then
    new.updated_at := now();
    return new; -- shop owner / service advisor: no restrictions
  end if;

  -- mechanics: must be the assigned mechanic on the existing row
  if old.assigned_mechanic is distinct from auth.uid() then
    raise exception 'Not permitted: you are not assigned to this work order';
  end if;

  -- mechanics cannot change these fields
  if new.assigned_mechanic is distinct from old.assigned_mechanic
     or new.customer_name is distinct from old.customer_name
     or new.customer_email is distinct from old.customer_email
     or new.phone is distinct from old.phone
     or new.boat_make_model is distinct from old.boat_make_model
     or new.boat_year is distinct from old.boat_year
     or new.boat_make is distinct from old.boat_make
     or new.boat_model is distinct from old.boat_model
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

drop policy if exists "work_orders: service_advisor full access" on public.work_orders;
create policy "work_orders: service_advisor full access" on public.work_orders
  for update using (public.is_active_user() and public.is_service_advisor())
  with check (public.is_active_user() and public.is_service_advisor());

alter table public.activities drop constraint if exists activities_activity_type_check;
-- NOT VALID: skips checking existing rows (a live shop's activities table may
-- already contain a type string from before this constraint existed, or from
-- an app version between deploys) — only new/updated rows are enforced.
alter table public.activities add constraint activities_activity_type_check check (activity_type in (
  'work_log', 'inspection', 'ai_summary', 'mechanic_note', 'customer_note',
  'status_change', 'photo_added', 'quote_sent', 'approval_received',
  'invoice_generated', 'payment_received', 'part_ordered', 'part_received',
  'job_edited'
)) not valid;

-- ---------------------------------------------------------------------------
-- 17. AI-first Job Timeline (2026-07): "What happened?" is now the single
--    primary way mechanics log an update. The AI draft's customer-facing
--    body (stored as a `work_log` activity, same as before) is editable
--    after saving — same as a customer_note — since a mechanic or advisor
--    may need to fix wording before it prints on an invoice. Widens the
--    edit guardrail above (section 14) from customer_note-only to also
--    allow work_log, with identical author/advisor/manager permission
--    checks and full activity_history versioning.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 16. Mechanic Profile: availability + role-change requests (2026-07)
--    Scope for this pass: profile page, active jobs, availability, and role
--    requests (the four items explicitly prioritized). The staff-invitation
--    "airlock" rework (pending_approval before any Supabase Auth user or
--    email exists) is a larger follow-up and NOT included here — today's
--    invite flow already goes through the existing manage-users Netlify
--    Function (service-role key stays server-side), it just doesn't yet have
--    a separate pre-approval step.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists phone text not null default '',
  add column if not exists availability_status text not null default 'available'
    check (availability_status in ('available','out_of_office','sick','training','vacation','other')),
  add column if not exists out_of_office_start date,
  add column if not exists out_of_office_end date,
  add column if not exists availability_note text not null default '';

create table if not exists public.role_change_requests (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_before text not null,
  requested_role text not null check (requested_role in ('shop_owner','service_advisor','mechanic')),
  reason text not null check (char_length(trim(reason)) > 0),
  status text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.role_change_requests enable row level security;

drop policy if exists "role_requests: shop_owner full access" on public.role_change_requests;
create policy "role_requests: shop_owner full access" on public.role_change_requests
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());

drop policy if exists "role_requests: self read" on public.role_change_requests;
create policy "role_requests: self read" on public.role_change_requests
  for select using (public.is_active_user() and profile_id = auth.uid());

drop policy if exists "role_requests: self insert" on public.role_change_requests;
create policy "role_requests: self insert" on public.role_change_requests
  for insert with check (public.is_active_user() and profile_id = auth.uid());

-- Note: there is intentionally NO update/delete policy for non-shop_owner
-- users — approval/denial is granted only through the review-role-change
-- Netlify Function running with the service-role key, never directly by a
-- client update. A requester may not edit their own pending request status.

-- Availability: a mechanic can already update their own row (including the
-- new availability columns) under the existing "profiles: self update
-- limited" policy above, since that policy only pins role/active as
-- unchanged and leaves every other column free. What's missing is a way for
-- service_advisor to update OTHER staff's availability (shop_owner already
-- has full access via "profiles: shop_owner full access").
drop policy if exists "profiles: service_advisor update availability" on public.profiles;
create policy "profiles: service_advisor update availability" on public.profiles
  for update using (public.is_active_user() and public.is_service_advisor())
  with check (public.is_active_user() and public.is_service_advisor());

-- ---------------------------------------------------------------------------
-- 18. Serial Number Capture (2026-07)
--    Photo classification so a serial-number photo is tagged instead of
--    landing in the normal unclassified gallery. The originally-shipped
--    single serial_number field/primary-photo design is superseded by the
--    multi-record model in section 19 below (a work order needs one serial
--    number per piece of equipment, not one total) — those columns are
--    added and dropped again there so both sections stay independently
--    readable as a history of the feature.
-- ---------------------------------------------------------------------------
alter table public.work_order_photos add column if not exists photo_type text not null default 'general'
  check (photo_type in ('general','serial_number'));
alter table public.work_order_photos add column if not exists extracted_text text not null default '';
alter table public.work_order_photos add column if not exists extraction_confidence numeric;

create index if not exists work_order_photos_serial_idx
  on public.work_order_photos (work_order_id, photo_type) where photo_type = 'serial_number';

-- No new RLS policies needed: work_order_photos already has full shop_owner
-- access, "uploader update own", and "advisor curate any" policies that
-- cover these new columns. The table already carries an audit-log trigger,
-- so every serial-number photo upload is recorded automatically.

-- ---------------------------------------------------------------------------
-- 19. Serial Number Capture v2 (2026-07): multiple records per work order,
--    shop-configured labels. Supersedes the single-field approach above
--    (section 18) — a work order previously had one serial_number/one
--    primary photo; shops need several (hull, each engine, trailer, etc),
--    each independently labeled and independently visible to the customer.
--    work_orders.serial_number and work_order_photos.is_primary_serial_photo
--    /equipment_id are dropped here; photo_type/extracted_text/
--    extraction_confidence stay (still used to tag/annotate photos).
-- ---------------------------------------------------------------------------
drop index if exists public.work_order_photos_one_primary_serial;
alter table public.work_order_photos drop column if exists is_primary_serial_photo;
alter table public.work_order_photos drop column if exists equipment_id;
alter table public.work_orders drop column if exists serial_number;

-- Shop-configured label choices for the serial-number dropdown. shop_id is
-- nullable and unused (always the single shop) until the real tenant table
-- exists — every query/policy already treats a null shop_id as "the shop",
-- so wiring in a real shop_id later is a column backfill, not a rewrite.
create table if not exists public.shop_serial_label_options (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid,
  label text not null check (char_length(trim(label)) > 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shop_serial_label_options_shop_idx
  on public.shop_serial_label_options (shop_id, is_active, sort_order);
create unique index if not exists shop_serial_label_options_unique_label
  on public.shop_serial_label_options (coalesce(shop_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(label));

-- Starter defaults, inserted once (only if the table is empty) so a fresh
-- deployment isn't blank, and never re-run on later deploys — a shop's
-- edits (renames, disables, reordering, additions) are never overwritten.
insert into public.shop_serial_label_options (label, sort_order, is_active)
select label, sort_order, true from (values
  ('Hull', 1), ('Main Engine', 2), ('Port Engine', 3), ('Starboard Engine', 4),
  ('Trailer', 5), ('Generator', 6), ('Battery', 7), ('Electronics', 8), ('Other', 9)
) as defaults(label, sort_order)
where not exists (select 1 from public.shop_serial_label_options);

alter table public.shop_serial_label_options enable row level security;
drop policy if exists "serial_labels: shop_owner full access" on public.shop_serial_label_options;
create policy "serial_labels: shop_owner full access" on public.shop_serial_label_options
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());
-- Every active user can read active AND disabled labels: disabled labels
-- must still resolve for historical records (see work_order_serial_numbers
-- below) even though they no longer appear as a selectable dropdown choice
-- (the frontend filters is_active for the dropdown itself).
drop policy if exists "serial_labels: read all" on public.shop_serial_label_options;
create policy "serial_labels: read all" on public.shop_serial_label_options
  for select using (public.is_active_user());

-- One or more serial-number records per work order. label is stored as
-- plain text (a snapshot of the option chosen, or a custom value) so a
-- record stays readable forever even if its source label option is later
-- renamed, disabled, or deleted.
create table if not exists public.work_order_serial_numbers (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references public.work_orders(id) on delete cascade,
  label text not null check (char_length(trim(label)) > 0),
  serial_number text not null default '',
  photo_id uuid references public.work_order_photos(id) on delete set null,
  extraction_confidence numeric,
  show_to_customer boolean not null default false,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists work_order_serial_numbers_wo_idx
  on public.work_order_serial_numbers (work_order_id) where active = true;

drop trigger if exists audit_work_order_serial_numbers on public.work_order_serial_numbers;
create trigger audit_work_order_serial_numbers
  after insert or update on public.work_order_serial_numbers
  for each row execute function public.write_audit_log();

alter table public.work_order_serial_numbers enable row level security;
drop policy if exists "serial_numbers: shop_owner full access" on public.work_order_serial_numbers;
create policy "serial_numbers: shop_owner full access" on public.work_order_serial_numbers
  for all using (public.is_shop_owner()) with check (public.is_shop_owner());
drop policy if exists "serial_numbers: read active" on public.work_order_serial_numbers;
create policy "serial_numbers: read active" on public.work_order_serial_numbers
  for select using (public.is_active_user() and active = true);
-- Same as work_order_photos: any active user may add a serial-number record
-- (mechanics capture these on the job same as any other photo); editing an
-- existing record (label/value/visibility/delete) is limited to its own
-- creator or a service_advisor, mirroring the photo curation policies.
drop policy if exists "serial_numbers: insert own" on public.work_order_serial_numbers;
create policy "serial_numbers: insert own" on public.work_order_serial_numbers
  for insert with check (public.is_active_user() and created_by = auth.uid());
drop policy if exists "serial_numbers: creator or advisor update" on public.work_order_serial_numbers;
create policy "serial_numbers: creator or advisor update" on public.work_order_serial_numbers
  for update using (public.is_active_user() and (created_by = auth.uid() or public.is_service_advisor()))
  with check (public.is_active_user() and (created_by = auth.uid() or public.is_service_advisor()));

alter table public.activities drop constraint if exists activities_activity_type_check;
-- NOT VALID here too, for the same reason as section 15's version of this
-- constraint above — do not fail the migration over pre-existing rows.
alter table public.activities add constraint activities_activity_type_check check (activity_type in (
  'work_log', 'inspection', 'ai_summary', 'mechanic_note', 'customer_note',
  'status_change', 'photo_added', 'quote_sent', 'approval_received',
  'invoice_generated', 'payment_received', 'part_ordered', 'part_received',
  'job_edited', 'serial_number_captured'
)) not valid;

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

-- ---------------------------------------------------------------------------
-- 19. Two-role model (2026-07): mechanic + shop_owner only
--     service_advisor is removed. Existing service_advisor accounts become
--     mechanics; pending advisor role requests become mechanic requests.
--     Mechanics are full shop staff: they read AND edit EVERY job in their
--     shop — never limited by assigned_mechanic = auth.uid(). This
--     deployment serves a single shop, so is_active_user() is the shop
--     boundary; when multi-tenant shop_memberships lands, every policy below
--     additionally scopes by shop_id = current_user_shop_id() to preserve
--     tenant isolation.
--     Account administration (staff accounts, roles, Shop Config, the full
--     Audit Log) stays shop_owner-only — those policies are unchanged.
--     platform_admin is NOT a shop role: it never appears in profiles.role
--     and must be stored/authorized separately, grantable only through a
--     secure server-side platform process.
-- ---------------------------------------------------------------------------

-- 19a. Migrate data, then tighten the role domain to two values.
update public.profiles set role = 'mechanic' where role = 'service_advisor';
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('shop_owner', 'mechanic'));

update public.role_change_requests set requested_role = 'mechanic'
  where requested_role = 'service_advisor';
alter table public.role_change_requests
  drop constraint if exists role_change_requests_requested_role_check;
alter table public.role_change_requests add constraint role_change_requests_requested_role_check
  check (requested_role in ('shop_owner', 'mechanic'));

-- 19b. Work orders: mechanics edit any job in their shop (status, priority,
--      assignment, customer/boat/issue fields, archive). The column guardrail
--      trigger no longer restricts mechanics — it only stamps updated_at and
--      rejects inactive accounts (defense in depth on top of RLS).
create or replace function public.enforce_work_order_edits()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_active_user() then
    raise exception 'Not permitted: account is not active';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop policy if exists "work_orders: mechanic update own" on public.work_orders;
drop policy if exists "work_orders: service_advisor full access" on public.work_orders;
drop policy if exists "work_orders: staff update shop" on public.work_orders;
create policy "work_orders: staff update shop" on public.work_orders
  for update using (public.is_active_user())
  with check (public.is_active_user());

-- 19c. Photos: any active staff member may add photos to ANY job (not just
--      assigned jobs) and curate photo details on any photo.
drop policy if exists "photos: advisor insert any job" on public.work_order_photos;
drop policy if exists "photos: mechanic insert own job" on public.work_order_photos;
drop policy if exists "photos: advisor curate any" on public.work_order_photos;
drop policy if exists "photos: staff insert any job" on public.work_order_photos;
create policy "photos: staff insert any job" on public.work_order_photos
  for insert with check (public.is_active_user() and created_by = auth.uid());
drop policy if exists "photos: staff curate any" on public.work_order_photos;
create policy "photos: staff curate any" on public.work_order_photos
  for update using (public.is_active_user())
  with check (public.is_active_user());

drop policy if exists "work-order-photos: mechanic insert own job" on storage.objects;
drop policy if exists "work-order-photos: staff insert any job" on storage.objects;
create policy "work-order-photos: staff insert any job" on storage.objects
  for insert with check (bucket_id = 'work-order-photos' and public.is_active_user());

-- 19d. Activity edits: author or shop_owner (advisor tier removed). Same
--      audit rules otherwise — only customer_note/work_log bodies are ever
--      editable, with full activity_history versioning.
create or replace function public.enforce_activity_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_shop_owner() then
    return new; -- owners may edit/restore/deactivate anything
  end if;

  if old.activity_type not in ('customer_note', 'work_log') and (
    new.body is distinct from old.body or new.meta is distinct from old.meta or new.active is distinct from old.active
  ) then
    raise exception 'Not permitted: only customer-facing notes and work-log customer updates can be edited after creation';
  end if;

  if old.activity_type in ('customer_note', 'work_log') and (new.body is distinct from old.body or new.meta is distinct from old.meta) then
    if old.author_id is distinct from auth.uid() then
      raise exception 'Not permitted: only the author or a shop owner may edit this update';
    end if;
  end if;

  return new;
end;
$$;

drop policy if exists "activities: author, advisor, or shop_owner update" on public.activities;
drop policy if exists "activities: author or shop_owner update" on public.activities;
create policy "activities: author or shop_owner update" on public.activities
  for update using (
    public.is_active_user() and (author_id = auth.uid() or public.is_shop_owner())
  )
  with check (public.is_active_user());

-- 19e. Serial numbers: any active staff member may edit records on any job.
drop policy if exists "serial_numbers: creator or advisor update" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: staff update any" on public.work_order_serial_numbers;
create policy "serial_numbers: staff update any" on public.work_order_serial_numbers
  for update using (public.is_active_user())
  with check (public.is_active_user());

-- 19f. Availability: self-service stays ("profiles: self update limited");
--      updating OTHER staff's availability is shop_owner-only again.
drop policy if exists "profiles: service_advisor update availability" on public.profiles;

-- 19g. Retire the advisor helper last — nothing references it anymore.
drop function if exists public.is_service_advisor();

-- ===========================================================================
-- 20. MULTI-TENANT FOUNDATION (Platform → Shop → Location → Membership)   2026-07
--
--   Hierarchy:
--     platform (this database)
--       └─ shops            = a subscribing business/company (the TENANT)
--            └─ shop_locations   = physical branches of that shop
--                 └─ shop_memberships = a profile's role within a shop
--                      └─ tenant-owned records (work_orders, activities, …)
--
--   Tenant boundary = shop_id. A location is an OPERATIONAL subdivision of a
--   shop, never a separate tenant. This phase enforces shop isolation in RLS;
--   location is a filter, NOT yet a mechanic access boundary.
--
--   Staged role migration: profiles.role is KEPT (the app still reads it).
--   shop_memberships.role becomes authoritative for authorization. A later
--   migration deprecates profiles.role once no executable code references it.
--
--   Active-shop context: profiles.active_shop_id, guarded by a trigger so a
--   user can only ever point it at a shop where they hold an ACTIVE membership.
--   current_user_shop_id() trusts it only after re-verifying that membership.
--
--   Idempotent. Runs in labelled phases 20A–20H. Fails LOUDLY rather than
--   silently misassigning rows.
--
--   platform_admin is NOT a shop role — it lives in its own platform_admins
--   table and is NEVER a permissive bypass baked into tenant policies.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 20A. Core tenant + location tables
-- ---------------------------------------------------------------------------
create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  legal_name text,
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,             -- state/province
  postal_code text,
  country text,
  timezone text not null default 'America/Toronto',
  is_active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
alter table public.shops enable row level security;

create table if not exists public.shop_locations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  name text not null check (char_length(trim(name)) > 0),
  location_code text,
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country text,
  timezone text,           -- null → inherit shop timezone (resolved in app)
  is_primary boolean not null default false,
  is_active boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
alter table public.shop_locations enable row level security;
create index if not exists shop_locations_shop_idx on public.shop_locations (shop_id, is_active);
-- Exactly one primary location per shop (partial unique index).
create unique index if not exists shop_locations_one_primary
  on public.shop_locations (shop_id) where is_primary = true;

-- ---------------------------------------------------------------------------
-- 20B. Memberships + helper functions
-- ---------------------------------------------------------------------------
create table if not exists public.shop_memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  role text not null default 'mechanic' check (role in ('shop_owner','mechanic')),
  is_active boolean not null default true,
  default_location_id uuid references public.shop_locations(id) on delete set null,
  invited_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, shop_id)          -- no duplicate membership in a shop
);
alter table public.shop_memberships enable row level security;
create index if not exists shop_memberships_profile_idx on public.shop_memberships (profile_id, is_active);
create index if not exists shop_memberships_shop_idx on public.shop_memberships (shop_id, is_active);
create index if not exists shop_memberships_profile_shop_idx on public.shop_memberships (profile_id, shop_id);

-- default_location_id, when set, must belong to the membership's own shop.
create or replace function public.enforce_membership_location()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.default_location_id is not null and not exists (
    select 1 from public.shop_locations l
    where l.id = new.default_location_id and l.shop_id = new.shop_id
  ) then
    raise exception 'default_location_id % does not belong to shop %', new.default_location_id, new.shop_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists guard_membership_location on public.shop_memberships;
create trigger guard_membership_location
  before insert or update on public.shop_memberships
  for each row execute function public.enforce_membership_location();

-- Platform administrators — explicitly NOT a shop role, NOT in profiles.role.
create table if not exists public.platform_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
alter table public.platform_admins enable row level security;
-- No client policies at all: platform admin is granted/read only via the
-- service-role key from a secure server process. RLS-enabled + zero policies
-- = no client of any ordinary role can read or write this table.

alter table public.profiles add column if not exists active_shop_id uuid references public.shops(id);

-- Identity is ALWAYS auth.uid(); no helper accepts a caller-supplied user id.

-- Active shop, resolved + verified: the caller's active_shop_id if it maps to
-- an active membership, else their default/earliest active membership.
create or replace function public.current_user_shop_id()
returns uuid language plpgsql security definer stable set search_path = public as $$
declare chosen uuid; resolved uuid;
begin
  if auth.uid() is null then return null; end if;
  select p.active_shop_id into chosen from public.profiles p where p.id = auth.uid();
  if chosen is not null and exists (
    select 1 from public.shop_memberships m
    where m.profile_id = auth.uid() and m.shop_id = chosen and m.is_active
  ) then
    return chosen;
  end if;
  select m.shop_id into resolved from public.shop_memberships m
    where m.profile_id = auth.uid() and m.is_active
    order by (m.default_location_id is not null) desc, m.created_at asc
    limit 1;
  return resolved;
end $$;

create or replace function public.is_active_shop_member(target_shop_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select target_shop_id is not null and exists (
    select 1 from public.shop_memberships m
    join public.profiles p on p.id = m.profile_id
    where m.profile_id = auth.uid() and m.shop_id = target_shop_id
      and m.is_active and p.active
  );
$$;

create or replace function public.current_user_membership_role()
returns text language sql security definer stable set search_path = public as $$
  select m.role from public.shop_memberships m
    where m.profile_id = auth.uid() and m.shop_id = public.current_user_shop_id() and m.is_active
    limit 1;
$$;

-- target-shop owner check
create or replace function public.is_shop_owner(target_shop_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select target_shop_id is not null and exists (
    select 1 from public.shop_memberships m
    join public.profiles p on p.id = m.profile_id
    where m.profile_id = auth.uid() and m.shop_id = target_shop_id
      and m.is_active and p.active and m.role = 'shop_owner'
  );
$$;

create or replace function public.is_platform_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.platform_admins a where a.profile_id = auth.uid() and a.is_active);
$$;

-- Backward-compatible zero-arg redefinitions: every section 1–19 policy that
-- calls is_shop_owner()/is_active_user() becomes shop-scoped automatically.
-- (These do NOT add a platform-admin bypass — that stays explicit.)
create or replace function public.is_shop_owner()
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_shop_owner(public.current_user_shop_id());
$$;

create or replace function public.is_active_user()
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_active_shop_member(public.current_user_shop_id());
$$;

-- Row-in-current-shop predicate used throughout 20E.
create or replace function public.row_in_current_shop(row_shop_id uuid)
returns boolean language sql stable set search_path = public as $$
  select row_shop_id is not null and row_shop_id = public.current_user_shop_id();
$$;

-- Guard active_shop_id: a user may only point it at an active membership.
create or replace function public.enforce_active_shop_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.active_shop_id is distinct from old.active_shop_id and new.active_shop_id is not null then
    if not exists (
      select 1 from public.shop_memberships m
      where m.profile_id = new.id and m.shop_id = new.active_shop_id and m.is_active
    ) then
      raise exception 'Cannot set active shop to one you are not an active member of';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_active_shop_id on public.profiles;
create trigger guard_active_shop_id
  before update on public.profiles
  for each row execute function public.enforce_active_shop_id();

-- Client-callable, membership-validated active-shop switch.
create or replace function public.set_active_shop(p_shop_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.shop_memberships m
    where m.profile_id = auth.uid() and m.shop_id = p_shop_id and m.is_active
  ) then
    raise exception 'Not an active member of that shop';
  end if;
  update public.profiles set active_shop_id = p_shop_id, updated_at = now() where id = auth.uid();
end $$;
revoke all on function public.set_active_shop(uuid) from public;
grant execute on function public.set_active_shop(uuid) to authenticated;

-- Auto-enroll newly provisioned auth users into a shop. Invite flow may pass
-- shop_id + role in app_metadata (service-role only); otherwise, if exactly
-- one shop exists, enroll there as mechanic. Never trusts user_metadata.
create or replace function public.handle_new_membership()
returns trigger language plpgsql security definer set search_path = public as $$
declare target uuid; target_role text; prim uuid;
begin
  target := nullif( (select raw_app_meta_data->>'shop_id' from auth.users where id = new.id), '')::uuid;
  target_role := coalesce((select raw_app_meta_data->>'role' from auth.users where id = new.id), 'mechanic');
  if target_role not in ('shop_owner','mechanic') then target_role := 'mechanic'; end if;
  if target is null then
    select id into target from public.shops order by created_at asc limit 1;
    if (select count(*) from public.shops) <> 1 then target := null; end if;  -- ambiguous → let invite set it
  end if;
  if target is not null then
    select id into prim from public.shop_locations where shop_id = target and is_primary limit 1;
    insert into public.shop_memberships (profile_id, shop_id, role, is_active, default_location_id)
    values (new.id, target, target_role, true, prim)
    on conflict (profile_id, shop_id) do nothing;
    update public.profiles set active_shop_id = target where id = new.id and active_shop_id is null;
  end if;
  return new;
end $$;
drop trigger if exists on_profile_created_membership on public.profiles;
create trigger on_profile_created_membership
  after insert on public.profiles
  for each row execute function public.handle_new_membership();

-- ---------------------------------------------------------------------------
-- 20C. Initial-shop + primary-location backfill (deterministic; fail-loud)
-- ---------------------------------------------------------------------------
do $$
declare v_shop uuid; v_loc uuid; v_owner uuid; n_shops int;
begin
  select count(*) into n_shops from public.shops;
  if n_shops > 1 then
    raise exception 'Section 20C expects 0 or 1 pre-existing shop, found %; migrate manually.', n_shops;
  end if;

  select id into v_shop from public.shops where slug is not distinct from null and name = 'Lessard Marine Works' limit 1;
  if v_shop is null then select id into v_shop from public.shops order by created_at asc limit 1; end if;
  if v_shop is null then
    insert into public.shops (name, legal_name, timezone)
    values ('Lessard Marine Works', 'Lessard Marine Works', 'America/Toronto')
    returning id into v_shop;
  end if;

  select id into v_loc from public.shop_locations where shop_id = v_shop and is_primary limit 1;
  if v_loc is null then
    insert into public.shop_locations (shop_id, name, is_primary, is_active)
    values (v_shop, 'Main Location', true, true) returning id into v_loc;
  end if;

  -- every existing profile → membership, role carried from legacy profiles.role
  insert into public.shop_memberships (profile_id, shop_id, role, is_active, default_location_id, approved_at)
  select p.id, v_shop,
         case when p.role = 'shop_owner' then 'shop_owner' else 'mechanic' end,
         p.active, v_loc, now()
  from public.profiles p
  where not exists (select 1 from public.shop_memberships m where m.profile_id = p.id and m.shop_id = v_shop);

  update public.profiles set active_shop_id = v_shop where active_shop_id is null;

  select id into v_owner from public.profiles where role = 'shop_owner' and active limit 1;
  if v_owner is not null then
    update public.shops set created_by = coalesce(created_by, v_owner) where id = v_shop;
    update public.shop_locations set created_by = coalesce(created_by, v_owner) where id = v_loc;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 20D. Tenant columns, backfill, constraints
--   Classification:
--     location-owned : work_orders            (shop_id + location_id)
--     shop-owned      : work_order_comments, work_order_photos, activities,
--                       work_order_serial_numbers, shop_serial_label_options,
--                       role_change_requests, audit_log   (shop_id only)
--     child-of-activity : activity_history    (no own key; scoped via join)
--     platform-global : profiles (identity), shops, shop_locations,
--                       shop_memberships, platform_admins
-- ---------------------------------------------------------------------------
do $$
declare v_shop uuid; v_loc uuid; t text;
  shop_tables text[] := array[
    'work_orders','work_order_comments','work_order_photos','activities',
    'work_order_serial_numbers','shop_serial_label_options','role_change_requests','audit_log'
  ];
begin
  select id into v_shop from public.shops order by created_at asc limit 1;
  select id into v_loc from public.shop_locations where shop_id = v_shop and is_primary limit 1;

  foreach t in array shop_tables loop
    execute format('alter table public.%I add column if not exists shop_id uuid references public.shops(id)', t);
    execute format('update public.%I set shop_id = $1 where shop_id is null', t) using v_shop;
    execute format('create index if not exists %I on public.%I (shop_id)', t||'_shop_idx', t);
  end loop;

  -- work_orders also carry a location
  alter table public.work_orders add column if not exists location_id uuid references public.shop_locations(id);
  update public.work_orders set location_id = v_loc where location_id is null;
  create index if not exists work_orders_location_idx on public.work_orders (location_id);
  create index if not exists work_orders_shop_status_idx on public.work_orders (shop_id, status, active);

  -- FAIL LOUD if anything is still unassigned, then lock NOT NULL.
  foreach t in array shop_tables loop
    execute format('do $chk$ begin if exists (select 1 from public.%I where shop_id is null) then raise exception %L; end if; end $chk$;',
                   t, 'Backfill left NULL shop_id in '||t);
    execute format('alter table public.%I alter column shop_id set not null', t);
  end loop;
  if exists (select 1 from public.work_orders where location_id is null) then
    raise exception 'Backfill left NULL location_id in work_orders';
  end if;
  alter table public.work_orders alter column location_id set not null;
end $$;

-- 20D-trigger. Stamp/verify shop_id on insert so clients can never forge it,
-- and default+validate work_orders.location_id.
create or replace function public.set_tenant_shop_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.shop_id is null or not public.is_active_shop_member(new.shop_id) then
    new.shop_id := public.current_user_shop_id();
  end if;
  if new.shop_id is null then
    raise exception 'Cannot determine current shop for insert into %', tg_table_name;
  end if;
  return new;
end $$;

do $$
declare t text;
  shop_tables text[] := array[
    'work_orders','work_order_comments','work_order_photos','activities',
    'work_order_serial_numbers','shop_serial_label_options','role_change_requests'
  ];
begin
  foreach t in array shop_tables loop
    execute format('drop trigger if exists set_shop_id on public.%I', t);
    execute format('create trigger set_shop_id before insert on public.%I for each row execute function public.set_tenant_shop_id()', t);
  end loop;
end $$;

create or replace function public.set_work_order_location()
returns trigger language plpgsql security definer set search_path = public as $$
declare prim uuid;
begin
  if new.location_id is not null then
    if not exists (select 1 from public.shop_locations l where l.id = new.location_id and l.shop_id = new.shop_id) then
      raise exception 'location_id % does not belong to shop %', new.location_id, new.shop_id;
    end if;
  else
    select id into prim from public.shop_locations where shop_id = new.shop_id and is_primary limit 1;
    if prim is null then
      select id into prim from public.shop_locations where shop_id = new.shop_id and is_active order by created_at limit 1;
    end if;
    if prim is null then raise exception 'Shop % has no location', new.shop_id; end if;
    new.location_id := prim;
  end if;
  return new;
end $$;
drop trigger if exists set_wo_location on public.work_orders;
-- runs AFTER set_shop_id (triggers fire alphabetically: set_shop_id < set_wo_location)
create trigger set_wo_location before insert on public.work_orders
  for each row execute function public.set_work_order_location();

-- Prevent moving a row between shops on UPDATE (defense in depth on top of RLS).
create or replace function public.forbid_shop_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.shop_id is distinct from old.shop_id and not public.is_platform_admin() then
    raise exception 'Cannot move a record between shops';
  end if;
  return new;
end $$;
do $$
declare t text;
  shop_tables text[] := array[
    'work_orders','work_order_comments','work_order_photos','activities',
    'work_order_serial_numbers','shop_serial_label_options','role_change_requests'
  ];
begin
  foreach t in array shop_tables loop
    execute format('drop trigger if exists forbid_shop_change on public.%I', t);
    execute format('create trigger forbid_shop_change before update on public.%I for each row execute function public.forbid_shop_change()', t);
  end loop;
end $$;

-- Audit trigger now records shop_id (generic extraction; profiles has none →
-- falls back to the actor's current shop).
create or replace function public.write_audit_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor public.profiles; act text; rec_id text; sid uuid;
begin
  select * into actor from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then act := 'insert';
  elsif tg_op = 'UPDATE' then
    act := case
      when tg_table_name = 'work_orders' and new.active = false and old.active = true then 'archive'
      when tg_table_name = 'work_orders' and new.active = true and old.active = false then 'restore'
      when tg_table_name = 'profiles' and new.active = false and old.active = true then 'deactivate'
      when tg_table_name = 'profiles' and new.active = true and old.active = false then 'reactivate'
      else 'update' end;
  elsif tg_op = 'DELETE' then act := 'delete';
  end if;
  rec_id := case when tg_op = 'DELETE' then old.id::text else new.id::text end;
  sid := coalesce(
    nullif(case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'shop_id','')::uuid,
    public.current_user_shop_id());
  insert into public.audit_log (actor_id, actor_name, actor_role, action, table_name, record_id, old_value, new_value, shop_id)
  values (auth.uid(), coalesce(actor.full_name,''), coalesce(actor.role,''), act, tg_table_name, rec_id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('UPDATE','INSERT') then to_jsonb(new) else null end,
    sid);
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 20E. RLS replacement — every tenant policy rewritten with an explicit
--      row_in_current_shop(shop_id) predicate. is_active_user()/is_shop_owner()
--      are now shop-scoped (20B) but are NOT sufficient alone on UPDATE/DELETE
--      (those don't require SELECT), so the row predicate is always present.
-- ---------------------------------------------------------------------------

-- shops
drop policy if exists "shops: member read" on public.shops;
create policy "shops: member read" on public.shops
  for select using (public.is_active_shop_member(id));
drop policy if exists "shops: owner update" on public.shops;
create policy "shops: owner update" on public.shops
  for update using (public.is_shop_owner(id)) with check (public.is_shop_owner(id));

-- shop_locations
drop policy if exists "locations: member read" on public.shop_locations;
create policy "locations: member read" on public.shop_locations
  for select using (public.is_active_shop_member(shop_id));
drop policy if exists "locations: owner manage" on public.shop_locations;
create policy "locations: owner manage" on public.shop_locations
  for all using (public.is_shop_owner(shop_id)) with check (public.is_shop_owner(shop_id));

-- shop_memberships
drop policy if exists "memberships: self read" on public.shop_memberships;
create policy "memberships: self read" on public.shop_memberships
  for select using (profile_id = auth.uid() or public.is_shop_owner(shop_id));
drop policy if exists "memberships: owner manage" on public.shop_memberships;
create policy "memberships: owner manage" on public.shop_memberships
  for all using (public.is_shop_owner(shop_id)) with check (public.is_shop_owner(shop_id));

-- profiles: self always; owners see/manage only profiles that share their shop.
drop policy if exists "profiles: shop_owner full access" on public.profiles;
create policy "profiles: owner manage shop members" on public.profiles
  for all using (
    id = auth.uid() or exists (
      select 1 from public.shop_memberships m
      where m.profile_id = public.profiles.id and m.shop_id = public.current_user_shop_id()
        and public.is_shop_owner(public.current_user_shop_id())
    )
  ) with check (
    id = auth.uid() or public.is_shop_owner(public.current_user_shop_id())
  );
-- (self read / self update limited from section 9/16 remain in force.)

-- work_orders
drop policy if exists "work_orders: shop_owner full access" on public.work_orders;
drop policy if exists "work_orders: mechanic read active" on public.work_orders;
drop policy if exists "work_orders: mechanic insert" on public.work_orders;
drop policy if exists "work_orders: staff update shop" on public.work_orders;
create policy "work_orders: shop read" on public.work_orders
  for select using (public.is_active_user() and public.row_in_current_shop(shop_id));
create policy "work_orders: shop insert" on public.work_orders
  for insert with check (public.is_active_user() and public.row_in_current_shop(shop_id) and created_by = auth.uid());
create policy "work_orders: shop update" on public.work_orders
  for update using (public.is_active_user() and public.row_in_current_shop(shop_id))
  with check (public.is_active_user() and public.row_in_current_shop(shop_id));
create policy "work_orders: owner delete" on public.work_orders
  for delete using (public.is_shop_owner() and public.row_in_current_shop(shop_id));

-- work_order_comments
drop policy if exists "comments: shop_owner full access" on public.work_order_comments;
drop policy if exists "comments: read active" on public.work_order_comments;
drop policy if exists "comments: insert own" on public.work_order_comments;
create policy "comments: shop read" on public.work_order_comments
  for select using (public.is_active_user() and active = true and public.row_in_current_shop(shop_id));
create policy "comments: shop insert" on public.work_order_comments
  for insert with check (public.is_active_user() and public.row_in_current_shop(shop_id) and author_id = auth.uid());
create policy "comments: owner update" on public.work_order_comments
  for update using (public.is_shop_owner() and public.row_in_current_shop(shop_id))
  with check (public.is_shop_owner() and public.row_in_current_shop(shop_id));

-- work_order_photos
drop policy if exists "photos: shop_owner full access" on public.work_order_photos;
drop policy if exists "photos: read active" on public.work_order_photos;
drop policy if exists "photos: staff insert any job" on public.work_order_photos;
drop policy if exists "photos: staff curate any" on public.work_order_photos;
drop policy if exists "photos: uploader update own" on public.work_order_photos;
create policy "photos: shop read" on public.work_order_photos
  for select using (public.is_active_user() and active = true and public.row_in_current_shop(shop_id));
create policy "photos: shop insert" on public.work_order_photos
  for insert with check (public.is_active_user() and public.row_in_current_shop(shop_id) and created_by = auth.uid());
create policy "photos: shop update" on public.work_order_photos
  for update using (public.is_active_user() and public.row_in_current_shop(shop_id))
  with check (public.is_active_user() and public.row_in_current_shop(shop_id));

-- activities
drop policy if exists "activities: shop_owner full access" on public.activities;
drop policy if exists "activities: read active" on public.activities;
drop policy if exists "activities: insert own" on public.activities;
drop policy if exists "activities: author or shop_owner update" on public.activities;
create policy "activities: shop read" on public.activities
  for select using (public.is_active_user() and active = true and public.row_in_current_shop(shop_id));
create policy "activities: shop insert" on public.activities
  for insert with check (public.is_active_user() and public.row_in_current_shop(shop_id) and author_id = auth.uid());
create policy "activities: author or owner update" on public.activities
  for update using (public.is_active_user() and public.row_in_current_shop(shop_id)
    and (author_id = auth.uid() or public.is_shop_owner()))
  with check (public.is_active_user() and public.row_in_current_shop(shop_id));

-- activity_history: scoped through its parent activity's shop.
drop policy if exists "activity_history: read active" on public.activity_history;
drop policy if exists "activity_history: insert own" on public.activity_history;
create policy "activity_history: read via activity" on public.activity_history
  for select using (exists (
    select 1 from public.activities a
    where a.id = activity_history.activity_id and public.is_active_user() and public.row_in_current_shop(a.shop_id)
  ));
create policy "activity_history: insert own" on public.activity_history
  for insert with check (edited_by = auth.uid() and exists (
    select 1 from public.activities a
    where a.id = activity_history.activity_id and public.is_active_user() and public.row_in_current_shop(a.shop_id)
  ));

-- work_order_serial_numbers
drop policy if exists "serial_numbers: shop_owner full access" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: read active" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: insert own" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: staff update any" on public.work_order_serial_numbers;
create policy "serial_numbers: shop read" on public.work_order_serial_numbers
  for select using (public.is_active_user() and active = true and public.row_in_current_shop(shop_id));
create policy "serial_numbers: shop insert" on public.work_order_serial_numbers
  for insert with check (public.is_active_user() and public.row_in_current_shop(shop_id) and created_by = auth.uid());
create policy "serial_numbers: shop update" on public.work_order_serial_numbers
  for update using (public.is_active_user() and public.row_in_current_shop(shop_id))
  with check (public.is_active_user() and public.row_in_current_shop(shop_id));

-- shop_serial_label_options
drop policy if exists "serial_labels: shop_owner full access" on public.shop_serial_label_options;
drop policy if exists "serial_labels: read all" on public.shop_serial_label_options;
create policy "serial_labels: owner manage" on public.shop_serial_label_options
  for all using (public.is_shop_owner() and public.row_in_current_shop(shop_id))
  with check (public.is_shop_owner() and public.row_in_current_shop(shop_id));
create policy "serial_labels: shop read" on public.shop_serial_label_options
  for select using (public.is_active_user() and public.row_in_current_shop(shop_id));

-- role_change_requests
drop policy if exists "role_requests: shop_owner full access" on public.role_change_requests;
drop policy if exists "role_requests: self read" on public.role_change_requests;
drop policy if exists "role_requests: self insert" on public.role_change_requests;
create policy "role_requests: owner manage" on public.role_change_requests
  for all using (public.is_shop_owner() and public.row_in_current_shop(shop_id))
  with check (public.is_shop_owner() and public.row_in_current_shop(shop_id));
create policy "role_requests: self read" on public.role_change_requests
  for select using (public.is_active_user() and profile_id = auth.uid() and public.row_in_current_shop(shop_id));
create policy "role_requests: self insert" on public.role_change_requests
  for insert with check (public.is_active_user() and profile_id = auth.uid() and public.row_in_current_shop(shop_id));

-- audit_log
drop policy if exists "audit_log: shop_owner read only" on public.audit_log;
create policy "audit_log: owner read shop" on public.audit_log
  for select using (public.is_shop_owner() and public.row_in_current_shop(shop_id));

-- storage.objects: writes require membership in the work order's shop.
drop policy if exists "work-order-photos: shop_owner full access" on storage.objects;
drop policy if exists "work-order-photos: staff insert any job" on storage.objects;
drop policy if exists "work-order-photos: mechanic insert own job" on storage.objects;
create policy "work-order-photos: shop member insert" on storage.objects
  for insert with check (
    bucket_id = 'work-order-photos' and exists (
      select 1 from public.work_orders wo
      where wo.id = (storage.foldername(name))[1]
        and public.is_active_user() and public.row_in_current_shop(wo.shop_id)
    ));
create policy "work-order-photos: owner manage" on storage.objects
  for all using (
    bucket_id = 'work-order-photos' and exists (
      select 1 from public.work_orders wo
      where wo.id = (storage.foldername(name))[1]
        and public.is_shop_owner() and public.row_in_current_shop(wo.shop_id)
    )) with check (
    bucket_id = 'work-order-photos' and exists (
      select 1 from public.work_orders wo
      where wo.id = (storage.foldername(name))[1]
        and public.is_shop_owner() and public.row_in_current_shop(wo.shop_id)
    ));
-- NOTE (unresolved risk): the bucket is public=true, so object BYTES are
-- readable by anyone with the path via the CDN, bypassing the SELECT policy.
-- Cross-tenant isolation of image bytes is therefore NOT enforced yet. To
-- close this, make the bucket private and serve via signed URLs — tracked as
-- a follow-up, out of scope for this phase (matches prior single-shop design).

-- ---------------------------------------------------------------------------
-- 20F. Indexes for common tenant queries (most created inline above)
-- ---------------------------------------------------------------------------
create index if not exists shop_memberships_active_idx on public.shop_memberships (shop_id) where is_active = true;
create index if not exists work_orders_shop_loc_status_idx on public.work_orders (shop_id, location_id, status) where active = true;
create index if not exists audit_log_shop_idx on public.audit_log (shop_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 20G. Verification queries — run manually after migrating. Each should
--      return ZERO rows (or the stated expectation).
-- ---------------------------------------------------------------------------
-- 1. No tenant row with null shop_id:
--   select 'work_orders' t, count(*) from public.work_orders where shop_id is null
--   union all select 'activities', count(*) from public.activities where shop_id is null
--   union all select 'work_order_photos', count(*) from public.work_order_photos where shop_id is null
--   union all select 'work_order_serial_numbers', count(*) from public.work_order_serial_numbers where shop_id is null
--   union all select 'work_order_comments', count(*) from public.work_order_comments where shop_id is null
--   union all select 'role_change_requests', count(*) from public.role_change_requests where shop_id is null
--   union all select 'shop_serial_label_options', count(*) from public.shop_serial_label_options where shop_id is null
--   union all select 'audit_log', count(*) from public.audit_log where shop_id is null;
-- 2. No work order points at a location from another shop:
--   select wo.id from public.work_orders wo join public.shop_locations l on l.id = wo.location_id
--   where l.shop_id <> wo.shop_id;
-- 3. Every active profile has a membership:
--   select p.id, p.email from public.profiles p where p.active
--   and not exists (select 1 from public.shop_memberships m where m.profile_id = p.id and m.is_active);
-- 4. Every profile's active shop is one of its active memberships (or null):
--   select p.id from public.profiles p where p.active_shop_id is not null
--   and not exists (select 1 from public.shop_memberships m where m.profile_id = p.id and m.shop_id = p.active_shop_id and m.is_active);
-- 5. No duplicate membership (guaranteed by unique constraint — should be 0):
--   select profile_id, shop_id, count(*) from public.shop_memberships group by 1,2 having count(*) > 1;
-- 6. Exactly one primary location per shop:
--   select shop_id, count(*) from public.shop_locations where is_primary group by shop_id having count(*) <> 1;
-- Cross-tenant negative tests (run while authenticated as a member of shop A,
-- using a second test shop B from the test script) — each must return 0 / fail:
-- 7. select count(*) from public.work_orders;                 -- only shop A rows
-- 8. insert ... work_orders (..., shop_id = '<shop B id>');   -- trigger rewrites to A / WITH CHECK blocks
-- 9. update public.work_orders set shop_id = '<shop B id>';   -- forbid_shop_change raises
-- 10. as a mechanic: update public.shop_memberships set role='shop_owner' where profile_id=auth.uid();  -- blocked (owner-only policy)
-- 11. as a shop_owner: insert into public.platform_admins ...; -- blocked (no client policy)
-- 12. deactivate a membership, re-run query 7 → 0 rows (tenant access lost).
-- 13. RECONCILIATION — legacy profiles.role must agree with the active
--     membership role in the user's active shop. Should return 0 rows; any row
--     is a dual-write drift to investigate before dropping profiles.role.
--   select p.id, p.email, p.role as legacy_role, m.role as membership_role, p.active_shop_id
--   from public.profiles p
--   join public.shop_memberships m
--     on m.profile_id = p.id and m.shop_id = p.active_shop_id and m.is_active
--   where p.role is distinct from m.role;

-- ---------------------------------------------------------------------------
-- 20H. Application migration notes (see DEPLOY-INSTRUCTIONS.md for full steps)
--   - profiles.role is retained (staged). shop_memberships.role is
--     authoritative for RLS. Do NOT drop profiles.role until a later
--     migration confirms no executable code reads it.
--   - Netlify functions (manage-users / update-staff-role / review-role-change)
--     still write profiles.role; they must ALSO upsert shop_memberships.role
--     for the target shop, and invites should pass app_metadata.shop_id so the
--     provisioning trigger enrolls the new user in the right shop.
--   - Frontend must call set_active_shop() via RPC on shop switch, clear all
--     tenant-scoped state, and reload. QR-linked jobs must verify membership
--     in that job's shop before opening.
-- ===========================================================================

-- ===========================================================================
-- 21. PRIVATE-STORAGE CONVERSION (additive; bucket stays PUBLIC in this pass)
--
--   Goal: make work-order-photos safe to flip to a PRIVATE bucket WITHOUT
--   breaking reads, and lock every storage operation to the caller's shop as
--   proven by AUTHORITATIVE DATABASE DATA — never by trusting the object path
--   text. This section is safe to apply while the bucket is still public:
--   the SELECT policy below is inert on a public bucket (public reads bypass
--   RLS) and simply becomes the enforcement point the moment the bucket is
--   flipped private (that flip is a DEPLOY step, NOT run here).
--
--   NOTHING in this section deletes bytes or changes the bucket's public flag.
-- ===========================================================================

-- 21A. Authoritative path->work_order resolver + object-name format guard.
--   The object path is <work_order_id>/<photo_id>-{orig|thumb}.jpg. We resolve
--   the FIRST segment against public.work_orders and return the row ONLY if it
--   genuinely exists; a made-up prefix resolves to nothing and is denied. The
--   format guard additionally prevents arbitrary path creation.
create or replace function public.storage_wo_in_current_shop(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.work_orders wo
    where wo.id = (storage.foldername(object_name))[1]
      and public.is_active_user()
      and public.row_in_current_shop(wo.shop_id)
  );
$$;

create or replace function public.storage_wo_owned_in_current_shop(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.work_orders wo
    where wo.id = (storage.foldername(object_name))[1]
      and public.is_shop_owner()
      and public.row_in_current_shop(wo.shop_id)
  );
$$;

-- Enforced object-name shape: "<segment>/<uuid-or-token>-orig.jpg" | "...-thumb.jpg".
-- Blocks arbitrary keys and stray folders (name must have exactly one "/").
create or replace function public.storage_name_is_valid_photo(object_name text)
returns boolean language sql immutable set search_path = public as $$
  select object_name ~ '^[^/]+/[^/]+-(orig|thumb)\.jpg$';
$$;

-- 21B. Storage policies (DB-authoritative). Replace the section-20 set.
drop policy if exists "work-order-photos: shop member insert" on storage.objects;
drop policy if exists "work-order-photos: owner manage" on storage.objects;
drop policy if exists "wop: select shop member" on storage.objects;
drop policy if exists "wop: insert shop member" on storage.objects;
drop policy if exists "wop: update shop member noshopmove" on storage.objects;
drop policy if exists "wop: delete owner only" on storage.objects;

-- READ: any active member of the work order's shop. Inert while the bucket is
-- public; the enforcement point once it is flipped private.
create policy "wop: select shop member" on storage.objects
  for select using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_in_current_shop(name)
  );

-- INSERT: active member of the WO's shop AND a well-formed photo key. The WO
-- must exist in the DB and belong to the caller's current shop.
create policy "wop: insert shop member" on storage.objects
  for insert with check (
    bucket_id = 'work-order-photos'
    and public.storage_name_is_valid_photo(name)
    and public.storage_wo_in_current_shop(name)
  );

-- UPDATE: active member of the WO's shop. USING pins the object to the current
-- shop; WITH CHECK re-validates the (possibly renamed) key against a WO in the
-- SAME shop and the required name shape — so an object can never be renamed or
-- moved into another work order or another shop.
create policy "wop: update shop member noshopmove" on storage.objects
  for update using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_in_current_shop(name)
  ) with check (
    bucket_id = 'work-order-photos'
    and public.storage_name_is_valid_photo(name)
    and public.storage_wo_in_current_shop(name)
  );

-- DELETE (byte removal): shop_owner of the WO's shop ONLY, as defense in depth.
-- The application never deletes bytes from the browser (soft delete only); the
-- real permanent purge runs server-side with the service-role key, which
-- bypasses RLS. This policy exists so that IF a browser-side delete is ever
-- attempted, a mechanic cannot destroy evidence and a cross-tenant caller is
-- refused. Mechanics: intentionally NO storage delete permission.
create policy "wop: delete owner only" on storage.objects
  for delete using (
    bucket_id = 'work-order-photos'
    and public.storage_wo_owned_in_current_shop(name)
  );

-- 21C. Retention / purge lifecycle columns on work_order_photos.
--   Smallest coherent model: reuse the EXISTING soft-delete pair
--   (archived_at = deleted_at, archived_by = deleted_by) and add ONLY the
--   purge-specific state. Three distinct states are representable:
--     inactive           : active = false                (soft-deleted, keep)
--     approved-for-purge : purge_approved_at is not null AND purge_after set
--     purged             : storage_deleted_at is not null (bytes gone)
alter table public.work_order_photos add column if not exists purge_approved_at timestamptz;
alter table public.work_order_photos add column if not exists purge_approved_by uuid references public.profiles(id);
alter table public.work_order_photos add column if not exists purge_after timestamptz;
alter table public.work_order_photos add column if not exists storage_deleted_at timestamptz;
alter table public.work_order_photos add column if not exists storage_delete_error text;
-- Replacement lineage (Phase D): the photo that superseded this one, if any.
alter table public.work_order_photos add column if not exists replaced_by_photo_id uuid references public.work_order_photos(id) on delete set null;

-- Index for the future purge worker: only rows explicitly approved, past their
-- retention date, and not yet purged.
create index if not exists work_order_photos_purge_ready_idx
  on public.work_order_photos (purge_after)
  where purge_approved_at is not null and storage_deleted_at is null;

-- 21D. Read-only purge-candidate view. This SELECTS candidates; it NEVER
--   deletes. A future controlled release adds a service-role worker that reads
--   this view, re-verifies each row, removes the orig+thumb objects via the
--   Storage API, then stamps storage_deleted_at (or storage_delete_error).
--   No purge is wired up in this pass.
create or replace view public.work_order_photos_purge_candidates as
  select id, work_order_id, shop_id, storage_path, thumb_path,
         active, archived_at, archived_by,
         purge_approved_at, purge_approved_by, purge_after
  from public.work_order_photos
  where active = false
    and purge_approved_at is not null
    and purge_after is not null
    and purge_after <= now()
    and storage_deleted_at is null;

-- NOTE: the bucket is DELIBERATELY still public here. Flip it private only as a
-- deploy step AFTER the signed-URL frontend is live and verified:
--     update storage.buckets set public = false where id = 'work-order-photos';
-- Rollback: set public = true (reads work again immediately via CDN).
-- ===========================================================================
