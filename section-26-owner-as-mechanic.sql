-- ===========================================================================
-- Section 26 — Owner-as-mechanic (a shop owner may ALSO work as a mechanic)
-- ===========================================================================
-- WHY
--   A shop owner needs to be assignable to work orders / jobs and to appear
--   anywhere a mechanic can be selected, WITHOUT losing the shop_owner role and
--   WITHOUT creating a second user or membership row. The two-role model keeps
--   exactly one membership per (profile, shop); this adds a capability FLAG on
--   that single row rather than a new role or a duplicate record.
--
-- WHAT
--   1. shop_memberships.acts_as_mechanic boolean not null default false.
--        * false for every existing row => existing owners/mechanics behave
--          EXACTLY as before (fully backward compatible).
--        * meaningful only for role='shop_owner'; ignored for role='mechanic'
--          (a mechanic is already assignable). A CHECK keeps it false for any
--          non-owner row so state can never be ambiguous.
--   2. get_assignable_mechanics()  — the assignable set for the caller's active
--        shop, readable by ANY active member (SECURITY DEFINER), so the owner
--        shows up in every assignment/filter UI, for owners and mechanics alike.
--   3. set_owner_mechanic_status() — owner-only toggle of acts_as_mechanic on an
--        owner membership in the caller's shop. Mirrors set_membership_active
--        (section 23): no shop_id param, owner-gated, writes ONE column.
--   4. get_shop_roster_admin() / get_team_roster() re-created to also return
--        acts_as_mechanic so the roster UI can show an "Owner · Mechanic" badge
--        and reflect the toggle state. Column set is otherwise unchanged.
--
-- IDEMPOTENT. Additive only. No table/policy/trigger is dropped. Safe to re-run.
-- ---------------------------------------------------------------------------

-- 1) Column ------------------------------------------------------------------
alter table public.shop_memberships
  add column if not exists acts_as_mechanic boolean not null default false;

-- Integrity: acts_as_mechanic is only ever true for an owner membership.
-- (Named check, added defensively — drop-then-add so a re-run stays clean.)
alter table public.shop_memberships
  drop constraint if exists shop_memberships_acts_as_mechanic_owner_only;
alter table public.shop_memberships
  add constraint shop_memberships_acts_as_mechanic_owner_only
  check (acts_as_mechanic = false or role = 'shop_owner');

-- 2) Assignable-mechanic set (readable by any active member of the shop) ------
--    Owner shows up wherever mechanics are selected/assigned/filtered.
--    Availability WINDOW fields (start/end/note) are returned ONLY to the shop
--    owner or to the row's own user — faithfully preserving the pre-existing
--    RLS visibility (a mechanic previously could read only their own profile
--    row; owners could read all). full_name / out_of_office / availability_status
--    are operational and already visible to coworkers via job cards.
create or replace function public.get_assignable_mechanics()
returns table (
  profile_id          uuid,
  full_name           text,
  role                text,
  acts_as_mechanic    boolean,
  out_of_office       boolean,
  availability_status text,
  out_of_office_start date,
  out_of_office_end   date,
  availability_note   text,
  default_location_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select m.profile_id,
         p.full_name,
         m.role,
         m.acts_as_mechanic,
         p.out_of_office,
         p.availability_status,
         case when public.is_shop_owner(public.current_user_shop_id()) or m.profile_id = auth.uid()
              then p.out_of_office_start else null end,
         case when public.is_shop_owner(public.current_user_shop_id()) or m.profile_id = auth.uid()
              then p.out_of_office_end else null end,
         case when public.is_shop_owner(public.current_user_shop_id()) or m.profile_id = auth.uid()
              then p.availability_note else null end,
         m.default_location_id
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.shop_id = public.current_user_shop_id()
    and public.is_active_shop_member(public.current_user_shop_id())
    and m.is_active
    and (m.role = 'mechanic' or (m.role = 'shop_owner' and m.acts_as_mechanic))
  order by p.full_name;
$$;

revoke all on function public.get_assignable_mechanics() from public;
revoke all on function public.get_assignable_mechanics() from anon;
grant execute on function public.get_assignable_mechanics() to authenticated;

-- 3) Owner-only toggle of mechanic capability --------------------------------
--    Shop derived from current_user_shop_id() (never a param) => cannot target
--    another tenant. Owner-gated. Target must be an OWNER membership of THIS
--    shop. Writes ONLY acts_as_mechanic — never role, is_active, or profiles.*.
create or replace function public.set_owner_mechanic_status(
  p_profile_id uuid,
  p_enabled    boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid := public.current_user_shop_id();
  v_role text;
begin
  if v_shop is null then
    raise exception 'No active shop context';
  end if;
  if not public.is_shop_owner(v_shop) then
    raise exception 'Only a shop owner may change mechanic capability';
  end if;

  select role into v_role
  from public.shop_memberships
  where profile_id = p_profile_id and shop_id = v_shop;

  if v_role is null then
    raise exception 'That person is not a member of this shop';
  end if;
  if v_role <> 'shop_owner' then
    -- A mechanic membership is already assignable; there is nothing to toggle.
    raise exception 'Mechanic capability only applies to a shop owner membership';
  end if;

  update public.shop_memberships
     set acts_as_mechanic = coalesce(p_enabled, false)
   where profile_id = p_profile_id and shop_id = v_shop;

  -- Best-effort audit (never fail the toggle if audit insert fails).
  begin
    insert into public.audit_log (actor_id, actor_role, action, table_name, record_id, new_value, shop_id)
    values (auth.uid(), 'shop_owner',
            case when coalesce(p_enabled,false) then 'owner_mechanic_enabled' else 'owner_mechanic_disabled' end,
            'shop_memberships', p_profile_id,
            jsonb_build_object('acts_as_mechanic', coalesce(p_enabled,false)), v_shop);
  exception when others then
    null;
  end;

  return coalesce(p_enabled, false);
end $$;

revoke all on function public.set_owner_mechanic_status(uuid, boolean) from public;
revoke all on function public.set_owner_mechanic_status(uuid, boolean) from anon;
grant execute on function public.set_owner_mechanic_status(uuid, boolean) to authenticated;

-- 4) Roster functions re-created to surface acts_as_mechanic -----------------
--    (owner roster: all members incl. inactive; mechanic roster: active only)
create or replace function public.get_shop_roster_admin()
returns table (
  profile_id          uuid,
  full_name           text,
  email               text,
  role                text,
  acts_as_mechanic    boolean,
  is_active           boolean,
  default_location_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select m.profile_id,
         p.full_name,
         p.email,
         m.role,
         m.acts_as_mechanic,
         m.is_active,
         m.default_location_id
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.shop_id = public.current_user_shop_id()
    and public.is_shop_owner(public.current_user_shop_id())
  order by (m.role = 'shop_owner') desc, p.full_name;
$$;
revoke all on function public.get_shop_roster_admin() from public;
revoke all on function public.get_shop_roster_admin() from anon;
grant execute on function public.get_shop_roster_admin() to authenticated;

create or replace function public.get_team_roster()
returns table (
  profile_id          uuid,
  full_name           text,
  role                text,
  acts_as_mechanic    boolean,
  is_active           boolean,
  default_location_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select m.profile_id,
         p.full_name,
         m.role,
         m.acts_as_mechanic,
         m.is_active,
         m.default_location_id
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.shop_id = public.current_user_shop_id()
    and public.is_active_shop_member(public.current_user_shop_id())
    and m.is_active
  order by (m.role = 'shop_owner') desc, p.full_name;
$$;
revoke all on function public.get_team_roster() from public;
revoke all on function public.get_team_roster() from anon;
grant execute on function public.get_team_roster() to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run after applying; each SELECT is an assertion)
-- ---------------------------------------------------------------------------
-- V1 — column exists with the right default and NOT NULL:
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and table_name='shop_memberships'
--     and column_name='acts_as_mechanic';
--   -- expect: boolean, NO, false
--
-- V2 — every existing row defaulted to false (no behavior change on deploy):
--   select count(*) from public.shop_memberships where acts_as_mechanic is null;   -- 0
--   select count(*) from public.shop_memberships where acts_as_mechanic = true;    -- 0 (until an owner opts in)
--
-- V3 — check constraint blocks a non-owner from being flagged:
--   update public.shop_memberships set acts_as_mechanic = true
--     where role = 'mechanic' limit 1;   -- expect: constraint violation
--
-- V4 — as an OWNER who has NOT opted in: owner is absent from assignable set;
--      as that owner after set_owner_mechanic_status(self, true): owner present.
--   select public.set_owner_mechanic_status('<owner profile id>', true);   -- true
--   select profile_id, role, acts_as_mechanic from public.get_assignable_mechanics();
--     -- expect the owner row to appear alongside role='mechanic' rows
--   select public.set_owner_mechanic_status('<owner profile id>', false);  -- false (owner drops out again)
--
-- V5 — a MECHANIC calling the toggle, or targeting another tenant: raises.
--   (as mechanic) select public.set_owner_mechanic_status('<any>', true);  -- exception
--
-- V6 — functions exist with the expected signatures:
--   select proname, pg_get_function_arguments(oid) from pg_proc
--   where proname in ('get_assignable_mechanics','set_owner_mechanic_status');
