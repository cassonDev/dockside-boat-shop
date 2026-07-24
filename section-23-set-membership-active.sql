-- ===========================================================================
-- Section 23 — Shop-scoped staff enable/disable (membership activity)
-- ===========================================================================
-- WHY
--   The Team "Disable / Reactivate" action must flip shop_memberships.is_active
--   for ONE member in the CURRENT shop — NOT profiles.active. Staging has no
--   client UPDATE policy on shop_memberships (only "memberships: self read"),
--   so a direct client update is blocked by RLS (0 rows) and PostgREST's
--   .single() surfaces it as "Cannot coerce the result to a single JSON object".
--
--   Rather than open a broad table-level UPDATE policy (which would also let the
--   client change role / default_location_id and bypass the guarded
--   update-staff-role path), expose ONE tightly-scoped SECURITY DEFINER function
--   that can only toggle is_active. Mirrors the get_team_roster() approach.
--
-- SAFETY PROPERTIES
--   * No shop_id parameter — shop is derived from current_user_shop_id()
--     (trusted only after membership re-verification). Cannot target another
--     tenant.
--   * Caller must be an active shop OWNER of that shop (is_shop_owner).
--   * Target must already be a member of THAT shop.
--   * Last-active-owner protection: refuses to disable a shop's only active
--     owner (defense in depth beyond the UI guard).
--   * Writes ONLY shop_memberships.is_active. Never profiles.active, role, or
--     default_location_id.
--   * Idempotent, additive. No table/policy/trigger is modified or dropped.
-- ---------------------------------------------------------------------------

create or replace function public.set_membership_active(
  p_profile_id uuid,
  p_active     boolean
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
    raise exception 'Only a shop owner may change staff status';
  end if;

  -- Target must be a member of the caller's current shop.
  select role into v_role
  from public.shop_memberships
  where profile_id = p_profile_id and shop_id = v_shop;

  if v_role is null then
    raise exception 'That person is not a member of this shop';
  end if;

  -- Never disable the shop's only remaining active owner.
  if p_active = false and v_role = 'shop_owner' then
    if (
      select count(*) from public.shop_memberships
      where shop_id = v_shop and role = 'shop_owner' and is_active
    ) <= 1 then
      raise exception 'Cannot disable the last active shop owner';
    end if;
  end if;

  update public.shop_memberships
     set is_active = p_active
   where profile_id = p_profile_id and shop_id = v_shop;

  return p_active;
end $$;

revoke all on function public.set_membership_active(uuid, boolean) from public;
revoke all on function public.set_membership_active(uuid, boolean) from anon;
grant execute on function public.set_membership_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Verification (run after applying)
-- ---------------------------------------------------------------------------
--  As Owner A (active shop S):
--    select public.set_membership_active('<cassie profile id>', false);  -- true path, disables
--    select is_active from public.shop_memberships where profile_id='<cassie>' and shop_id='<S>';  -- false
--    select public.set_membership_active('<cassie profile id>', true);   -- reactivates
--  Last-owner guard:
--    select public.set_membership_active('<only active owner>', false);  -- raises exception
--  Cross-shop / non-owner:
--    (as a mechanic, or targeting a member of another shop) -> raises exception, 0 rows
--  profiles.active is never read or written by this function.
