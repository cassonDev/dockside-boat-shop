-- ===========================================================================
-- Section 24 — Owner team-roster read (RLS-independent, owner-gated)
-- ===========================================================================
-- WHY
--   The owner Team page reads shop_memberships DIRECTLY under RLS. In production
--   the "memberships: self read" SELECT policy's is_shop_owner(shop_id) branch is
--   not granting, so an owner gets only their own row (profile_id = auth.uid())
--   and the roster shows just themselves. The mechanic path already works because
--   get_team_roster() is SECURITY DEFINER and bypasses RLS.
--
--   This gives the OWNER path the same RLS-independent mechanism: a SECURITY
--   DEFINER function, gated to owners of the caller's current shop, returning ALL
--   members (active AND inactive — owners need inactive for the Inactive filter
--   and reactivate). No table policy is changed; the mechanic path is untouched.
--
-- SAFETY PROPERTIES
--   * No shop_id parameter — shop is derived from current_user_shop_id()
--     (membership-verified). Cannot target another tenant.
--   * Owner-gated: is_shop_owner(current_user_shop_id()) must be true, else the
--     function returns ZERO rows (a mechanic calling it gets nothing).
--   * Read-only; returns a whitelisted column set (adds email + is_active vs the
--     mechanic roster, which the owner is already authorized to see).
--   * Idempotent, additive. No table/policy/trigger is modified or dropped.
-- ---------------------------------------------------------------------------

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
  select m.profile_id,
         p.full_name,
         p.email,
         m.role,
         m.is_active,
         m.default_location_id
  from public.shop_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.shop_id = public.current_user_shop_id()
    and public.is_shop_owner(public.current_user_shop_id())   -- caller must own this shop
  order by (m.role = 'shop_owner') desc, p.full_name;
$$;

revoke all on function public.get_shop_roster_admin() from public;
revoke all on function public.get_shop_roster_admin() from anon;
grant execute on function public.get_shop_roster_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run after applying)
-- ---------------------------------------------------------------------------
--  As an OWNER (Cassandra), in the browser (carries auth.uid()):
--    supabase.rpc('get_shop_roster_admin')  -> all members of her shop, incl inactive.
--  As a MECHANIC:
--    supabase.rpc('get_shop_roster_admin')  -> zero rows (not owner).
--  SQL editor (no auth.uid()) -> zero rows (expected; not a valid user-context test).
