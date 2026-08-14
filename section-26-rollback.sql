-- ===========================================================================
-- Section 26 — ROLLBACK (owner-as-mechanic)
-- ===========================================================================
-- Reverses section-26-owner-as-mechanic.sql. Safe to run more than once.
--
-- ORDER MATTERS: drop the functions that read acts_as_mechanic first, then
-- restore the section 22/24 roster signatures, then drop the column/constraint.
-- Dropping the column while a get_..._roster function still returns it would
-- leave a broken function definition.
--
-- NOTE on data: any owner who had opted in loses the flag (the column is
-- removed). Their role and membership row are untouched — they simply stop
-- appearing in the assignable-mechanic list, i.e. pre-Section-26 behavior.
-- ---------------------------------------------------------------------------

drop function if exists public.get_assignable_mechanics();
drop function if exists public.set_owner_mechanic_status(uuid, boolean);

-- Restore get_shop_roster_admin() to its section-24 signature (no acts_as_mechanic).
-- Return type changes, so drop before create.
drop function if exists public.get_shop_roster_admin();
create or replace function public.get_shop_roster_admin()
returns table (
  profile_id          uuid,
  full_name           text,
  email               text,
  role                text,
  is_active           boolean,
  default_location_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select m.profile_id, p.full_name, p.email, m.role, m.is_active, m.default_location_id
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.shop_id = public.current_user_shop_id()
    and public.is_shop_owner(public.current_user_shop_id())
  order by (m.role = 'shop_owner') desc, p.full_name;
$$;
revoke all on function public.get_shop_roster_admin() from public;
revoke all on function public.get_shop_roster_admin() from anon;
grant execute on function public.get_shop_roster_admin() to authenticated;

-- Restore get_team_roster() to its section-22 signature (no acts_as_mechanic).
-- Return type changes, so drop before create.
drop function if exists public.get_team_roster();
create or replace function public.get_team_roster()
returns table (
  profile_id          uuid,
  full_name           text,
  role                text,
  is_active           boolean,
  default_location_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select m.profile_id, p.full_name, m.role, m.is_active, m.default_location_id
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

alter table public.shop_memberships
  drop constraint if exists shop_memberships_acts_as_mechanic_owner_only;
alter table public.shop_memberships
  drop column if exists acts_as_mechanic;
