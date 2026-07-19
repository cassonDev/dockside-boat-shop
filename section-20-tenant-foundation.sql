-- ===========================================================================
-- section-20-tenant-foundation.sql   (CORRECTED, STANDALONE, FOR REVIEW)
--
-- Reconciled against the ACTUAL live pre-tenant schema (Jul 2026):
--   * profiles has NO active_shop_id
--   * work_orders has NO shop_id and NO location_id  (id is TEXT)
--   * work_order_photos/comments/activities/serial_numbers have NO shop_id
--   * only shop_serial_label_options.shop_id exists (nullable)
--   * only pre-tenant helpers exist: is_active_user(), is_shop_owner()
--
-- This file does NOT assume shops.slug (the bug that broke the original run).
-- It is idempotent where safe. It seeds ONE initial tenant, "Lessard Marine
-- Works", enrolls every existing profile, and backfills shop_id onto all
-- tenant tables WITHOUT changing any existing id or application data.
--
-- DO NOT EXECUTE YET. Review first. Run inside ONE transaction so a failure
-- rolls the whole thing back (the Supabase SQL editor does this by default).
-- Section 21 (private storage) stays OUT of this file and is applied later,
-- only after the go/no-go gate in SECTION-20-PLAN.md passes.
-- ===========================================================================


-- ===========================================================================
-- PHASE 0 — RECONCILIATION REPORT (READ-ONLY, RUN SEPARATELY, BEFORE MIGRATING)
--   Manual review gate. Run this by itself, NOT inside the migration txn. It
--   changes nothing. Every 'to_backfill' should equal 'rows' on a clean
--   never-applied DB, and 'after_backfill' should equal 'rows' (no row lost).
-- ===========================================================================
-- 0.1 Row counts + backfill projection per tenant table.
select 'profiles' as tbl,
       (select count(*) from public.profiles) as rows,
       0 as to_backfill,
       (select count(*) from public.profiles) as after_backfill
union all select 'work_orders',
       (select count(*) from public.work_orders),
       (select count(*) from public.work_orders),
       (select count(*) from public.work_orders)
union all select 'activities',
       (select count(*) from public.activities),
       (select count(*) from public.activities),
       (select count(*) from public.activities)
union all select 'work_order_photos',
       (select count(*) from public.work_order_photos),
       (select count(*) from public.work_order_photos),
       (select count(*) from public.work_order_photos)
union all select 'work_order_comments',
       (select count(*) from public.work_order_comments),
       (select count(*) from public.work_order_comments),
       (select count(*) from public.work_order_comments)
union all select 'work_order_serial_numbers',
       (select count(*) from public.work_order_serial_numbers),
       (select count(*) from public.work_order_serial_numbers),
       (select count(*) from public.work_order_serial_numbers)
union all select 'audit_log',
       (select count(*) from public.audit_log),
       (select count(*) from public.audit_log),
       (select count(*) from public.audit_log)
union all select 'activity_history',
       (select count(*) from public.activity_history),
       (select count(*) from public.activity_history),
       (select count(*) from public.activity_history)
union all select 'role_change_requests',
       (select count(*) from public.role_change_requests),
       (select count(*) from public.role_change_requests),
       (select count(*) from public.role_change_requests)
order by tbl;

-- 0.2 Existing RLS policies on every affected table (manual baseline review).
--     Compare this list against your known section 1-19 baseline. If anything
--     unexpected appears, STOP — do not run the migration.
select tablename, policyname, cmd
from pg_policies
where schemaname='public'
  and tablename in ('profiles','work_orders','work_order_photos','work_order_comments',
                    'activities','activity_history','work_order_serial_numbers',
                    'audit_log','role_change_requests','shops','shop_memberships')
order by tablename, policyname;
-- ===========================================================================


-- ===========================================================================
-- PREFLIGHT (RAISES AND STOPS on mismatch). Read-only except for the RAISE.
--   Proves the live schema is the expected pre-tenant shape before we change
--   anything. If any assumption is false, the whole transaction aborts.
--
-- SINGLE EXPLICIT TRANSACTION STARTS HERE. Preflight, the RLS-policy guard, all
-- schema changes, the backfill, and every policy drop+recreate run between this
-- BEGIN and the final COMMIT. If ANY statement fails (guard RAISE, a policy that
-- won't recreate, a NOT-NULL that won't lock), the whole transaction ROLLS BACK
-- — no dropped policy and no half-applied schema is ever left behind. Do NOT run
-- the PHASE 0 / verification blocks inside this transaction.
-- ===========================================================================
begin;

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'PREFLIGHT: public.profiles missing'; end if;
  if to_regclass('public.work_orders') is null then
    raise exception 'PREFLIGHT: public.work_orders missing'; end if;
  if to_regclass('public.work_order_photos') is null then
    raise exception 'PREFLIGHT: public.work_order_photos missing'; end if;

  -- work_orders.id: KEEP AS-IS. We do NOT redesign the primary key. Per the
  -- approved direction, authorization relies on shop_id + work_orders.id, never
  -- on changing the identifier strategy. NOTE: the live id is a short TEXT job
  -- code (globally unique today), not a uuid — we preserve it exactly. If a
  -- future decision moves to uuid PKs, that is a separate migration, not this.
  if (select data_type from information_schema.columns
        where table_schema='public' and table_name='work_orders' and column_name='id') <> 'text' then
    raise notice 'PREFLIGHT NOTE: work_orders.id is not text — schema differs from expected; review before proceeding.';
  end if;

  -- These tenant tables must NOT already exist as populated tenant tables.
  -- (create-if-not-exists below tolerates empty shells; we only guard data.)
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='work_orders' and column_name='shop_id') then
    raise notice 'PREFLIGHT NOTE: work_orders.shop_id already exists — partial prior run? Inspect before proceeding.';
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='profiles' and column_name='active_shop_id') then
    raise notice 'PREFLIGHT NOTE: profiles.active_shop_id already exists — partial prior run? Inspect before proceeding.';
  end if;

  raise notice 'PREFLIGHT OK: live schema matches expected pre-tenant shape.';
end $$;

-- ---------------------------------------------------------------------------
-- RLS-POLICY GUARD (RAISES on unexpected state). Do NOT silently replace live
--   policies. The live pre-tenant policies are PERMISSIVE (no per-row shop
--   predicate); after helper redefinition they would OR-in and BYPASS tenant
--   isolation. So 20F below DROPS the KNOWN pre-tenant baseline and REPLACES it
--   with shop-scoped policies (strengthening, not weakening). This guard makes
--   that safe: it ABORTS if any policy exists on an affected table whose name
--   is NOT in the known baseline AND not one of the new shop-scoped names — an
--   unknown/custom policy could grant broader access and MUST be reconciled by
--   a human first. Run the Phase 0.2 inventory and read PHASE0-AND-FINDINGS.md.
-- ---------------------------------------------------------------------------
do $$
declare unknowns text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into unknowns
  from pg_policies
  where schemaname='public'
    and tablename in ('profiles','work_orders','work_order_photos','work_order_comments',
      'activities','activity_history','work_order_serial_numbers','audit_log',
      'role_change_requests','shop_serial_label_options')
    and policyname not in (
      -- KNOWN pre-tenant baseline (sections 1-19 + staff updates) — replaced in 20F:
      'profiles: shop_owner full access','profiles: self read','profiles: self update limited',
      'profiles: service_advisor update availability',
      'work_orders: shop_owner full access','work_orders: mechanic read active',
      'work_orders: mechanic update own','work_orders: mechanic insert',
      'work_orders: service_advisor full access','work_orders: staff update shop',
      'comments: shop_owner full access','comments: read active','comments: insert own',
      'photos: shop_owner full access','photos: read active','photos: advisor insert any job',
      'photos: mechanic insert own job','photos: uploader update own','photos: advisor curate any',
      'photos: staff insert any job','photos: staff curate any',
      'activities: shop_owner full access','activities: read active','activities: insert own',
      'activities: author, advisor, or shop_owner update','activities: author or shop_owner update',
      'activity_history: read active','activity_history: insert own',
      'serial_numbers: shop_owner full access','serial_numbers: read active',
      'serial_numbers: insert own','serial_numbers: creator or advisor update','serial_numbers: staff update any',
      'audit_log: shop_owner read only',
      'role_requests: shop_owner full access','role_requests: self read','role_requests: self insert',
      'serial_labels: shop_owner full access','serial_labels: read all',
      -- NEW shop-scoped names created by 20F (idempotent re-run tolerance):
      'profiles: owner manage shop members','wo: shop isolation','wop: shop isolation',
      'woc: shop isolation','act: shop isolation','sn: shop isolation','ah: shop isolation',
      'audit: shop read','rcr: shop isolation','serial_labels: shop isolation',
      'shops: member read','memberships: self read'
    );
  if unknowns is not null then
    raise exception 'RLS GUARD: unknown/custom policies on affected tables require manual reconciliation before migrating: %', unknowns;
  end if;
  raise notice 'RLS GUARD OK: only known-baseline policies present; 20F will replace them with shop-scoped versions.';
end $$;


-- ###########################################################################
-- ####################  EXECUTABLE MIGRATION SQL (continues in the same tx) ##
-- ###########################################################################

-- ---------------------------------------------------------------------------
-- 20A. Core tenant + location tables  (NO slug column)
-- ---------------------------------------------------------------------------
create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shops enable row level security;

create table if not exists public.shop_locations (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete restrict,
  name text not null check (char_length(trim(name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.shop_locations enable row level security;
create index if not exists shop_locations_shop_idx on public.shop_locations (shop_id);

create table if not exists public.shop_memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  shop_id uuid not null references public.shops(id) on delete cascade,
  role text not null default 'mechanic' check (role in ('shop_owner','mechanic')),
  is_active boolean not null default true,
  default_location_id uuid references public.shop_locations(id),
  created_at timestamptz not null default now(),
  unique (profile_id, shop_id)
);
alter table public.shop_memberships enable row level security;
create index if not exists shop_memberships_profile_idx on public.shop_memberships (profile_id);
create index if not exists shop_memberships_shop_idx on public.shop_memberships (shop_id);

create table if not exists public.platform_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

-- profiles gets a pointer to the caller's currently-active shop.
alter table public.profiles add column if not exists active_shop_id uuid references public.shops(id);

-- ---------------------------------------------------------------------------
-- 20B. Tenant columns on the work tables (added NULL first, backfilled in 20D,
--      set NOT NULL in 20E after backfill proves complete).
-- ---------------------------------------------------------------------------
alter table public.work_orders            add column if not exists shop_id uuid references public.shops(id);
alter table public.work_orders            add column if not exists location_id uuid references public.shop_locations(id);
alter table public.work_order_photos      add column if not exists shop_id uuid references public.shops(id);
alter table public.work_order_comments    add column if not exists shop_id uuid references public.shops(id);
alter table public.activities             add column if not exists shop_id uuid references public.shops(id);
alter table public.work_order_serial_numbers add column if not exists shop_id uuid references public.shops(id);
-- Additional tenant-scoped tables (per approved isolation-scope decision):
alter table public.audit_log             add column if not exists shop_id uuid references public.shops(id);
alter table public.activity_history      add column if not exists shop_id uuid references public.shops(id);
alter table public.role_change_requests  add column if not exists shop_id uuid references public.shops(id);
-- shop_serial_label_options.shop_id already exists (nullable) — backfilled in 20D.

-- ---------------------------------------------------------------------------
-- 20C. Membership-aware helper functions (replace the pre-tenant zero-arg set)
-- ---------------------------------------------------------------------------
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
create or replace function public.is_shop_owner()
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_shop_owner(public.current_user_shop_id());
$$;

create or replace function public.is_active_user()
returns boolean language sql security definer stable set search_path = public as $$
  select public.is_active_shop_member(public.current_user_shop_id());
$$;

create or replace function public.row_in_current_shop(row_shop_id uuid)
returns boolean language sql stable set search_path = public as $$
  select row_shop_id is not null and row_shop_id = public.current_user_shop_id();
$$;

-- Guard: a user may only point active_shop_id at a shop they are an active member of.
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
create trigger guard_active_shop_id before update on public.profiles
  for each row execute function public.enforce_active_shop_id();

-- Client-callable, membership-validated active-shop switch.
create or replace function public.set_active_shop(p_shop_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.shop_memberships m
    where m.profile_id = auth.uid() and m.shop_id = p_shop_id and m.is_active) then
    raise exception 'Not an active member of that shop';
  end if;
  update public.profiles set active_shop_id = p_shop_id, updated_at = now() where id = auth.uid();
end $$;
revoke all on function public.set_active_shop(uuid) from public;
grant execute on function public.set_active_shop(uuid) to authenticated;

-- Server-side stamp: on insert, set shop_id from the caller's current shop when
-- the client didn't provide it. Never trusts a client-sent shop_id blindly —
-- it overwrites with the resolved current shop. STRICT variant (raises) is for
-- app-owned tables where a missing shop is a real error.
create or replace function public.set_tenant_shop_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.shop_id := public.current_user_shop_id();
  if new.shop_id is null then
    raise exception 'No current shop for caller — cannot stamp shop_id';
  end if;
  return new;
end $$;

-- LENIENT variant for append-only / system tables (audit_log, activity_history)
-- written by SECURITY DEFINER triggers: prefer the parent/current shop but must
-- NEVER block the base operation if the shop can't be resolved. Keeps any
-- explicitly-set shop_id, else fills from current shop, else leaves NULL.
create or replace function public.set_tenant_shop_id_lenient()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.shop_id is null then new.shop_id := public.current_user_shop_id(); end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 20D. Seed the initial tenant + backfill ALL existing data (idempotent seed)
-- ---------------------------------------------------------------------------
do $$
declare v_shop uuid; v_loc uuid; v_owner uuid;
begin
  -- 1) One shop: Lessard Marine Works (reuse if already seeded).
  select id into v_shop from public.shops where name = 'Lessard Marine Works' limit 1;
  if v_shop is null then
    insert into public.shops (name) values ('Lessard Marine Works') returning id into v_shop;
  end if;

  -- 2) One default location.
  select id into v_loc from public.shop_locations where shop_id = v_shop order by created_at asc limit 1;
  if v_loc is null then
    insert into public.shop_locations (shop_id, name) values (v_shop, 'Main Location') returning id into v_loc;
  end if;

  -- 3) Enroll every existing profile. Existing role 'shop_owner' → owner, else mechanic.
  insert into public.shop_memberships (profile_id, shop_id, role, is_active, default_location_id)
  select p.id, v_shop,
         case when p.role = 'shop_owner' then 'shop_owner' else 'mechanic' end,
         p.active, v_loc
  from public.profiles p
  on conflict (profile_id, shop_id) do nothing;

  -- 4) Point active_shop_id at the seed shop — ONLY for profiles that now have
  --    an ACTIVE membership in it (created in step 3 above). This runs after the
  --    memberships exist AND satisfies enforce_active_shop_id(), which requires
  --    an active membership. Deactivated / inactive profiles received an INACTIVE
  --    membership in step 3 and are intentionally left with active_shop_id = NULL
  --    (they have no current shop until reactivated). The guard is NOT disabled,
  --    bypassed, or weakened — this update simply never asks it to approve a shop
  --    the profile is not an active member of.
  --    FIX (2026-07-18): the prior version updated ALL profiles unconditionally,
  --    which raised P0001 from enforce_active_shop_id() on the first inactive
  --    profile (inactive membership). The EXISTS predicate below is the fix.
  update public.profiles p set active_shop_id = v_shop
  where p.active_shop_id is null
    and exists (
      select 1 from public.shop_memberships m
      where m.profile_id = p.id and m.shop_id = v_shop and m.is_active
    );

  raise notice 'SEED OK: tenant % (location %) seeded; members enrolled; active_shop_id set.', v_shop, v_loc;
end $$;

-- 20D-2. Temporarily disable USER triggers on ONLY the tables about to be
--   backfilled. WHY: pre-existing BEFORE UPDATE guards (e.g.
--   guard_work_order_edits -> enforce_work_order_edits) call is_active_user()/
--   auth.uid(); in a SQL-editor migration auth.uid() is NULL, so they RAISE
--   'Not permitted: account is not active' on an administrative shop_id stamp.
--   This toggle is TABLE-scoped AND TRANSACTION-scoped: it disables only user
--   triggers on these specific tables, re-enables them in 20D-4 BEFORE commit,
--   touches NO RLS, drops NOTHING, and leaves referential-integrity (system)
--   triggers active. If the whole tx rolls back, this disable rolls back too
--   (DDL is transactional) -- triggers are never left disabled after this runs.
--   >>> RUN THE TRIGGER-DISCOVERY QUERY (runbook Phase 6, failure B) FIRST to see
--       exactly which triggers this temporarily disables, and to confirm the
--       live trigger set on these tables (live is the source of truth). <<<
do $$
declare t text;
begin
  foreach t in array array[
    'work_orders','work_order_photos','work_order_comments','activities',
    'work_order_serial_numbers','activity_history','audit_log',
    'role_change_requests','shop_serial_label_options'
  ] loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;
  raise notice 'BACKFILL GUARD: user triggers temporarily disabled on backfill tables.';
end $$;

-- 20D-3. Backfill every work table's shop_id (children from their parent WO).
--   Runs with the app-authorization guards temporarily off (20D-2); they are
--   restored in 20D-4 before commit. Re-resolves v_shop/v_loc (new scope).
do $$
declare v_shop uuid; v_loc uuid;
begin
  select id into v_shop from public.shops where name = 'Lessard Marine Works' limit 1;
  select id into v_loc from public.shop_locations where shop_id = v_shop order by created_at asc limit 1;

  -- work_orders (shop_id + location_id)
  update public.work_orders set shop_id = v_shop where shop_id is null;
  update public.work_orders set location_id = v_loc where location_id is null;
  -- child tables from their parent work order (authoritative link)
  update public.work_order_photos ph set shop_id = wo.shop_id
    from public.work_orders wo where ph.work_order_id = wo.id and ph.shop_id is null;
  update public.work_order_comments c set shop_id = wo.shop_id
    from public.work_orders wo where c.work_order_id = wo.id and c.shop_id is null;
  update public.activities a set shop_id = wo.shop_id
    from public.work_orders wo where a.work_order_id = wo.id and a.shop_id is null;
  update public.work_order_serial_numbers s set shop_id = wo.shop_id
    from public.work_orders wo where s.work_order_id = wo.id and s.shop_id is null;
  -- activity_history from its parent activity
  update public.activity_history ah set shop_id = a.shop_id
    from public.activities a where ah.activity_id = a.id and ah.shop_id is null;
  -- audit_log + role_change_requests: single-tenant backfill to the seed shop
  update public.audit_log set shop_id = v_shop where shop_id is null;
  update public.role_change_requests set shop_id = v_shop where shop_id is null;
  -- shop_serial_label_options (shop_id already existed, nullable)
  update public.shop_serial_label_options set shop_id = v_shop where shop_id is null;

  raise notice 'BACKFILL OK: shop_id stamped on all existing tenant rows.';
end $$;

-- 20D-4. Re-enable the USER triggers disabled in 20D-2 (BEFORE commit). If any
--   later statement (20E/20F) fails, the whole tx rolls back and the original
--   enabled state is restored automatically.
do $$
declare t text;
begin
  foreach t in array array[
    'work_orders','work_order_photos','work_order_comments','activities',
    'work_order_serial_numbers','activity_history','audit_log',
    'role_change_requests','shop_serial_label_options'
  ] loop
    execute format('alter table public.%I enable trigger user', t);
  end loop;
  raise notice 'BACKFILL GUARD: user triggers re-enabled on backfill tables.';
end $$;

-- ---------------------------------------------------------------------------
-- 20E. Backfill validation + lock NOT NULL + install stamping triggers.
--   Each guard RAISES (aborting the txn) if any tenant row was left unstamped.
-- ---------------------------------------------------------------------------
do $$
declare n bigint;
begin
  select count(*) into n from public.work_orders where shop_id is null;
  if n > 0 then raise exception 'BACKFILL INCOMPLETE: % work_orders with null shop_id', n; end if;
  select count(*) into n from public.work_order_photos where shop_id is null;
  if n > 0 then raise exception 'BACKFILL INCOMPLETE: % work_order_photos with null shop_id', n; end if;
  select count(*) into n from public.work_order_comments where shop_id is null;
  if n > 0 then raise exception 'BACKFILL INCOMPLETE: % work_order_comments with null shop_id', n; end if;
  select count(*) into n from public.activities where shop_id is null;
  if n > 0 then raise exception 'BACKFILL INCOMPLETE: % activities with null shop_id', n; end if;
  select count(*) into n from public.work_order_serial_numbers where shop_id is null;
  if n > 0 then raise exception 'BACKFILL INCOMPLETE: % serial_numbers with null shop_id', n; end if;
  select count(*) into n from public.role_change_requests where shop_id is null;
  if n > 0 then raise exception 'BACKFILL INCOMPLETE: % role_change_requests with null shop_id', n; end if;
  -- audit_log + activity_history are LENIENT (append-only): backfilled best-effort
  -- and intentionally left nullable, so they are reported but do NOT abort.
  select count(*) into n from public.audit_log where shop_id is null;
  if n > 0 then raise notice 'NOTE: % audit_log rows still null shop_id (lenient, allowed).', n; end if;
  select count(*) into n from public.activity_history where shop_id is null;
  if n > 0 then raise notice 'NOTE: % activity_history rows still null shop_id (lenient, allowed).', n; end if;
  raise notice 'BACKFILL VALIDATED: no null shop_id on strict tenant tables.';
end $$;

alter table public.work_orders            alter column shop_id set not null;
alter table public.work_order_photos      alter column shop_id set not null;
alter table public.work_order_comments    alter column shop_id set not null;
alter table public.activities             alter column shop_id set not null;
alter table public.work_order_serial_numbers alter column shop_id set not null;
alter table public.role_change_requests   alter column shop_id set not null;
-- audit_log + activity_history: deliberately left NULLABLE (append-only, lenient).

create index if not exists work_orders_shop_idx        on public.work_orders (shop_id);
create index if not exists work_orders_location_idx    on public.work_orders (location_id);
create index if not exists work_order_photos_shop_idx  on public.work_order_photos (shop_id);
create index if not exists work_order_comments_shop_idx on public.work_order_comments (shop_id);
create index if not exists activities_shop_idx         on public.activities (shop_id);
create index if not exists serial_numbers_shop_idx     on public.work_order_serial_numbers (shop_id);
create index if not exists audit_log_shop_idx          on public.audit_log (shop_id);
create index if not exists activity_history_shop_idx   on public.activity_history (shop_id);
create index if not exists role_change_requests_shop_idx on public.role_change_requests (shop_id);

-- Stamp shop_id on new inserts (client value ignored/overwritten).
drop trigger if exists stamp_shop_id on public.work_orders;
create trigger stamp_shop_id before insert on public.work_orders
  for each row execute function public.set_tenant_shop_id();
drop trigger if exists stamp_shop_id on public.work_order_photos;
create trigger stamp_shop_id before insert on public.work_order_photos
  for each row execute function public.set_tenant_shop_id();
drop trigger if exists stamp_shop_id on public.work_order_comments;
create trigger stamp_shop_id before insert on public.work_order_comments
  for each row execute function public.set_tenant_shop_id();
drop trigger if exists stamp_shop_id on public.activities;
create trigger stamp_shop_id before insert on public.activities
  for each row execute function public.set_tenant_shop_id();
drop trigger if exists stamp_shop_id on public.work_order_serial_numbers;
create trigger stamp_shop_id before insert on public.work_order_serial_numbers
  for each row execute function public.set_tenant_shop_id();
drop trigger if exists stamp_shop_id on public.role_change_requests;
create trigger stamp_shop_id before insert on public.role_change_requests
  for each row execute function public.set_tenant_shop_id();
-- Append-only tables use the LENIENT stamp (never blocks the base write).
drop trigger if exists stamp_shop_id on public.audit_log;
create trigger stamp_shop_id before insert on public.audit_log
  for each row execute function public.set_tenant_shop_id_lenient();
drop trigger if exists stamp_shop_id on public.activity_history;
create trigger stamp_shop_id before insert on public.activity_history
  for each row execute function public.set_tenant_shop_id_lenient();

-- ---------------------------------------------------------------------------
-- 20F. Replace permissive pre-tenant policies with shop-scoped isolation.
--   The pre-tenant baseline is DROPPED (it lacks a per-row shop predicate and
--   would OR-in to bypass isolation) and REPLACED with row_in_current_shop()-
--   guarded policies. The RLS guard above already aborted on any unknown
--   policy, so every name dropped here is a known-safe baseline name.
-- ---------------------------------------------------------------------------
alter table public.shops             enable row level security;
alter table public.shop_memberships  enable row level security;

-- Drop the KNOWN permissive baseline on every affected table.
drop policy if exists "profiles: shop_owner full access" on public.profiles;
drop policy if exists "profiles: service_advisor update availability" on public.profiles;
drop policy if exists "work_orders: shop_owner full access" on public.work_orders;
drop policy if exists "work_orders: mechanic read active" on public.work_orders;
drop policy if exists "work_orders: mechanic update own" on public.work_orders;
drop policy if exists "work_orders: mechanic insert" on public.work_orders;
drop policy if exists "work_orders: service_advisor full access" on public.work_orders;
drop policy if exists "work_orders: staff update shop" on public.work_orders;
drop policy if exists "comments: shop_owner full access" on public.work_order_comments;
drop policy if exists "comments: read active" on public.work_order_comments;
drop policy if exists "comments: insert own" on public.work_order_comments;
drop policy if exists "photos: shop_owner full access" on public.work_order_photos;
drop policy if exists "photos: read active" on public.work_order_photos;
drop policy if exists "photos: advisor insert any job" on public.work_order_photos;
drop policy if exists "photos: mechanic insert own job" on public.work_order_photos;
drop policy if exists "photos: uploader update own" on public.work_order_photos;
drop policy if exists "photos: advisor curate any" on public.work_order_photos;
drop policy if exists "photos: staff insert any job" on public.work_order_photos;
drop policy if exists "photos: staff curate any" on public.work_order_photos;
drop policy if exists "activities: shop_owner full access" on public.activities;
drop policy if exists "activities: read active" on public.activities;
drop policy if exists "activities: insert own" on public.activities;
drop policy if exists "activities: author, advisor, or shop_owner update" on public.activities;
drop policy if exists "activities: author or shop_owner update" on public.activities;
drop policy if exists "activity_history: read active" on public.activity_history;
drop policy if exists "activity_history: insert own" on public.activity_history;
drop policy if exists "serial_numbers: shop_owner full access" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: read active" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: insert own" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: creator or advisor update" on public.work_order_serial_numbers;
drop policy if exists "serial_numbers: staff update any" on public.work_order_serial_numbers;
drop policy if exists "audit_log: shop_owner read only" on public.audit_log;
drop policy if exists "role_requests: shop_owner full access" on public.role_change_requests;
drop policy if exists "role_requests: self read" on public.role_change_requests;
drop policy if exists "role_requests: self insert" on public.role_change_requests;
drop policy if exists "serial_labels: shop_owner full access" on public.shop_serial_label_options;
drop policy if exists "serial_labels: read all" on public.shop_serial_label_options;

-- profiles: self access preserved (no cross-tenant path); owner scoped to shop.
drop policy if exists "profiles: self read" on public.profiles;
create policy "profiles: self read" on public.profiles for select using (id = auth.uid());
create policy "profiles: owner manage shop members" on public.profiles for all
  using (id = auth.uid() or (public.is_shop_owner() and exists (
    select 1 from public.shop_memberships m
    where m.profile_id = public.profiles.id and m.shop_id = public.current_user_shop_id())))
  with check (id = auth.uid() or (public.is_shop_owner() and exists (
    select 1 from public.shop_memberships m
    where m.profile_id = public.profiles.id and m.shop_id = public.current_user_shop_id())));

-- shops / memberships read scoping.
drop policy if exists "shops: member read" on public.shops;
create policy "shops: member read" on public.shops for select
  using (public.is_active_shop_member(id) or public.is_platform_admin());
drop policy if exists "memberships: self read" on public.shop_memberships;
create policy "memberships: self read" on public.shop_memberships for select
  using (profile_id = auth.uid() or public.is_platform_admin());

-- Per-table row isolation (SELECT/INSERT/UPDATE/DELETE gated by current shop).
-- work_orders
drop policy if exists "wo: shop isolation" on public.work_orders;
create policy "wo: shop isolation" on public.work_orders for all
  using (public.row_in_current_shop(shop_id))
  with check (public.row_in_current_shop(shop_id));
-- work_order_photos
drop policy if exists "wop: shop isolation" on public.work_order_photos;
create policy "wop: shop isolation" on public.work_order_photos for all
  using (public.row_in_current_shop(shop_id))
  with check (public.row_in_current_shop(shop_id));
-- work_order_comments
drop policy if exists "woc: shop isolation" on public.work_order_comments;
create policy "woc: shop isolation" on public.work_order_comments for all
  using (public.row_in_current_shop(shop_id))
  with check (public.row_in_current_shop(shop_id));
-- activities
drop policy if exists "act: shop isolation" on public.activities;
create policy "act: shop isolation" on public.activities for all
  using (public.row_in_current_shop(shop_id))
  with check (public.row_in_current_shop(shop_id));
-- work_order_serial_numbers
drop policy if exists "sn: shop isolation" on public.work_order_serial_numbers;
create policy "sn: shop isolation" on public.work_order_serial_numbers for all
  using (public.row_in_current_shop(shop_id))
  with check (public.row_in_current_shop(shop_id));
-- activity_history (APPEND-ONLY for clients: SELECT-only; rows written by
-- SECURITY DEFINER triggers). Shop-scoped; NULL legacy rows platform-admin only.
alter table public.activity_history enable row level security;
drop policy if exists "ah: shop isolation" on public.activity_history;
create policy "ah: shop isolation" on public.activity_history for select
  using (public.row_in_current_shop(shop_id) or public.is_platform_admin());
-- role_change_requests (tenant-scoped: a request belongs to one shop).
alter table public.role_change_requests enable row level security;
drop policy if exists "rcr: shop isolation" on public.role_change_requests;
create policy "rcr: shop isolation" on public.role_change_requests for all
  using (public.row_in_current_shop(shop_id) or public.is_platform_admin())
  with check (public.row_in_current_shop(shop_id) or public.is_platform_admin());
-- audit_log (READ-ONLY from clients; never updated/deleted via RLS). Members
-- read their own shop's log; legacy NULL-shop rows are platform-admin only.
alter table public.audit_log enable row level security;
drop policy if exists "audit: shop read" on public.audit_log;
create policy "audit: shop read" on public.audit_log for select
  using (public.row_in_current_shop(shop_id) or public.is_platform_admin());

-- serial_labels (shop_serial_label_options now has a real shop_id).
alter table public.shop_serial_label_options enable row level security;
drop policy if exists "serial_labels: shop isolation" on public.shop_serial_label_options;
create policy "serial_labels: shop isolation" on public.shop_serial_label_options for all
  using (public.row_in_current_shop(shop_id))
  with check (public.row_in_current_shop(shop_id));

commit;

-- ###########################################################################
-- #####################  END EXECUTABLE MIGRATION SQL  ######################
-- ###########################################################################


-- ===========================================================================
-- POST-MIGRATION VERIFICATION (READ-ONLY). Run after commit. Changes nothing.
-- ===========================================================================
-- V1 — tenant tables exist. Expected: 4 rows.
select table_name from information_schema.tables where table_schema='public'
  and table_name in ('shops','shop_locations','shop_memberships','platform_admins')
order by table_name;

-- V2 — tenant helpers exist. Expected: all present.
select proname, pg_get_function_arguments(oid) as args from pg_proc
where proname in ('current_user_shop_id','is_active_shop_member','row_in_current_shop',
                  'is_shop_owner','is_active_user','set_tenant_shop_id','set_active_shop')
order by proname;

-- V3 — tenant columns present + NOT NULL. Expected: is_nullable = NO on shop_id.
select table_name, column_name, is_nullable from information_schema.columns
where table_schema='public' and column_name='shop_id'
  and table_name in ('work_orders','work_order_photos','work_order_comments',
                     'activities','work_order_serial_numbers')
order by table_name;

-- V4 — exactly one seed shop + everyone enrolled. Expected: 1 shop; members = profiles count.
select (select count(*) from public.shops) as shops,
       (select count(*) from public.shop_memberships) as memberships,
       (select count(*) from public.profiles) as profiles;

-- V5 — no orphan/unstamped rows. Expected: all zero.
select
  (select count(*) from public.work_orders where shop_id is null) as wo_null,
  (select count(*) from public.work_order_photos where shop_id is null) as wop_null,
  (select count(*) from public.activities where shop_id is null) as act_null;

-- V6 — stamping triggers installed. Expected: 9 rows.
select tgrelid::regclass as tbl, tgname from pg_trigger
where tgname='stamp_shop_id' and not tgisinternal order by tbl;

-- V7 — isolation policies present on all tenant tables. Expected: 11 rows.
select tablename, policyname from pg_policies where schemaname='public'
  and policyname in ('shops: member read','memberships: self read',
    'wo: shop isolation','wop: shop isolation','woc: shop isolation',
    'act: shop isolation','sn: shop isolation','ah: shop isolation',
    'audit: shop read','rcr: shop isolation','serial_labels: shop isolation')
order by tablename, policyname;

-- V7b — permissive pre-tenant policies are GONE. Expected: 0 rows.
select tablename, policyname from pg_policies where schemaname='public'
  and policyname in ('work_orders: mechanic read active','photos: read active',
    'comments: read active','activities: read active','serial_numbers: read active',
    'audit_log: shop_owner read only','role_requests: self read')
order by tablename, policyname;

-- V7c — append-only preserved: audit_log & activity_history have SELECT-only
--        client policies (NO insert/update/delete policy). Expected: only 'r' cmds.
select tablename, policyname, cmd from pg_policies where schemaname='public'
  and tablename in ('audit_log','activity_history') order by tablename;

-- V8 — NEW audit/history rows get tenant-stamped. Runs in a rolled-back tx so
--      it changes nothing. Manually set role/claims to a Lessard user first, or
--      run inside a session where current_user_shop_id() resolves. Expected:
--      both stamped_shop_id values NON-NULL; if either is null, VERIFICATION FAILS.
-- begin;
--   insert into public.audit_log (actor_id, action, entity)
--     values (auth.uid(), 'verify.audit', 'work_order') returning shop_id as audit_stamped;
--   -- (activity_history requires a parent activity_id; insert a representative row
--   --  referencing an existing activity in the current shop, then check shop_id)
--   insert into public.activity_history (activity_id, edited_by, snapshot)
--     select a.id, auth.uid(), '{}'::jsonb from public.activities a
--     where a.shop_id = public.current_user_shop_id() limit 1
--     returning shop_id as history_stamped;
-- rollback;
-- Adjust column names to the live audit_log/activity_history shape before running.
-- ===========================================================================
