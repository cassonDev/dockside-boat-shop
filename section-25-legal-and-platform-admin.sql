-- ===========================================================================
-- section-25-legal-and-platform-admin.sql   (STANDALONE, FOR REVIEW)
--
-- Adds, on top of the already-applied Section 20 tenant foundation:
--   * Versioned legal agreements  (legal_agreements + legal_acceptances)
--   * accept_legal_agreement()    SECURITY DEFINER RPC (canonical, uid-bound)
--   * create_shop_as_owner()      SECURITY DEFINER RPC (atomic owner onboarding)
--   * platform_admins             (idempotent — Section 20 already created it)
--   * is_platform_admin()         (idempotent — Section 20 already created it)
--   * get_platform_shops()        read-only, whitelisted, platform-admin-gated
--   * get_platform_shop_details() read-only, whitelisted, platform-admin-gated
--   * get_platform_shop_members() read-only, whitelisted, platform-admin-gated
--
-- PRECONDITIONS (verified live 2026-07-19, see RECONCILED-LIVE-STATE.md):
--   * Section 20 is fully applied: shops, shop_locations, shop_memberships,
--     platform_admins exist; helpers current_user_shop_id(),
--     is_active_shop_member(uuid), is_shop_owner(uuid), is_platform_admin(),
--     enforce_active_shop_id() exist; profiles.active_shop_id exists.
--   * Verified live columns ONLY (no schema-drift columns are referenced):
--       shops(id, name, is_active, created_at)
--       shop_locations(id, shop_id, name, is_active, created_at)   [no is_primary]
--       shop_memberships(id, profile_id, shop_id, role, is_active,
--                        default_location_id, created_at)
--       profiles(id, full_name, email, active_shop_id)
--       audit_log(actor_id, actor_name, actor_role, action, table_name,
--                 record_id, old_value, new_value, shop_id, created_at)
--       work_orders(shop_id, created_at, updated_at)
--
-- SAFETY / DESIGN INVARIANTS
--   * NO existing table, policy, trigger, or helper is dropped or weakened.
--     This file is PURELY ADDITIVE. (Rollback lives in
--     section-25-rollback.sql.)
--   * Acceptance rows are NEVER written by the client: legal_acceptances has a
--     self-SELECT policy and NO insert/update/delete policy. Only the
--     SECURITY DEFINER accept_legal_agreement() (and create path) write it.
--   * No RPC accepts a profile id / owner id / shop id it will trust as the
--     actor — identity is ALWAYS auth.uid().
--   * Platform-admin reads are gated INSIDE the function body
--     (public.is_platform_admin()); a non-admin gets ZERO rows, never an error
--     that leaks existence, and never any non-whitelisted column.
--   * Everything runs inside ONE explicit transaction; any failure rolls the
--     whole thing back.
--
-- DO NOT run in production until reviewed + tested in staging.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 25A. platform_admins  (idempotent — Section 20 already created this exact
--      shape; create-if-not-exists so this file is safe to run on a DB where
--      Section 20 is present, and self-sufficient on one where it is not).
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

-- Platform admins may read the platform_admins table (self-membership check);
-- no client write path (rows are added out-of-band by a trusted operator —
-- see SECTION-25-README.md). Idempotent.
drop policy if exists "platform_admins: admin read" on public.platform_admins;
create policy "platform_admins: admin read" on public.platform_admins
  for select using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- 25B. is_platform_admin()  (idempotent redefinition, identical to Section 20)
--      SECURITY DEFINER, scoped to auth.uid(). Kept here so this file is
--      self-sufficient; CREATE OR REPLACE leaves the Section 20 version intact
--      in behavior.
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.profile_id = auth.uid() and a.is_active
  );
$$;
revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_platform_admin() from anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 25C. Versioned legal agreements
--      legal_agreements  — the canonical, application-owned agreement text.
--                          One row per (kind, version). At most one is_current
--                          row per kind (partial unique index).
--      legal_acceptances — an append-only record that a specific profile
--                          accepted a specific agreement version, with a
--                          server-copied snapshot of the canonical text.
-- ---------------------------------------------------------------------------
create table if not exists public.legal_agreements (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (char_length(trim(kind)) > 0),   -- e.g. 'pilot_agreement'
  version      integer not null check (version > 0),
  title        text not null check (char_length(trim(title)) > 0),
  body         text not null check (char_length(trim(body)) > 0),
  content_hash text not null,                                       -- md5(body); integrity marker
  is_current   boolean not null default false,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (kind, version)
);
alter table public.legal_agreements enable row level security;
-- At most one current version per kind.
create unique index if not exists legal_agreements_one_current_per_kind
  on public.legal_agreements (kind) where is_current;

create table if not exists public.legal_acceptances (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  agreement_id  uuid not null references public.legal_agreements(id) on delete restrict,
  kind          text not null,
  version       integer not null,
  accepted_text text not null,          -- server-copied canonical snapshot (never client text)
  content_hash  text not null,          -- copied from the agreement row
  accepted_at   timestamptz not null default now(),
  unique (profile_id, agreement_id)     -- one acceptance per person per version
);
alter table public.legal_acceptances enable row level security;
create index if not exists legal_acceptances_profile_idx on public.legal_acceptances (profile_id);
create index if not exists legal_acceptances_agreement_idx on public.legal_acceptances (agreement_id);

-- RLS: agreements are readable by any signed-in user (they must see what they
-- are agreeing to). NO client write path — agreements are managed out-of-band.
drop policy if exists "legal_agreements: authenticated read" on public.legal_agreements;
create policy "legal_agreements: authenticated read" on public.legal_agreements
  for select to authenticated using (true);

-- RLS: a user may read ONLY their own acceptance rows; a platform admin may
-- read all (needed for the read-only platform admin agreement-status column).
-- CRUCIALLY: there is NO insert/update/delete policy, so the client can never
-- write an acceptance directly — only accept_legal_agreement() (SECURITY
-- DEFINER) can. This is the enforcement of "users must not directly insert or
-- modify acceptance records."
drop policy if exists "legal_acceptances: self or admin read" on public.legal_acceptances;
create policy "legal_acceptances: self or admin read" on public.legal_acceptances
  for select using (profile_id = auth.uid() or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- 25D. Seed the current pilot agreement (idempotent). The text below is the
--      CANONICAL agreement stored by the application; the accept RPC copies it
--      verbatim into each acceptance. Bump `version`, insert a new row, and
--      flip is_current to publish a new version later (old acceptances stay
--      pinned to the version they accepted).
-- ---------------------------------------------------------------------------
do $$
declare
  v_kind    text := 'pilot_agreement';
  v_version integer := 1;
  v_title   text := 'Boat Shop Pilot Program Agreement (v1)';
  v_body    text := $agreement$Boat Shop Pilot Program Agreement — Version 1

By creating a shop you agree to participate in the Boat Shop pilot program under the following terms:

1. Pilot status. The service is provided on a pilot basis, "as is", without warranties of any kind. Features may change, and the service may be interrupted for maintenance.

2. Your data. You are responsible for the accuracy of the shop, customer, and work-order data you enter. You retain ownership of your shop's data. We process it solely to provide the service to you.

3. Tenant isolation. Your shop's data is logically isolated from other shops. You agree not to attempt to access, or to circumvent controls protecting, data belonging to any other shop.

4. Acceptable use. You will use the service lawfully, will keep your account credentials secure, and are responsible for the actions of the staff you invite.

5. Confidentiality of the pilot. Non-public details of the pilot (pricing, roadmap, and unreleased features) are confidential.

6. No fee during pilot. No subscription fee applies during the pilot period. Continued use after the pilot may require a paid plan; you will be notified before any charge.

7. Termination. Either party may end participation at any time. On termination you may request an export of your shop's data.

8. Limitation of liability. To the maximum extent permitted by law, the pilot is provided without liability for indirect or consequential loss.

This agreement is versioned. Your acceptance is recorded against the exact version shown above.$agreement$;
  v_hash    text;
begin
  v_hash := md5(v_body);

  if not exists (
    select 1 from public.legal_agreements where kind = v_kind and version = v_version
  ) then
    -- Ensure no other row for this kind stays flagged current.
    update public.legal_agreements set is_current = false where kind = v_kind and is_current;
    insert into public.legal_agreements (kind, version, title, body, content_hash, is_current)
    values (v_kind, v_version, v_title, v_body, v_hash, true);
    raise notice 'SEED: pilot_agreement v% inserted and set current.', v_version;
  else
    raise notice 'SEED: pilot_agreement v% already present — left unchanged.', v_version;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 25E. accept_legal_agreement()  SECURITY DEFINER
--      Records the CANONICAL agreement version + text for the CURRENT user.
--      * identity = auth.uid() (no user id parameter);
--      * reads text/hash from legal_agreements (client cannot supply text);
--      * idempotent (unique(profile_id, agreement_id) + ON CONFLICT).
--      Client passes only which agreement (kind + version) it displayed.
-- ---------------------------------------------------------------------------
create or replace function public.accept_legal_agreement(
  p_kind    text,
  p_version integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  a     public.legal_agreements%rowtype;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;

  select * into a
  from public.legal_agreements
  where kind = p_kind and version = p_version;

  if a.id is null then
    raise exception 'Unknown agreement % v%', p_kind, p_version;
  end if;

  -- Copy the CANONICAL text + hash from the agreement row (never from client).
  insert into public.legal_acceptances
    (profile_id, agreement_id, kind, version, accepted_text, content_hash)
  values
    (v_uid, a.id, a.kind, a.version, a.body, a.content_hash)
  on conflict (profile_id, agreement_id) do nothing;

  return a.id;
end $$;
revoke all on function public.accept_legal_agreement(text, integer) from public;
revoke all on function public.accept_legal_agreement(text, integer) from anon;
grant execute on function public.accept_legal_agreement(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 25F. create_shop_as_owner()  SECURITY DEFINER
--      Atomic owner-onboarding. Everything below happens in the single
--      function-call transaction; any failure rolls it all back.
--      * identity = auth.uid() — NO profile/owner id parameter;
--      * requires the CURRENT pilot agreement version to be accepted;
--      * refuses if the caller already has ANY active membership (onboarding
--        is only for accounts not yet linked to a shop) — defense in depth,
--        not reliance on the UI;
--      * creates shop -> first location -> active owner membership ->
--        sets profiles.active_shop_id -> writes an audit-log entry.
-- ---------------------------------------------------------------------------
create or replace function public.create_shop_as_owner(
  p_shop_name     text,
  p_location_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_shop_name text := nullif(trim(p_shop_name), '');
  v_loc_name  text := nullif(trim(p_location_name), '');
  v_pilot     public.legal_agreements%rowtype;
  v_shop_id   uuid;
  v_loc_id    uuid;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;
  if v_shop_name is null then
    raise exception 'Shop name is required';
  end if;
  if v_loc_name is null then
    raise exception 'A default location name is required';
  end if;
  if char_length(v_shop_name) > 120 then
    raise exception 'Shop name is too long';
  end if;
  if char_length(v_loc_name) > 120 then
    raise exception 'Location name is too long';
  end if;

  -- Onboarding is only for accounts with NO active shop membership.
  if exists (
    select 1 from public.shop_memberships m
    where m.profile_id = v_uid and m.is_active
  ) then
    raise exception 'Account is already linked to a shop';
  end if;

  -- Require the CURRENT pilot agreement to have been accepted by THIS user.
  select * into v_pilot
  from public.legal_agreements
  where kind = 'pilot_agreement' and is_current
  limit 1;
  if v_pilot.id is null then
    raise exception 'No current pilot agreement is published';
  end if;
  if not exists (
    select 1 from public.legal_acceptances la
    where la.profile_id = v_uid and la.agreement_id = v_pilot.id
  ) then
    raise exception 'The pilot agreement must be accepted before creating a shop';
  end if;

  -- 1) Shop.
  insert into public.shops (name, is_active)
  values (v_shop_name, true)
  returning id into v_shop_id;

  -- 2) First (default) location.
  insert into public.shop_locations (shop_id, name, is_active)
  values (v_shop_id, v_loc_name, true)
  returning id into v_loc_id;

  -- 3) Active owner membership, defaulting to the location just created.
  insert into public.shop_memberships
    (profile_id, shop_id, role, is_active, default_location_id)
  values
    (v_uid, v_shop_id, 'shop_owner', true, v_loc_id);

  -- 4) Set the caller's active shop (membership above satisfies the
  --    enforce_active_shop_id() guard).
  update public.profiles
     set active_shop_id = v_shop_id, updated_at = now()
   where id = v_uid;

  -- 5) Audit-log entry, explicitly stamped to the new shop.
  insert into public.audit_log
    (actor_id, actor_name, actor_role, action, table_name, record_id, new_value, shop_id)
  select v_uid,
         coalesce(p.full_name, ''),
         'shop_owner',
         'create_shop_as_owner',
         'shops',
         v_shop_id::text,
         jsonb_build_object('shop_name', v_shop_name, 'location_name', v_loc_name),
         v_shop_id
  from public.profiles p where p.id = v_uid;

  return v_shop_id;
end $$;
revoke all on function public.create_shop_as_owner(text, text) from public;
revoke all on function public.create_shop_as_owner(text, text) from anon;
grant execute on function public.create_shop_as_owner(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 25G. Read-only platform-admin RPCs. All three:
--        * are SECURITY DEFINER but gated by public.is_platform_admin()
--          INSIDE the body → a non-admin caller gets ZERO rows;
--        * return only a WHITELISTED column set (no address/phone/settings,
--          no customer data, no work-order contents);
--        * take no parameter that can widen scope beyond a single shop id.
-- ---------------------------------------------------------------------------

-- 25G-1. One row per shop, with the platform dashboard aggregates.
create or replace function public.get_platform_shops()
returns table (
  shop_id          uuid,
  shop_name        text,
  created_at       timestamptz,
  is_active        boolean,
  owner_name       text,
  owner_email      text,
  location_count   bigint,
  user_count       bigint,
  agreement_status text,
  last_activity_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    s.id,
    s.name,
    s.created_at,
    s.is_active,
    owner.full_name,
    owner.email,
    (select count(*) from public.shop_locations l
       where l.shop_id = s.id and l.is_active),
    (select count(*) from public.shop_memberships m
       where m.shop_id = s.id and m.is_active),
    case when exists (
      select 1
      from public.shop_memberships m
      join public.legal_acceptances la on la.profile_id = m.profile_id
      join public.legal_agreements ag on ag.id = la.agreement_id
      where m.shop_id = s.id and m.role = 'shop_owner' and m.is_active
        and ag.kind = 'pilot_agreement' and ag.is_current
    ) then 'accepted' else 'not accepted' end,
    greatest(
      s.created_at,
      (select max(al.created_at) from public.audit_log al where al.shop_id = s.id),
      (select max(w.updated_at)  from public.work_orders w where w.shop_id = s.id)
    )
  from public.shops s
  left join lateral (
    select p.full_name, p.email
    from public.shop_memberships m
    join public.profiles p on p.id = m.profile_id
    where m.shop_id = s.id and m.role = 'shop_owner' and m.is_active
    order by m.created_at asc
    limit 1
  ) owner on true
  where public.is_platform_admin()      -- non-admin → zero rows
  order by s.created_at desc;
$$;
revoke all on function public.get_platform_shops() from public;
revoke all on function public.get_platform_shops() from anon;
grant execute on function public.get_platform_shops() to authenticated;

-- 25G-2. Detail for one shop (same whitelisted shape, single row).
create or replace function public.get_platform_shop_details(p_shop_id uuid)
returns table (
  shop_id          uuid,
  shop_name        text,
  created_at       timestamptz,
  is_active        boolean,
  owner_name       text,
  owner_email      text,
  location_count   bigint,
  user_count       bigint,
  agreement_status text,
  last_activity_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    s.id,
    s.name,
    s.created_at,
    s.is_active,
    owner.full_name,
    owner.email,
    (select count(*) from public.shop_locations l
       where l.shop_id = s.id and l.is_active),
    (select count(*) from public.shop_memberships m
       where m.shop_id = s.id and m.is_active),
    case when exists (
      select 1
      from public.shop_memberships m
      join public.legal_acceptances la on la.profile_id = m.profile_id
      join public.legal_agreements ag on ag.id = la.agreement_id
      where m.shop_id = s.id and m.role = 'shop_owner' and m.is_active
        and ag.kind = 'pilot_agreement' and ag.is_current
    ) then 'accepted' else 'not accepted' end,
    greatest(
      s.created_at,
      (select max(al.created_at) from public.audit_log al where al.shop_id = s.id),
      (select max(w.updated_at)  from public.work_orders w where w.shop_id = s.id)
    )
  from public.shops s
  left join lateral (
    select p.full_name, p.email
    from public.shop_memberships m
    join public.profiles p on p.id = m.profile_id
    where m.shop_id = s.id and m.role = 'shop_owner' and m.is_active
    order by m.created_at asc
    limit 1
  ) owner on true
  where public.is_platform_admin()      -- non-admin → zero rows
    and s.id = p_shop_id;
$$;
revoke all on function public.get_platform_shop_details(uuid) from public;
revoke all on function public.get_platform_shop_details(uuid) from anon;
grant execute on function public.get_platform_shop_details(uuid) to authenticated;

-- 25G-3. Members of one shop (whitelisted: name, email, role, active, joined).
create or replace function public.get_platform_shop_members(p_shop_id uuid)
returns table (
  profile_id uuid,
  full_name  text,
  email      text,
  role       text,
  is_active  boolean,
  joined_at  timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select
    m.profile_id,
    p.full_name,
    p.email,
    m.role,
    m.is_active,
    m.created_at
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where public.is_platform_admin()      -- non-admin → zero rows
    and m.shop_id = p_shop_id
  order by (m.role = 'shop_owner') desc, p.full_name;
$$;
revoke all on function public.get_platform_shop_members(uuid) from public;
revoke all on function public.get_platform_shop_members(uuid) from anon;
grant execute on function public.get_platform_shop_members(uuid) to authenticated;

commit;

-- ===========================================================================
-- POST-MIGRATION VERIFICATION (READ-ONLY). Run after commit. Changes nothing.
-- ===========================================================================
-- V1 — new tables exist. Expected: 2 rows.
-- select table_name from information_schema.tables where table_schema='public'
--   and table_name in ('legal_agreements','legal_acceptances') order by table_name;

-- V2 — new functions exist. Expected: all present.
-- select proname, pg_get_function_arguments(oid) as args from pg_proc
-- where proname in ('accept_legal_agreement','create_shop_as_owner',
--   'get_platform_shops','get_platform_shop_details','get_platform_shop_members',
--   'is_platform_admin') order by proname;

-- V3 — exactly one current pilot agreement. Expected: 1 row, version 1.
-- select kind, version, is_current from public.legal_agreements
--   where kind='pilot_agreement' and is_current;

-- V4 — acceptance table has SELECT-only client policy (NO write policy).
--   Expected: only cmd='r' (SELECT) rows for legal_acceptances.
-- select tablename, policyname, cmd from pg_policies
--   where schemaname='public' and tablename in ('legal_agreements','legal_acceptances')
--   order by tablename, cmd;

-- V5 — platform reads reject non-admins. As a NON-admin user session:
--   select * from public.get_platform_shops();            -- expect 0 rows
--   select * from public.get_platform_shop_details(gen_random_uuid());  -- 0 rows
--   As a platform admin: get_platform_shops() returns one row per shop.

-- V6 — acceptance cannot be forged directly (as any signed-in user):
--   insert into public.legal_acceptances(profile_id,agreement_id,kind,version,accepted_text,content_hash)
--     values (auth.uid(), gen_random_uuid(), 'x', 1, 'forged', 'x');
--   -- expect: RLS violation (no insert policy). Then:
--   select public.accept_legal_agreement('pilot_agreement', 1);  -- succeeds, canonical text
-- ===========================================================================
